/** read_playlist, analyze_playlist, compare_playlists, merge_playlists, expand_playlist, refresh_taste */
import type { Draft, DraftArtist, DraftOptions, DraftTrack, OrderMode, PlaylistTrack } from '../types.js';
import { LineupifyError } from '../types.js';
import { resolveSettings } from '../infra/config.js';
import { clean, fmtDuration } from '../infra/text.js';
import { artistKeyFor, makeDraftId, makeTrackId, saveDraft, applyOrder } from '../engine/draft.js';
import { fold } from '../engine/normalize.js';
import { parsePlaylistRef, readPlaylist, refLabel, resolveSource, type PlaylistRef } from '../engine/playlists.js';
import { basicStats, enrichStats, renderStats } from '../engine/analyze.js';
import { compareSides, renderComparison, trackIdentity } from '../engine/compare.js';
import { summary } from '../engine/render.js';
import { songKey } from '../engine/select.js';
import * as spotify from '../sources/spotify.js';
import { clampInt, connectedName, text } from './shared.js';
import { createDraft, type CreateDraftArgs } from './drafts.js';

function requireTrackRef(input: string): PlaylistRef {
  const ref = parsePlaylistRef(input);
  if (ref.kind === 'me') throw new LineupifyError('NOT_A_PLAYLIST', '"me" is a listening profile, not a track list.', 'Use "library" for your liked songs, or a playlist link.');
  return ref;
}

export async function readPlaylistTool(args: { playlist: string; view?: 'summary' | 'tracks' | 'artists'; offset?: number; limit?: number; refresh?: boolean }) {
  const ref = requireTrackRef(clean(args.playlist, 200));
  const snap = await readPlaylist(ref, { refresh: args.refresh });
  const view = args.view ?? 'summary';
  const offset = clampInt(args.offset, 0, 100_000, 0);
  const limit = clampInt(args.limit, 1, 100, 50);
  const total = snap.tracks.reduce((s, t) => s + t.durationMs, 0);
  const head = `Playlist "${clean(snap.name, 60)}" by ${clean(snap.owner, 30)} (${snap.source}) · ${snap.tracks.length}${snap.truncated ? ` of ${snap.total}` : ''} tracks · ${fmtDuration(total)} · ${snap.public === false ? 'private' : 'public'}${snap.url ? ` · ${snap.url}` : ''}${snap.truncated ? ' · truncated at the read cap' : ''}`;
  if (view === 'summary') {
    const stats = basicStats(snap.tracks);
    const lines = [head];
    if (snap.description) lines.push(`Description: ${clean(snap.description, 160)}`);
    lines.push(`Artists (${stats.artistCount}): ${stats.artists.slice(0, 15).map((a) => `${clean(a.name, 25)} ${a.count}`).join(' · ')}`);
    if (stats.decades.length) lines.push(`Decades: ${stats.decades.map((d) => `${d.label} ${d.count}`).join(' · ')}`);
    lines.push(`Explicit ${stats.explicit} · with ISRC ${snap.tracks.filter((t) => t.isrc).length}`);
    lines.push('Next: read_playlist view=tracks for the list, analyze_playlist for genres and tempo, compare_playlists to compare with another, or create_draft with a playlist seed / expand_playlist to build on it.');
    return text(lines.join('\n'));
  }
  if (view === 'artists') {
    const stats = basicStats(snap.tracks);
    const slice = stats.artists.slice(offset, offset + limit);
    const lines = [head, `Artists ${offset + 1}-${offset + slice.length} of ${stats.artists.length}. Columns: artist  tracks`];
    for (const a of slice) lines.push(`${clean(a.name, 40)}  ${a.count}`);
    if (offset + slice.length < stats.artists.length) lines.push(`… ${stats.artists.length - offset - slice.length} more: read_playlist view=artists offset=${offset + slice.length}`);
    return text(lines.join('\n'));
  }
  const slice = snap.tracks.slice(offset, offset + limit);
  const lines = [head, `Tracks ${offset + 1}-${offset + slice.length} of ${snap.tracks.length}. Columns: #  artist – title  length  year  isrc  uri`];
  slice.forEach((t, i) => {
    lines.push(`#${offset + i + 1}  ${clean(t.artists.join(', '), 40)} – ${clean(t.name, 50)}  ${fmtDuration(t.durationMs)}  ${t.year ?? '-'}  ${t.isrc ?? '-'}  ${t.uri ?? (t.deezerTrackId ? `deezer:track:${t.deezerTrackId}` : '-')}${t.explicit ? ' [E]' : ''}`);
  });
  if (offset + slice.length < snap.tracks.length) lines.push(`… ${snap.tracks.length - offset - slice.length} more: read_playlist view=tracks offset=${offset + slice.length}`);
  return text(lines.join('\n'));
}

