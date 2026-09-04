/**
 * Background build jobs. One job per draft per process, guarded by a lock file
 * so a second Lineupify instance (another MCP host) reads instead of building.
 * The job owns its AbortController; tool-call cancellation never reaches it.
 * Progress is checkpointed to disk after every artist so a killed process can
 * resume from where it stopped.
 */
import type { Candidate, Draft, DraftArtist, Provider, Tier } from '../types.js';
import { LineupifyError } from '../types.js';
import { log } from '../infra/log.js';
import { lockAge, paths, tryLock, type LockHandle } from '../infra/store.js';
import { flushAllCaches } from '../infra/cache.js';
import { fold } from './normalize.js';
import { applyOrder, hasPendingWork, loadDraft, makeTrackId, saveDraft, artistKeyFor } from './draft.js';
import { collabParts, isAbort, resolveArtist, resolveOrSplit, type ResolveContext } from './resolve.js';
import { lookupTrack, matchCandidate } from './match.js';
import { applyStepwiseCap, songKey, targetFor, trimToDuration } from './select.js';
import { bpmAccepts, trackYear, yearAccepts } from './filters.js';
import { expandSeed, seedLabel } from './seeds.js';
import { resolveSource } from './playlists.js';
import { dropCovers } from './covers.js';
import { compareTaste } from './taste.js';
import { artistCache } from '../infra/cache.js';
import { clean } from '../infra/text.js';
import { isVersionCandidate } from '../sources/deezer.js';
import { getAccessToken } from '../sources/spotify.js';

/** Errors that stop the whole build (the draft pauses) instead of failing one artist or seed. */
const FATAL = ['SPOTIFY_QUOTA_EXCEEDED', 'TOKEN_EXPIRED_RECONNECT', 'SPOTIFY_NOT_CONNECTED', 'SPOTIFY_FORBIDDEN', 'SPOTIFY_RATE_LIMITED', 'SPOTIFY_SCOPE_MISSING'];
const MAX_ARTISTS = 400;

export interface JobSettings {
  lastfmApiKey?: string;
}

interface Job {
  id: string;
  ctrl: AbortController;
  promise: Promise<void>;
  lock: LockHandle;
  heartbeat: NodeJS.Timeout;
  draft: Draft;
  saving: Promise<void>;
}

const jobs = new Map<string, Job>();
const CONCURRENCY = 3;
const TIER_ORDER: Record<Tier, number> = { headliner: 0, sub: 1, undercard: 2, flat: 1 };

export function isRunning(draftId: string): boolean {
  return jobs.has(draftId);
}

/** The in-memory draft of a job running in this process, if any. */
export function liveDraft(draftId: string): Draft | undefined {
  return jobs.get(draftId)?.draft;
}

export async function lockedElsewhere(draftId: string): Promise<boolean> {
  if (jobs.has(draftId)) return false;
  const age = await lockAge(paths.draftLock(draftId));
  return age !== undefined && age < 60_000;
}

export type StartResult = 'started' | 'already_running' | 'locked_elsewhere' | 'nothing_to_do';

export async function startJob(draftId: string, settings: JobSettings, draftOverride?: Draft): Promise<StartResult> {
  if (jobs.has(draftId)) return 'already_running';
  const draft = draftOverride ?? (await loadDraft(draftId));
  if (!draft) throw new LineupifyError('DRAFT_NOT_FOUND', `No draft ${draftId}.`);
  if (!hasPendingWork(draft)) return 'nothing_to_do';

  const lock = await tryLock(paths.draftLock(draftId));
  if (!lock) return 'locked_elsewhere';

  const ctrl = new AbortController();
  const heartbeat = setInterval(() => void lock.heartbeat(), 5000);
  heartbeat.unref?.();
  const job: Job = { id: draftId, ctrl, lock, heartbeat, draft, saving: Promise.resolve(), promise: Promise.resolve() };
  jobs.set(draftId, job);
  job.promise = run(job, settings)
    .catch((err) => log.error(`job ${draftId} crashed`, String(err)))
    .finally(async () => {
      clearInterval(heartbeat);
      jobs.delete(draftId);
      await lock.release();
      await flushAllCaches().catch(() => undefined);
    });
  return 'started';
}

export async function waitForJob(draftId: string, ms: number): Promise<boolean> {
  const job = jobs.get(draftId);
  if (!job) return true;
  const timeout = new Promise<false>((r) => setTimeout(() => r(false), ms));
  return Promise.race([job.promise.then(() => true), timeout]);
}

