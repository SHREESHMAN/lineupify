/**
 * Compare two or more "sides" (playlists, drafts, a listening profile):
 * shared tracks, shared artists, pairwise overlap and what is distinct to
 * each side. Pure; the tool layer fetches the sides.
 */
import type { PlaylistTrack } from '../types.js';
import { clean } from '../infra/text.js';
import { fold } from './normalize.js';
import { songKey } from './select.js';

export interface Side {
  label: string;
  tracks: PlaylistTrack[];
  /** Weighted artists (weight = track count, or taste weight for a profile). */
  artists: { name: string; weight: number }[];
}

export interface PairOverlap {
  a: string;
  b: string;
  sharedArtists: string[];
  sharedTracks: number;
  /** Jaccard similarity of the artist sets, 0..1. */
  artistSimilarity: number;
}

export interface Comparison {
  sides: { label: string; tracks: number; artists: number }[];
  /** Tracks present on every side (matched by ISRC, URI or normalized title+artist). */
  sharedTracks: { name: string; artist: string }[];
  /** Artists present on every side, ordered by combined weight. */
  sharedArtists: string[];
  pairs: PairOverlap[];
  distinct: { label: string; artists: string[] }[];
}

export function trackIdentity(t: PlaylistTrack): string[] {
  const ids: string[] = [];
  if (t.isrc) ids.push(`isrc:${t.isrc}`);
  if (t.uri) ids.push(`uri:${t.uri}`);
  ids.push(`song:${songKey(t.name, t.artists[0] ?? '')}`);
  return ids;
}

function artistMap(side: Side): Map<string, { name: string; weight: number }> {
  const m = new Map<string, { name: string; weight: number }>();
  for (const a of side.artists) {
    const k = fold(a.name);
    if (!k) continue;
    const cur = m.get(k);
    if (cur) cur.weight += a.weight;
    else m.set(k, { name: a.name, weight: a.weight });
  }
  return m;
}

function trackSets(side: Side): { keys: Set<string>; byKey: Map<string, PlaylistTrack> } {
  const keys = new Set<string>();
  const byKey = new Map<string, PlaylistTrack>();
  for (const t of side.tracks) {
    for (const id of trackIdentity(t)) {
      keys.add(id);
      if (!byKey.has(id)) byKey.set(id, t);
    }
  }
  return { keys, byKey };
}

function sharedTrackCount(a: Set<string>, b: Set<string>, tracksA: PlaylistTrack[]): number {
  let n = 0;
  for (const t of tracksA) if (trackIdentity(t).some((id) => b.has(id)) && trackIdentity(t).some((id) => a.has(id))) n++;
  return n;
}

export function compareSides(sides: Side[], limits: { artists?: number; tracks?: number } = {}): Comparison {
  const maxArtists = limits.artists ?? 25;
  const maxTracks = limits.tracks ?? 25;
  const maps = sides.map(artistMap);
  const sets = sides.map(trackSets);

  // Artists on every side.
  const sharedArtists: { name: string; weight: number }[] = [];
  for (const [k, v] of maps[0] ?? []) {
    if (maps.every((m) => m.has(k))) sharedArtists.push({ name: v.name, weight: maps.reduce((s, m) => s + (m.get(k)?.weight ?? 0), 0) });
  }
  sharedArtists.sort((x, y) => y.weight - x.weight);

  // Tracks on every side.
  const sharedTracks: { name: string; artist: string }[] = [];
  const seen = new Set<string>();
  for (const t of sides[0]?.tracks ?? []) {
    const ids = trackIdentity(t);
    if (!sets.every((s) => ids.some((id) => s.keys.has(id)))) continue;
    const key = ids[ids.length - 1]!;
    if (seen.has(key)) continue;
    seen.add(key);
    sharedTracks.push({ name: t.name, artist: t.artists[0] ?? '' });
  }

  const pairs: PairOverlap[] = [];
  for (let i = 0; i < sides.length; i++) {
    for (let j = i + 1; j < sides.length; j++) {
      const a = maps[i]!;
      const b = maps[j]!;
      const shared = [...a.keys()].filter((k) => b.has(k));
      const union = new Set([...a.keys(), ...b.keys()]).size;
      shared.sort((x, y) => (b.get(y)!.weight + a.get(y)!.weight) - (b.get(x)!.weight + a.get(x)!.weight));
      pairs.push({
        a: sides[i]!.label,
        b: sides[j]!.label,
        sharedArtists: shared.slice(0, maxArtists).map((k) => a.get(k)!.name),
        sharedTracks: sharedTrackCount(sets[i]!.keys, sets[j]!.keys, sides[i]!.tracks),
        artistSimilarity: union ? shared.length / union : 0,
      });
    }
  }

  const distinct = sides.map((s, i) => {
    const mine = maps[i]!;
    const others = maps.filter((_, j) => j !== i);
    const only = [...mine.entries()].filter(([k]) => !others.some((o) => o.has(k))).sort((x, y) => y[1].weight - x[1].weight);
    return { label: s.label, artists: only.slice(0, maxArtists).map(([, v]) => v.name) };
  });

  return {
    sides: sides.map((s, i) => ({ label: s.label, tracks: s.tracks.length, artists: maps[i]!.size })),
    sharedTracks: sharedTracks.slice(0, maxTracks),
    sharedArtists: sharedArtists.slice(0, maxArtists).map((a) => a.name),
    pairs,
    distinct,
  };
}

export function renderComparison(c: Comparison): string {
  const lines: string[] = [];
  lines.push(`Compared ${c.sides.length} sides: ${c.sides.map((s) => `${clean(s.label, 40)} (${s.tracks} tracks, ${s.artists} artists)`).join(' · ')}`);
  lines.push(`Shared by all — artists (${c.sharedArtists.length}): ${c.sharedArtists.map((a) => clean(a, 30)).join(', ') || 'none'}`);
  lines.push(`Shared by all — tracks (${c.sharedTracks.length}): ${c.sharedTracks.map((t) => `${clean(t.artist, 25)} – ${clean(t.name, 40)}`).join(' | ') || 'none'}`);
  for (const p of c.pairs) {
    lines.push(`${clean(p.a, 30)} vs ${clean(p.b, 30)}: artist overlap ${(p.artistSimilarity * 100).toFixed(0)}% (${p.sharedArtists.length} shared, ${p.sharedTracks} identical tracks)${p.sharedArtists.length ? `: ${p.sharedArtists.slice(0, 15).map((a) => clean(a, 30)).join(', ')}` : ''}`);
  }
  for (const d of c.distinct) lines.push(`Only in ${clean(d.label, 30)} (${d.artists.length}${d.artists.length >= 25 ? '+' : ''}): ${d.artists.slice(0, 15).map((a) => clean(a, 30)).join(', ') || 'nothing'}`);
  return lines.join('\n');
}
