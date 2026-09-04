/** parse_lineup, create_draft, get_draft, edit_draft, list_drafts, delete_draft, export_draft */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { DraftOptions, LineupArtist, OrderMode, SeedSpec, SourceName, Tier } from '../types.js';
import { DEFAULT_SEED_LIMIT, MAX_SEED_LIMIT } from '../engine/seeds.js';
import { LineupifyError } from '../types.js';
import { resolveSettings } from '../infra/config.js';
import { paths, safeFileName } from '../infra/store.js';
import { sleep } from '../infra/http.js';
import { clean, fmtDuration, nowIso } from '../infra/text.js';
import { parseLineupText } from '../engine/lineup.js';
import { applyEdits, deleteDraft, listDrafts, newDraft, saveDraft, totalDurationMs, type EditOp } from '../engine/draft.js';
import { isRunning, startJob, waitForJob } from '../engine/jobs.js';
import { lookupTrack } from '../engine/match.js';
import { artistsView, summary, tracksView, unresolvedView } from '../engine/render.js';
import { fold } from '../engine/normalize.js';
import * as spotify from '../sources/spotify.js';
import { clampInt, connectedName, ensureNotLockedElsewhere, getDraft, maybeResume, persist, text } from './shared.js';

export async function parseLineup(args: { text: string }) {
  const parsed = parseLineupText(args.text);
  const lines: string[] = [];
  lines.push(`Parsed ${parsed.artists.length} artists${parsed.tiered ? ' with tiers' : ' (no tiers detected: pass tier per artist if the poster shows one)'}${parsed.days.length ? ` · days: ${parsed.days.join(', ')}` : ''}${parsed.stages.length ? ` · stages: ${parsed.stages.map((s) => clean(s, 20)).join(', ')}` : ''}`);
  for (const a of parsed.artists) {
    lines.push(`- ${clean(a.name, 50)}${a.tier ? `  [${a.tier}]` : ''}${a.day ? `  ${a.day}` : ''}${a.stage ? `  @${clean(a.stage, 20)}` : ''}`);
  }
  if (parsed.discarded.length) lines.push(`Ignored as headers/furniture: ${parsed.discarded.slice(0, 15).map((d) => clean(d, 25)).join(' | ')}${parsed.discarded.length > 15 ? ' …' : ''}`);
  lines.push('Next: review the list (fix tiers or names if the poster says otherwise), then call create_draft with these artists.');
  return text(lines.join('\n'));
}

export interface CreateDraftArgs {
  lineup?: string;
  name?: string;
  description?: string;
  /** Optional when seeds are given. */
  artists?: (string | LineupArtist)[];
  seeds?: SeedSpec[];
  tracksPerTier?: Partial<{ headliner: number; sub: number; undercard: number }>;
  tracksPerArtist?: number;
  maxTracks?: number;
  maxDurationMin?: number;
  order?: OrderMode;
  excludeArtists?: string[];
  excludeExplicit?: boolean;
  allowVersions?: boolean;
  discoveryOnly?: boolean;
  stopIfUnresolved?: boolean;
  days?: string[];
  public?: boolean;
  sources?: SourceName[];
  yearRange?: { from?: number; to?: number };
  strictYear?: boolean;
  bpmRange?: { min?: number; max?: number };
  strictBpm?: boolean;
  skipCovers?: boolean;
  excludeTracksFrom?: string[];
}

const SEED_TYPES: SeedSpec['type'][] = ['genre', 'similar_to', 'chart', 'country', 'playlist', 'taste', 'blend'];
const MAX_SEEDS = 8;

function cleanSeeds(raw: SeedSpec[] | undefined): SeedSpec[] {
  const out: SeedSpec[] = [];
  for (const s of raw ?? []) {
    if (!s || !SEED_TYPES.includes(s.type)) throw new LineupifyError('BAD_SEED', `Unknown seed type "${String((s as { type?: unknown })?.type)}".`, `Use one of ${SEED_TYPES.join(', ')}.`);
    const seed: SeedSpec = { type: s.type };
    if (s.value !== undefined) seed.value = clean(s.value, 120);
    if (s.sources) seed.sources = s.sources.map((x) => clean(x, 200)).filter(Boolean).slice(0, 4);
    if (s.minShared !== undefined) seed.minShared = clampInt(s.minShared, 2, 4, 2);
    if (s.limit !== undefined) seed.limit = clampInt(s.limit, 1, MAX_SEED_LIMIT, DEFAULT_SEED_LIMIT);
    if (s.tier && ['headliner', 'sub', 'undercard', 'flat'].includes(s.tier)) seed.tier = s.tier;
    if (['genre', 'similar_to', 'country', 'playlist'].includes(seed.type) && !seed.value) throw new LineupifyError('SEED_VALUE_REQUIRED', `A ${seed.type} seed needs a value.`);
    if (seed.type === 'blend' && (seed.sources?.length ?? 0) < 2) throw new LineupifyError('BLEND_NEEDS_SOURCES', 'A blend seed needs 2 to 4 sources (playlist links, draft ids or "me").');
    out.push(seed);
  }
  if (out.length > MAX_SEEDS) throw new LineupifyError('TOO_MANY_SEEDS', `${out.length} seeds is more than the ${MAX_SEEDS} allowed.`);
  return out;
}