export async function abortAllJobs(): Promise<void> {
  for (const job of jobs.values()) job.ctrl.abort();
  await Promise.allSettled([...jobs.values()].map((j) => j.promise));
}

function checkpoint(job: Job, bump = false): Promise<void> {
  job.saving = job.saving.then(() => saveDraft(job.draft, { bump }).then(() => undefined)).catch((err) => log.error('checkpoint failed', String(err)));
  return job.saving;
}

async function run(job: Job, settings: JobSettings): Promise<void> {
  const { draft, ctrl } = job;
  const signal = ctrl.signal;
  draft.status = 'building';
  draft.error = undefined;
  await checkpoint(job);

  try {
    const provider = draft.provider ?? 'spotify';
    let userId = 'deezer';
    if (provider === 'spotify') {
      const tokens = await getAccessToken();
      if (!draft.spotifyUserId) draft.spotifyUserId = tokens.userId;
      if (draft.spotifyUserId !== tokens.userId) {
        throw new LineupifyError('SPOTIFY_USER_MISMATCH', `This draft was built for Spotify user ${draft.spotifyUserId} but ${tokens.userId} is connected.`, 'Reconnect the original account, or create a new draft.');
      }
      userId = tokens.userId;
    }

    await expandSeeds(job, settings, signal);
    await resolveExclusions(job, signal);
    if (draft.options.discoveryOnly && provider === 'spotify') await applyDiscoveryOnly(job, signal);

    const rctx: ResolveContext = { sources: provider === 'deezer' ? draft.options.sources.filter((s) => s !== 'spotify') : draft.options.sources, lastfmApiKey: settings.lastfmApiKey, signal, spotifyAvailable: provider === 'spotify' };
    const mctx = { userId, signal, wantBpm: !!draft.options.bpmRange, provider };

    await expandCollabs(draft, rctx);
    applyTargets(draft);
    draft.progress = { done: draft.artists.filter((a) => a.status !== 'pending' && a.status !== 'excluded').length, total: draft.artists.filter((a) => a.status !== 'excluded').length };
    await checkpoint(job);

    const ex = draft.excludeTracks;
    const seenUri = new Set([...draft.tracks.map((t) => t.uri), ...(ex?.uris ?? [])]);
    const seenIsrc = new Set([...draft.tracks.map((t) => t.isrc).filter((x): x is string => !!x), ...(ex?.isrcs ?? [])]);
    const seenSong = new Set([...draft.tracks.map((t) => songKey(t.name, t.artists[0] ?? '')), ...(ex?.songKeys ?? [])]);
    const ids = new Set(draft.tracks.map((t) => t.id));

    const seen: Seen = { seenUri, seenIsrc, seenSong, ids, candidates: new Map() };
    const byLineup = (x: DraftArtist, y: DraftArtist) => TIER_ORDER[x.tier] - TIER_ORDER[y.tier] || draft.artists.indexOf(x) - draft.artists.indexOf(y);
    const have = (a: DraftArtist) => draft.tracks.filter((t) => t.artistKey === a.key).length;

    // Pass 1: resolve every artist and take its own (lead) songs.
    // Pass 2: artists still short take songs where they are only featured.
    // Pass 3: artists still short accept live/remix/edit versions.
    const passes: Pass[] = draft.options.allowVersions
      ? [{ role: 'lead', versions: 'any' }, { role: 'featured', versions: 'any' }]
      : [{ role: 'lead', versions: 'no' }, { role: 'featured', versions: 'no' }, { role: 'any', versions: 'only' }];

    for (const [pi, pass] of passes.entries()) {
      const queue = draft.artists.filter((a) => (pi === 0 ? a.status === 'pending' : a.status === 'resolved' && seen.candidates.has(a.key) && have(a) < a.target)).sort(byLineup);
      if (!queue.length) continue;
      let cursor = 0;
      const worker = async () => {
        for (;;) {
          if (signal.aborted) return;
          const a = queue[cursor++];
          if (!a) return;
          try {
            await processArtist(draft, a, pass, rctx, mctx, seen);
          } catch (err) {
            if (isAbort(err)) return;
            if (err instanceof LineupifyError && FATAL.includes(err.code)) throw err;
            log.error(`artist "${a.name}" failed`, String(err));
            a.status = 'unresolved';
            a.reason = `error: ${err instanceof Error ? err.message : String(err)}`;
          }
          draft.progress.done = draft.artists.filter((x) => x.status !== 'pending' && x.status !== 'excluded').length;
          await checkpoint(job);
        }
      };
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
      if (signal.aborted) break;
    }
    for (const a of draft.artists) {
      if (a.status === 'resolved' && have(a) === 0) a.reason = a.reason ?? (provider === 'deezer' ? 'no tracks passed the filters on Deezer' : 'no playable tracks matched on Spotify');
    }

    if (signal.aborted) {
      draft.status = 'paused';
      draft.error = 'build interrupted; call get_draft to resume';
      await checkpoint(job);
      return;
    }

    await finalize(job, seen, signal);
    if (signal.aborted) {
      draft.status = 'paused';
      draft.error = 'build interrupted; call get_draft to resume';
      await checkpoint(job);
      return;
    }
    draft.status = 'ready';
    await checkpoint(job, true);
    log.info(`draft ${draft.id} ready: ${draft.tracks.length} tracks`);
  } catch (err) {
    if (isAbort(err)) {
      draft.status = 'paused';
      draft.error = 'build interrupted; call get_draft to resume';
      requeueShortArtists(draft);
    } else if (err instanceof LineupifyError && FATAL.includes(err.code)) {
      draft.status = 'paused';
      draft.error = `${err.code}: ${err.message} ${err.hint ?? ''}`.trim();
      requeueShortArtists(draft);
    } else {
      draft.status = 'failed';
      draft.error = err instanceof Error ? `${(err as LineupifyError).code ?? 'ERROR'}: ${err.message}` : String(err);
      log.error(`draft ${draft.id} failed`, draft.error);
    }
    await checkpoint(job);
  }
}

