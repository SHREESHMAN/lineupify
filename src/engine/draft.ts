/**
 * Draft model: persistence with revisions, stable track ids, and the edit
 * operations. Long-running work (fetching more tracks) is delegated to the job
 * runner through `deps.requestRebuild`.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Draft, DraftArtist, DraftOptions, DraftTrack, LineupArtist, OrderMode, SeedSpec, SpotifyTrack, Tier } from '../types.js';
import { LineupifyError } from '../types.js';
import { paths, readJson, writeJsonAtomic } from '../infra/store.js';
import { nowIso, shortHash } from '../infra/text.js';
import { fold } from './normalize.js';
import { effectiveTier, orderTracks, targetFor } from './select.js';
import { artistCache } from '../infra/cache.js';

const MAX_REVISIONS = 10;

export function makeTrackId(uri: string, existing: Set<string>): string {
  let id = `t_${shortHash(uri)}`;
  let n = 0;
  while (existing.has(id)) id = `t_${shortHash(uri + String(++n))}`;
  return id;
}

export function makeDraftId(): string {
  return `d_${shortHash(String(Date.now()) + Math.random(), 5)}`;
}

export function artistKeyFor(name: string, existing: Set<string>): string {
  let key = fold(name) || name.toLowerCase();
  let n = 1;
  while (existing.has(key)) key = `${fold(name)}~${++n}`;
  return key;
}

export function makeSeedId(seed: SeedSpec, index: number): string {
  return `s_${shortHash(`${seed.type}:${seed.value ?? ''}:${(seed.sources ?? []).join(',')}:${index}`)}`;
}

export function newDraft(params: { name: string; artists: LineupArtist[]; options: DraftOptions; spotifyUserId: string; description?: string; seeds?: SeedSpec[] }): Draft {
  const anyTier = params.artists.some((a) => !!a.tier);
  const keys = new Set<string>();
  const excluded = new Set(params.options.excludeArtists.map(fold));
  const artists: DraftArtist[] = params.artists.map((a) => {
    const key = artistKeyFor(a.name, keys);
    keys.add(key);
    const tier: Tier = effectiveTier(a, anyTier);
    const isExcluded = excluded.has(fold(a.name));
    return {
      key,
      name: a.name.trim(),
      tier,
      day: a.day,
      stage: a.stage,
      status: isExcluded ? 'excluded' : 'pending',
      target: targetFor(tier, params.options),
    };
  });
  const now = nowIso();
  return {
    id: makeDraftId(),
    name: params.name,
    description: params.description ?? '',
    public: params.options.public,
    createdAt: now,
    updatedAt: now,
    revision: 0,
    status: 'building',
    progress: { done: 0, total: artists.filter((a) => a.status !== 'excluded').length },
    spotifyUserId: params.spotifyUserId,
    options: params.options,
    artists,
    tracks: [],
    rules: [],
    seeds: params.seeds?.length ? params.seeds.map((s, i) => ({ ...s, id: makeSeedId(s, i), status: 'pending' as const })) : undefined,
    excludeTracks: params.options.excludeTracksFrom?.length ? { uris: [], isrcs: [], songKeys: [], resolved: false } : undefined,
  };
}

/** True while the build has anything left to do: seeds to expand, exclusions to read, artists to fetch. */
export function hasPendingWork(d: Draft): boolean {
  if (d.artists.some((a) => a.status === 'pending')) return true;
  if (d.seeds?.some((s) => s.status === 'pending')) return true;
  if (d.excludeTracks && !d.excludeTracks.resolved) return true;
  return false;
}

export async function loadDraft(id: string): Promise<Draft | undefined> {
  if (!/^d_[a-z0-9]{3,12}$/.test(id)) return undefined;
  return readJson<Draft>(paths.draft(id));
}

export async function requireDraft(id: string): Promise<Draft> {
  const d = await loadDraft(id);
  if (!d) throw new LineupifyError('DRAFT_NOT_FOUND', `No draft with id ${id}.`, 'Call list_drafts to see available drafts.');
  return d;
}

/** Persist. `bump` increments the revision and snapshots the previous state for undo. */
export async function saveDraft(draft: Draft, opts: { bump?: boolean; previous?: Draft } = {}): Promise<Draft> {
  if (opts.bump) {
    if (opts.previous) {
      const revDir = paths.draftRevDir(draft.id);
      await fs.mkdir(revDir, { recursive: true });
      await writeJsonAtomic(path.join(revDir, `${opts.previous.revision}.json`), opts.previous);
      const files = (await fs.readdir(revDir)).filter((f) => f.endsWith('.json')).sort((a, b) => Number(a.replace('.json', '')) - Number(b.replace('.json', '')));
      for (const f of files.slice(0, Math.max(0, files.length - MAX_REVISIONS))) await fs.unlink(path.join(revDir, f)).catch(() => undefined);
    }
    draft.revision += 1;
  }
  draft.updatedAt = nowIso();
  await writeJsonAtomic(paths.draft(draft.id), draft);
  return draft;
}

