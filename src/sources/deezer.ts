/**
 * Deezer public API client. No key needed. Deezer signals errors with HTTP 200
 * and an `error` object in the body: code 4 is quota (back off and retry),
 * code 800 is "no data", anything else is a real failure. Nothing carrying an
 * error object is ever cached.
 */
import type { Candidate } from '../types.js';
import { http, sleep } from '../infra/http.js';
import { log } from '../infra/log.js';
import { classifyVersion, fold, looksLikeClone, normalizeIsrc } from '../engine/normalize.js';

const BASE = 'https://api.deezer.com';

interface DeezerError {
  error?: { type?: string; message?: string; code?: number };
}

export interface DeezerArtist {
  id: number;
  name: string;
  nbFan: number;
}

class DeezerQuotaError extends Error {
  constructor() {
    super('Deezer quota exceeded');
    this.name = 'DeezerQuotaError';
  }
}

async function get<T>(path: string, signal?: AbortSignal): Promise<T | undefined> {
  const url = `${BASE}${path}`;
  for (let attempt = 1; attempt <= 6; attempt++) {
    const res = await http(url, { signal, timeoutMs: 12_000 });
    const body = res.json<T & DeezerError>();
    if (!body) return undefined;
    if (body.error) {
      const code = body.error.code;
      if (code === 4) {
        const wait = Math.min(15_000, 1000 * 2 ** (attempt - 1)) + Math.random() * 400;
        log.debug(`deezer quota hit, waiting ${Math.round(wait)}ms`);
        if (attempt === 6) throw new DeezerQuotaError();
        await sleep(wait, signal);
        continue;
      }
      if (code === 800) return undefined;
      throw new Error(`Deezer error ${code ?? '?'}: ${body.error.message ?? body.error.type ?? 'unknown'}`);
    }
    return body;
  }
  return undefined;
}

export async function searchArtists(query: string, signal?: AbortSignal): Promise<DeezerArtist[]> {
  const body = await get<{ data?: { id: number; name: string; nb_fan?: number }[] }>(
    `/search/artist?q=${encodeURIComponent(query)}&limit=10`,
    signal,
  );
  return (body?.data ?? []).map((a) => ({ id: a.id, name: a.name, nbFan: a.nb_fan ?? 0 }));
}

/**
 * Choose the Deezer artist for a lineup name: exact fold match, not a karaoke
 * clone, highest fan count. Returns the pick plus a confidence flag.
 */
export function pickArtist(query: string, results: DeezerArtist[]): { artist: DeezerArtist; confidence: 'high' | 'low' } | undefined {
  const q = fold(query);
  const exact = results.filter((a) => fold(a.name) === q && !looksLikeClone(a.name));
  if (exact.length) {
    exact.sort((a, b) => b.nbFan - a.nbFan);
    const best = exact[0]!;
    const rival = results.filter((a) => fold(a.name) !== q && !looksLikeClone(a.name)).sort((a, b) => b.nbFan - a.nbFan)[0];
    const low = best.nbFan < 50 && rival !== undefined && rival.nbFan > best.nbFan * 1000;
    return { artist: best, confidence: low ? 'low' : 'high' };
  }
  // Loose fallback: query contained in candidate or vice versa, e.g. "Fred again" vs "Fred again..".
  const loose = results
    .filter((a) => !looksLikeClone(a.name))
    .filter((a) => {
      const f = fold(a.name);
      return f.startsWith(q) || q.startsWith(f) || f.replace(/\W/g, '') === q.replace(/\W/g, '');
    })
    .sort((a, b) => b.nbFan - a.nbFan);
  if (loose.length && loose[0]!.nbFan >= 100) return { artist: loose[0]!, confidence: 'low' };
  return undefined;
}

interface DeezerTopTrack {
  id: number;
  title: string;
  title_short: string;
  title_version?: string;
  duration?: number;
  explicit_lyrics?: boolean;
  rank?: number;
  readable?: boolean;
  artist?: { id: number; name: string };
  contributors?: { id: number; name: string; role?: string }[];
  album?: { title?: string };
}

export async function artistTopTracks(artistId: number, limit = 50, signal?: AbortSignal): Promise<Candidate[]> {
  const body = await get<{ data?: DeezerTopTrack[] }>(`/artist/${artistId}/top?limit=${Math.min(100, limit)}`, signal);
  const data = body?.data ?? [];
  return data
    .filter((t) => t.readable !== false)
    .map((t, i) => {
      const lead = t.artist ?? t.contributors?.[0];
      const contributors = (t.contributors ?? []).map((c) => c.name);
      const role: Candidate['role'] = lead && lead.id === artistId ? 'lead' : 'featured';
      const titleVersion = t.title_version ?? '';
      const c: Candidate = {
        source: 'deezer',
        title: t.title,
        titleShort: t.title_short || t.title,
        titleVersion,
        leadArtist: lead?.name ?? '',
        leadArtistId: lead ? String(lead.id) : undefined,
        contributors,
        role,
        rank: i,
        deezerTrackId: t.id,
        durationMs: t.duration ? t.duration * 1000 : undefined,
        explicit: t.explicit_lyrics ?? undefined,
        album: t.album?.title,
        deezerRank: t.rank,
      };
      return c;
    });
}

