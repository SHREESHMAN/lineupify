import { describe, it, expect } from 'vitest';
import type { DraftArtist, DraftOptions, DraftTrack, Tier } from '../../src/types.js';
import { applyStepwiseCap, effectiveTier, interleave, orderTracks, seededRandom, shuffle, songKey, targetFor, trimToDuration } from '../../src/engine/select.js';

const baseOpts: DraftOptions = {
  tracksPerTier: { headliner: 5, sub: 3, undercard: 2 },
  maxTracks: 100,
  order: 'interleave',
  excludeArtists: [],
  excludeExplicit: false,
  allowVersions: false,
  discoveryOnly: false,
  public: false,
  sources: ['deezer'],
};

function mk(artistKey: string, n: number, extra: Partial<DraftTrack> = {}): DraftTrack {
  return {
    id: `${artistKey}-${n}`,
    uri: `spotify:track:${artistKey}${n}`,
    spotifyId: `${artistKey}${n}`,
    name: `Song ${n}`,
    artists: [artistKey],
    artistKey,
    durationMs: 180_000,
    explicit: false,
    matchedVia: 'text',
    source: 'deezer',
    role: 'lead',
    ...extra,
  };
}

function artist(key: string, tier: Tier, extra: Partial<DraftArtist> = {}): DraftArtist {
  return { key, name: key, tier, status: 'resolved', target: 1, ...extra };
}

function noAdjacentDuplicates(list: DraftTrack[]): string[] {
  const bad: string[] = [];
  for (let i = 1; i < list.length; i++) if (list[i]!.artistKey === list[i - 1]!.artistKey) bad.push(`${i - 1}/${i}:${list[i]!.artistKey}`);
  return bad;
}

const ids = (list: DraftTrack[]) => list.map((t) => t.id).sort();

describe('effectiveTier', () => {
  it('keeps an explicit tier', () => {
    expect(effectiveTier({ name: 'A', tier: 'headliner' }, true)).toBe('headliner');
    expect(effectiveTier({ name: 'A', tier: 'sub' }, false)).toBe('sub');
  });
  it('untiered artists are undercard on a tiered lineup and flat otherwise', () => {
    expect(effectiveTier({ name: 'A' }, true)).toBe('undercard');
    expect(effectiveTier({ name: 'A' }, false)).toBe('flat');
  });
});

describe('targetFor', () => {
  it('reads per-tier counts, flat uses the sub count', () => {
    expect(targetFor('headliner', baseOpts)).toBe(5);
    expect(targetFor('sub', baseOpts)).toBe(3);
    expect(targetFor('undercard', baseOpts)).toBe(2);
    expect(targetFor('flat', baseOpts)).toBe(3);
  });
  it('tracksPerArtist overrides every tier (floored, never negative)', () => {
    const o = { ...baseOpts, tracksPerArtist: 4.7 };
    expect(targetFor('headliner', o)).toBe(4);
    expect(targetFor('undercard', o)).toBe(4);
    expect(targetFor('flat', { ...baseOpts, tracksPerArtist: -2 })).toBe(0);
    expect(targetFor('sub', { ...baseOpts, tracksPerArtist: 0 })).toBe(0);
  });
});