export async function popRevision(draft: Draft): Promise<Draft | undefined> {
  const revDir = paths.draftRevDir(draft.id);
  const files = (await fs.readdir(revDir).catch(() => [] as string[])).filter((f) => f.endsWith('.json'));
  if (!files.length) return undefined;
  const latest = files.map((f) => Number(f.replace('.json', ''))).sort((a, b) => b - a)[0]!;
  const prev = await readJson<Draft>(path.join(revDir, `${latest}.json`));
  await fs.unlink(path.join(revDir, `${latest}.json`)).catch(() => undefined);
  return prev;
}

export async function listDrafts(): Promise<Draft[]> {
  const dir = paths.draftsDir();
  const files = (await fs.readdir(dir).catch(() => [] as string[])).filter((f) => /^d_[a-z0-9]+\.json$/.test(f));
  const drafts: Draft[] = [];
  for (const f of files) {
    const d = await readJson<Draft>(path.join(dir, f));
    if (d) drafts.push(d);
  }
  drafts.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  return drafts;
}

export async function deleteDraft(id: string): Promise<boolean> {
  const d = await loadDraft(id);
  if (!d) return false;
  await fs.unlink(paths.draft(id)).catch(() => undefined);
  await fs.rm(paths.draftRevDir(id), { recursive: true, force: true }).catch(() => undefined);
  await fs.unlink(paths.draftLock(id)).catch(() => undefined);
  return true;
}

/** Remove unpublished drafts untouched for 30 days. Published drafts are kept forever. */
export async function pruneDrafts(): Promise<number> {
  const cutoff = Date.now() - 30 * 86_400_000;
  let n = 0;
  for (const d of await listDrafts()) {
    if (d.playlistId) continue;
    if (new Date(d.updatedAt).getTime() < cutoff) {
      await deleteDraft(d.id);
      n++;
    }
  }
  return n;
}

// ---------------------------------------------------------------------------
// Derived values
// ---------------------------------------------------------------------------

export function totalDurationMs(d: Draft): number {
  return d.tracks.reduce((s, t) => s + t.durationMs, 0);
}

export function findArtist(d: Draft, name: string): DraftArtist | undefined {
  const f = fold(name);
  return d.artists.find((a) => a.key === name || fold(a.name) === f || fold(a.resolved?.name ?? '') === f) ?? d.artists.find((a) => fold(a.name).includes(f));
}

export function applyOrder(d: Draft, mode?: OrderMode, seed?: number): void {
  const m = mode ?? d.options.order;
  if (mode) d.options.order = mode;
  if (seed !== undefined) d.options.shuffleSeed = seed;
  const s = d.options.shuffleSeed ?? Math.floor(Math.random() * 2 ** 31);
  if (m === 'shuffle') d.options.shuffleSeed = s;
  d.tracks = orderTracks(d.tracks, d.artists, m, s);
}

// ---------------------------------------------------------------------------
// Edit operations
// ---------------------------------------------------------------------------

export type EditOp =
  | { op: 'remove_tracks'; ids?: string[]; indexes?: number[] }
  | { op: 'add_track'; track: string; artist?: string; position?: number }
  | { op: 'exclude_artist'; artist: string }
  | { op: 'set_artist_track_count'; artist: string; count: number }
  | { op: 'set_artist_source'; artist: string; deezerId?: number; spotifyArtistId?: string }
  | { op: 'move'; id?: string; from?: number; to: number }
  | { op: 'shuffle'; seed?: number }
  | { op: 'reorder'; mode: OrderMode }
  | { op: 'set_meta'; name?: string; description?: string; public?: boolean }
  | { op: 'filter'; explicit?: boolean; versions?: boolean }
  | { op: 'undo' };

export interface EditDeps {
  lookupTrack: (input: string) => Promise<SpotifyTrack | undefined>;
}

export interface EditOutcome {
  draft: Draft;
  diff: string[];
  /** Artists that now need (re)fetching; caller starts the job when non-empty. */
  rebuildArtists: string[];
  undone?: boolean;
}

const POSITIONAL: EditOp['op'][] = ['remove_tracks', 'add_track', 'move', 'shuffle', 'reorder', 'undo'];

