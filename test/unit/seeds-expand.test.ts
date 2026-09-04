/** expandSeed per type with Deezer and Last.fm mocked at the module boundary. */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

const home = await fs.mkdtemp(path.join(os.tmpdir(), 'lineupify-seeds-'));
process.env.LINEUPIFY_HOME = home;
process.env.LINEUPIFY_LOG = 'error';

const deezerPlaylists: Record<number, { artistName: string; artistId?: number }[]> = {
  1: [{ artistName: 'Slowdive', artistId: 11 }, { artistName: 'Ride', artistId: 12 }, { artistName: 'Lush', artistId: 13 }],
  2: [{ artistName: 'Ride', artistId: 12 }, { artistName: 'DIIV', artistId: 14 }],
  9: [{ artistName: 'Anitta', artistId: 21 }, { artistName: 'Ana Castela', artistId: 22 }],
};

vi.mock('../../src/sources/deezer.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/sources/deezer.js')>();
  return {
    ...orig,
    searchArtists: async (q: string) => (/khruangbin/i.test(q) ? [{ id: 5, name: 'Khruangbin', nbFan: 90_000 }] : []),
    relatedArtists: async (id: number) => (id === 5 ? [{ id: 6, name: 'Skinshape', nbFan: 40_000 }, { id: 7, name: 'Sault', nbFan: 80_000 }] : id === 11 ? [{ id: 12, name: 'Ride', nbFan: 30_000 }, { id: 15, name: 'Chapterhouse', nbFan: 8_000 }] : id === 14 ? [{ id: 12, name: 'Ride', nbFan: 30_000 }, { id: 16, name: 'Beach Fossils', nbFan: 20_000 }] : []),
    chartArtists: async () => [{ id: 31, name: 'Drake', nbFan: 9_000_000 }, { id: 32, name: 'Olivia Rodrigo', nbFan: 7_000_000 }],
    searchPlaylists: async (q: string) =>
      /shoegaze/i.test(q)
        ? [{ id: 1, title: 'Shoegaze Essentials', nbTracks: 50, userName: 'Deezer Alternative Editor' }, { id: 2, title: 'shoegaze & dream pop', nbTracks: 30, userName: 'fan' }, { id: 3, title: 'Random', nbTracks: 40, userName: 'fan' }]
        : /top brazil/i.test(q)
          ? [{ id: 9, title: 'Top Brazil', nbTracks: 100, userName: 'Deezer Charts' }, { id: 8, title: 'Top Brazil fan mix', nbTracks: 100, userName: 'fan' }]
          : [],
    playlistInfo: async (id: number) => (deezerPlaylists[id] ? { id, title: `List ${id}`, nbTracks: deezerPlaylists[id]!.length, link: `https://www.deezer.com/playlist/${id}` } : undefined),
    playlistTracks: async (id: number) => ({
      tracks: (deezerPlaylists[id] ?? []).map((t, i) => ({ id: id * 100 + i, title: `Song ${i}`, titleShort: `Song ${i}`, titleVersion: '', durationMs: 180_000, explicit: false, artistName: t.artistName, artistId: t.artistId })),
      total: (deezerPlaylists[id] ?? []).length,
    }),
  };
});

vi.mock('../../src/sources/lastfm.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/sources/lastfm.js')>();
  return {
    ...orig,
    tagTopArtists: async () => [{ name: 'Slowdive' }, { name: 'My Bloody Valentine' }],
    similarArtists: async () => [{ name: 'Sault', match: 0.8 }, { name: 'Men I Trust', match: 0.6 }],
    geoTopArtists: async () => [{ name: 'Anitta', listeners: 1000 }, { name: 'Luísa Sonza', listeners: 800 }],
    chartTopArtists: async () => [{ name: 'Drake', listeners: 5000 }],
  };
});

const { expandSeed } = await import('../../src/engine/seeds.js');

afterAll(async () => {
  await fs.rm(home, { recursive: true, force: true }).catch(() => undefined);
});

