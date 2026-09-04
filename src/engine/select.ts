/**
 * Pure selection helpers: per-tier targets, stepwise caps, dedupe keys and
 * ordering modes. No I/O so everything here is unit-testable.
 */
import type { DraftArtist, DraftOptions, DraftTrack, LineupArtist, OrderMode, Tier } from '../types.js';
import { fold, titleKey } from './normalize.js';

export function effectiveTier(a: LineupArtist, anyTierPresent: boolean): Tier {
  if (a.tier) return a.tier;
  return anyTierPresent ? 'undercard' : 'flat';
}

export function targetFor(tier: Tier, opts: DraftOptions): number {
  if (opts.tracksPerArtist !== undefined) return Math.max(0, Math.floor(opts.tracksPerArtist));
  switch (tier) {
    case 'headliner':
      return opts.tracksPerTier.headliner;
    case 'sub':
      return opts.tracksPerTier.sub;
    case 'undercard':
      return opts.tracksPerTier.undercard;
    default:
      return opts.tracksPerTier.sub;
  }
}

const REDUCTION_ORDER: Tier[] = ['undercard', 'flat', 'sub', 'headliner'];

/**
 * Bring the sum of `targets` under `maxTotal` by first lowering per-artist
 * counts one step at a time (undercard first, then sub, then headliner) and
 * only removing whole artists (undercard, last on the lineup first) when every
 * artist is already at one track.
 */
export function applyStepwiseCap(artists: { tier: Tier }[], targets: number[], maxTotal: number): number[] {
  const out = targets.slice();
  const sum = () => out.reduce((a, b) => a + b, 0);
  if (sum() <= maxTotal) return out;

  let changed = true;
  while (sum() > maxTotal && changed) {
    changed = false;
    for (const tier of REDUCTION_ORDER) {
      const idx = artists.map((a, i) => i).filter((i) => artists[i]!.tier === tier && out[i]! > 1);
      if (!idx.length) continue;
      for (const i of idx) out[i] = out[i]! - 1;
      changed = true;
      if (sum() <= maxTotal) return out;
    }
  }
  for (const tier of REDUCTION_ORDER) {
    for (let i = out.length - 1; i >= 0 && sum() > maxTotal; i--) {
      if (artists[i]!.tier === tier && out[i]! > 0) out[i] = 0;
    }
  }
  return out;
}

/** Dedupe key for a song independent of catalogue: normalized short title + lead artist. */
export function songKey(titleShort: string, leadArtist: string): string {
  return `${titleKey(titleShort)}|${fold(leadArtist)}`;
}

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

export function seededRandom(seed: number): () => number {
  let s = (seed >>> 0) || 0x9e3779b9;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0x100000000;
  };
}

function groupByArtist(tracks: DraftTrack[], artistOrder: string[]): Map<string, DraftTrack[]> {
  const groups = new Map<string, DraftTrack[]>();
  for (const key of artistOrder) groups.set(key, []);
  for (const t of tracks) {
    if (!groups.has(t.artistKey)) groups.set(t.artistKey, []);
    groups.get(t.artistKey)!.push(t);
  }
  for (const [k, v] of groups) if (!v.length) groups.delete(k);
  return groups;
}

/**
 * Weighted interleave: each artist's k-th track lands near position
 * (k + 0.5) / n * total, so artists with more tracks are spread across the
 * whole playlist instead of clumping at the end. A final pass swaps adjacent
 * tracks by the same artist.
 */
export function interleave(tracks: DraftTrack[], artistOrder: string[]): DraftTrack[] {
  const groups = groupByArtist(tracks, artistOrder);
  const total = tracks.length;
  if (total < 3) return tracks.slice();
  const slots: { pos: number; tiebreak: number; track: DraftTrack }[] = [];
  let artistIdx = 0;
  for (const [, list] of groups) {
    const n = list.length;
    list.forEach((track, k) => {
      const pos = ((k + 0.5) / n) * total;
      slots.push({ pos, tiebreak: artistIdx / groups.size, track });
    });
    artistIdx++;
  }
  slots.sort((a, b) => a.pos - b.pos || a.tiebreak - b.tiebreak);
  const out = slots.map((s) => s.track);
  return fixAdjacent(out);
}