export async function applyEdits(draft: Draft, ops: EditOp[], deps: EditDeps): Promise<EditOutcome> {
  const diff: string[] = [];
  const rebuild = new Set<string>();
  const building = draft.status === 'building';

  if (ops.some((o) => o.op === 'undo')) {
    if (ops.length > 1) throw new LineupifyError('EDIT_UNDO_ALONE', 'undo must be the only op in the list.');
    if (building) throw new LineupifyError('DRAFT_BUSY', 'Cannot undo while the draft is still building.', 'Call get_draft with waitSeconds until status is ready.');
    const prev = await popRevision(draft);
    if (!prev) throw new LineupifyError('NOTHING_TO_UNDO', 'No earlier revision is stored for this draft.');
    prev.revision = draft.revision + 1;
    return { draft: prev, diff: [`restored revision ${draft.revision - 1} as rev ${prev.revision}`], rebuildArtists: [], undone: true };
  }

  const snapshot = draft.tracks.slice();
  const byId = new Map(snapshot.map((t, i) => [t.id, i]));
  const removeSet = new Set<string>();

  for (const op of ops) {
    if (building && POSITIONAL.includes(op.op)) {
      throw new LineupifyError('DRAFT_BUSY', `"${op.op}" is not allowed while the draft is building; only exclude_artist, set_artist_track_count, set_artist_source, filter and set_meta are.`, 'Call get_draft with waitSeconds until status is ready, then edit.');
    }
    switch (op.op) {
      case 'remove_tracks': {
        const targets: string[] = [];
        for (const id of op.ids ?? []) {
          if (!byId.has(id)) throw new LineupifyError('TRACK_NOT_FOUND', `No track ${id} in this draft (revision ${draft.revision}).`, 'Call get_draft view=tracks and use the ids shown.');
          targets.push(id);
        }
        for (const idx of op.indexes ?? []) {
          const t = snapshot[idx - 1];
          if (!t) throw new LineupifyError('TRACK_NOT_FOUND', `No track at position ${idx} (draft has ${snapshot.length}).`);
          targets.push(t.id);
        }
        for (const id of targets) removeSet.add(id);
        diff.push(`removed ${targets.length} track${targets.length === 1 ? '' : 's'}: ${targets.join(', ')}`);
        break;
      }
      case 'add_track': {
        const t = await deps.lookupTrack(op.track);
        if (!t) throw new LineupifyError('TRACK_NOT_FOUND', `Could not find a Spotify track for "${op.track}".`, 'Use search_tracks to find the exact track, then pass its spotify:track: URI.');
        if (draft.tracks.some((x) => x.uri === t.uri)) {
          diff.push(`skipped ${t.name}: already in draft`);
          break;
        }
        let artist = op.artist ? findArtist(draft, op.artist) : undefined;
        if (!artist) artist = draft.artists.find((a) => t.artists.some((ta) => fold(ta.name) === fold(a.name) || (a.spotifyArtistId && ta.id === a.spotifyArtistId)));
        if (!artist) {
          const keys = new Set(draft.artists.map((a) => a.key));
          const name = t.artists[0]?.name ?? 'Added';
          artist = { key: artistKeyFor(name, keys), name, tier: 'flat', status: 'resolved', target: 0, resolved: { name, source: 'user', confidence: 'high', spotifyArtistId: t.artists[0]?.id } };
          draft.artists.push(artist);
        }
        const ids = new Set(draft.tracks.map((x) => x.id));
        const nt: DraftTrack = {
          id: makeTrackId(t.uri, ids),
          uri: t.uri,
          spotifyId: t.id,
          name: t.name,
          artists: t.artists.map((a) => a.name),
          artistKey: artist.key,
          durationMs: t.durationMs,
          explicit: t.explicit,
          isrc: t.isrc,
          album: t.albumName,
          matchedVia: 'manual',
          source: 'manual',
          role: 'lead',
        };
        const pos = op.position !== undefined ? Math.max(0, Math.min(draft.tracks.length, op.position - 1)) : draft.tracks.length;
        draft.tracks.splice(pos, 0, nt);
        diff.push(`added ${nt.id} ${nt.artists[0]} – ${nt.name} at #${pos + 1}`);
        break;
      }
      case 'exclude_artist': {
        const a = findArtist(draft, op.artist);
        if (!a) throw new LineupifyError('ARTIST_NOT_FOUND', `No artist matching "${op.artist}" in this draft.`);
        const before = draft.tracks.length;
        for (const t of draft.tracks) if (t.artistKey === a.key) removeSet.add(t.id);
        a.status = 'excluded';
        a.target = 0;
        if (building) draft.rules.push({ op: 'exclude_artist', payload: { key: a.key } });
        diff.push(`excluded ${a.name} (${draft.tracks.filter((t) => t.artistKey === a.key).length} of ${before} tracks)`);
        break;
      }
      case 'set_artist_track_count': {
        const a = findArtist(draft, op.artist);
        if (!a) throw new LineupifyError('ARTIST_NOT_FOUND', `No artist matching "${op.artist}" in this draft.`);
        const count = Math.max(0, Math.floor(op.count));
        const have = draft.tracks.filter((t) => t.artistKey === a.key && !removeSet.has(t.id));
        a.target = count;
        if (a.status === 'excluded') a.status = count > 0 ? 'pending' : 'excluded';
        if (count < have.length) {
          for (const t of have.slice(count)) removeSet.add(t.id);
          diff.push(`${a.name}: ${have.length} -> ${count} tracks`);
        } else if (count > have.length) {
          a.status = 'pending';
          rebuild.add(a.key);
          diff.push(`${a.name}: ${have.length} -> ${count} tracks (fetching more)`);
        } else diff.push(`${a.name}: already ${count} tracks`);
        if (building) draft.rules.push({ op: 'set_artist_track_count', payload: { key: a.key, count } });
        break;
      }
      case 'set_artist_source': {
        const a = findArtist(draft, op.artist);
        if (!a) throw new LineupifyError('ARTIST_NOT_FOUND', `No artist matching "${op.artist}" in this draft.`);
        if (!op.deezerId && !op.spotifyArtistId) throw new LineupifyError('BAD_EDIT', 'set_artist_source needs deezerId or spotifyArtistId.');
        const resolved = { name: a.name, source: 'user' as const, confidence: 'high' as const, deezerId: op.deezerId, spotifyArtistId: op.spotifyArtistId };
        await artistCache.set(fold(a.name), resolved);
        a.resolved = resolved;
        for (const t of draft.tracks) if (t.artistKey === a.key) removeSet.add(t.id);
        a.status = 'pending';
        rebuild.add(a.key);
        diff.push(`${a.name}: source overridden (${op.deezerId ? `deezer ${op.deezerId}` : `spotify ${op.spotifyArtistId}`}), refetching`);
        break;
      }
      case 'move': {
        const fromIdx = op.id !== undefined ? draft.tracks.findIndex((t) => t.id === op.id) : (op.from ?? 0) - 1;
        if (fromIdx < 0 || fromIdx >= draft.tracks.length) throw new LineupifyError('TRACK_NOT_FOUND', `move: source ${op.id ?? op.from} not found.`);
        const to = Math.max(0, Math.min(draft.tracks.length - 1, op.to - 1));
        const [t] = draft.tracks.splice(fromIdx, 1);
        draft.tracks.splice(to, 0, t!);
        diff.push(`moved ${t!.id} to #${to + 1}`);
        break;
      }
      case 'shuffle': {
        const seed = op.seed ?? Math.floor(Math.random() * 2 ** 31);
        draft.options.order = 'shuffle';
        draft.options.shuffleSeed = seed;
        applyOrder(draft, 'shuffle', seed);
        diff.push(`shuffled ${draft.tracks.length - removeSet.size} tracks (seed ${seed})`);
        break;
      }
      case 'reorder': {
        applyOrder(draft, op.mode);
        diff.push(`reordered ${draft.tracks.length - removeSet.size} tracks (mode ${op.mode})`);
        break;
      }
      case 'set_meta': {
        if (op.name !== undefined) {
          draft.name = op.name.trim().slice(0, 100);
          diff.push(`name: ${draft.name}`);
        }
        if (op.description !== undefined) {
          draft.description = op.description.replace(/<[^>]*>/g, '').slice(0, 300);
          diff.push('description updated');
        }
        if (op.public !== undefined) {
          draft.public = op.public;
          diff.push(`public: ${op.public}`);
        }
        if (building) draft.rules.push({ op: 'set_meta', payload: { ...op } });
        break;
      }
      case 'filter': {
        if (op.explicit !== undefined) {
          draft.options.excludeExplicit = op.explicit;
          if (op.explicit) {
            const n = draft.tracks.filter((t) => t.explicit).length;
            for (const t of draft.tracks) if (t.explicit) removeSet.add(t.id);
            diff.push(`explicit filter on: removed ${n}`);
          } else diff.push('explicit filter off (existing tracks unchanged)');
        }
        if (op.versions !== undefined) {
          draft.options.allowVersions = op.versions;
          if (!op.versions) {
            const n = draft.tracks.filter((t) => t.isVersion).length;
            for (const t of draft.tracks) if (t.isVersion) removeSet.add(t.id);
            diff.push(`versions filter on: removed ${n} live/remix/edit tracks`);
          } else diff.push('versions allowed (existing tracks unchanged)');
        }
        if (building) draft.rules.push({ op: 'filter', payload: { ...op } });
        break;
      }
    }
  }

  if (removeSet.size) draft.tracks = draft.tracks.filter((t) => !removeSet.has(t.id));
  return { draft, diff, rebuildArtists: [...rebuild] };
}
