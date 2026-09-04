/**
 * MCP server wiring: tool registration with descriptions and annotations, a
 * stdout guard so nothing but JSON-RPC reaches the host, and lifecycle hooks
 * that stop background jobs when the host closes stdin.
 */
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';
import { log } from './infra/log.js';
import { ensureDirs } from './infra/store.js';
import { flushAllCaches } from './infra/cache.js';
import { abortAllJobs } from './engine/jobs.js';
import { pruneDrafts } from './engine/draft.js';
import { guard } from './tools/shared.js';
import { connect, disconnect, setup, status, VERSION } from './tools/connect.js';
import { createDraft, deleteDraftTool, editDraft, exportDraft, getDraftTool, listDraftsTool, parseLineup } from './tools/drafts.js';
import { compareTasteTool, createPlaylist, searchTracks, updatePlaylist } from './tools/playlist.js';
import { analyzePlaylistTool, comparePlaylistsTool, expandPlaylistTool, mergePlaylistsTool, readPlaylistTool, refreshTasteTool } from './tools/playlists.js';

const TIER = z.enum(['headliner', 'sub', 'undercard', 'flat']);
const ORDER = z.enum(['interleave', 'lineup', 'shuffle', 'by_day', 'known_first']);
const SOURCE = z.enum(['deezer', 'lastfm', 'spotify']);

const artistSchema = z.union([
  z.string().min(1).max(120),
  z.object({
    name: z.string().min(1).max(120),
    tier: TIER.optional().describe('headliner / sub / undercard as printed on the poster (font size). Omit if unknown.'),
    day: z.string().max(20).optional().describe('e.g. friday'),
    stage: z.string().max(40).optional(),
  }),
]);

const seedSchema = z.object({
  type: z.enum(['genre', 'similar_to', 'chart', 'country', 'playlist', 'taste', 'blend']).describe('genre: any genre/mood/scene words ("shoegaze", "melancholic", "rainy sunday jazz"); similar_to: artists like this one; chart: what is popular now; country: what a country listens to; playlist: the artists of a playlist (link, id, name in your library, "library"); taste: your own top artists; blend: artists several people would all like'),
  value: z.string().max(120).optional().describe('genre words, artist name, country, or playlist reference'),
  sources: z.array(z.string().max(200)).min(2).max(4).optional().describe('blend only: playlist links/names, draft ids, "library" or "me"'),
  minShared: z.number().int().min(2).max(4).optional().describe('blend only: sides an artist must appear on (default: all)'),
  limit: z.number().int().min(1).max(100).optional().describe('max artists from this seed (default 30)'),
  tier: TIER.optional().describe('tier for the seeded artists (default flat, or undercard when the typed artists have tiers)'),
});

const yearRangeSchema = z.object({ from: z.number().int().min(1900).max(2100).optional(), to: z.number().int().min(1900).max(2100).optional() }).optional().describe('Keep only tracks released in this range, e.g. { from: 1990, to: 1999 }');
const bpmRangeSchema = z.object({ min: z.number().int().min(30).max(300).optional(), max: z.number().int().min(30).max(300).optional() }).optional().describe('Keep only tracks whose tempo (Deezer) is in this range, e.g. running { min: 160, max: 180 }');
const PLAYLIST_REF = z.string().min(1).max(200).describe('open.spotify.com/playlist link, spotify:playlist: URI, playlist id, a playlist name from your own library, a deezer.com/playlist link, a draft id (d_xxxx), or "library" for your liked songs');

const PROVIDER = z.enum(['spotify', 'deezer']);

const buildOptionSchemas = {
  provider: PROVIDER.optional().describe('spotify: needs a connected account, can publish. deezer: no account or login at all, every feature except publishing (export the list instead). Default: spotify when connected, otherwise deezer'),
  tracksPerTier: z.object({ headliner: z.number().int().min(0).max(30).optional(), sub: z.number().int().min(0).max(30).optional(), undercard: z.number().int().min(0).max(30).optional() }).optional(),
  tracksPerArtist: z.number().int().min(0).max(30).optional().describe('Same count for every artist; overrides tracksPerTier. Use 1 for "one song per artist"'),
  maxTracks: z.number().int().min(1).max(10_000).optional(),
  maxDurationMin: z.number().int().min(10).max(100_000).optional().describe('Total length cap, e.g. 45 for a commute'),
  order: ORDER.optional().describe('interleave (default, spreads artists), lineup (artist by artist), shuffle, by_day, known_first'),
  excludeArtists: z.array(z.string()).optional(),
  excludeExplicit: z.boolean().optional(),
  allowVersions: z.boolean().optional().describe('Allow live/remix/edit versions'),
  discoveryOnly: z.boolean().optional().describe("Skip artists already in the user's top or followed artists"),
  public: z.boolean().optional(),
  yearRange: yearRangeSchema,
  strictYear: z.boolean().optional().describe('With yearRange: also drop tracks whose year is unknown or comes from a remaster/compilation'),
  bpmRange: bpmRangeSchema,
  strictBpm: z.boolean().optional().describe('With bpmRange: also drop tracks with no known tempo'),
  skipCovers: z.boolean().optional().describe('Drop a song when a more popular artist has the original (e.g. a Motörhead cover of Enter Sandman). Off by default; costs one Deezer lookup per track'),
};

const editOpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('remove_tracks'), ids: z.array(z.string()).optional().describe('Track ids like t_4k2p from get_draft view=tracks (preferred)'), indexes: z.array(z.number().int().min(1)).optional().describe('1-based positions as shown in the same listing') }),
  z.object({ op: z.literal('add_track'), track: z.string().min(1).max(200).describe('spotify:track: URI, open.spotify.com track URL, or "Artist - Title"'), artist: z.string().max(120).optional().describe('Draft artist to credit; auto-detected when omitted'), position: z.number().int().min(1).optional().describe('1-based insert position; end when omitted') }),
  z.object({ op: z.literal('exclude_artist'), artist: z.string().min(1).max(120) }),
  z.object({ op: z.literal('set_artist_track_count'), artist: z.string().min(1).max(120), count: z.number().int().min(0).max(50) }),
  z.object({ op: z.literal('set_artist_source'), artist: z.string().min(1).max(120), deezerId: z.number().int().optional(), spotifyArtistId: z.string().optional() }).describe('Override which artist a name resolves to when the wrong one was picked; refetches that artist'),
  z.object({ op: z.literal('move'), id: z.string().optional(), from: z.number().int().min(1).optional(), to: z.number().int().min(1) }),
  z.object({ op: z.literal('shuffle'), seed: z.number().int().optional() }),
  z.object({ op: z.literal('reorder'), mode: ORDER }),
  z.object({ op: z.literal('set_meta'), name: z.string().max(100).optional(), description: z.string().max(300).optional(), public: z.boolean().optional() }),
  z.object({ op: z.literal('filter'), explicit: z.boolean().optional().describe('true removes explicit tracks'), versions: z.boolean().optional().describe('false removes live/remix/edit versions') }),
  z.object({ op: z.literal('undo') }),
]);