export interface DeezerTrackDetails {
  isrc?: string;
  explicit?: boolean;
  durationMs?: number;
  /** null when Deezer has no tempo for the recording. */
  bpm?: number | null;
  rank?: number;
  releaseDate?: string;
  title?: string;
  artistName?: string;
  artistId?: number;
  albumId?: number;
}

interface RawTrackDetails {
  id?: number;
  title?: string;
  isrc?: string;
  explicit_lyrics?: boolean;
  duration?: number;
  bpm?: number;
  rank?: number;
  release_date?: string;
  artist?: { id: number; name: string };
  album?: { id: number };
}

function toDetails(body: RawTrackDetails): DeezerTrackDetails {
  return {
    isrc: normalizeIsrc(body.isrc),
    explicit: body.explicit_lyrics,
    durationMs: body.duration ? body.duration * 1000 : undefined,
    bpm: body.bpm && body.bpm > 0 ? Math.round(body.bpm * 10) / 10 : null,
    rank: body.rank,
    releaseDate: body.release_date,
    title: body.title,
    artistName: body.artist?.name,
    artistId: body.artist?.id,
    albumId: body.album?.id,
  };
}

export async function trackDetails(trackId: number, signal?: AbortSignal): Promise<DeezerTrackDetails | undefined> {
  const body = await get<RawTrackDetails>(`/track/${trackId}`, signal);
  return body ? toDetails(body) : undefined;
}

/** Look a recording up by ISRC (tempo, popularity, release date). */
export async function trackByIsrc(isrc: string, signal?: AbortSignal): Promise<DeezerTrackDetails | undefined> {
  const body = await get<RawTrackDetails>(`/track/isrc:${encodeURIComponent(isrc)}`, signal);
  return body && body.id ? toDetails(body) : undefined;
}

export function isVersionCandidate(c: Candidate): boolean {
  return classifyVersion(c.titleVersion, c.title).isVersion;
}

// ---------------------------------------------------------------------------
// Discovery endpoints (all keyless). Verified against the live API 2026-09-04:
// /artist/{id}/related and /chart/0 work; /genre/{id}/artists and
// /chart/{genre} return the global chart regardless of genre, so genre and
// country seeds go through public playlists instead.
// ---------------------------------------------------------------------------

export async function relatedArtists(artistId: number, limit = 20, signal?: AbortSignal): Promise<DeezerArtist[]> {
  const body = await get<{ data?: { id: number; name: string; nb_fan?: number }[] }>(`/artist/${artistId}/related?limit=${Math.min(50, limit)}`, signal);
  return (body?.data ?? []).filter((a) => !looksLikeClone(a.name)).map((a) => ({ id: a.id, name: a.name, nbFan: a.nb_fan ?? 0 }));
}

export async function chartArtists(limit = 50, signal?: AbortSignal): Promise<DeezerArtist[]> {
  const body = await get<{ data?: { id: number; name: string; nb_fan?: number; position?: number }[] }>(`/chart/0/artists?limit=${Math.min(100, limit)}`, signal);
  return (body?.data ?? []).map((a) => ({ id: a.id, name: a.name, nbFan: a.nb_fan ?? 0 }));
}

export interface DeezerPlaylistRef {
  id: number;
  title: string;
  nbTracks: number;
  userId?: number;
  userName?: string;
}

export async function searchPlaylists(query: string, limit = 10, signal?: AbortSignal): Promise<DeezerPlaylistRef[]> {
  const body = await get<{ data?: { id: number; title: string; nb_tracks?: number; public?: boolean; user?: { id: number; name: string } }[] }>(
    `/search/playlist?q=${encodeURIComponent(query)}&limit=${Math.min(25, limit)}`,
    signal,
  );
  return (body?.data ?? []).filter((p) => p.public !== false).map((p) => ({ id: p.id, title: p.title, nbTracks: p.nb_tracks ?? 0, userId: p.user?.id, userName: p.user?.name }));
}

export interface DeezerPlaylistInfo {
  id: number;
  title: string;
  description?: string;
  creator?: string;
  nbTracks: number;
  fans?: number;
  link: string;
  public?: boolean;
}