export async function analyzePlaylistTool(args: { playlist: string; genres?: boolean; tempo?: boolean; refresh?: boolean }) {
  const ref = requireTrackRef(clean(args.playlist, 200));
  const snap = await readPlaylist(ref, { refresh: args.refresh });
  if (!snap.tracks.length) throw new LineupifyError('PLAYLIST_EMPTY', `"${clean(snap.name, 60)}" has no readable tracks.`);
  const settings = await resolveSettings();
  const stats = await enrichStats(basicStats(snap.tracks), snap.tracks, { lastfmApiKey: settings.lastfmApiKey, genres: args.genres !== false, bpm: args.tempo !== false });
  const lines = [renderStats(stats, snap.name)];
  if (snap.truncated) lines.push(`Note: only the first ${snap.tracks.length} of ${snap.total} tracks were read.`);
  lines.push('Numbers only; render them as a table or chart in the client. Next: compare_playlists, or create_draft with a playlist / blend seed.');
  return text(lines.join('\n'));
}

export async function comparePlaylistsTool(args: { sources: string[] }) {
  const inputs = (args.sources ?? []).map((s) => clean(s, 200)).filter(Boolean);
  if (inputs.length < 2) throw new LineupifyError('COMPARE_NEEDS_SOURCES', 'Pass 2 to 4 sources: playlist links, names, draft ids, "library" or "me".');
  if (inputs.length > 4) throw new LineupifyError('COMPARE_TOO_MANY', 'compare_playlists takes at most 4 sources.');
  const sides = [];
  for (const input of inputs) {
    const src = await resolveSource(input);
    sides.push({ label: src.label, tracks: src.tracks, artists: src.artists.map((a) => ({ name: a.name, weight: a.weight })) });
  }
  const c = compareSides(sides);
  const lines = [renderComparison(c)];
  lines.push('Next: create_draft with seeds: [{ type: "blend", sources: [...] }] for a playlist both would like, optionally excludeTracksFrom the same sources so nothing already owned is repeated.');
  return text(lines.join('\n'));
}

function dedupeTracks(lists: PlaylistTrack[][]): { tracks: PlaylistTrack[]; removed: number } {
  const seen = new Set<string>();
  const out: PlaylistTrack[] = [];
  let removed = 0;
  for (const list of lists) {
    for (const t of list) {
      const ids = trackIdentity(t);
      if (ids.some((id) => seen.has(id))) {
        removed++;
        continue;
      }
      for (const id of ids) seen.add(id);
      out.push(t);
    }
  }
  return { tracks: out, removed };
}

export async function mergePlaylistsTool(args: { playlists: string[]; name?: string; description?: string; order?: OrderMode; excludeExplicit?: boolean; maxTracks?: number; public?: boolean }) {
  const tokens = await spotify.loadTokens();
  if (!tokens) throw new LineupifyError('SPOTIFY_NOT_CONNECTED', 'No Spotify account connected.', 'Call status for setup steps, then connect.');
  const inputs = (args.playlists ?? []).map((s) => clean(s, 200)).filter(Boolean);
  if (inputs.length < 1) throw new LineupifyError('MERGE_NEEDS_PLAYLISTS', 'Pass 1 to 6 playlists (links, names, draft ids or "library").');
  if (inputs.length > 6) throw new LineupifyError('MERGE_TOO_MANY', 'merge_playlists takes at most 6 playlists.');
  const settings = await resolveSettings();
  const snaps = [];
  for (const input of inputs) {
    const ref = requireTrackRef(input);
    if (ref.kind === 'deezer') throw new LineupifyError('MERGE_DEEZER_UNSUPPORTED', `Deezer playlists cannot be merged directly (${input}).`, 'Use create_draft with a { type: "playlist" } seed for a Deezer playlist; merge works with Spotify playlists, drafts and "library".');
    snaps.push(await readPlaylist(ref));
  }
  const merged = dedupeTracks(snaps.map((s) => s.tracks.filter((t) => t.uri && (!args.excludeExplicit || !t.explicit))));
  const cap = clampInt(args.maxTracks, 1, 10_000, 10_000);
  const tracks = merged.tracks.slice(0, cap);
  if (!tracks.length) throw new LineupifyError('DRAFT_EMPTY', 'Nothing to merge: no Spotify tracks in these playlists.');

  const d = settings.defaults;
  const options: DraftOptions = { ...d, tracksPerTier: { ...d.tracksPerTier }, maxTracks: cap, order: args.order ?? 'lineup', excludeExplicit: !!args.excludeExplicit, public: args.public ?? d.public };
  const keys = new Set<string>();
  const artists: DraftArtist[] = [];
  const artistKey = new Map<string, string>();
  const ids = new Set<string>();
  const draftTracks: DraftTrack[] = [];
  for (const t of tracks) {
    const lead = t.artists[0] ?? 'Unknown';
    const f = fold(lead);
    let key = artistKey.get(f);
    if (!key) {
      key = artistKeyFor(lead, keys);
      keys.add(key);
      artistKey.set(f, key);
      artists.push({ key, name: lead, tier: 'flat', status: 'resolved', target: 0, resolved: { name: lead, source: 'user', confidence: 'high', spotifyArtistId: t.artistIds?.[0] }, spotifyArtistId: t.artistIds?.[0] });
    }
    const id = makeTrackId(t.uri!, ids);
    ids.add(id);
    draftTracks.push({ id, uri: t.uri!, spotifyId: t.spotifyId ?? t.uri!.split(':').pop()!, name: t.name, artists: t.artists, artistKey: key, durationMs: t.durationMs, explicit: t.explicit, isrc: t.isrc, album: t.album, matchedVia: 'manual', source: 'manual', role: 'lead', year: t.year });
  }
  for (const a of artists) a.target = draftTracks.filter((t) => t.artistKey === a.key).length;
  const now = new Date().toISOString();
  const name = clean(args.name ?? '', 100) || `${snaps.map((s) => s.name).filter(Boolean).slice(0, 3).join(' + ')} · Lineupify`.slice(0, 100);
  const draft: Draft = {
    id: makeDraftId(),
    name,
    description: clean(args.description ?? '', 300) || `Merged from ${snaps.length} playlist${snaps.length === 1 ? '' : 's'}. Built with Lineupify.`,
    public: options.public,
    createdAt: now,
    updatedAt: now,
    revision: 0,
    status: 'ready',
    progress: { done: artists.length, total: artists.length },
    spotifyUserId: tokens.userId,
    options,
    artists,
    tracks: draftTracks,
    rules: [],
    buildNotes: [`merged ${snaps.map((s) => `"${clean(s.name, 30)}" (${s.tracks.length})`).join(', ')}; ${merged.removed} duplicate${merged.removed === 1 ? '' : 's'} removed${merged.tracks.length > cap ? `; cut to ${cap}` : ''}`],
  };
  if (options.order !== 'lineup') applyOrder(draft, options.order);
  await saveDraft(draft);
  return text(summary(draft, { connectedAs: connectedName(tokens) }));
}