function defaultNameFor(seeds: SeedSpec[]): string {
  const s = seeds[0];
  if (!s) return 'Festival lineup';
  const cap = (x: string) => x.replace(/\b\w/g, (c) => c.toUpperCase());
  switch (s.type) {
    case 'genre':
      return cap(s.value ?? 'Mix');
    case 'similar_to':
      return `Like ${s.value ?? ''}`.trim();
    case 'chart':
      return 'Top charts';
    case 'country':
      return `Top ${cap(s.value ?? '')}`.trim();
    case 'playlist':
      return 'More like my playlist';
    case 'taste':
      return 'Fresh from your favourites';
    case 'blend':
      return 'Blend';
    default:
      return 'Mix';
  }
}

function yearRangeOf(r: { from?: number; to?: number } | undefined): { from?: number; to?: number } | undefined {
  if (!r) return undefined;
  const from = r.from !== undefined ? clampInt(r.from, 1900, 2100, 1900) : undefined;
  const to = r.to !== undefined ? clampInt(r.to, 1900, 2100, 2100) : undefined;
  if (from === undefined && to === undefined) return undefined;
  if (from !== undefined && to !== undefined && from > to) throw new LineupifyError('BAD_YEAR_RANGE', `yearRange.from (${from}) is after yearRange.to (${to}).`);
  return { from, to };
}

function bpmRangeOf(r: { min?: number; max?: number } | undefined): { min?: number; max?: number } | undefined {
  if (!r) return undefined;
  const min = r.min !== undefined ? clampInt(r.min, 30, 300, 30) : undefined;
  const max = r.max !== undefined ? clampInt(r.max, 30, 300, 300) : undefined;
  if (min === undefined && max === undefined) return undefined;
  if (min !== undefined && max !== undefined && min > max) throw new LineupifyError('BAD_BPM_RANGE', `bpmRange.min (${min}) is above bpmRange.max (${max}).`);
  return { min, max };
}

export async function createDraft(args: CreateDraftArgs) {
  const tokens = await spotify.loadTokens();
  if (!tokens) throw new LineupifyError('SPOTIFY_NOT_CONNECTED', 'No Spotify account connected.', 'Call status for setup steps, then connect.');
  const age = spotify.refreshTokenAge(tokens);
  if (age.daysLeft <= 0) throw new LineupifyError('TOKEN_EXPIRED_RECONNECT', 'The Spotify refresh token is older than 6 months.', 'Call connect with force: true.');
  const settings = await resolveSettings();

  const artists: LineupArtist[] = [];
  const seen = new Set<string>();
  for (const raw of args.artists ?? []) {
    const a: LineupArtist = typeof raw === 'string' ? { name: raw } : { ...raw };
    a.name = clean(a.name, 80);
    if (!a.name) continue;
    if (a.tier && !['headliner', 'sub', 'undercard', 'flat'].includes(a.tier)) delete a.tier;
    if (a.day) a.day = clean(a.day, 20).toLowerCase();
    if (a.stage) a.stage = clean(a.stage, 40);
    const k = fold(a.name);
    if (seen.has(k)) continue;
    seen.add(k);
    artists.push(a);
  }
  const seeds = cleanSeeds(args.seeds);
  if (!artists.length && !seeds.length) throw new LineupifyError('NO_ARTISTS', 'No artists or seeds given.', 'Pass at least one artist name, or a seed such as { type: "similar_to", value: "Khruangbin" }.');
  if (artists.length > 400) throw new LineupifyError('TOO_MANY_ARTISTS', `${artists.length} artists is more than the 400 limit.`, 'Split the lineup by day and create one draft per day.');

  let filtered = artists;
  if (args.days?.length) {
    const want = new Set(args.days.map((d) => d.toLowerCase()));
    filtered = artists.filter((a) => !a.day || want.has(a.day));
  }

  const d = settings.defaults;
  const excludeTracksFrom = (args.excludeTracksFrom ?? []).map((x) => clean(x, 200)).filter(Boolean).slice(0, 8);
  const options: DraftOptions = {
    tracksPerTier: { ...d.tracksPerTier, ...(args.tracksPerTier ?? {}) },
    tracksPerArtist: args.tracksPerArtist ?? d.tracksPerArtist,
    maxTracks: clampInt(args.maxTracks, 1, 10_000, d.maxTracks),
    maxDurationMin: args.maxDurationMin ?? d.maxDurationMin,
    order: args.order ?? d.order,
    excludeArtists: [...(d.excludeArtists ?? []), ...(args.excludeArtists ?? [])],
    excludeExplicit: args.excludeExplicit ?? d.excludeExplicit,
    allowVersions: args.allowVersions ?? d.allowVersions,
    discoveryOnly: args.discoveryOnly ?? d.discoveryOnly,
    stopIfUnresolved: args.stopIfUnresolved ?? d.stopIfUnresolved,
    days: args.days,
    public: args.public ?? d.public,
    sources: args.sources?.length ? args.sources : d.sources,
    yearRange: yearRangeOf(args.yearRange),
    strictYear: args.strictYear || undefined,
    bpmRange: bpmRangeOf(args.bpmRange),
    strictBpm: args.strictBpm || undefined,
    skipCovers: (args.skipCovers ?? d.skipCovers) || undefined,
    excludeTracksFrom: excludeTracksFrom.length ? excludeTracksFrom : undefined,
  };

  const lineupName = clean(args.lineup ?? '', 60) || defaultNameFor(seeds);
  const name = clean(args.name ?? '', 100) || settings.namingTemplate.replace('{lineup}', lineupName).slice(0, 100);
  const draft = newDraft({ name, artists: filtered, options, spotifyUserId: tokens.userId, description: clean(args.description ?? '', 300), seeds });

  await saveDraft(draft);
  await startJob(draft.id, { lastfmApiKey: settings.lastfmApiKey }, draft);
  await waitForJob(draft.id, 15_000);
  const fresh = await getDraft(draft.id);
  return text(summary(fresh, { connectedAs: connectedName(tokens) }));
}