export async function playlistInfo(playlistId: number, signal?: AbortSignal): Promise<DeezerPlaylistInfo | undefined> {
  const body = await get<{ id: number; title: string; description?: string; nb_tracks?: number; fans?: number; link?: string; public?: boolean; creator?: { name: string } }>(`/playlist/${playlistId}?limit=1`, signal);
  if (!body || !body.id) return undefined;
  return { id: body.id, title: body.title, description: body.description, creator: body.creator?.name, nbTracks: body.nb_tracks ?? 0, fans: body.fans, link: body.link ?? `https://www.deezer.com/playlist/${body.id}`, public: body.public };
}

export interface DeezerPlaylistTrack {
  id: number;
  title: string;
  titleShort: string;
  titleVersion: string;
  isrc?: string;
  durationMs: number;
  explicit: boolean;
  rank?: number;
  artistId?: number;
  artistName: string;
  album?: string;
  addedAt?: string;
}

/** All tracks of a public playlist, paged 100 at a time, capped at `max`. */
export async function playlistTracks(playlistId: number, max = 1000, signal?: AbortSignal): Promise<{ tracks: DeezerPlaylistTrack[]; total: number }> {
  const out: DeezerPlaylistTrack[] = [];
  let total = 0;
  for (let index = 0; index < max; index += 100) {
    const body = await get<{ data?: { id: number; title: string; title_short?: string; title_version?: string; isrc?: string; duration?: number; explicit_lyrics?: boolean; rank?: number; readable?: boolean; time_add?: number; artist?: { id: number; name: string }; album?: { title?: string } }[]; total?: number; next?: string }>(
      `/playlist/${playlistId}/tracks?limit=${Math.min(100, max - index)}&index=${index}`,
      signal,
    );
    const data = body?.data ?? [];
    total = body?.total ?? total;
    for (const t of data) {
      out.push({
        id: t.id,
        title: t.title,
        titleShort: t.title_short || t.title,
        titleVersion: t.title_version ?? '',
        isrc: normalizeIsrc(t.isrc),
        durationMs: (t.duration ?? 0) * 1000,
        explicit: !!t.explicit_lyrics,
        rank: t.rank,
        artistId: t.artist?.id,
        artistName: t.artist?.name ?? '',
        album: t.album?.title,
        addedAt: t.time_add ? new Date(t.time_add * 1000).toISOString() : undefined,
      });
    }
    if (!body?.next || data.length === 0) break;
  }
  return { tracks: out, total: total || out.length };
}

export interface DeezerTrackHit {
  id: number;
  title: string;
  titleShort: string;
  titleVersion: string;
  rank: number;
  artistId?: number;
  artistName: string;
  isrc?: string;
}

/** Recordings with this title, most popular first (Deezer's own ordering is not by rank, so we sort). */
export async function searchTracksByTitle(title: string, limit = 10, signal?: AbortSignal): Promise<DeezerTrackHit[]> {
  const q = `track:"${title.replace(/"/g, '')}"`;
  const body = await get<{ data?: { id: number; title: string; title_short?: string; title_version?: string; rank?: number; isrc?: string; artist?: { id: number; name: string } }[] }>(`/search/track?q=${encodeURIComponent(q)}&limit=${Math.min(25, limit)}`, signal);
  return (body?.data ?? [])
    .map((t) => ({ id: t.id, title: t.title, titleShort: t.title_short || t.title, titleVersion: t.title_version ?? '', rank: t.rank ?? 0, artistId: t.artist?.id, artistName: t.artist?.name ?? '', isrc: normalizeIsrc(t.isrc) }))
    .filter((t) => t.artistName && !looksLikeClone(t.artistName))
    .sort((a, b) => b.rank - a.rank);
}

let genreList: { id: number; name: string }[] | undefined;
/** Deezer's coarse genre list (Pop, Rock, Metal, ...), fetched once per process. */
export async function genres(signal?: AbortSignal): Promise<{ id: number; name: string }[]> {
  if (genreList) return genreList;
  const body = await get<{ data?: { id: number; name: string }[] }>('/genre', signal);
  genreList = (body?.data ?? []).filter((g) => g.id !== 0);
  return genreList;
}

/** Recent albums of an artist with their genre id; used to infer a coarse genre. */
export async function artistAlbumGenres(artistId: number, limit = 5, signal?: AbortSignal): Promise<number[]> {
  const body = await get<{ data?: { genre_id?: number }[] }>(`/artist/${artistId}/albums?limit=${limit}`, signal);
  return (body?.data ?? []).map((a) => a.genre_id).filter((g): g is number => typeof g === 'number' && g > 0);
}