const COMMON_KEYS: (keyof CreateDraftArgs)[] = ['name', 'description', 'tracksPerArtist', 'maxTracks', 'maxDurationMin', 'order', 'excludeArtists', 'excludeExplicit', 'allowVersions', 'public', 'yearRange', 'strictYear', 'bpmRange', 'strictBpm', 'skipCovers', 'discoveryOnly'];

function pickCommon(args: Record<string, unknown>): Partial<CreateDraftArgs> {
  const out: Record<string, unknown> = {};
  for (const k of COMMON_KEYS) if (args[k] !== undefined) out[k] = args[k];
  return out as Partial<CreateDraftArgs>;
}

export type ExpandPlaylistArgs = Partial<CreateDraftArgs> & { playlist: string; limitArtists?: number; excludeExisting?: boolean };

export async function expandPlaylistTool(args: ExpandPlaylistArgs) {
  const playlist = clean(args.playlist, 200);
  const ref = requireTrackRef(playlist);
  // Read it now (cached for the seed) so the draft is named after the playlist's title, not its id.
  const label = await readPlaylist(ref)
    .then((s) => s.name || refLabel(ref))
    .catch(() => refLabel(ref));
  return createDraft({
    ...pickCommon(args as Record<string, unknown>),
    lineup: args.name ? undefined : `More like ${label.replace(/^"|"$/g, '')}`,
    seeds: [{ type: 'playlist', value: playlist, limit: clampInt(args.limitArtists, 1, MAX_ARTIST_LIMIT, 30) }],
    tracksPerArtist: args.tracksPerArtist ?? 2,
    excludeTracksFrom: args.excludeExisting === false ? undefined : [playlist],
  });
}

const MAX_ARTIST_LIMIT = 100;

export type RefreshTasteArgs = Partial<CreateDraftArgs> & { limitArtists?: number; excludeLibrary?: boolean; excludePlaylists?: string[] };

export async function refreshTasteTool(args: RefreshTasteArgs) {
  const exclude = [...(args.excludeLibrary === false ? [] : ['library']), ...(args.excludePlaylists ?? []).map((p) => clean(p, 200)).filter(Boolean)];
  return createDraft({
    ...pickCommon(args as Record<string, unknown>),
    lineup: args.name ? undefined : 'Fresh from your favourites',
    seeds: [{ type: 'taste', limit: clampInt(args.limitArtists, 1, MAX_ARTIST_LIMIT, 30) }],
    tracksPerArtist: args.tracksPerArtist ?? 2,
    excludeTracksFrom: exclude.length ? exclude : undefined,
  });
}

/** Exposed for tests: dedupe order and identity. */
export const _internal = { dedupeTracks, songKey };
