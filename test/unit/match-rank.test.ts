import { describe, it, expect } from 'vitest';
import type { SpotifyTrack } from '../../src/types.js';
import { rankIsrcHits } from '../../src/engine/match.js';

function hit(id: string, extra: Partial<SpotifyTrack> & { artist?: string } = {}): SpotifyTrack {
  const { artist = 'Genesis', ...rest } = extra;
  return {
    uri: `spotify:track:${id}`,
    id,
    name: 'Song',
    artists: [{ id: `ar-${artist}`, name: artist }],
    albumName: 'Album',
    albumType: 'album',
    releaseDate: '1991-01-01',
    trackNumber: 5,
    durationMs: 200_000,
    explicit: false,
    isrc: 'GBUM71029604',
    isPlayable: true,
    ...rest,
  };
}

describe('rankIsrcHits', () => {
  it('returns undefined with no playable hits', () => {
    expect(rankIsrcHits([], 'Genesis')).toBeUndefined();
    expect(rankIsrcHits([hit('a', { isPlayable: false }), hit('b', { isPlayable: false })], 'Genesis')).toBeUndefined();
  });

  it('drops unplayable hits even when they would otherwise rank first', () => {
    const hits = [hit('album', { isPlayable: false }), hit('comp', { albumType: 'compilation' })];
    expect(rankIsrcHits(hits, 'Genesis')?.id).toBe('comp');
  });

  it('prefers hits credited to the lead artist over better-ranked hits by others', () => {
    const hits = [hit('other', { artist: 'Various Artists', albumType: 'album', releaseDate: '1980-01-01' }), hit('mine', { albumType: 'compilation', releaseDate: '2010-01-01' })];
    expect(rankIsrcHits(hits, 'Genesis')?.id).toBe('mine');
    // Artist match is fold-based and prefix tolerant (any artist slot counts).
    expect(rankIsrcHits([hit('x', { artists: [{ id: '1', name: 'Someone' }, { id: '2', name: 'Fred again..' }] }), hit('y', { artist: 'Nobody' })], 'Fred again')?.id).toBe('x');
  });

  it('falls back to all playable hits when none matches the artist', () => {
    const hits = [hit('a', { artist: 'X', albumType: 'single' }), hit('b', { artist: 'Y', albumType: 'album' })];
    expect(rankIsrcHits(hits, 'Genesis')?.id).toBe('b');
  });

  it('ranks album > single > compilation > unknown types', () => {
    const hits = [hit('weird', { albumType: 'ep' }), hit('comp', { albumType: 'compilation' }), hit('single', { albumType: 'single' }), hit('album', { albumType: 'album' })];
    expect(rankIsrcHits(hits, 'Genesis')?.id).toBe('album');
    expect(rankIsrcHits(hits.filter((h) => h.id !== 'album'), 'Genesis')?.id).toBe('single');
    expect(rankIsrcHits(hits.filter((h) => h.id !== 'album' && h.id !== 'single'), 'Genesis')?.id).toBe('comp');
  });

  it('prefers the earliest release within the same album type', () => {
    const hits = [hit('reissue', { releaseDate: '2007-05-01' }), hit('orig', { releaseDate: '1991-11-11' }), hit('later', { releaseDate: '1999-01-01' })];
    expect(rankIsrcHits(hits, 'Genesis')?.id).toBe('orig');
    // Album type still beats an earlier single.
    expect(rankIsrcHits([hit('single', { albumType: 'single', releaseDate: '1990-01-01' }), hit('album', { releaseDate: '1991-01-01' })], 'Genesis')?.id).toBe('album');
  });

  it('prefers the lowest track number when type and date tie', () => {
    const hits = [hit('t9', { trackNumber: 9 }), hit('t2', { trackNumber: 2 }), hit('t4', { trackNumber: 4 })];
    expect(rankIsrcHits(hits, 'Genesis')?.id).toBe('t2');
  });

  it('does not mutate the input array', () => {
    const hits = [hit('b', { trackNumber: 2 }), hit('a', { trackNumber: 1 })];
    rankIsrcHits(hits, 'Genesis');
    expect(hits.map((h) => h.id)).toEqual(['b', 'a']);
  });
});