describe('applyStepwiseCap', () => {
  const lineup: { tier: Tier }[] = [
    { tier: 'headliner' }, { tier: 'headliner' },
    { tier: 'sub' }, { tier: 'sub' }, { tier: 'sub' },
    { tier: 'undercard' }, { tier: 'undercard' }, { tier: 'undercard' }, { tier: 'undercard' }, { tier: 'undercard' },
  ];
  const targets = [5, 5, 3, 3, 3, 2, 2, 2, 2, 2]; // sum 29

  it('is a no-op (returning a copy) when under the cap', () => {
    const out = applyStepwiseCap(lineup, targets, 29);
    expect(out).toEqual(targets);
    expect(out).not.toBe(targets);
    expect(applyStepwiseCap(lineup, targets, 1000)).toEqual(targets);
    expect(applyStepwiseCap([], [], 0)).toEqual([]);
  });

  it('does not mutate the input', () => {
    const copy = targets.slice();
    applyStepwiseCap(lineup, targets, 10);
    expect(targets).toEqual(copy);
  });

  it('reduces undercard first', () => {
    expect(applyStepwiseCap(lineup, targets, 25)).toEqual([5, 5, 3, 3, 3, 1, 1, 1, 1, 1]);
  });

  it('then sub, then headliner, one step each', () => {
    expect(applyStepwiseCap(lineup, targets, 20)).toEqual([4, 4, 2, 2, 2, 1, 1, 1, 1, 1]);
  });

  it('keeps stepping headliners down before anyone is removed', () => {
    const out = applyStepwiseCap(lineup, targets, 12);
    expect(out).toEqual([2, 2, 1, 1, 1, 1, 1, 1, 1, 1]);
    expect(out.every((n) => n >= 1)).toBe(true);
  });

  it('never removes an artist while any artist still has more than one track', () => {
    for (let cap = 10; cap <= 29; cap++) {
      const out = applyStepwiseCap(lineup, targets, cap);
      const sum = out.reduce((a, b) => a + b, 0);
      expect(sum, `cap ${cap}`).toBeLessThanOrEqual(cap);
      expect(out.every((n) => n >= 1), `cap ${cap} removed an artist: ${out}`).toBe(true);
    }
  });

  it('removes undercard artists last-on-lineup first only once everyone is at one', () => {
    expect(applyStepwiseCap(lineup, targets, 7)).toEqual([1, 1, 1, 1, 1, 1, 1, 0, 0, 0]);
    expect(applyStepwiseCap(lineup, targets, 5)).toEqual([1, 1, 1, 1, 1, 0, 0, 0, 0, 0]);
  });

  it('removes sub artists (last first) after all undercard are gone, keeping headliners', () => {
    expect(applyStepwiseCap(lineup, targets, 3)).toEqual([1, 1, 1, 0, 0, 0, 0, 0, 0, 0]);
    expect(applyStepwiseCap(lineup, targets, 2)).toEqual([1, 1, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(applyStepwiseCap(lineup, targets, 1)).toEqual([1, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it('treats flat artists between undercard and sub', () => {
    const l: { tier: Tier }[] = [{ tier: 'flat' }, { tier: 'flat' }, { tier: 'flat' }];
    expect(applyStepwiseCap(l, [3, 3, 3], 6)).toEqual([2, 2, 2]);
    expect(applyStepwiseCap(l, [3, 3, 3], 2)).toEqual([1, 1, 0]);
  });

  it('leaves zero targets at zero', () => {
    const l: { tier: Tier }[] = [{ tier: 'headliner' }, { tier: 'undercard' }, { tier: 'undercard' }];
    expect(applyStepwiseCap(l, [5, 0, 2], 4)).toEqual([3, 0, 1]);
  });
});

describe('songKey', () => {
  it('is catalogue independent', () => {
    expect(songKey('Song (Live)', 'The Artist')).toBe(songKey('Song', 'Artist'));
    expect(songKey('Song - Radio Edit', 'A$AP Rocky')).toBe('song|asap rocky');
  });
});

describe('seededRandom', () => {
  it('is deterministic for a seed and yields values in [0, 1)', () => {
    const a = seededRandom(42);
    const b = seededRandom(42);
    const seqA = Array.from({ length: 200 }, () => a());
    const seqB = Array.from({ length: 200 }, () => b());
    expect(seqA).toEqual(seqB);
    for (const v of seqA) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
    expect(new Set(seqA).size).toBeGreaterThan(150);
  });

  it('differs between seeds and copes with seed 0', () => {
    const a = seededRandom(1)();
    const b = seededRandom(2)();
    expect(a).not.toBe(b);
    const zero = seededRandom(0);
    const vals = Array.from({ length: 5 }, () => zero());
    expect(new Set(vals).size).toBe(5);
  });
});

describe('shuffle', () => {
  const tracks = Array.from({ length: 20 }, (_, i) => mk(`a${i % 4}`, i));

  it('is deterministic by seed and preserves all tracks', () => {
    const x = shuffle(tracks, 7);
    const y = shuffle(tracks, 7);
    expect(x.map((t) => t.id)).toEqual(y.map((t) => t.id));
    expect(ids(x)).toEqual(ids(tracks));
    expect(x).not.toBe(tracks);
  });

  it('changes order for different seeds and does not mutate input', () => {
    const before = tracks.map((t) => t.id);
    const x = shuffle(tracks, 7).map((t) => t.id);
    const y = shuffle(tracks, 8).map((t) => t.id);
    expect(x).not.toEqual(y);
    expect(x).not.toEqual(before);
    expect(tracks.map((t) => t.id)).toEqual(before);
  });
});

describe('interleave', () => {
  it('spreads a realistic tiered lineup with no adjacent same-artist tracks', () => {
    const tracks: DraftTrack[] = [];
    const order: string[] = [];
    for (let i = 0; i < 3; i++) {
      order.push(`h${i}`);
      for (let k = 0; k < 5; k++) tracks.push(mk(`h${i}`, k));
    }
    for (let i = 0; i < 10; i++) {
      order.push(`s${i}`);
      for (let k = 0; k < 3; k++) tracks.push(mk(`s${i}`, k));
    }
    for (let i = 0; i < 30; i++) {
      order.push(`u${i}`);
      for (let k = 0; k < 2; k++) tracks.push(mk(`u${i}`, k));
    }
    const out = interleave(tracks, order);
    expect(out.length).toBe(105);
    expect(ids(out)).toEqual(ids(tracks));
    expect(noAdjacentDuplicates(out)).toEqual([]);
    // Headliners are spread over the whole playlist, not clumped.
    const h0 = out.map((t, i) => (t.artistKey === 'h0' ? i : -1)).filter((i) => i >= 0);
    expect(h0[0]).toBeLessThan(20);
    expect(h0[h0.length - 1]).toBeGreaterThan(85);
  });

  it('alternates two artists with equal counts', () => {
    const tracks = [mk('a', 0), mk('a', 1), mk('a', 2), mk('b', 0), mk('b', 1), mk('b', 2)];
    const out = interleave(tracks, ['a', 'b']);
    expect(out.map((t) => t.artistKey)).toEqual(['a', 'b', 'a', 'b', 'a', 'b']);
  });

  it("keeps each artist's own tracks in their original relative order", () => {
    const tracks = [mk('a', 0), mk('a', 1), mk('a', 2), mk('b', 0), mk('c', 0), mk('c', 1)];
    const out = interleave(tracks, ['a', 'b', 'c']);
    expect(out.filter((t) => t.artistKey === 'a').map((t) => t.id)).toEqual(['a-0', 'a-1', 'a-2']);
    expect(ids(out)).toEqual(ids(tracks));
    expect(noAdjacentDuplicates(out)).toEqual([]);
  });

  it('returns a copy unchanged for fewer than three tracks', () => {
    const tracks = [mk('a', 0), mk('a', 1)];
    const out = interleave(tracks, ['a']);
    expect(out).toEqual(tracks);
    expect(out).not.toBe(tracks);
    expect(interleave([], [])).toEqual([]);
  });

  it('copes with artists not present in artistOrder', () => {
    const tracks = [mk('a', 0), mk('z', 0), mk('a', 1), mk('z', 1)];
    const out = interleave(tracks, ['a']);
    expect(ids(out)).toEqual(ids(tracks));
    expect(noAdjacentDuplicates(out)).toEqual([]);
  });
});

describe('orderTracks', () => {
  const artists = [
    artist('a', 'headliner', { day: 'friday', known: true }),
    artist('b', 'sub', { day: 'saturday' }),
    artist('c', 'undercard', { day: 'friday', known: true }),
    artist('d', 'undercard', { day: 'saturday' }),
  ];
  // deliberately scrambled input order
  const tracks = [mk('d', 0), mk('b', 0), mk('a', 0), mk('c', 0), mk('a', 1), mk('b', 1), mk('d', 1), mk('a', 2), mk('c', 1), mk('b', 2)];

  it('lineup groups tracks by artist in lineup order', () => {
    const out = orderTracks(tracks, artists, 'lineup');
    expect(out.map((t) => t.id)).toEqual(['a-0', 'a-1', 'a-2', 'b-0', 'b-1', 'b-2', 'c-0', 'c-1', 'd-0', 'd-1']);
  });

  it('by_day keeps each day together, interleaved within the day', () => {
    const out = orderTracks(tracks, artists, 'by_day');
    expect(ids(out)).toEqual(ids(tracks));
    const days = out.map((t) => artists.find((a) => a.key === t.artistKey)!.day);
    const firstSat = days.indexOf('saturday');
    expect(days.slice(0, firstSat).every((d) => d === 'friday')).toBe(true);
    expect(days.slice(firstSat).every((d) => d === 'saturday')).toBe(true);
    expect(noAdjacentDuplicates(out.slice(0, firstSat))).toEqual([]);
    expect(noAdjacentDuplicates(out.slice(firstSat))).toEqual([]);
  });

  it('by_day groups artists with no day into their own block', () => {
    const arts = [artist('a', 'sub'), artist('b', 'sub', { day: 'friday' })];
    const out = orderTracks([mk('b', 0), mk('a', 0), mk('b', 1), mk('a', 1)], arts, 'by_day');
    expect(out.map((t) => t.artistKey)).toEqual(['a', 'a', 'b', 'b']);
  });

  it('known_first puts known artists before new ones', () => {
    const out = orderTracks(tracks, artists, 'known_first');
    expect(ids(out)).toEqual(ids(tracks));
    const known = out.map((t) => !!artists.find((a) => a.key === t.artistKey)!.known);
    const firstNew = known.indexOf(false);
    expect(firstNew).toBe(5);
    expect(known.slice(firstNew).every((k) => !k)).toBe(true);
    expect(noAdjacentDuplicates(out.slice(0, firstNew))).toEqual([]);
    expect(noAdjacentDuplicates(out.slice(firstNew))).toEqual([]);
  });

  it('shuffle is deterministic via the seed', () => {
    expect(orderTracks(tracks, artists, 'shuffle', 5).map((t) => t.id)).toEqual(shuffle(tracks, 5).map((t) => t.id));
    expect(orderTracks(tracks, artists, 'shuffle', 5).map((t) => t.id)).not.toEqual(orderTracks(tracks, artists, 'shuffle', 6).map((t) => t.id));
  });

  it('interleave (default) avoids adjacent same-artist tracks', () => {
    for (const mode of ['interleave', 'bogus'] as const) {
      const out = orderTracks(tracks, artists, mode as 'interleave');
      expect(ids(out)).toEqual(ids(tracks));
      expect(noAdjacentDuplicates(out)).toEqual([]);
    }
  });
});

describe('trimToDuration', () => {
  const artists = [artist('h', 'headliner'), artist('s', 'sub'), artist('u', 'undercard')];
  const min = (m: number) => m * 60_000;
  const tracks = [
    mk('h', 0, { durationMs: min(4) }), mk('h', 1, { durationMs: min(4) }), mk('h', 2, { durationMs: min(4) }),
    mk('s', 0, { durationMs: min(4) }), mk('s', 1, { durationMs: min(4) }),
    mk('u', 0, { durationMs: min(4) }), mk('u', 1, { durationMs: min(4) }),
  ]; // 28 minutes

  it('returns everything (as a copy) when it already fits', () => {
    const out = trimToDuration(tracks, artists, min(28));
    expect(out).toEqual(tracks);
    expect(out).not.toBe(tracks);
  });

  it('drops the last track of undercard artists first', () => {
    const out = trimToDuration(tracks, artists, min(24));
    expect(out.map((t) => t.id)).toEqual(['h-0', 'h-1', 'h-2', 's-0', 's-1', 'u-0']);
  });

  it('then sub, then headliner, one track per artist per step', () => {
    expect(trimToDuration(tracks, artists, min(20)).map((t) => t.id)).toEqual(['h-0', 'h-1', 'h-2', 's-0', 'u-0']);
    expect(trimToDuration(tracks, artists, min(16)).map((t) => t.id)).toEqual(['h-0', 'h-1', 's-0', 'u-0']);
    expect(trimToDuration(tracks, artists, min(12)).map((t) => t.id)).toEqual(['h-0', 's-0', 'u-0']);
  });

  it('removes whole artists (undercard first) only when everyone is at one track', () => {
    expect(trimToDuration(tracks, artists, min(8)).map((t) => t.id)).toEqual(['h-0', 's-0']);
    expect(trimToDuration(tracks, artists, min(4)).map((t) => t.id)).toEqual(['h-0']);
    expect(trimToDuration(tracks, artists, 0)).toEqual([]);
  });

  it('does not mutate the input', () => {
    const before = tracks.map((t) => t.id);
    trimToDuration(tracks, artists, min(4));
    expect(tracks.map((t) => t.id)).toEqual(before);
  });
});