export function buildServer(): McpServer {
  const server = new McpServer({ name: 'lineupify', version: VERSION });
  const net = { openWorldHint: true };

  server.registerTool(
    'status',
    {
      title: 'Lineupify status',
      description:
        'Call this first. Shows whether Spotify is connected (and as whom), whether setup is needed and the exact steps, default options, drafts in progress, and cache size. Also shows a login that is still waiting for the browser.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, ...net },
    },
    guard(status),
  );

  server.registerTool(
    'setup',
    {
      title: 'Save Spotify client ID',
      description:
        'Save the Spotify client ID (32 hex chars from the app page at developer.spotify.com/dashboard; redirect URI must be http://127.0.0.1:8765/callback) so it is not needed in the MCP config. Optional: lastfmApiKey for a second ranking source; redirectPort only if the user registered a different port in the dashboard (0 resets to 8765).',
      inputSchema: z.object({
        clientId: z.string().optional(),
        redirectPort: z.number().int().optional(),
        lastfmApiKey: z.string().optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    guard(setup),
  );

  server.registerTool(
    'connect',
    {
      title: 'Connect Spotify',
      description:
        'Start the Spotify login. Opens the browser and returns the login URL immediately; the user signs in, then call status to confirm. Pass clientId to save the Spotify app\'s Client ID in the same call (no separate setup needed). Pass force: true to switch accounts or re-login (needed every 6 months). Refused while a draft is building.',
      inputSchema: z.object({ force: z.boolean().optional(), clientId: z.string().optional().describe('32-hex Client ID from developer.spotify.com/dashboard; saved before the login starts') }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, ...net },
    },
    guard(connect),
  );

  server.registerTool(
    'disconnect',
    {
      title: 'Disconnect Spotify',
      description:
        'Forget the saved Spotify login (deletes tokens.json). With purge: true also deletes everything Lineupify keeps on disk: config, caches, drafts and exports. Spotify-side access must be removed by the user at https://www.spotify.com/account/apps/ (the tool says so). Refused while a draft is building. Ask the user before purging.',
      inputSchema: z.object({ purge: z.boolean().optional().describe('Also delete the whole ~/.lineupify data folder') }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    guard(disconnect),
  );

  server.registerTool(
    'parse_lineup',
    {
      title: 'Parse lineup text',
      description:
        'Turn raw poster text (as read from an image or pasted) into a clean artist list with tiers, days and stages, dropping dates, stage names and "tickets" lines. Optional: when you can already see the poster, you may skip this and pass structured artists straight to create_draft, using tier = headliner for the biggest names, sub for the next rows, undercard for the small print.',
      inputSchema: z.object({ text: z.string().min(1).max(20_000) }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guard(parseLineup),
  );

  server.registerTool(
    'create_draft',
    {
      title: 'Create playlist draft',
      description:
        'Build a draft playlist from artists and/or seeds. Works with a Spotify login (publishable) or with provider "deezer" and no account at all (export the list instead of publishing). Artists: a typed list (festival lineup, "these five bands"). Seeds: genre/mood words, similar_to an artist, chart, country, a playlist, the user\'s taste, or a blend of several people\'s playlists. For a free-text request ("rainy Sunday jazz for cooking", "90s hip hop for a run") propose 15-30 fitting artists yourself and pass them as artists, and add a genre seed with the same words so the list is not only your guess. Each artist gets its most popular songs (Deezer/Last.fm ranking, matched to Spotify by ISRC); constraints: tracksPerArtist, maxDurationMin, excludeExplicit, yearRange, bpmRange, skipCovers, excludeTracksFrom. Returns within ~15 s; larger builds continue in the background (status "building") — poll with get_draft waitSeconds: 25. Nothing is written to Spotify until create_playlist. Defaults: headliner 5, sub 3, undercard 2 tracks (flat artists 3), max 250 tracks, interleaved order, private playlist, live/remix versions skipped.',
      inputSchema: z.object({
        lineup: z.string().max(80).optional().describe('Festival name and year, or a short theme, used for the playlist name, e.g. "Glastonbury 2026" or "Rainy Sunday jazz"'),
        name: z.string().max(100).optional().describe('Playlist name; default "<lineup> · Lineupify"'),
        description: z.string().max(300).optional(),
        artists: z.array(artistSchema).max(400).optional().describe('Required unless seeds are given'),
        seeds: z.array(seedSchema).max(8).optional(),
        ...buildOptionSchemas,
        stopIfUnresolved: z.boolean().optional().describe('Off by default. When true, create_playlist refuses until every artist is found or excluded, so the user can fix names first'),
        days: z.array(z.string()).optional().describe('Keep only artists tagged with these days'),
        sources: z.array(SOURCE).optional(),
        excludeTracksFrom: z.array(PLAYLIST_REF).max(8).optional().describe('Never pick tracks that are in these playlists / "library" (e.g. "songs I do not already have")'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, ...net },
    },
    guard(createDraft),
  );

  server.registerTool(
    'read_playlist',
    {
      title: 'Read a playlist',
      description:
        'Read any playlist into a structured list: a Spotify or Deezer link, a playlist name from the user\'s own library, a draft id, or "library" (liked songs). Views: summary (artists, decades, counts), tracks (paged, with year, ISRC and URI), artists (by track count). Cached for 12 hours; refresh: true re-reads. Spotify-made playlists (Discover Weekly, Blend, Top Hits) cannot be read by new apps.',
      inputSchema: z.object({
        playlist: PLAYLIST_REF,
        view: z.enum(['summary', 'tracks', 'artists']).optional(),
        offset: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(100).optional().describe('default 50'),
        refresh: z.boolean().optional(),
      }),
      annotations: { readOnlyHint: true, ...net },
    },
    guard(readPlaylistTool),
  );

  server.registerTool(
    'analyze_playlist',
    {
      title: 'Analyze a playlist',
      description:
        'Numbers about a playlist (or "library" / a draft): length, artist concentration, decade spread, explicit share, coarse genres (Deezer) and Last.fm tags when a key is set, tempo distribution (Deezer, sampled). Returns plain data lines; render them as a table or chart. Takes up to ~20 s on a large playlist the first time; results are cached.',
      inputSchema: z.object({
        playlist: PLAYLIST_REF,
        genres: z.boolean().optional().describe('default true'),
        tempo: z.boolean().optional().describe('default true'),
        refresh: z.boolean().optional(),
      }),
      annotations: { readOnlyHint: true, ...net },
    },
    guard(analyzePlaylistTool),
  );

  server.registerTool(
    'compare_playlists',
    {
      title: 'Compare playlists or people',
      description:
        'Compare 2-4 sides — playlists (links or names), drafts, "library", or "me" (the user\'s top and followed artists): artists and identical tracks shared by all, pairwise overlap, and what is distinct to each side. Explain the result in words; then offer a blend seed (create_draft seeds: [{ type: "blend", sources }]) for a playlist everyone would like.',
      inputSchema: z.object({ sources: z.array(PLAYLIST_REF).min(2).max(4) }),
      annotations: { readOnlyHint: true, ...net },
    },
    guard(comparePlaylistsTool),
  );

  server.registerTool(
    'merge_playlists',
    {
      title: 'Merge playlists',
      description:
        'Combine 1-6 Spotify playlists (links or names), drafts or "library" into one ready draft, keeping the actual tracks and removing duplicates (same URI, ISRC or title+artist). Then create_playlist to publish. For "add more songs by these artists" use expand_playlist instead.',
      inputSchema: z.object({
        playlists: z.array(PLAYLIST_REF).min(1).max(6),
        name: z.string().max(100).optional(),
        description: z.string().max(300).optional(),
        order: ORDER.optional().describe('default lineup (playlist after playlist); interleave or shuffle to mix them'),
        excludeExplicit: z.boolean().optional(),
        maxTracks: z.number().int().min(1).max(10_000).optional(),
        public: z.boolean().optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, ...net },
    },
    guard(mergePlaylistsTool),
  );

  server.registerTool(
    'expand_playlist',
    {
      title: 'Expand a playlist',
      description:
        'Build a draft of more songs by the artists of an existing playlist (default 2 per artist, the 30 most frequent artists), excluding tracks the playlist already has. Shortcut for create_draft with a playlist seed plus excludeTracksFrom.',
      inputSchema: z.object({
        playlist: PLAYLIST_REF,
        limitArtists: z.number().int().min(1).max(100).optional().describe('default 30'),
        excludeExisting: z.boolean().optional().describe('default true'),
        name: z.string().max(100).optional(),
        ...buildOptionSchemas,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, ...net },
    },
    guard(expandPlaylistTool),
  );

  server.registerTool(
    'refresh_taste',
    {
      title: 'New songs from your favourite artists',
      description:
        "Build a draft from the user's own top and followed artists (default 2 songs each, 30 artists), skipping everything already in their liked songs. Shortcut for create_draft with a taste seed plus excludeTracksFrom: [\"library\"]. Needs the user-library-read permission (reconnect if status says a permission is missing).",
      inputSchema: z.object({
        limitArtists: z.number().int().min(1).max(100).optional().describe('default 30'),
        excludeLibrary: z.boolean().optional().describe('default true'),
        excludePlaylists: z.array(PLAYLIST_REF).max(6).optional().describe('Also skip tracks in these playlists'),
        name: z.string().max(100).optional(),
        ...buildOptionSchemas,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, ...net },
    },
    guard(refreshTasteTool),
  );

  server.registerTool(
    'get_draft',
    {
      title: 'Read draft',
      description:
        'Show a draft: summary (default), tracks (paged, with stable ids for editing), artists (status per artist), or unresolved (artists that could not be found or matched with low confidence). While a draft is building, pass waitSeconds (max 25) to wait for progress. Omit draftId for the most recent draft. Also resumes an interrupted build.',
      inputSchema: z.object({
        draftId: z.string().optional(),
        view: z.enum(['summary', 'tracks', 'artists', 'unresolved']).optional(),
        offset: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(100).optional().describe('default 50'),
        waitSeconds: z.number().int().min(0).max(25).optional(),
      }),
      annotations: { readOnlyHint: true, ...net },
    },
    guard(getDraftTool),
  );

  server.registerTool(
    'edit_draft',
    {
      title: 'Edit draft',
      description:
        'Apply one or more edits atomically: remove_tracks (by id from get_draft view=tracks), add_track (URI, URL or "Artist - Title"), exclude_artist, set_artist_track_count, set_artist_source (fix a wrong artist match), move, shuffle, reorder, set_meta (name/description/public), filter (explicit/versions), undo. Pass expectedRevision from the last get_draft so edits never apply to a list the user has not seen. While the draft is still building only exclude_artist, set_artist_track_count, set_artist_source, filter and set_meta are allowed.',
      inputSchema: z.object({
        draftId: z.string(),
        expectedRevision: z.number().int().optional(),
        ops: z.array(editOpSchema).min(1).max(50),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, ...net },
    },
    guard(editDraft),
  );

  server.registerTool(
    'search_tracks',
    {
      title: 'Search Spotify tracks',
      description: 'Search Spotify (or Deezer, for a Deezer draft or when Spotify is not connected) for a track to add manually. Supports filters like "track:Marea artist:Fred again". Returns URIs for edit_draft add_track.',
      inputSchema: z.object({ query: z.string().min(1).max(120), limit: z.number().int().min(1).max(10).optional(), provider: PROVIDER.optional().describe('Match the draft you will add to') }),
      annotations: { readOnlyHint: true, ...net },
    },
    guard(searchTracks),
  );

  server.registerTool(
    'create_playlist',
    {
      title: 'Create Spotify playlist',
      description:
        'Publish a ready draft as a new playlist in the connected Spotify account and return its URL. Requires that the draft was shown to the user (get_draft) or confirm: true. Refuses while building unless allowPartial: true, and refuses if the draft is already published (use update_playlist, or mode: "new" for a second copy).',
      inputSchema: z.object({
        draftId: z.string(),
        confirm: z.boolean().optional(),
        allowPartial: z.boolean().optional(),
        mode: z.enum(['new']).optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, ...net },
    },
    guard(createPlaylist),
  );

  server.registerTool(
    'update_playlist',
    {
      title: 'Update Spotify playlist',
      description:
        'Replace the tracks and details of the playlist this draft was published to, so edits made with edit_draft reach Spotify. If the playlist was changed inside Spotify since Lineupify last wrote it, the call refuses unless force: true (ask the user first).',
      inputSchema: z.object({ draftId: z.string(), force: z.boolean().optional() }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, ...net },
    },
    guard(updatePlaylist),
  );

  server.registerTool(
    'compare_taste',
    {
      title: 'Compare lineup to listening history',
      description:
        "Mark each artist in a draft as known (in the user's top artists over the last 4 weeks / 6 months / all time, or followed) or new to them. Optional reorderKnownFirst puts familiar artists first. Good for 'which of these acts do I already like?' and 'is this festival for me?'",
      inputSchema: z.object({ draftId: z.string(), reorderKnownFirst: z.boolean().optional() }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, ...net },
    },
    guard(compareTasteTool),
  );

  server.registerTool(
    'export_draft',
    {
      title: 'Export draft',
      description: 'Return the draft as markdown, CSV, M3U, or links (one track URL per line, the format playlist transfer tools accept) for sharing or for taking a Deezer draft into any service. With save: true the file is written under ~/.lineupify/exports/ (never elsewhere).',
      inputSchema: z.object({ draftId: z.string(), format: z.enum(['markdown', 'csv', 'm3u', 'links']).optional(), save: z.boolean().optional(), overwrite: z.boolean().optional() }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    guard(exportDraft),
  );

  server.registerTool(
    'list_drafts',
    { title: 'List drafts', description: 'List saved drafts, newest first, with status and whether they were published.', inputSchema: z.object({}), annotations: { readOnlyHint: true, openWorldHint: false } },
    guard(listDraftsTool),
  );

  server.registerTool(
    'delete_draft',
    { title: 'Delete draft', description: 'Delete a draft from disk. The Spotify playlist, if published, is not touched.', inputSchema: z.object({ draftId: z.string() }), annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false } },
    guard(deleteDraftTool),
  );

  return server;
}

function installStdoutGuard(): void {
  const realWrite = process.stdout.write.bind(process.stdout) as typeof process.stdout.write;
  const guarded: typeof process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
    const s = typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : '';
    const first = s.trimStart()[0];
    if (first === '{' || first === '[' || s === '' || s === '\n') {
      return (realWrite as (c: unknown, ...r: unknown[]) => boolean)(chunk, ...rest);
    }
    process.stderr.write(`[stdout-redirected] ${s}`);
    const cb = rest.find((r) => typeof r === 'function') as ((err?: Error) => void) | undefined;
    cb?.();
    return true;
  }) as typeof process.stdout.write;
  process.stdout.write = guarded;
}

export async function serve(): Promise<void> {
  installStdoutGuard();
  await ensureDirs();
  void pruneDrafts().catch(() => undefined);

  let shuttingDown = false;
  const shutdown = async (why: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`shutting down (${why})`);
    try {
      await Promise.race([abortAllJobs(), new Promise((r) => setTimeout(r, 3000))]);
      await flushAllCaches();
    } finally {
      process.exit(0);
    }
  };
  process.stdin.on('end', () => void shutdown('stdin end'));
  process.stdin.on('close', () => void shutdown('stdin close'));
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(sig, () => void shutdown(sig));

  serveStdio(() => buildServer(), { onerror: (err) => log.error('mcp transport error', String(err)) });
  log.info(`lineupify ${VERSION} serving on stdio`);
}