export async function getDraftTool(args: { draftId?: string; view?: 'summary' | 'tracks' | 'artists' | 'unresolved'; offset?: number; limit?: number; waitSeconds?: number }) {
  const id = args.draftId ?? (await listDrafts())[0]?.id;
  if (!id) throw new LineupifyError('NO_DRAFTS', 'There are no drafts yet.', 'Call create_draft first.');
  let d = await getDraft(id);
  await maybeResume(d);
  const wait = clampInt(args.waitSeconds, 0, 25, 0);
  if (wait && d.status === 'building') {
    const deadline = Date.now() + wait * 1000;
    while (Date.now() < deadline) {
      if (isRunning(id)) {
        await waitForJob(id, deadline - Date.now());
        d = await getDraft(id);
        if (d.status !== 'building') break;
        continue;
      }
      // Built by another process (or a stale lock from a killed one): watch the file and retry the resume.
      await sleep(Math.min(2000, Math.max(0, deadline - Date.now())));
      d = await getDraft(id);
      if (d.status !== 'building') break;
      await maybeResume(d);
    }
    d = await getDraft(id);
  }
  const tokens = await spotify.loadTokens();
  const view = args.view ?? 'summary';
  const offset = clampInt(args.offset, 0, 100_000, 0);
  const limit = clampInt(args.limit, 1, 100, 50);
  if (view === 'summary') return text(summary(d, { connectedAs: connectedName(tokens) }));
  if (d.status !== 'building') {
    d.viewedAt = nowIso();
    await persist(d, false);
  }
  const head = `Draft ${d.id} "${clean(d.name, 60)}" rev ${d.revision} status ${d.status}`;
  if (view === 'tracks') return text(`${head}\n${tracksView(d, offset, limit)}`);
  if (view === 'artists') return text(`${head}\n${artistsView(d, offset, limit)}`);
  return text(`${head}\n${unresolvedView(d)}`);
}

