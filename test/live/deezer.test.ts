/**
 * Live Deezer resolution (network). Run with: npm run test:live
 * Verifies the artist picker against real data, including the duplicate-name
 * traps and featured-track partitioning.
 */
import { describe, expect, it } from 'vitest';
import { pickArtist, searchArtists, artistTopTracks, trackDetails, relatedArtists, chartArtists, searchPlaylists, playlistTracks, trackByIsrc, searchTracksByTitle } from '../../src/sources/deezer.js';
import { fold } from '../../src/engine/normalize.js';

const CASES: { query: string; expectId: number; minFans: number }[] = [
  { query: 'Genesis', expectId: 3037, minFans: 1_000_000 },
  { query: 'Fred again..', expectId: 76053262, minFans: 50_000 },
  { query: 'Wet Leg', expectId: 0, minFans: 20_000 },
  { query: 'Tyler, The Creator', expectId: 0, minFans: 500_000 },
  { query: 'Simon & Garfunkel', expectId: 0, minFans: 500_000 },
  { query: 'Simon and Garfunkel', expectId: 0, minFans: 500_000 },
  { query: 'Kneecap', expectId: 0, minFans: 5_000 },
  { query: '!!!', expectId: 0, minFans: 5_000 },
  { query: 'Four Tet', expectId: 0, minFans: 100_000 },
];

describe('live deezer', () => {
  for (const c of CASES) {
    it(`resolves ${c.query}`, async () => {
      const results = await searchArtists(c.query);
      const pick = pickArtist(c.query, results);
      expect(pick, `no pick for ${c.query} among ${results.map((r) => `${r.name}(${r.nbFan})`).join(', ')}`).toBeTruthy();
      expect(pick!.artist.nbFan).toBeGreaterThanOrEqual(c.minFans);
      if (c.expectId) expect(pick!.artist.id).toBe(c.expectId);
      expect(fold(pick!.artist.name)).toBe(fold(c.query));
    }, 30_000);
  }

  it('partitions Fred again.. top tracks into lead and featured and finds ISRCs', async () => {
    const top = await artistTopTracks(76053262, 10);
    expect(top.length).toBeGreaterThan(5);
    expect(top.some((t) => t.role === 'featured')).toBe(true);
    expect(top.some((t) => t.role === 'lead')).toBe(true);
    const lead = top.find((t) => t.role === 'lead')!;
    const d = await trackDetails(lead.deezerTrackId!);
    expect(d?.isrc).toMatch(/^[A-Z]{2}[A-Z0-9]{3}\d{7}$/);
  }, 30_000);

  it('related artists, chart, playlist search, playlist tracks and ISRC lookup respond with usable data', async () => {
    const related = await relatedArtists(27, 5); // Daft Punk
    expect(related.length).toBeGreaterThan(2);
    expect(related.every((a) => a.nbFan > 0)).toBe(true);
    const chart = await chartArtists(5);
    expect(chart.length).toBeGreaterThan(2);
    const lists = await searchPlaylists('shoegaze', 10);
    expect(lists.length).toBeGreaterThan(0);
    const tracks = await playlistTracks(lists[0]!.id, 10);
    expect(tracks.tracks.length).toBeGreaterThan(0);
    expect(tracks.tracks[0]!.artistName).toBeTruthy();
    const yellow = await trackByIsrc('GBAYE0601498');
    expect(yellow?.bpm).toBeGreaterThan(50);
    expect(yellow?.rank).toBeGreaterThan(0);
    const hits = await searchTracksByTitle('Enter Sandman', 10);
    expect(hits[0]?.artistName).toBe('Metallica');
  }, 60_000);

  it('returns nothing for a nonsense name instead of a wrong artist', async () => {
    const results = await searchArtists('zzqx nonexistent artist 9182');
    expect(pickArtist('zzqx nonexistent artist 9182', results)).toBeUndefined();
  }, 30_000);
});
