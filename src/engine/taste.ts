/**
 * Mark each draft artist as known (already in the user's top artists or
 * followed) or new. Matching is by Spotify artist id; names are a fallback
 * for artists that never produced a Spotify track.
 */
import type { Draft } from '../types.js';
import { nowIso } from '../infra/text.js';
import { fold } from './normalize.js';
import * as spotify from '../sources/spotify.js';

export interface TasteResult {
  known: string[];
  fresh: string[];
  unresolved: string[];
  topCount: number;
  followingCount: number;
}

export async function compareTaste(draft: Draft, signal?: AbortSignal): Promise<TasteResult> {
  const [short, medium, long, following] = await Promise.all([
    spotify.topArtists('short_term', signal),
    spotify.topArtists('medium_term', signal),
    spotify.topArtists('long_term', signal),
    spotify.followedArtists(signal),
  ]);
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const a of [...short, ...medium, ...long, ...following]) {
    ids.add(a.id);
    names.add(fold(a.name));
  }
  const known: string[] = [];
  const fresh: string[] = [];
  const unresolved: string[] = [];
  for (const a of draft.artists) {
    if (a.status === 'excluded') continue;
    if (a.status === 'unresolved') {
      unresolved.push(a.name);
      a.known = names.has(fold(a.name));
      continue;
    }
    a.known = a.spotifyArtistId ? ids.has(a.spotifyArtistId) : names.has(fold(a.resolved?.name ?? a.name));
    (a.known ? known : fresh).push(a.name);
  }
  draft.tasteCheckedAt = nowIso();
  const topIds = new Set([...short, ...medium, ...long].map((a) => a.id));
  return { known, fresh, unresolved, topCount: topIds.size, followingCount: following.length };
}
