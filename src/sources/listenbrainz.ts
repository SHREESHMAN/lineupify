/**
 * MetaBrainz open data, no key needed:
 * - MusicBrainz maps an ISRC (or artist + title) to recording MBIDs.
 *   Rate limit 1 request/second and a descriptive User-Agent are required.
 * - ListenBrainz Labs "similar recordings": recordings people play in the
 *   same listening sessions, from the open ListenBrainz dataset. Verified
 *   live 2026-09-05 with the algorithm below (the labs page lists the
 *   available algorithm names; a wrong name is a 400).
 */
import { http } from '../infra/http.js';
import { normalizeIsrc } from '../engine/normalize.js';

const MB = 'https://musicbrainz.org/ws/2';
const LB = 'https://labs.api.listenbrainz.org';
const USER_AGENT = 'lineupify-mcp (https://github.com/shreeshman/lineupify)';
export const LB_ALGORITHM = 'session_based_days_7500_session_300_contribution_5_threshold_15_limit_50_skip_30';
/** The algorithm bakes in limit_50: at most 50 similar recordings per seed. */
export const LB_MAX_PER_SEED = 50;

const HEADERS = { 'User-Agent': USER_AGENT, Accept: 'application/json' };

/** Recording MBIDs registered for an ISRC (usually one; several when a recording was entered twice). */
export async function recordingMbidsByIsrc(isrc: string, signal?: AbortSignal): Promise<string[]> {
  const code = normalizeIsrc(isrc);
  if (!code) return [];
  const res = await http(`${MB}/isrc/${code}?fmt=json&inc=artist-credits`, { signal, headers: HEADERS, attempts: 2, timeoutMs: 15_000 });
  if (res.status === 404) return [];
  const body = res.json<{ recordings?: { id: string }[] }>();
  return (body?.recordings ?? []).map((r) => r.id).filter(Boolean);
}

/** Recording MBIDs for an artist + title, best first (MusicBrainz search scoring). */
export async function recordingMbidsByNames(artist: string, title: string, signal?: AbortSignal): Promise<string[]> {
  const esc = (s: string) => s.replace(/["\\]/g, ' ').trim();
  const query = `recording:"${esc(title)}" AND artist:"${esc(artist)}"`;
  const res = await http(`${MB}/recording?query=${encodeURIComponent(query)}&fmt=json&limit=3`, { signal, headers: HEADERS, attempts: 2, timeoutMs: 15_000 });
  const body = res.json<{ recordings?: { id: string; score?: number }[] }>();
  return (body?.recordings ?? []).filter((r) => (r.score ?? 0) >= 80).map((r) => r.id);
}

export interface LbSimilar {
  mbid: string;
  title: string;
  artist: string;
  /** Session co-occurrence count; only comparable within one response. */
  score: number;
}

interface LbRow {
  recording_mbid?: string;
  recording_name?: string;
  artist_credit_name?: string;
  artist_name?: string;
  score?: number;
}

export async function similarRecordings(mbid: string, signal?: AbortSignal): Promise<LbSimilar[]> {
  const url = `${LB}/similar-recordings/json?recording_mbids=${encodeURIComponent(mbid)}&algorithm=${LB_ALGORITHM}`;
  const res = await http(url, { signal, headers: HEADERS, attempts: 2, timeoutMs: 20_000 });
  if (res.status >= 400) return [];
  const body = res.json<LbRow[]>();
  return parseSimilarRows(Array.isArray(body) ? body : []);
}

/** Pure: keep rows that name a recording and an artist, most co-played first. */
export function parseSimilarRows(rows: LbRow[]): LbSimilar[] {
  return rows
    .filter((r) => r.recording_mbid && r.recording_name && (r.artist_credit_name || r.artist_name))
    .map((r) => ({ mbid: r.recording_mbid!, title: r.recording_name!, artist: (r.artist_credit_name ?? r.artist_name)!, score: Number(r.score ?? 0) }))
    .sort((a, b) => b.score - a.score);
}