/**
 * A pause can land while an artist is already "resolved" but still short of
 * its target (the error came from matching, not resolving). Put those back to
 * pending so the resume has work to do; their candidates are cached, so the
 * retry is cheap.
 */
function requeueShortArtists(draft: Draft): void {
  const counts = new Map<string, number>();
  for (const t of draft.tracks) counts.set(t.artistKey, (counts.get(t.artistKey) ?? 0) + 1);
  for (const a of draft.artists) {
    if (a.status === 'resolved' && (counts.get(a.key) ?? 0) < a.target) a.status = 'pending';
  }
}

/** Recompute per-artist targets from options, rules and the maxTracks cap. */
export function applyTargets(draft: Draft): void {
  const live = draft.artists.filter((a) => a.status !== 'excluded');
  const targets = live.map((a) => a.target);
  const capped = applyStepwiseCap(live, targets, draft.options.maxTracks);
  live.forEach((a, i) => {
    a.target = capped[i]!;
  });
}

async function finalize(job: Job, seen: Seen, signal: AbortSignal): Promise<void> {
  const { draft } = job;
  draft.buildNotes = undefined;
  if (draft.options.skipCovers) {
    const dropped = await dropCovers(draft, seen.candidates, signal);
    draft.buildNotes = [dropped.length ? `skipCovers removed ${dropped.length}: ${dropped.slice(0, 8).map((d) => clean(d, 90)).join(' | ')}${dropped.length > 8 ? ' …' : ''}` : 'skipCovers: nothing looked like a cover'];
    await checkpoint(job);
  }
  if (draft.options.maxDurationMin) {
    draft.tracks = trimToDuration(draft.tracks, draft.artists, draft.options.maxDurationMin * 60_000);
  }
  applyOrder(draft);
}

/**
 * Turn each pending seed into artists appended to the draft. A seed that
 * fails is marked failed with the reason and the build goes on; the build
 * fails only when nothing at all is left to fetch.
 */
