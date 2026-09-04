/** Remote cover check and analysis enrichment with Deezer and Last.fm mocked. */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { DraftTrack, PlaylistTrack } from '../../src/types.js';

const home = await fs.mkdtemp(path.join(os.tmpdir(), 'lineupify-covers-'));
process.env.LINEUPIFY_HOME = home;
process.env.LINEUPIFY_LOG = 'error';

vi.mock('../../src/sources/deezer.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/sources/deezer.js')>();
  return {
    ...orig,
    searchTracksByTitle: async (title: string) =>
      /enter sandman/i.test(title)
        ? [
            { id: 1, title: 'Enter Sandman', titleShort: 'Enter Sandman', titleVersion: '', rank: 900_000, artistName: 'Metallica' },
            { id: 2, title: 'Enter Sandman', titleShort: 'Enter Sandman', titleVersion: '', rank: 100_000, artistName: 'Motörhead' },
          ]
        : /ace of spades/i.test(title)
          ? [{ id: 3, title: 'Ace of Spades', titleShort: 'Ace of Spades', titleVersion: '', rank: 800_000, artistName: 'Motörhead' }]
          : [],
    searchArtists: async (q: string) => (/mitski/i.test(q) ? [{ id: 50, name: 'Mitski', nbFan: 1_000_000 }] : []),
    artistAlbumGenres: async (id: number) => (id === 50 ? [85, 85, 132] : []),
    genres: async () => [
      { id: 85, name: 'Alternative' },
      { id: 132, name: 'Pop' },
    ],
    trackByIsrc: async (isrc: string) => (isrc === 'ISRC1' ? { isrc, bpm: 172, rank: 1 } : isrc === 'ISRC2' ? { isrc, bpm: null } : undefined),
  };
});
vi.mock('../../src/sources/lastfm.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/sources/lastfm.js')>();
  return { ...orig, artistTopTags: async (_key: string, artist: string) => (/mitski/i.test(artist) ? ['indie rock', 'sadcore'] : []) };
});

const { isCoverOnDeezer } = await import('../../src/engine/covers.js');
const { artistGenres, basicStats, enrichStats, renderStats } = await import('../../src/engine/analyze.js');

afterAll(async () => {
  await fs.rm(home, { recursive: true, force: true }).catch(() => undefined);
});

const track = (name: string, artist: string, rank?: number): DraftTrack => ({ id: 't', uri: 'u', spotifyId: 's', name, artists: [artist], artistKey: artist.toLowerCase(), durationMs: 1, explicit: false, matchedVia: 'isrc', source: 'deezer', role: 'lead', rank });

describe('isCoverOnDeezer', () => {
  it('flags a title whose most popular recording is by someone else, and not the original', async () => {
    expect(await isCoverOnDeezer(track('Enter Sandman', 'Motörhead', 100_000), 'Motörhead')).toBe(true);
    expect(await isCoverOnDeezer(track('Enter Sandman', 'Metallica', 900_000), 'Metallica')).toBe(false);
    expect(await isCoverOnDeezer(track('Ace of Spades', 'Motörhead'), 'Motörhead')).toBe(false);
    expect(await isCoverOnDeezer(track('Unknown Song', 'Nobody'), 'Nobody')).toBe(false);
  });
});

describe('analysis enrichment', () => {
  const tracks: PlaylistTrack[] = [
    { name: 'a', artists: ['Mitski'], durationMs: 200_000, explicit: false, isrc: 'ISRC1', year: 2018 },
    { name: 'b', artists: ['Mitski'], durationMs: 180_000, explicit: true, isrc: 'ISRC2', year: 2014 },
    { name: 'c', artists: ['Nobody'], durationMs: 100_000, explicit: false, year: 2001 },
  ];
  it('artistGenres uses Deezer album genres and Last.fm tags, cached', async () => {
    expect(await artistGenres('Mitski', { lastfmApiKey: 'k' })).toEqual({ genres: ['Alternative', 'Pop'], tags: ['indie rock', 'sadcore'] });
    expect(await artistGenres('Nobody', {})).toEqual({ genres: [], tags: [] });
  });
  it('enrichStats adds genre counts weighted by tracks and a tempo distribution', async () => {
    const s = await enrichStats(basicStats(tracks), tracks, { lastfmApiKey: 'k' });
    expect(s.genres).toEqual([
      { label: 'Alternative', count: 2 },
      { label: 'Pop', count: 2 },
    ]);
    expect(s.tags![0]).toEqual({ label: 'indie rock', count: 2 });
    expect(s.bpm).toMatchObject({ known: 1, sampled: 2, median: 172 });
    const out = renderStats(s, 'Mine');
    expect(out).toContain('Genres (Deezer, coarse, by track count of the top artists): Alternative 2 · Pop 2');
    expect(out).toContain('Tempo (Deezer, 1 of 2 sampled): median 172 BPM');
    expect(out).toContain('Decades: 2000s 1 · 2010s 2');
  });
  it('can skip genres and tempo', async () => {
    const s = await enrichStats(basicStats(tracks), tracks, { genres: false, bpm: false });
    expect(s.genres).toBeUndefined();
    expect(s.bpm).toBeUndefined();
  });
});
