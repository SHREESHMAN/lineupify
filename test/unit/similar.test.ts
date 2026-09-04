/** Pure similar_songs helpers: score merging across sources, per-artist grouping, ListenBrainz row parsing. */
import { describe, expect, it } from 'vitest';
import { groupByArtist, leadOfCredit, mergeSimilarSongs } from '../../src/engine/similar.js';
import { parseSimilarRows } from '../../src/sources/listenbrainz.js';

describe('mergeSimilarSongs', () => {
  it('normalises each list, sums per song, boosts songs found by both sources and keeps order on ties', () => {
    const out = mergeSimilarSongs([
      { source: 'lastfm', songs: [{ title: 'Liggi', artist: 'Ritviz', score: 1 }, { title: 'Uff Teri Adaa', artist: 'Shankar Mahadevan', score: 0.5 }, { title: 'Paro', artist: 'Aditya Rikhari', score: 0.36 }] },
      { source: 'listenbrainz', songs: [{ title: 'Choo Lo', artist: 'The Local Train', score: 37 }, { title: 'Paro', artist: 'Aditya Rikhari', score: 33 }, { title: 'Kasoor', artist: 'Prateek Kuhad', score: 24 }] },
    ]);
    expect(out[0]).toMatchObject({ title: 'Paro', sources: ['lastfm', 'listenbrainz'] });
    // Paro: 3rd on Last.fm (1/1.2) + 2nd on ListenBrainz (1/1.1) + both-sources bonus.
    expect(out[0]!.score).toBeCloseTo(1 / 1.2 + 1 / 1.1 + 0.25, 5);
    // Liggi and Choo Lo both top their list (1.0); Liggi was seen first.
    expect(out.map((s) => s.title)).toEqual(['Paro', 'Liggi', 'Choo Lo', 'Uff Teri Adaa', 'Kasoor']);
  });

  it('treats "Song (Remastered)" and "Song" by the same artist as one song', () => {
    const out = mergeSimilarSongs([
      { source: 'lastfm', songs: [{ title: 'Let It Be (Remastered 2009)', artist: 'The Beatles', score: 0.8 }] },
      { source: 'listenbrainz', songs: [{ title: 'Let It Be', artist: 'The Beatles', score: 10 }] },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.sources).toEqual(['lastfm', 'listenbrainz']);
  });

  it('drops rows without an artist and survives an all-zero list', () => {
    const out = mergeSimilarSongs([{ source: 'listenbrainz', songs: [{ title: 'x', artist: '', score: 5 }, { title: 'y', artist: 'Z', score: 0 }] }]);
    expect(out.map((s) => s.title)).toEqual(['y']);
    // Position is what counts: second in its list, even with a zero raw score.
    expect(out[0]!.score).toBeCloseTo(1 / 1.1, 5);
  });
});

describe('groupByArtist', () => {
  const songs = [
    { title: 'A', artist: 'One', score: 2, sources: ['lastfm' as const] },
    { title: 'B', artist: 'Two', score: 1.5, sources: ['listenbrainz' as const] },
    { title: 'C', artist: 'one', score: 1, sources: ['lastfm' as const, 'listenbrainz' as const] },
    { title: 'A', artist: 'One', score: 0.5, sources: ['lastfm' as const] },
    { title: 'D', artist: 'One', score: 0.4, sources: ['listenbrainz' as const] },
  ];
  it('groups in first-appearance order, sums weights, dedupes titles and pins candidates in rank order', () => {
    const g = groupByArtist(songs);
    expect(g.map((x) => x.name)).toEqual(['One', 'Two']);
    expect(g[0]!.weight).toBeCloseTo(3.4, 5);
    expect(g[0]!.candidates.map((c) => c.title)).toEqual(['A', 'C', 'D']);
    expect(g[0]!.candidates.map((c) => c.rank)).toEqual([0, 2, 3]);
    expect(g[0]!.candidates[1]).toMatchObject({ source: 'lastfm', role: 'lead', leadArtist: 'one', titleShort: 'C' });
    expect(g[1]!.candidates[0]!.source).toBe('listenbrainz');
  });
  it('caps songs per artist when asked', () => {
    const g = groupByArtist(songs, 2);
    expect(g[0]!.candidates.map((c) => c.title)).toEqual(['A', 'C']);
  });
});

describe('leadOfCredit', () => {
  it('takes the first artist of a credit string and keeps the rest as contributors', () => {
    expect(leadOfCredit('Tanishk Bagchi, Arijit Singh & Asees Kaur')).toEqual({ lead: 'Tanishk Bagchi', all: ['Tanishk Bagchi', 'Arijit Singh', 'Asees Kaur'] });
    expect(leadOfCredit('Fred again.. feat. Future')).toEqual({ lead: 'Fred again..', all: ['Fred again..', 'Future'] });
    expect(leadOfCredit('Simon & Garfunkel').lead).toBe('Simon');
    expect(leadOfCredit('Kanye West').all).toEqual(['Kanye West']);
  });
  it('groups a credited song under the lead artist', () => {
    const g = groupByArtist([{ title: 'Bolna', artist: 'Tanishk Bagchi, Arijit Singh & Asees Kaur', score: 1, sources: ['listenbrainz'] }]);
    expect(g[0]!.name).toBe('Tanishk Bagchi');
    expect(g[0]!.candidates[0]!.contributors).toEqual(['Tanishk Bagchi', 'Arijit Singh', 'Asees Kaur']);
  });
});

describe('parseSimilarRows', () => {
  it('keeps rows with a recording and an artist, sorted by score', () => {
    const rows = parseSimilarRows([
      { recording_mbid: 'a', recording_name: 'Choo Lo', artist_credit_name: 'The Local Train', score: 37 },
      { recording_mbid: 'b', recording_name: 'Kasoor', artist_name: 'Prateek Kuhad', score: 40 },
      { recording_mbid: 'c', score: 99 },
      { recording_name: 'no mbid', artist_name: 'x', score: 5 },
    ]);
    expect(rows.map((r) => r.title)).toEqual(['Kasoor', 'Choo Lo']);
    expect(rows[1]).toEqual({ mbid: 'a', title: 'Choo Lo', artist: 'The Local Train', score: 37 });
  });
});