async function expandSeeds(job: Job, settings: JobSettings, signal: AbortSignal): Promise<void> {
  const { draft } = job;
  const pending = (draft.seeds ?? []).filter((s) => s.status === 'pending');
  if (!pending.length) return;
  const provider = draft.provider ?? 'spotify';
  const ctx = {
    lastfmApiKey: settings.lastfmApiKey,
    signal,
    provider,
    lookupTrack: (ref: string) => lookupTrack(ref, signal, provider),
    excludeSeedSongs: draft.options.excludeSeedSongs,
    excludeSeedArtists: draft.options.excludeSeedArtists,
    tracksPerArtist: draft.options.tracksPerArtist,
  };
  const anyTier = draft.artists.some((a) => a.tier !== 'flat');
  const excluded = new Set(draft.options.excludeArtists.map(fold));
  for (const seed of pending) {
    if (signal.aborted) throw new Error('aborted');
    try {
      const r = await expandSeed(seed, ctx);
      if (r.seedSongs?.length) seed.label = r.seedSongs.map((s) => `${clean(s.artist, 24)} – ${clean(s.title, 30)}`).join(', ');
      const keys = new Set(draft.artists.map((a) => a.key));
      const existing = new Set(draft.artists.map((a) => fold(a.name)));
      const tier: Tier = seed.tier ?? (anyTier ? 'undercard' : 'flat');
      let added = 0;
      if (r.seedSongs?.length && draft.options.excludeSeedSongs) {
        const ex = draft.excludeTracks ?? { uris: [], isrcs: [], songKeys: [], resolved: !draft.options.excludeTracksFrom?.length };
        for (const s of r.seedSongs) {
          if (s.uri && !ex.uris.includes(s.uri)) ex.uris.push(s.uri);
          if (s.isrc && !ex.isrcs.includes(s.isrc)) ex.isrcs.push(s.isrc);
          if (!ex.songKeys.includes(s.key)) ex.songKeys.push(s.key);
        }
        ex.note = [ex.note, `${r.seedSongs.length} seed song${r.seedSongs.length === 1 ? '' : 's'}`].filter(Boolean).join('; ');
        draft.excludeTracks = ex;
      }
      for (const a of r.artists) {
        const f = fold(a.name);
        if (!f || excluded.has(f)) continue;
        const pinned = r.pinned?.[f];
        if (existing.has(f)) {
          // Same artist again (typed, or from another seed): add the pinned songs it does not have yet.
          const cur = draft.artists.find((x) => fold(x.name) === f);
          if (cur && pinned?.length && cur.status === 'pending') {
            const have = new Set((cur.pinned ?? []).map((c) => songKey(c.titleShort || c.title, c.leadArtist)));
            const fresh = pinned.filter((c) => !have.has(songKey(c.titleShort || c.title, c.leadArtist)));
            if (fresh.length) {
              cur.pinned = [...(cur.pinned ?? []), ...fresh];
              cur.target = draft.options.tracksPerArtist ?? cur.pinned.length;
            }
          }
          continue;
        }
        if (draft.artists.length >= MAX_ARTISTS) break;
        const key = artistKeyFor(a.name, keys);
        keys.add(key);
        existing.add(f);
        const target = pinned?.length ? (draft.options.tracksPerArtist ?? pinned.length) : targetFor(tier, draft.options);
        draft.artists.push({ key, name: a.name, tier, status: 'pending', target, origin: seedLabel(seed), ...(pinned?.length ? { pinned } : {}) });
        if (a.deezerId && !(await artistCache.get(f))) {
          await artistCache.set(f, { name: a.name, source: 'deezer', deezerId: a.deezerId, nbFan: a.nbFan, confidence: 'high' });
        }
        added++;
      }
      seed.added = added;
      seed.note = r.note;
      seed.status = r.artists.length ? 'done' : 'failed';
      if (!r.artists.length) seed.error = r.note || 'no artists found';
      log.info(`seed ${seedLabel(seed)}: ${added} artists added (${r.note})`);
    } catch (err) {
      if (isAbort(err)) throw err;
      if (err instanceof LineupifyError && FATAL.includes(err.code)) throw err;
      seed.status = 'failed';
      seed.error = err instanceof LineupifyError ? `${err.message} ${err.hint ?? ''}`.trim() : err instanceof Error ? err.message : String(err);
      log.error(`seed ${seedLabel(seed)} failed`, seed.error);
    }
    await checkpoint(job);
  }
  if (!draft.artists.some((a) => a.status !== 'excluded')) {
    throw new LineupifyError('NO_ARTISTS_FROM_SEEDS', 'None of the seeds produced any artists.', 'get_draft view=unresolved shows why each seed failed. Fix the seed values, add a Last.fm key for tag/country seeds, or pass artists directly.');
  }
}

