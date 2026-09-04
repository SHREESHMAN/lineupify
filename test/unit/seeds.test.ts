import { describe, expect, it } from 'vitest';
import { aggregatePlaylistArtists, countryName, mapLimit, mergeSeedArtists, rankPlaylistCandidates, scoreBlend, seedLabel } from '../../src/engine/seeds.js';

describe('mergeSeedArtists', () => {
  it('sums weights across lists, keeps the first spelling and ids, sorts by weight', () => {
    const out = mergeSeedArtists([
      [{ name: 'Slowdive', weight: 1 }, { name: 'Ride', weight: 0.5, deezerId: 7 }],
      [{ name: 'slowdive', weight: 2, deezerId: 3 }, { name: 'Lush', weight: 0.4 }],
    ]);
    expect(out.map((a) => a.name)).toEqual(['Slowdive', 'Ride', 'Lush']);
    expect(out[0]).toMatchObject({ weight: 3, deezerId: 3 });
  });
});

describe('rankPlaylistCandidates', () => {
  const results = [
    { id: 1, title: 'you\'re dreaming', nbTracks: 50, userName: 'Georges - Deezer Alternative Editor' },
    { id: 2, title: 'Shoegaze Essentials', nbTracks: 80, userName: 'someone' },
    { id: 3, title: 'tiny', nbTracks: 4, userName: 'someone' },
    { id: 4, title: 'Random pop', nbTracks: 40, userName: 'someone' },
  ];
  it('prefers title matches and Deezer editors, drops tiny lists and unrelated ones', () => {
    const ranked = rankPlaylistCandidates('shoegaze', results);
    expect(ranked.map((p) => p.id)).toEqual([2, 1]);
  });
  it('can restrict to official playlists', () => {
    expect(rankPlaylistCandidates('Top Brazil', [{ id: 9, title: 'Top Brazil', nbTracks: 100, userName: 'Deezer Charts' }, { id: 8, title: 'Top Brazil 2020', nbTracks: 100, userName: 'fan' }], { officialOnly: true }).map((p) => p.id)).toEqual([9]);
  });
});

describe('aggregatePlaylistArtists', () => {
  it('values presence on several playlists over repeats within one', () => {
    const out = aggregatePlaylistArtists([
      { weight: 1, tracks: [{ artistName: 'Beach House', artistId: 1 }, { artistName: 'Slowdive' }, { artistName: 'Beach House', artistId: 1 }] },
      { weight: 0.5, tracks: [{ artistName: 'Slowdive' }, { artistName: 'Ride' }] },
    ]);
    expect(out.map((a) => a.name)).toEqual(['Slowdive', 'Beach House', 'Ride']);
    expect(out[1]!.deezerId).toBe(1);
    expect(out[0]!.weight).toBeGreaterThan(out[1]!.weight);
  });
});

describe('scoreBlend', () => {
  const sides = [
    { label: 'A', direct: [{ name: 'Mitski', weight: 3 }, { name: 'Beach House', weight: 2 }], expanded: [{ name: 'Clairo', weight: 1 }, { name: 'Alvvays', weight: 1 }] },
    { label: 'B', direct: [{ name: 'Clairo', weight: 3 }, { name: 'Phoebe Bridgers', weight: 2 }], expanded: [{ name: 'Mitski', weight: 1 }, { name: 'Alvvays', weight: 0.5 }] },
  ];
  it('keeps artists on enough sides and ranks direct presence first', () => {
    const { artists, sidesOf } = scoreBlend(sides, 2);
    expect(artists.map((a) => a.name)).toEqual(['Mitski', 'Clairo', 'Alvvays']);
    expect(sidesOf.get('mitski')).toBe(2);
    expect(sidesOf.get('beach house')).toBeUndefined();
  });
  it('with minShared 1 everything is kept, most-shared first', () => {
    const { artists } = scoreBlend(sides, 1);
    expect(artists.length).toBe(5);
    expect(artists.slice(0, 3).map((a) => a.name)).toEqual(['Mitski', 'Clairo', 'Alvvays']);
  });
});

describe('countryName / seedLabel / mapLimit', () => {
  it('maps codes and capitalises names', () => {
    expect(countryName('br')).toBe('Brazil');
    expect(countryName('UK')).toBe('United Kingdom');
    expect(countryName('south africa')).toBe('South Africa');
  });
  it('labels seeds', () => {
    expect(seedLabel({ type: 'similar_to', value: 'Khruangbin' })).toBe('similar_to "Khruangbin"');
    expect(seedLabel({ type: 'blend', sources: ['a', 'me'] })).toBe('blend a + me');
    expect(seedLabel({ type: 'chart' })).toBe('chart');
  });
  it('mapLimit preserves order and bounds concurrency', async () => {
    let running = 0;
    let peak = 0;
    const out = await mapLimit([1, 2, 3, 4, 5], 2, async (n) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
      return n * 2;
    });
    expect(out).toEqual([2, 4, 6, 8, 10]);
    expect(peak).toBe(2);
  });
});