export async function editDraft(args: { draftId: string; expectedRevision?: number; ops: EditOp[] }) {
  await ensureNotLockedElsewhere(args.draftId);
  const d = await getDraft(args.draftId);
  if (args.expectedRevision !== undefined && args.expectedRevision !== d.revision) {
    throw new LineupifyError('STALE_REVISION', `Draft is at revision ${d.revision}, you expected ${args.expectedRevision}.`, `Re-read with get_draft and retry with expectedRevision: ${d.revision}.`);
  }
  if (!args.ops.length) throw new LineupifyError('NO_OPS', 'ops is empty.');
  const previous = structuredClone(d);
  const outcome = await applyEdits(d, args.ops, { lookupTrack: (s) => lookupTrack(s) });
  const result = outcome.draft;
  if (outcome.undone) {
    await saveDraft(result);
  } else {
    await persist(result, true, previous);
  }
  if (outcome.rebuildArtists.length) {
    const settings = await resolveSettings();
    result.status = 'building';
    await persist(result, false);
    await startJob(result.id, { lastfmApiKey: settings.lastfmApiKey }, result);
    await waitForJob(result.id, 10_000);
  }
  const latest = await getDraft(result.id);
  const lines = [`Applied ${outcome.diff.length} change${outcome.diff.length === 1 ? '' : 's'} (rev ${latest.revision}):`, ...outcome.diff.map((l) => `- ${clean(l, 160)}`), '', summary(latest)];
  return text(lines.join('\n'));
}

export async function listDraftsTool() {
  const drafts = await listDrafts();
  if (!drafts.length) return text('No drafts. Next: create_draft.');
  const lines = [`${drafts.length} draft${drafts.length === 1 ? '' : 's'} (newest first). Columns: id  status  tracks  length  name  published`];
  for (const d of drafts.slice(0, 30)) {
    lines.push(`${d.id}  ${d.status}${d.status === 'building' ? ` ${d.progress.done}/${d.progress.total}` : ''}  ${d.tracks.length}  ${fmtDuration(totalDurationMs(d))}  "${clean(d.name, 50)}"  ${d.playlistId ? 'yes' : '-'}  ${d.updatedAt.slice(0, 10)}`);
  }
  return text(lines.join('\n'));
}

export async function deleteDraftTool(args: { draftId: string }) {
  if (isRunning(args.draftId)) throw new LineupifyError('JOB_RUNNING', 'This draft is building; wait until it is ready before deleting.');
  const ok = await deleteDraft(args.draftId);
  return text(ok ? `Deleted draft ${args.draftId} (the Spotify playlist, if any, is untouched).` : `No draft ${args.draftId}.`);
}

export async function exportDraft(args: { draftId: string; format?: 'markdown' | 'csv' | 'm3u'; save?: boolean; overwrite?: boolean }) {
  const d = await getDraft(args.draftId);
  const fmt = args.format ?? 'markdown';
  const artistName = new Map(d.artists.map((a) => [a.key, a.name]));
  let body = '';
  if (fmt === 'csv') {
    const esc = (s: unknown) => `"${String(s ?? '').replace(/"/g, '""')}"`;
    body = [
      'position,artist,title,all_artists,album,year,duration_seconds,explicit,bpm,isrc,spotify_uri,spotify_url',
      ...d.tracks.map((t, i) => [i + 1, artistName.get(t.artistKey) ?? t.artists[0], t.name, t.artists.join('; '), t.album ?? '', t.year ?? '', Math.round(t.durationMs / 1000), t.explicit, t.bpm ? Math.round(t.bpm) : '', t.isrc ?? '', t.uri, `https://open.spotify.com/track/${t.spotifyId}`].map(esc).join(',')),
    ].join('\n');
  } else if (fmt === 'm3u') {
    body = ['#EXTM3U', ...d.tracks.flatMap((t) => [`#EXTINF:${Math.round(t.durationMs / 1000)},${artistName.get(t.artistKey) ?? t.artists[0]} - ${t.name}`, `https://open.spotify.com/track/${t.spotifyId}`])].join('\n');
  } else {
    body = [`# ${d.name}`, '', `${d.tracks.length} tracks · ${fmtDuration(totalDurationMs(d))}`, '', ...d.tracks.map((t, i) => `${i + 1}. **${artistName.get(t.artistKey) ?? t.artists[0]}** – ${t.name}${t.album ? ` _(${t.album})_` : ''} · ${fmtDuration(t.durationMs)}`)].join('\n');
  }
  if (!args.save) return text(body.length > 60_000 ? body.slice(0, 60_000) + '\n… truncated; use save: true for the full file' : body);
  const ext = fmt === 'markdown' ? 'md' : fmt;
  const file = path.join(paths.exportsDir(), `${safeFileName(d.name, d.id)}.${ext}`);
  await fs.mkdir(paths.exportsDir(), { recursive: true });
  const exists = await fs.stat(file).then(() => true, () => false);
  if (exists && !args.overwrite) throw new LineupifyError('FILE_EXISTS', `${file} already exists.`, 'Pass overwrite: true to replace it.');
  await fs.writeFile(file, body, 'utf8');
  return text(`Saved ${d.tracks.length} tracks to ${file}`);
}

export function tierList(): Tier[] {
  return ['headliner', 'sub', 'undercard', 'flat'];
}