/** Read the playlists named in excludeTracksFrom once and remember their tracks so the build never picks them. */
async function resolveExclusions(job: Job, signal: AbortSignal): Promise<void> {
  const { draft } = job;
  const from = draft.options.excludeTracksFrom ?? [];
  if (!from.length) return;
  const ex = draft.excludeTracks ?? { uris: [], isrcs: [], songKeys: [], resolved: false };
  if (ex.resolved) return;
  const uris = new Set(ex.uris);
  const isrcs = new Set(ex.isrcs);
  const keys = new Set(ex.songKeys);
  const notes: string[] = [];
  for (const ref of from) {
    if (signal.aborted) throw new Error('aborted');
    try {
      const src = await resolveSource(ref, { signal });
      for (const t of src.tracks) {
        if (t.uri) uris.add(t.uri);
        if (t.isrc) isrcs.add(t.isrc);
        keys.add(songKey(t.name, t.artists[0] ?? ''));
      }
      notes.push(`${clean(src.label, 30)} (${src.tracks.length} tracks)`);
    } catch (err) {
      if (isAbort(err)) throw err;
      if (err instanceof LineupifyError && FATAL.includes(err.code)) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      notes.push(`${clean(ref, 30)}: could not read (${clean(msg, 80)})`);
      log.error(`excludeTracksFrom ${ref} failed`, msg);
    }
  }
  draft.excludeTracks = { uris: [...uris], isrcs: [...isrcs], songKeys: [...keys], resolved: true, note: notes.join('; ') };
  await checkpoint(job);
}

/** discoveryOnly: drop pending artists the user already listens to (checked here so seeded artists are covered too). */
async function applyDiscoveryOnly(job: Job, signal: AbortSignal): Promise<void> {
  const { draft } = job;
  if (!draft.artists.some((a) => a.status === 'pending' && a.known === undefined)) return;
  await compareTaste(draft, signal);
  for (const a of draft.artists) {
    if (a.status === 'pending' && a.known) {
      a.status = 'excluded';
      a.target = 0;
      a.reason = 'already in your top or followed artists (discoveryOnly)';
    }
  }
  await checkpoint(job);
}

/**
 * "A b2b B", "A x B", "A & B": try the whole name first (cheap: cached or one
 * Deezer search); split only when the whole fails and every part resolves.
 */
async function expandCollabs(draft: Draft, rctx: ResolveContext): Promise<void> {
  const pending = draft.artists.filter((a) => a.status === 'pending' && !a.pinned?.length);
  for (const a of pending) {
    const parts = collabParts(a.name);
    if (!parts) continue;
    if (rctx.signal?.aborted) return;
    const r = await resolveOrSplit(a.name, rctx);
    if (!r.parts) continue;
    const idx = draft.artists.indexOf(a);
    const keys = new Set(draft.artists.map((x) => x.key));
    const existing = new Set(draft.artists.filter((x) => x !== a).map((x) => fold(x.name)));
    const replacements: DraftArtist[] = [];
    for (const p of r.parts) {
      if (existing.has(fold(p.name))) continue;
      const key = artistKeyFor(p.name, keys);
      keys.add(key);
      existing.add(fold(p.name));
      replacements.push({ key, name: p.name, tier: a.tier, day: a.day, stage: a.stage, status: 'pending', target: a.target });
    }
    draft.artists.splice(idx, 1, ...replacements);
    log.info(`split "${a.name}" into ${r.parts.map((p) => p.name).join(' / ')}`);
  }
}

interface Pass {
  role: 'lead' | 'featured' | 'any';
  versions: 'no' | 'only' | 'any';
}

interface Seen {
  seenUri: Set<string>;
  seenIsrc: Set<string>;
  seenSong: Set<string>;
  ids: Set<string>;
  /** Candidates fetched in pass 1, keyed by artist key, reused by later passes. */
  candidates: Map<string, Candidate[]>;
}

function accepts(pass: Pass, c: Candidate): boolean {
  if (pass.role !== 'any' && c.role !== pass.role) return false;
  const v = isVersionCandidate(c);
  if (pass.versions === 'no' && v) return false;
  if (pass.versions === 'only' && !v) return false;
  return true;
}