describe('expandSeed', () => {
  it('genre: Deezer playlists only without a key, merged with Last.fm tags with a key', async () => {
    const dz = await expandSeed({ type: 'genre', value: 'shoegaze', limit: 10 }, {});
    expect(dz.artists.map((a) => a.name)).toEqual(['Ride', 'Slowdive', 'Lush', 'DIIV']);
    expect(dz.note).toContain('Deezer playlists: Shoegaze Essentials, shoegaze & dream pop');
    expect(dz.note).not.toContain('Random');
    const both = await expandSeed({ type: 'genre', value: 'shoegaze', limit: 10 }, { lastfmApiKey: 'k' });
    expect(both.artists.map((a) => a.name)).toContain('My Bloody Valentine');
    expect(both.artists[0]!.name).toBe('Slowdive');
    expect(both.note).toContain('Last.fm tag');
  });

  it('genre with no matching playlists reports why', async () => {
    const r = await expandSeed({ type: 'genre', value: 'zzz nothing' }, {});
    expect(r.artists).toEqual([]);
    expect(r.note).toContain('no public Deezer playlists match');
  });

  it('similar_to: related artists minus the seed, Last.fm added with a key, unknown seed throws', async () => {
    const r = await expandSeed({ type: 'similar_to', value: 'Khruangbin', limit: 5 }, {});
    expect(r.artists.map((a) => a.name)).toEqual(['Skinshape', 'Sault']);
    expect(r.artists[0]!.deezerId).toBe(6);
    const withKey = await expandSeed({ type: 'similar_to', value: 'Khruangbin', limit: 5 }, { lastfmApiKey: 'k' });
    expect(withKey.artists.map((a) => a.name)).toEqual(['Sault', 'Skinshape', 'Men I Trust']);
    await expect(expandSeed({ type: 'similar_to', value: 'Nobody' }, {})).rejects.toMatchObject({ code: 'SEED_ARTIST_NOT_FOUND' });
  });

  it('chart and country', async () => {
    expect((await expandSeed({ type: 'chart', limit: 1 }, {})).artists.map((a) => a.name)).toEqual(['Drake']);
    const br = await expandSeed({ type: 'country', value: 'br', limit: 5 }, {});
    expect(br.artists.map((a) => a.name)).toEqual(['Anitta', 'Ana Castela']);
    expect(br.note).toContain('Top Brazil');
    expect(br.note).not.toContain('fan mix');
    const brKey = await expandSeed({ type: 'country', value: 'Brazil', limit: 5 }, { lastfmApiKey: 'k' });
    expect(brKey.artists[0]!.name).toBe('Anitta');
    expect(brKey.artists.map((a) => a.name)).toContain('Luísa Sonza');
  });

  it('playlist seed reads a Deezer playlist', async () => {
    const r = await expandSeed({ type: 'playlist', value: 'https://www.deezer.com/playlist/1', limit: 2 }, {});
    expect(r.artists.map((a) => a.name)).toEqual(['Slowdive', 'Ride']);
    expect(r.note).toContain('List 1 (3 tracks, 3 artists)');
  });

  it('blend keeps artists on every side, directly or through related artists', async () => {
    const r = await expandSeed({ type: 'blend', sources: ['deezer:playlist:1', 'deezer:playlist:2'], limit: 10 }, {});
    // Ride is on both lists directly; Chapterhouse only relates to side 1; Beach Fossils only to side 2.
    expect(r.artists[0]!.name).toBe('Ride');
    expect(r.artists.map((a) => a.name)).not.toContain('Chapterhouse');
    expect(r.note).toContain('blend of List 1 + List 2');
    await expect(expandSeed({ type: 'blend', sources: ['deezer:playlist:1'] }, {})).rejects.toMatchObject({ code: 'BLEND_NEEDS_SOURCES' });
  });

  it('validates values', async () => {
    await expect(expandSeed({ type: 'genre' }, {})).rejects.toMatchObject({ code: 'SEED_VALUE_REQUIRED' });
    await expect(expandSeed({ type: 'nope' as 'genre' }, {})).rejects.toMatchObject({ code: 'BAD_SEED' });
  });
});