function fixAdjacent(list: DraftTrack[]): DraftTrack[] {
  const out = list.slice();
  const key = (i: number) => out[i]?.artistKey;
  for (let pass = 0; pass < 3; pass++) {
    let clean = true;
    for (let i = 1; i < out.length; i++) {
      if (key(i) !== key(i - 1)) continue;
      clean = false;
      // Find a j to swap with so neither position ends up next to a same-artist track.
      for (let j = i + 1; j < out.length; j++) {
        const cand = key(j);
        if (cand === key(i - 1) || cand === key(i + 1)) continue;
        const leftOfJ = j - 1 === i ? cand : key(j - 1);
        const rightOfJ = key(j + 1);
        if (leftOfJ === key(i) || rightOfJ === key(i)) continue;
        [out[i], out[j]] = [out[j]!, out[i]!];
        break;
      }
    }
    if (clean) break;
  }
  return out;
}

export function shuffle(tracks: DraftTrack[], seed: number): DraftTrack[] {
  const rnd = seededRandom(seed);
  const out = tracks.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

export function orderTracks(tracks: DraftTrack[], artists: DraftArtist[], mode: OrderMode, seed = 1): DraftTrack[] {
  const order = artists.map((a) => a.key);
  switch (mode) {
    case 'lineup': {
      const groups = groupByArtist(tracks, order);
      return [...groups.values()].flat();
    }
    case 'shuffle':
      return shuffle(tracks, seed);
    case 'by_day': {
      const days: string[] = [];
      for (const a of artists) {
        const d = a.day ?? '';
        if (!days.includes(d)) days.push(d);
      }
      const out: DraftTrack[] = [];
      for (const d of days) {
        const keys = artists.filter((a) => (a.day ?? '') === d).map((a) => a.key);
        const subset = tracks.filter((t) => keys.includes(t.artistKey));
        out.push(...interleave(subset, keys));
      }
      return out;
    }
    case 'known_first': {
      const knownKeys = artists.filter((a) => a.known).map((a) => a.key);
      const newKeys = artists.filter((a) => !a.known).map((a) => a.key);
      const known = tracks.filter((t) => knownKeys.includes(t.artistKey));
      const fresh = tracks.filter((t) => !knownKeys.includes(t.artistKey));
      return [...interleave(known, knownKeys), ...interleave(fresh, newKeys)];
    }
    case 'interleave':
    default:
      return interleave(tracks, order);
  }
}

/** Remove tracks, lowest-ranked per artist first (stepwise by tier), until total duration fits. */
export function trimToDuration(tracks: DraftTrack[], artists: DraftArtist[], maxMs: number): DraftTrack[] {
  const total = () => kept.reduce((s, t) => s + t.durationMs, 0);
  const kept = tracks.slice();
  if (total() <= maxMs) return kept;
  const tierOf = new Map(artists.map((a) => [a.key, a.tier]));
  let changed = true;
  while (total() > maxMs && changed) {
    changed = false;
    for (const tier of REDUCTION_ORDER) {
      const byArtist = new Map<string, number[]>();
      kept.forEach((t, i) => {
        if (tierOf.get(t.artistKey) !== tier) return;
        if (!byArtist.has(t.artistKey)) byArtist.set(t.artistKey, []);
        byArtist.get(t.artistKey)!.push(i);
      });
      const removable = [...byArtist.values()].filter((idx) => idx.length > 1).map((idx) => idx[idx.length - 1]!);
      if (!removable.length) continue;
      removable.sort((a, b) => b - a).forEach((i) => kept.splice(i, 1));
      changed = true;
      if (total() <= maxMs) return kept;
    }
  }
  for (const tier of REDUCTION_ORDER) {
    for (let i = kept.length - 1; i >= 0 && total() > maxMs; i--) {
      if (tierOf.get(kept[i]!.artistKey) === tier) kept.splice(i, 1);
    }
  }
  return kept;
}
