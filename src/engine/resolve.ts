/**
 * Artist -> ranked candidate tracks.
 * Order: Deezer (keyless) -> Last.fm (if key) -> Spotify artist search + latest
 * releases -> unresolved with the queries that were tried.
 */
import type { Candidate, ResolvedArtist, SourceName } from '../types.js';
import { artistCache } from '../infra/cache.js';
import { log } from '../infra/log.js';
import { fold, labelPresents, splitAmpersand, splitCollab, stripSetSuffix } from './normalize.js';
import * as deezer from '../sources/deezer.js';
import * as lastfm from '../sources/lastfm.js';
import * as spotify from '../sources/spotify.js';

export interface ResolveContext {
  sources: SourceName[];
  lastfmApiKey?: string;
  signal?: AbortSignal;
  /** When false, skip the Spotify fallback (used for preview / no login). */
  spotifyAvailable: boolean;
}

export interface ResolveResult {
  resolved?: ResolvedArtist;
  candidates: Candidate[];
  reason?: string;
  queriesTried: string[];
}

function uniqueQueries(name: string): string[] {
  const out: string[] = [];
  const { stripped } = stripSetSuffix(name);
  const lp = labelPresents(stripped);
  for (const q of [lp?.rest ?? '', stripped, name]) {
    const t = q.trim();
    if (t && !out.some((o) => fold(o) === fold(t))) out.push(t);
  }
  return out;
}

export async function resolveArtist(name: string, ctx: ResolveContext): Promise<ResolveResult> {
  const queries = uniqueQueries(name);
  const tried: string[] = [];

  for (const q of queries) {
    const cached = await artistCache.get(fold(q));
    if (cached) {
      const r = await candidatesFor(cached, q, ctx);
      if (r.candidates.length) return { resolved: cached, candidates: r.candidates, queriesTried: [q] };
    }
  }

  // Deezer
  if (ctx.sources.includes('deezer')) {
    for (const q of queries) {
      tried.push(`deezer:${q}`);
      try {
        const results = await deezer.searchArtists(q, ctx.signal);
        const pick = deezer.pickArtist(q, results);
        if (!pick) continue;
        const top = await deezer.artistTopTracks(pick.artist.id, 50, ctx.signal);
        if (!top.length) continue;
        const resolved: ResolvedArtist = { name: pick.artist.name, source: 'deezer', deezerId: pick.artist.id, nbFan: pick.artist.nbFan, confidence: pick.confidence };
        await artistCache.set(fold(q), resolved);
        return { resolved, candidates: top, queriesTried: tried };
      } catch (err) {
        if (isAbort(err)) throw err;
        log.info(`deezer lookup failed for "${q}"`, String(err));
      }
    }
  }

  // Last.fm
  if (ctx.sources.includes('lastfm') && ctx.lastfmApiKey) {
    for (const q of queries) {
      tried.push(`lastfm:${q}`);
      try {
        const tracks = await lastfm.topTracks(ctx.lastfmApiKey, q, 30, ctx.signal);
        if (tracks && tracks.length) {
          const resolved: ResolvedArtist = { name: tracks[0]!.leadArtist || q, source: 'lastfm', lastfmName: q, confidence: 'high' };
          await artistCache.set(fold(q), resolved);
          return { resolved, candidates: tracks, queriesTried: tried };
        }
      } catch (err) {
        if (isAbort(err)) throw err;
        log.info(`lastfm lookup failed for "${q}"`, String(err));
      }
    }
  }

  // Spotify artist search + latest releases
  if (ctx.sources.includes('spotify') && ctx.spotifyAvailable) {
    for (const q of queries) {
      tried.push(`spotify:${q}`);
      try {
        const found = await spotify.searchArtists(q, ctx.signal);
        const exact = found.find((a) => fold(a.name) === fold(q));
        if (!exact) continue;
        const resolved: ResolvedArtist = { name: exact.name, source: 'spotify', spotifyArtistId: exact.id, confidence: 'high' };
        const candidates = await spotifyCandidates(resolved, ctx);
        if (!candidates.length) continue;
        await artistCache.set(fold(q), resolved);
        return { resolved, candidates, queriesTried: tried };
      } catch (err) {
        if (isAbort(err)) throw err;
        log.info(`spotify artist lookup failed for "${q}"`, String(err));
      }
    }
  }

  return { candidates: [], reason: 'not found in Deezer' + (ctx.lastfmApiKey ? ', Last.fm' : '') + (ctx.spotifyAvailable ? ' or Spotify' : ''), queriesTried: tried };
}

