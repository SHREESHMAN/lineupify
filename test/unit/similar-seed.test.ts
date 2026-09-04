/** similar_songs seed end to end with Last.fm, MusicBrainz/ListenBrainz and the track lookup mocked. */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { SpotifyTrack } from '../../src/types.js';

const home = await fs.mkdtemp(path.join(os.tmpdir(), 'lineupify-similar-'));
process.env.LINEUPIFY_HOME = home;
process.env.LINEUPIFY_LOG = 'error';

const lfmCalls: string[] = [];
vi.mock('../../src/sources/lastfm.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/sources/lastfm.js')>();
  return {
    ...orig,
    similarTracks: async (_key: string, artist: string, track: string, limit: number) => {
      lfmCalls.push(`${artist}|${track}|${limit}`);
      if (/udd gaye/i.test(track)) return [{ title: 'Liggi', artist: 'Ritviz', match: 1 }, { title: 'Uff Teri Adaa', artist: 'Shankar Mahadevan', match: 0.5 }, { title: 'Paro', artist: 'Aditya Rikhari', match: 0.36 }];
      if (/sathi/i.test(track)) return [{ title: 'Paro', artist: 'Aditya Rikhari', match: 0.6 }, { title: 'Bass Rani', artist: 'Nucleya', match: 0.4 }];
      return [];
    },
  };
});

vi.mock('../../src/sources/listenbrainz.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/sources/listenbrainz.js')>();
  return {
    ...orig,
    recordingMbidsByIsrc: async (isrc: string) => (isrc === 'FRX201782605' ? ['mbid-udd'] : []),
    recordingMbidsByNames: async (_artist: string, title: string) => (/sathi/i.test(title) ? ['mbid-sathi'] : []),
    similarRecordings: async (mbid: string) =>
      mbid === 'mbid-udd'
        ? [{ mbid: 'r1', title: 'Choo Lo', artist: 'The Local Train', score: 37 }, { mbid: 'r2', title: 'Paro', artist: 'Aditya Rikhari', score: 33 }]
        : mbid === 'mbid-sathi'
          ? [{ mbid: 'r3', title: 'Kasoor', artist: 'Prateek Kuhad', score: 24 }]
          : [],
  };
});

const { expandSeed } = await import('../../src/engine/seeds.js');

const tracks: Record<string, SpotifyTrack> = {
  'Ritviz - Udd Gaye': { uri: 'spotify:track:udd', id: 'udd', name: 'Udd Gaye', artists: [{ id: 'rv', name: 'Ritviz' }], albumName: 'Ved', albumType: 'album', releaseDate: '2017-01-01', trackNumber: 1, durationMs: 200_000, explicit: false, isPlayable: true, isrc: 'FRX201782605' },
  'Ritviz - Sathi': { uri: 'spotify:track:sathi', id: 'sathi', name: 'Sathi', artists: [{ id: 'rv', name: 'Ritviz' }, { id: 'nu', name: 'Nucleya' }], albumName: 'Baaraat', albumType: 'album', releaseDate: '2021-01-01', trackNumber: 1, durationMs: 200_000, explicit: false, isPlayable: true },
};
const lookupTrack = async (ref: string) => tracks[ref];

afterAll(async () => {
  await fs.rm(home, { recursive: true, force: true }).catch(() => undefined);
});

describe('similar_songs seed', () => {
  it('merges both sources per seed song, unions across seeds, pins songs per artist and keeps seed artists by default', async () => {
    const r = await expandSeed({ type: 'similar_songs', value: 'Ritviz - Udd Gaye', songs: ['Ritviz - Sathi'], limit: 10 }, { lastfmApiKey: 'k', lookupTrack });
    expect(lfmCalls).toContain('Ritviz|Udd Gaye|20');
    // Paro is near both seeds and found by both sources: first.
    expect(r.artists[0]!.name).toBe('Aditya Rikhari');
    const names = r.artists.map((a) => a.name);
    expect(names).toContain('Ritviz');
    expect(names).toContain('The Local Train');
    expect(names).toContain('Prateek Kuhad');
    expect(r.pinned!['aditya rikhari']!.map((c) => c.title)).toEqual(['Paro']);
    expect(r.pinned!['ritviz']!.map((c) => c.title)).toEqual(['Liggi']);
    expect(r.seedSongs!.map((s) => s.title)).toEqual(['Udd Gaye', 'Sathi']);
    expect(r.note).toMatch(/songs by \d+ artists \(\d+ found by both sources\)/);
    expect(r.note).toContain('Last.fm 3, ListenBrainz 2');
  });

  it('excludeSeedArtists drops the seed artists, excludeSeedSongs only the seed songs', async () => {
    const a = await expandSeed({ type: 'similar_songs', value: 'Ritviz - Udd Gaye' }, { lastfmApiKey: 'k', lookupTrack, excludeSeedArtists: true });
    expect(a.artists.map((x) => x.name)).not.toContain('Ritviz');
    expect(a.note).toContain('removed as seed artists/songs');
    const b = await expandSeed({ type: 'similar_songs', value: 'Ritviz - Udd Gaye' }, { lastfmApiKey: 'k', lookupTrack, excludeSeedSongs: true });
    expect(b.artists.map((x) => x.name)).toContain('Ritviz'); // Liggi is not a seed song
  });

  it('works without a Last.fm key on ListenBrainz alone, and names the missing key', async () => {
    const r = await expandSeed({ type: 'similar_songs', value: 'Ritviz - Udd Gaye' }, { lookupTrack });
    expect(r.artists.map((x) => x.name)).toEqual(['The Local Train', 'Aditya Rikhari']);
    // fold() drops a leading "the", so the pinned key is "local train".
    expect(r.pinned!['local train']![0]!.source).toBe('listenbrainz');
    expect(r.note).toContain('no Last.fm key');
  });

  it('respects tracksPerArtist as a per-artist cap and limit as songs per seed', async () => {
    const r = await expandSeed({ type: 'similar_songs', value: 'Ritviz - Udd Gaye', limit: 1 }, { lastfmApiKey: 'k', lookupTrack, tracksPerArtist: 1 });
    const total = Object.values(r.pinned!).reduce((n, c) => n + c.length, 0);
    expect(total).toBe(1);
  });

  it('fails clearly when no seed song can be found', async () => {
    await expect(expandSeed({ type: 'similar_songs', value: 'Nobody - Nothing' }, { lastfmApiKey: 'k', lookupTrack })).rejects.toMatchObject({ code: 'SEED_SONG_NOT_FOUND' });
    await expect(expandSeed({ type: 'similar_songs', value: 'Ritviz - Udd Gaye' }, {})).rejects.toMatchObject({ code: 'SEED_NEEDS_LOOKUP' });
  });
});
