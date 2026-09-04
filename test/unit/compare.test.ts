import { describe, expect, it } from 'vitest';
import type { PlaylistTrack } from '../../src/types.js';
import { compareSides, renderComparison, trackIdentity } from '../../src/engine/compare.js';
import { basicStats } from '../../src/engine/analyze.js';

function t(name: string, artists: string[], extra: Partial<PlaylistTrack> = {}): PlaylistTrack {
  return { name, artists, durationMs: 200_000, explicit: false, ...extra };
}

const a = [t('Washing Machine Heart', ['Mitski'], { isrc: 'US1', year: 2018 }), t('Helena', ['My Chemical Romance'], { uri: 'spotify:track:helena', year: 2004 }), t('Space Song', ['Beach House'], { year: 2015 })];
const b = [t('Washing Machine Heart', ['Mitski'], { isrc: 'US1', year: 2018 }), t('Helena', ['My Chemical Romance'], { uri: 'spotify:track:helena2', year: 2004 }), t('Bags', ['Clairo'], { year: 2019 })];

describe('trackIdentity', () => {
  it('prefers ISRC and URI but always includes the song key', () => {
    expect(trackIdentity(a[0]!)).toEqual(['isrc:US1', 'song:washing machine heart|mitski']);
    expect(trackIdentity(a[2]!)).toEqual(['song:space song|beach house']);
  });
});

describe('compareSides', () => {
  const sides = [
    { label: 'A', tracks: a, artists: [{ name: 'Mitski', weight: 1 }, { name: 'My Chemical Romance', weight: 1 }, { name: 'Beach House', weight: 1 }] },
    { label: 'B', tracks: b, artists: [{ name: 'Mitski', weight: 1 }, { name: 'My Chemical Romance', weight: 1 }, { name: 'Clairo', weight: 1 }] },
  ];
  const c = compareSides(sides);
  it('finds shared artists and tracks (same song under different URIs counts by title)', () => {
    expect(c.sharedArtists).toEqual(['Mitski', 'My Chemical Romance']);
    expect(c.sharedTracks.map((x) => x.name)).toEqual(['Washing Machine Heart', 'Helena']);
    expect(c.pairs[0]!.artistSimilarity).toBeCloseTo(0.5);
    expect(c.pairs[0]!.sharedTracks).toBe(2);
    expect(c.distinct).toEqual([
      { label: 'A', artists: ['Beach House'] },
      { label: 'B', artists: ['Clairo'] },
    ]);
  });
  it('renders one line per fact', () => {
    const out = renderComparison(c);
    expect(out).toContain('Shared by all — artists (2): Mitski, My Chemical Romance');
    expect(out).toContain('A vs B: artist overlap 50%');
    expect(out).toContain('Only in A (1): Beach House');
  });
  it('handles three sides where nothing is shared by all', () => {
    const three = compareSides([...sides, { label: 'C', tracks: [t('Bags', ['Clairo'])], artists: [{ name: 'Clairo', weight: 1 }] }]);
    expect(three.sharedArtists).toEqual([]);
    expect(three.pairs.length).toBe(3);
  });
});

describe('basicStats', () => {
  it('computes counts, decades and concentration', () => {
    const s = basicStats([...a, ...b]);
    expect(s.tracks).toBe(6);
    expect(s.artistCount).toBe(4);
    expect(s.artists[0]!.name).toBe('Mitski');
    expect(s.decades).toEqual([
      { label: '2000s', count: 2 },
      { label: '2010s', count: 4 },
    ]);
    expect(s.yearMin).toBe(2004);
    expect(s.yearMax).toBe(2019);
    expect(s.top5Share).toBe(1);
    expect(s.explicit).toBe(0);
  });
  it('counts unknown years', () => {
    expect(basicStats([t('x', ['y'])]).unknownYear).toBe(1);
  });
});