async function processArtist(draft: Draft, a: DraftArtist, pass: Pass, rctx: ResolveContext, mctx: { userId: string; signal: AbortSignal; wantBpm?: boolean; provider?: Provider }, seen: Seen): Promise<void> {
  const have = () => draft.tracks.filter((t) => t.artistKey === a.key).length;
  let candidates = seen.candidates.get(a.key);
  if (!candidates && a.pinned?.length) {
    // similar_songs: these exact songs, not the artist's top tracks.
    candidates = a.pinned.map((c) => ({ ...c }));
    a.resolved = a.resolved ?? { name: a.name, source: candidates[0]!.source, confidence: 'high' };
    a.reason = undefined;
    seen.candidates.set(a.key, candidates);
    a.status = 'resolved';
  }
  if (!candidates) {
    if (a.target - have() <= 0) {
      a.status = a.resolved ? 'resolved' : 'unresolved';
      return;
    }
    const r = await resolveArtist(a.name, rctx);
    if (!r.resolved) {
      a.status = 'unresolved';
      a.reason = r.reason;
      a.queriesTried = r.queriesTried;
      return;
    }
    a.resolved = r.resolved;
    a.reason = undefined;
    a.queriesTried = r.queriesTried;
    if (r.resolved.spotifyArtistId) a.spotifyArtistId = r.resolved.spotifyArtistId;
    candidates = r.candidates;
    seen.candidates.set(a.key, candidates);
    a.status = 'resolved';
  }

  for (const c of candidates) {
    if (have() >= a.target) break;
    if (mctx.signal.aborted) throw new Error('aborted');
    if (!accepts(pass, c)) continue;
    if (draft.options.excludeExplicit && c.explicit === true) continue;
    const key = songKey(c.titleShort || c.title, c.leadArtist || a.name);
    if (seen.seenSong.has(key)) continue;
    seen.seenSong.add(key);
    const m = await matchCandidate(c, a.resolved?.name ?? a.name, mctx);
    if (!m) {
      seen.seenSong.delete(key);
      continue;
    }
    const t = m.track;
    if (seen.seenUri.has(t.uri) || (t.isrc && seen.seenIsrc.has(t.isrc))) continue;
    if (draft.options.excludeExplicit && t.explicit) continue;
    const yearInfo = trackYear(t, c);
    if (!yearAccepts(yearInfo, draft.options) || !bpmAccepts(c.bpm, draft.options)) {
      seen.seenSong.delete(key);
      continue;
    }
    seen.seenUri.add(t.uri);
    if (t.isrc) seen.seenIsrc.add(t.isrc);
    const id = makeTrackId(t.uri, seen.ids);
    seen.ids.add(id);
    const isVersion = isVersionCandidate(c);
    if (isVersion && !draft.options.allowVersions) a.allowedVersions = true;
    draft.tracks.push({
      id,
      uri: t.uri,
      spotifyId: t.id,
      name: t.name,
      artists: t.artists.map((x) => x.name),
      artistKey: a.key,
      durationMs: t.durationMs || c.durationMs || 0,
      explicit: t.explicit,
      isrc: t.isrc ?? c.isrc,
      album: t.albumName || c.album,
      matchedVia: m.via,
      source: c.source,
      role: c.role,
      isVersion: isVersion || undefined,
      year: yearInfo.year,
      yearUncertain: yearInfo.year !== undefined && yearInfo.uncertain ? true : undefined,
      bpm: c.bpm ?? undefined,
      rank: c.deezerRank,
      deezerTrackId: t.deezerTrackId,
      url: t.deezerTrackId ? `https://www.deezer.com/track/${t.deezerTrackId}` : `https://open.spotify.com/track/${t.id}`,
    });
    if (!a.spotifyArtistId && mctx.provider !== 'deezer') {
      const target = fold(a.resolved?.name ?? a.name);
      const hit = t.artists.find((x) => fold(x.name) === target) ?? (c.role === 'lead' ? t.artists[0] : undefined);
      if (hit) a.spotifyArtistId = hit.id;
    }
  }
}

/** Used by preview mode and tests: candidates -> which would be picked, without Spotify. */
export function previewPick(candidates: Candidate[], need: number, allowVersions: boolean): Candidate[] {
  const passes: Pass[] = allowVersions
    ? [{ role: 'lead', versions: 'any' }, { role: 'featured', versions: 'any' }]
    : [{ role: 'lead', versions: 'no' }, { role: 'featured', versions: 'no' }, { role: 'any', versions: 'only' }];
  const out: Candidate[] = [];
  const seen = new Set<string>();
  for (const pass of passes) {
    for (const c of candidates) {
      if (out.length >= need) return out;
      if (!accepts(pass, c)) continue;
      const key = songKey(c.titleShort || c.title, c.leadArtist);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(c);
    }
  }
  return out;
}