async function candidatesFor(resolved: ResolvedArtist, query: string, ctx: ResolveContext): Promise<{ candidates: Candidate[] }> {
  try {
    if (resolved.deezerId) return { candidates: await deezer.artistTopTracks(resolved.deezerId, 50, ctx.signal) };
    if (resolved.source === 'lastfm' && ctx.lastfmApiKey) return { candidates: (await lastfm.topTracks(ctx.lastfmApiKey, resolved.lastfmName ?? query, 30, ctx.signal)) ?? [] };
    if (resolved.spotifyArtistId && ctx.spotifyAvailable) return { candidates: await spotifyCandidates(resolved, ctx) };
  } catch (err) {
    if (isAbort(err)) throw err;
    log.info(`cached artist lookup failed for "${query}"`, String(err));
  }
  return { candidates: [] };
}

async function spotifyCandidates(resolved: ResolvedArtist, ctx: ResolveContext): Promise<Candidate[]> {
  if (!resolved.spotifyArtistId) return [];
  const albums = await spotify.artistAlbums(resolved.spotifyArtistId, 3, ctx.signal);
  const out: Candidate[] = [];
  let rank = 0;
  for (const album of albums) {
    const tracks = await spotify.albumTracks(album, ctx.signal);
    for (const t of tracks) {
      if (!t.artists.some((a) => a.id === resolved.spotifyArtistId)) continue;
      out.push({
        source: 'spotify',
        title: t.name,
        titleShort: t.name.replace(/\s*[([].*?[)\]]\s*$/, '').replace(/\s+-\s+.*$/, '').trim() || t.name,
        titleVersion: '',
        leadArtist: t.artists[0]?.name ?? resolved.name,
        leadArtistId: t.artists[0]?.id,
        contributors: t.artists.map((a) => a.name),
        role: t.artists[0]?.id === resolved.spotifyArtistId ? 'lead' : 'featured',
        rank: rank++,
        spotifyUri: t.uri,
        spotify: t,
        durationMs: t.durationMs,
        explicit: t.explicit,
        isrc: t.isrc,
        album: t.albumName,
      });
    }
  }
  return out;
}

export function isAbort(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || err.message === 'aborted');
}

export interface SplitResult {
  whole: ResolveResult;
  /** Present when the whole name failed but every part resolved: "A b2b B" -> A, B. */
  parts?: { name: string; result: ResolveResult }[];
}

/** Names that look like a collaboration: try whole first, then each part. */
export function collabParts(name: string): string[] | undefined {
  const collab = splitCollab(name);
  if (collab) return collab.length <= 4 ? collab : undefined;
  if (!/[&+]|\band\b/i.test(name)) return undefined;
  const parts = splitAmpersand(name);
  if (!parts || parts.length < 2 || parts.length > 4) return undefined;
  // "X & The Y" is almost always one band; "Raj and Shriya Rao" is a duo whose
  // first half is too short to look up safely. Keep those whole.
  if (parts.some((p) => /^the\s/i.test(p) || p.replace(/[^\p{L}\p{N}]/gu, '').length < 4)) return undefined;
  return parts;
}

export async function resolveOrSplit(name: string, ctx: ResolveContext): Promise<SplitResult> {
  const whole = await resolveArtist(name, ctx);
  if (whole.resolved) return { whole };
  const parts = collabParts(name);
  if (!parts) return { whole };
  const results = await Promise.all(parts.map(async (p) => ({ name: p, result: await resolveArtist(p, ctx) })));
  if (!results.every((r) => r.result.resolved)) return { whole };
  return { whole, parts: results };
}
