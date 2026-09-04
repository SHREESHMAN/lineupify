/** Last.fm parsers against canned JSON (the key is optional, so these paths otherwise only run for users with a key). */
import { afterAll, describe, expect, it } from 'vitest';
import { setFetch } from '../../src/infra/http.js';
import * as lastfm from '../../src/sources/lastfm.js';

const KEY = 'k';
const calls: URL[] = [];

const bodies: Record<string, unknown> = {
  'artist.gettoptracks': { toptracks: { '@attr': { artist: 'Wet Leg' }, track: [{ name: 'Chaise Longue', listeners: '900000', artist: { name: 'Wet Leg' } }, { name: 'Intro', listeners: '5000', artist: { name: 'Wet Leg' } }, { name: 'Obscure', listeners: '12', artist: { name: 'Wet Leg' } }] } },
  'tag.gettopartists': { topartists: { artist: [{ name: 'Slowdive' }, { name: 'Ride' }] } },
  'artist.getsimilar': { similarartists: { artist: [{ name: 'Ride', match: '0.9' }, { name: 'Lush', match: '0.4' }] } },
  'geo.gettopartists': { topartists: { artist: [{ name: 'Anitta', listeners: '1200000' }] } },
  'chart.gettopartists': { artists: { artist: [{ name: 'Drake', listeners: '5000000' }] } },
  'artist.gettoptags': { toptags: { tag: [{ name: 'shoegaze', count: 100 }, { name: 'seen live', count: 80 }, { name: 'Dream Pop', count: 60 }, { name: 'rare', count: 3 }, { name: '90s', count: 40 }] } },
  'artist.getinfo': { artist: { name: 'Radiohead' } },
};

setFetch(async (input) => {
  const url = new URL(String(input));
  calls.push(url);
  const method = url.searchParams.get('method') ?? '';
  const body = url.searchParams.get('api_key') === 'bad' ? { error: 10, message: 'Invalid API key' } : (bodies[method] ?? { error: 6, message: 'unknown' });
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
});

afterAll(() => setFetch((...args) => fetch(...args)));

describe('lastfm', () => {
  it('topTracks keeps popular, non-junk tracks and checks the echoed artist', async () => {
    const t = (await lastfm.topTracks(KEY, 'Wet Leg'))!;
    expect(t.map((x) => x.title)).toEqual(['Chaise Longue']);
    expect(t[0]).toMatchObject({ source: 'lastfm', leadArtist: 'Wet Leg', role: 'lead', rank: 0 });
    expect(await lastfm.topTracks(KEY, 'Wet Legg')).toBeUndefined();
    expect(calls.at(-1)!.searchParams.get('autocorrect')).toBe('0');
  });

  it('tag, similar, geo and chart lists parse with listeners and match scores', async () => {
    expect((await lastfm.tagTopArtists(KEY, 'shoegaze')).map((a) => a.name)).toEqual(['Slowdive', 'Ride']);
    expect(await lastfm.similarArtists(KEY, 'Slowdive')).toEqual([
      { name: 'Ride', listeners: undefined, match: 0.9 },
      { name: 'Lush', listeners: undefined, match: 0.4 },
    ]);
    expect(await lastfm.geoTopArtists(KEY, 'Brazil')).toEqual([{ name: 'Anitta', listeners: 1_200_000, match: undefined }]);
    expect((await lastfm.chartTopArtists(KEY))[0]!.listeners).toBe(5_000_000);
    expect(calls.at(-1)!.searchParams.get('limit')).toBe('50');
  });

  it('artistTopTags drops junk tags and low counts, lower-cases, and caps the count', async () => {
    expect(await lastfm.artistTopTags(KEY, 'Slowdive', 2)).toEqual(['shoegaze', 'dream pop']);
    expect(await lastfm.artistTopTags(KEY, 'Slowdive')).toEqual(['shoegaze', 'dream pop']);
  });

  it('an API error answers empty, and validateKey reflects it', async () => {
    expect(await lastfm.tagTopArtists('bad', 'x')).toEqual([]);
    expect(await lastfm.validateKey('bad')).toBe(false);
    expect(await lastfm.validateKey(KEY)).toBe(true);
  });
});
