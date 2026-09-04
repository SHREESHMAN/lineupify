/**
 * Candidate -> Spotify track. ISRC first (exact recording), ranked so the
 * original album release wins over compilations; text search as fallback with
 * strict title and primary-artist checks. Every lookup is cached per Spotify
 * user because playability depends on the user's market.
 */
import type { Candidate, Provider, SpotifyTrack } from '../types.js';
import { deezerTrackCache, spotifyTrackCache, type CachedSpotifyTrack } from '../infra/cache.js';
import { log } from '../infra/log.js';
import { fold, normalizeIsrc, stripTitleDecorations, titleKey } from './normalize.js';
import * as deezer from '../sources/deezer.js';
import * as spotify from '../sources/spotify.js';
import { isAbort } from './resolve.js';

export interface MatchContext {
  userId: string;
  signal?: AbortSignal;
  /** Fetch Deezer tempo for the candidate (bpmRange filter). */
  wantBpm?: boolean;
  /** Default spotify. With "deezer" nothing touches Spotify: the candidate's own Deezer recording is the track. */
  provider?: Provider;
}

export interface MatchResult {
  track: SpotifyTrack;
  via: 'isrc' | 'text' | 'spotify' | 'deezer';
}

/** Deezer provider: the candidate is already a Deezer recording, or is looked up by title+artist. */
async function matchOnDeezer(c: Candidate, artistName: string, ctx: MatchContext): Promise<MatchResult | undefined> {
  if (c.deezerTrackId) {
    await ensureIsrc(c, ctx.signal, true);
    const track = deezer.toProviderTrack({
      id: c.deezerTrackId,
      title: c.title,
      isrc: c.isrc,
      durationMs: c.durationMs,
      explicit: c.explicit,
      rank: c.deezerRank,
      releaseDate: c.releaseDate,
      artistName: c.leadArtist || artistName,
      contributors: c.contributors,
      album: c.album,
    });
    return { track, via: 'deezer' };
  }
  const key = `deezer:q:${titleKey(c.titleShort || c.title)}|${fold(c.leadArtist || artistName)}`;
  const cached = await spotifyTrackCache.get(key);
  if (cached === null) return undefined;
  if (cached) return { track: cached, via: 'deezer' };
  const found = await deezer.findTrack(c.titleShort || c.title, c.leadArtist || artistName, ctx.signal);
  await spotifyTrackCache.set(key, found ? toCached(found) : null);
  return found ? { track: found, via: 'deezer' } : undefined;
}

function toCached(t: SpotifyTrack): CachedSpotifyTrack {
  return { ...t };
}

function artistMatches(track: SpotifyTrack, name: string, primaryOnly: boolean): boolean {
  const target = fold(name);
  if (!target) return false;
  const pool = primaryOnly ? track.artists.slice(0, 1) : track.artists;
  return pool.some((a) => {
    const f = fold(a.name);
    return f === target || f.startsWith(target) || target.startsWith(f);
  });
}

const ALBUM_RANK: Record<string, number> = { album: 0, single: 1, compilation: 2 };

export function rankIsrcHits(hits: SpotifyTrack[], leadArtist: string): SpotifyTrack | undefined {
  const playable = hits.filter((h) => h.isPlayable);
  const byArtist = playable.filter((h) => artistMatches(h, leadArtist, false));
  const pool = byArtist.length ? byArtist : playable;
  if (!pool.length) return undefined;
  pool.sort((a, b) => {
    const ra = ALBUM_RANK[a.albumType] ?? 3;
    const rb = ALBUM_RANK[b.albumType] ?? 3;
    if (ra !== rb) return ra - rb;
    if (a.releaseDate !== b.releaseDate) return a.releaseDate < b.releaseDate ? -1 : 1;
    return a.trackNumber - b.trackNumber;
  });
  return pool[0];
}

/**
 * Ensure the candidate carries its ISRC (Deezer track lookup, cached), and
 * with `wantBpm` its tempo too (entries cached before 0.2.0 lack it and are
 * refetched once).
 */
