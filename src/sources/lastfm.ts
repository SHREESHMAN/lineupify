/**
 * Last.fm client (optional; needs LASTFM_API_KEY). Used as a fallback when
 * Deezer has no artist or too few tracks. autocorrect is off so Last.fm can't
 * silently swap one artist for another; the echoed artist name must match.
 */
import type { Candidate } from '../types.js';
import { http } from '../infra/http.js';
import { fold } from '../engine/normalize.js';

const BASE = 'https://ws.audioscrobbler.com/2.0/';
const JUNK_TITLE = /^(untitled|intro|outro|interlude|track\s*\d+|unknown( track)?|skit)$/i;
const MIN_LISTENERS = 50;

interface LfmTopTracks {
  toptracks?: {
    track?: { name: string; playcount?: string; listeners?: string; artist?: { name: string } }[];
    '@attr'?: { artist?: string };
  };
  error?: number;
  message?: string;
}

export async function topTracks(apiKey: string, artist: string, limit = 30, signal?: AbortSignal): Promise<Candidate[] | undefined> {
  const url =
    `${BASE}?method=artist.gettoptracks&artist=${encodeURIComponent(artist)}` +
    `&autocorrect=0&limit=${limit}&api_key=${encodeURIComponent(apiKey)}&format=json`;
  const res = await http(url, { signal, timeoutMs: 12_000, attempts: 3 });
  const body = res.json<LfmTopTracks>();
  if (!body || body.error) return undefined;
  const echoed = body.toptracks?.['@attr']?.artist;
  if (!echoed || fold(echoed) !== fold(artist)) return undefined;
  const tracks = body.toptracks?.track ?? [];
  return tracks
    .filter((t) => Number(t.listeners ?? 0) >= MIN_LISTENERS && !JUNK_TITLE.test(t.name.trim()))
    .map((t, i) => ({
      source: 'lastfm' as const,
      title: t.name,
      titleShort: t.name.replace(/\s*[([].*?[)\]]\s*$/, '').replace(/\s+-\s+.*$/, '').trim() || t.name,
      titleVersion: '',
      leadArtist: t.artist?.name ?? artist,
      contributors: [t.artist?.name ?? artist],
      role: 'lead' as const,
      rank: i,
    }));
}

export async function validateKey(apiKey: string): Promise<boolean> {
  const url = `${BASE}?method=artist.getinfo&artist=Radiohead&api_key=${encodeURIComponent(apiKey)}&format=json`;
  try {
    const res = await http(url, { attempts: 1, timeoutMs: 8000 });
    const body = res.json<{ error?: number }>();
    return !!body && !body.error;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Discovery (tag, similar, geo, chart, tags). All need the key.
// ---------------------------------------------------------------------------

export interface LfmArtist {
  name: string;
  listeners?: number;
  /** artist.getSimilar: 0..1 */
  match?: number;
}

async function call<T>(apiKey: string, params: Record<string, string>, signal?: AbortSignal): Promise<T | undefined> {
  const qs = new URLSearchParams({ ...params, api_key: apiKey, format: 'json' });
  const res = await http(`${BASE}?${qs.toString()}`, { signal, timeoutMs: 12_000, attempts: 3 });
  const body = res.json<T & { error?: number; message?: string }>();
  if (!body || body.error) return undefined;
  return body;
}

interface ArtistList {
  name: string;
  listeners?: string;
  match?: string;
}

function toArtists(list: ArtistList[] | undefined): LfmArtist[] {
  return (list ?? []).filter((a) => a.name).map((a) => ({ name: a.name, listeners: a.listeners ? Number(a.listeners) : undefined, match: a.match ? Number(a.match) : undefined }));
}

export async function tagTopArtists(apiKey: string, tag: string, limit = 50, signal?: AbortSignal): Promise<LfmArtist[]> {
  const body = await call<{ topartists?: { artist?: ArtistList[] } }>(apiKey, { method: 'tag.gettopartists', tag, limit: String(limit) }, signal);
  return toArtists(body?.topartists?.artist);
}

export async function similarArtists(apiKey: string, artist: string, limit = 30, signal?: AbortSignal): Promise<LfmArtist[]> {
  const body = await call<{ similarartists?: { artist?: ArtistList[] } }>(apiKey, { method: 'artist.getsimilar', artist, autocorrect: '0', limit: String(limit) }, signal);
  return toArtists(body?.similarartists?.artist);
}

/** `country` is an ISO 3166-1 country name, e.g. "brazil". */
export async function geoTopArtists(apiKey: string, country: string, limit = 50, signal?: AbortSignal): Promise<LfmArtist[]> {
  const body = await call<{ topartists?: { artist?: ArtistList[] } }>(apiKey, { method: 'geo.gettopartists', country, limit: String(limit) }, signal);
  return toArtists(body?.topartists?.artist);
}

export async function chartTopArtists(apiKey: string, limit = 50, signal?: AbortSignal): Promise<LfmArtist[]> {
  const body = await call<{ artists?: { artist?: ArtistList[] } }>(apiKey, { method: 'chart.gettopartists', limit: String(limit) }, signal);
  return toArtists(body?.artists?.artist);
}

const JUNK_TAG = /^(seen live|favorites?|favourites?|my favorites?|all|under 2000 listeners|spotify|\d+s?|male vocalists?|female vocalists?|awesome|love|good|beautiful|check out)$/i;

export async function artistTopTags(apiKey: string, artist: string, limit = 5, signal?: AbortSignal): Promise<string[]> {
  const body = await call<{ toptags?: { tag?: { name: string; count?: number }[] } }>(apiKey, { method: 'artist.gettoptags', artist, autocorrect: '1' }, signal);
  return (body?.toptags?.tag ?? [])
    .filter((t) => t.name && !JUNK_TAG.test(t.name.trim()) && (t.count ?? 0) >= 10)
    .slice(0, limit)
    .map((t) => t.name.toLowerCase());
}