export async function ensureIsrc(c: Candidate, signal?: AbortSignal, wantBpm = false): Promise<void> {
  if (!c.deezerTrackId) return;
  if (c.isrc && (!wantBpm || c.bpm !== undefined)) return;
  const key = String(c.deezerTrackId);
  let d = await deezerTrackCache.get(key);
  if (!d || (wantBpm && d.bpm === undefined)) {
    try {
      const fresh = await deezer.trackDetails(c.deezerTrackId, signal);
      if (fresh) {
        d = fresh;
        await deezerTrackCache.set(key, d);
      }
    } catch (err) {
      if (isAbort(err)) throw err;
      log.debug(`deezer track ${key} lookup failed`, String(err));
    }
  }
  if (!d) return;
  c.isrc = c.isrc ?? normalizeIsrc(d.isrc);
  if (c.explicit === undefined && d.explicit !== undefined) c.explicit = d.explicit;
  if (!c.durationMs && d.durationMs) c.durationMs = d.durationMs;
  if (d.bpm !== undefined) c.bpm = d.bpm;
  if (d.rank && !c.deezerRank) c.deezerRank = d.rank;
  if (d.releaseDate && !c.releaseDate) c.releaseDate = d.releaseDate;
}

function textQuery(c: Candidate, artist: string): string {
  const title = stripTitleDecorations(c.titleShort || c.title).replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  const art = artist.replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  return `track:${title} artist:${art}`;
}

function titleMatches(spotifyName: string, c: Candidate): boolean {
  const a = titleKey(spotifyName);
  const b = titleKey(c.titleShort || c.title);
  if (!a || !b) return false;
  return a === b || a.startsWith(b) || b.startsWith(a);
}

export async function matchCandidate(c: Candidate, artistName: string, ctx: MatchContext): Promise<MatchResult | undefined> {
  if (ctx.provider === 'deezer') return matchOnDeezer(c, artistName, ctx);
  if (c.spotify) return { track: c.spotify, via: 'spotify' };
  if (c.spotifyUri) {
    const t = await spotify.track(c.spotifyUri.split(':').pop()!, ctx.signal);
    return t ? { track: t, via: 'spotify' } : undefined;
  }

  await ensureIsrc(c, ctx.signal, ctx.wantBpm);
  const lead = c.leadArtist || artistName;

  if (c.isrc) {
    const key = `${ctx.userId}:isrc:${c.isrc}`;
    const cached = await spotifyTrackCache.get(key);
    if (cached === null) {
      /* known miss, fall through to text */
    } else if (cached) {
      return { track: cached, via: 'isrc' };
    } else {
      const hits = await spotify.searchByIsrc(c.isrc, ctx.signal);
      const best = rankIsrcHits(hits, lead);
      await spotifyTrackCache.set(key, best ? toCached(best) : null);
      if (best) return { track: best, via: 'isrc' };
    }
  }

  const q = textQuery(c, artistName);
  const qKey = `${ctx.userId}:q:${q.toLowerCase()}`;
  const cachedQ = await spotifyTrackCache.get(qKey);
  if (cachedQ === null) return undefined;
  if (cachedQ) return { track: cachedQ, via: 'text' };

  const hits = await spotify.searchTracks(q, 5, ctx.signal);
  const primaryOnly = c.role !== 'featured';
  const best = hits.find((h) => h.isPlayable && titleMatches(h.name, c) && (artistMatches(h, artistName, primaryOnly) || artistMatches(h, lead, primaryOnly)));
  await spotifyTrackCache.set(qKey, best ? toCached(best) : null);
  return best ? { track: best, via: 'text' } : undefined;
}

/** Resolve a user-supplied track reference on the given provider (default Spotify). */
export async function lookupTrack(input: string, signal?: AbortSignal, provider: Provider = 'spotify'): Promise<SpotifyTrack | undefined> {
  const s = input.trim();
  if (provider === 'deezer') {
    const id = deezer.parseTrackRef(s);
    if (id) return deezer.trackById(id, signal);
    const dash = s.match(/^(.+?)\s+[-–—]\s+(.+)$/);
    if (dash) return deezer.findTrack(dash[2]!, dash[1]!, signal);
    const hits = await deezer.searchTracksByTitle(s, 5, signal);
    const h = hits[0];
    return h ? deezer.trackById(h.id, signal) : undefined;
  }
  const uriMatch = s.match(/^spotify:track:([A-Za-z0-9]{22})$/);
  const urlMatch = s.match(/open\.spotify\.com\/(?:intl-[a-z]+\/)?track\/([A-Za-z0-9]{22})/);
  const id = uriMatch?.[1] ?? urlMatch?.[1];
  if (id) return spotify.track(id, signal);
  const dash = s.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  const q = dash ? `track:${dash[2]!.replace(/[^\p{L}\p{N}\s]/gu, ' ')} artist:${dash[1]!.replace(/[^\p{L}\p{N}\s]/gu, ' ')}` : s;
  const hits = await spotify.searchTracks(q, 5, signal);
  return hits.find((h) => h.isPlayable) ?? hits[0];
}
