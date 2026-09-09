/**
 * The real Deezer client against a canned fetch: the HTTP-200 error bodies
 * (quota code 4 with backoff, "no data" 800, anything else), parsing of the
 * endpoints the engine relies on, paging, and the search ranking rules.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

process.env.LINEUPIFY_LOG = 'error';
const { setFetch, setLimit } = await import('../../src/infra/http.js');
const deezer = await import('../../src/sources/deezer.js');

setLimit('api.deezer.com', 1000, 1000);

type Reply = unknown | ((url: URL) => unknown);
const routes = new Map<string, Reply[]>();
const hits: string[] = [];

/** Queue replies for a path (the last one repeats). */
function on(pathname: string, ...replies: Reply[]): void {
  routes.set(pathname, replies);
}

setFetch(async (input) => {
  const url = new URL(String(input));
  hits.push(url.pathname + url.search);
  const q = routes.get(url.pathname);
  if (!q) return new Response('{}', { status: 500, headers: { 'retry-after': '99' } });
  const r = q.length > 1 ? q.shift()! : q[0]!;
  const body = typeof r === 'function' ? (r as (u: URL) => unknown)(url) : r;
  return Response.json(body);
});

beforeEach(() => {
  routes.clear();
  hits.length = 0;
});
afterAll(() => setFetch((...args) => fetch(...args)));

const artist = (id: number, name: string, nb_fan = 1000) => ({ id, name, nb_fan });

describe('error bodies', () => {
  it('quota (code 4) backs off and retries; "no data" (800) is an empty result', async () => {
    on('/search/artist', { error: { type: 'Exception', message: 'Quota limit exceeded', code: 4 } }, { data: [artist(1, 'Kneecap')] });
    const t0 = Date.now();
    expect(await deezer.searchArtists('Kneecap')).toEqual([{ id: 1, name: 'Kneecap', nbFan: 1000 }]);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900);
    expect(hits.filter((h) => h.startsWith('/search/artist')).length).toBe(2);

    on('/search/artist', { error: { type: 'DataException', message: 'no data', code: 800 } });
    expect(await deezer.searchArtists('nobody')).toEqual([]);
  }, 10_000);

  it('any other error code throws with the code and message', async () => {
    on('/artist/9/top', { error: { type: 'OAuthException', message: 'Invalid OAuth access token', code: 300 } });
    await expect(deezer.artistTopTracks(9)).rejects.toThrow('Deezer error 300: Invalid OAuth access token');
  });
});

describe('parsing', () => {
  it('artistTopTracks marks lead vs featured, drops unreadable tracks and keeps the popularity rank', async () => {
    on('/artist/1/top', {
      data: [
        { id: 11, title: 'Marea (we lost dancing)', title_short: 'Marea', title_version: '(we lost dancing)', duration: 292, explicit_lyrics: false, rank: 900000, readable: true, artist: { id: 1, name: 'Fred again..' }, contributors: [{ id: 1, name: 'Fred again..' }], album: { title: 'Actual Life' } },
        { id: 12, title: 'Baby again..', title_short: 'Baby again..', duration: 300, rank: 800000, readable: true, artist: { id: 4, name: 'Four Tet' }, contributors: [{ id: 4, name: 'Four Tet' }, { id: 1, name: 'Fred again..' }] },
        { id: 13, title: 'Gone', title_short: 'Gone', readable: false, artist: { id: 1, name: 'Fred again..' } },
      ],
    });
    const c = await deezer.artistTopTracks(1, 500);
    expect(hits[0]).toBe('/artist/1/top?limit=100');
    expect(c.map((x) => [x.deezerTrackId, x.role])).toEqual([[11, 'lead'], [12, 'featured']]);
    expect(c[0]).toMatchObject({ source: 'deezer', titleShort: 'Marea', titleVersion: '(we lost dancing)', leadArtist: 'Fred again..', leadArtistId: '1', durationMs: 292_000, explicit: false, album: 'Actual Life', deezerRank: 900000, rank: 0 });
    expect(c[1]!.contributors).toEqual(['Four Tet', 'Fred again..']);
  });

  it('trackByIsrc rounds the tempo, reports a missing tempo as null, and needs an id', async () => {
    on('/track/isrc:GBAYE0601498', { id: 3135556, title: 'Yellow', isrc: 'GBAYE0601498', bpm: 173.71, rank: 700000, release_date: '2000-07-10', duration: 266, explicit_lyrics: false, artist: { id: 892, name: 'Coldplay' }, album: { id: 5 } });
    const d = await deezer.trackByIsrc('GBAYE0601498');
    expect(d).toMatchObject({ isrc: 'GBAYE0601498', bpm: 173.7, rank: 700000, releaseDate: '2000-07-10', durationMs: 266_000, artistName: 'Coldplay', artistId: 892, albumId: 5 });
    on('/track/isrc:XX0000000000', { id: 1, bpm: 0 });
    expect((await deezer.trackByIsrc('XX0000000000'))?.bpm).toBeNull();
    on('/track/isrc:YY0000000000', {});
    expect(await deezer.trackByIsrc('YY0000000000')).toBeUndefined();
  });

  it('playlistTracks pages 100 at a time, honours the cap and reports the total', async () => {
    const page = (from: number, n: number, next: boolean) => ({
      data: Array.from({ length: n }, (_, i) => ({ id: from + i, title: `Song ${from + i}`, title_short: `Song ${from + i}`, isrc: `GB000${String(from + i).padStart(7, '0')}`, duration: 200, explicit_lyrics: false, rank: 1, time_add: 1_700_000_000 + i, artist: { id: 7, name: 'Someone' }, album: { title: 'Al' } })),
      total: 120,
      ...(next ? { next: 'more' } : {}),
    });
    on('/playlist/5/tracks', (u: URL) => (u.searchParams.get('index') === '100' ? page(100, 20, false) : page(0, 100, true)));
    const r = await deezer.playlistTracks(5);
    expect(r.total).toBe(120);
    expect(r.tracks.length).toBe(120);
    expect(r.tracks[0]).toMatchObject({ id: 0, isrc: 'GB0000000000', durationMs: 200_000, artistId: 7, artistName: 'Someone', album: 'Al' });
    expect(r.tracks[0]!.addedAt).toMatch(/^2023-11-14T/);
    expect(hits.filter((h) => h.startsWith('/playlist/5/tracks'))).toEqual(['/playlist/5/tracks?limit=100&index=0', '/playlist/5/tracks?limit=100&index=100']);

    hits.length = 0;
    const capped = await deezer.playlistTracks(5, 30);
    expect(capped.tracks.length).toBe(100);
    expect(hits).toEqual(['/playlist/5/tracks?limit=30&index=0']);
  });

  it('playlistInfo needs an id; trackById refuses unreadable recordings and keeps contributors', async () => {
    on('/playlist/5', { id: 5, title: 'Top France', nb_tracks: 100, fans: 12, public: true, creator: { name: 'Deezer Charts' } });
    expect(await deezer.playlistInfo(5)).toMatchObject({ id: 5, title: 'Top France', creator: 'Deezer Charts', nbTracks: 100, link: 'https://www.deezer.com/playlist/5' });
    on('/playlist/6', { title: 'no id' });
    expect(await deezer.playlistInfo(6)).toBeUndefined();

    on('/track/101', { id: 101, title: 'Texas Sun', isrc: 'USDPP1900001', duration: 250, readable: true, artist: { id: 1, name: 'Khruangbin' }, contributors: [{ name: 'Khruangbin' }, { name: 'Leon Bridges' }], album: { id: 9, title: 'Texas Sun' } });
    const t = await deezer.trackById(101);
    expect(t).toMatchObject({ uri: 'deezer:track:101', id: '101', name: 'Texas Sun', isrc: 'USDPP1900001', durationMs: 250_000, albumName: 'Texas Sun', deezerTrackId: 101, isPlayable: true });
    expect(t!.artists.map((a) => a.name)).toEqual(['Khruangbin', 'Leon Bridges']);
    on('/track/102', { id: 102, title: 'Gone', readable: false });
    expect(await deezer.trackById(102)).toBeUndefined();
  });
});

describe('search ranking', () => {
  it('findTrack wants an exact title, prefers the named artist, then the most popular', async () => {
    on('/search/track', {
      data: [
        { id: 1, title: 'Texas Sun', title_short: 'Texas Sun', rank: 100, readable: true, artist: { name: 'Texas Sun Karaoke Band' } },
        { id: 2, title: 'Texas Sun (Live)', title_short: 'Texas Sun', rank: 900, readable: true, artist: { name: 'Khruangbin' }, isrc: 'US0000000002' },
        { id: 3, title: 'Texas Sunrise', title_short: 'Texas Sunrise', rank: 950, readable: true, artist: { name: 'Khruangbin' } },
        { id: 4, title: 'Texas Sun', title_short: 'Texas Sun', rank: 500, readable: true, artist: { name: 'Someone Else' } },
      ],
    });
    const t = await deezer.findTrack('Texas Sun', 'Khruangbin');
    expect(t?.id).toBe('2');
    // Plain text, not `artist:"x" track:"y"`: the artist field returns zero results
    // from Deezer since 2026-09, so a query carrying it would silently find nothing.
    const q = new URL('https://x' + hits[0]!).searchParams.get('q');
    expect(q).toBe('Khruangbin Texas Sun');
    expect(q).not.toContain('artist:');
    // Featured artist: the name is not on the hit, the exact title still wins over the karaoke clone.
    on('/search/track', { data: [{ id: 5, title: 'Texas Sun', title_short: 'Texas Sun', rank: 700, readable: true, artist: { name: 'Khruangbin' } }, { id: 6, title: 'Texas Sun', title_short: 'Texas Sun', rank: 999, readable: true, artist: { name: 'Karaoke Kings' } }] });
    expect((await deezer.findTrack('Texas Sun', 'Leon Bridges'))?.id).toBe('5');
    on('/search/track', { data: [] });
    expect(await deezer.findTrack('Nothing', 'Nobody')).toBeUndefined();
  });

  it('searchTracksByTitle sorts by rank and drops clones; searchTracksText caps the request and the result', async () => {
    on('/search/track', { data: [{ id: 1, title: 'Enter Sandman', rank: 100, artist: { id: 1, name: 'Metal Tribute Band' } }, { id: 2, title: 'Enter Sandman', rank: 500, artist: { id: 2, name: 'Motörhead' } }, { id: 3, title: 'Enter Sandman', rank: 900, artist: { id: 3, name: 'Metallica' }, isrc: 'USEE19100001' }] });
    const hitsByTitle = await deezer.searchTracksByTitle('Enter Sandman', 10);
    expect(hitsByTitle.map((h) => h.artistName)).toEqual(['Metallica', 'Motörhead']);
    expect(hitsByTitle[0]!.isrc).toBe('USEE19100001');

    hits.length = 0;
    on('/search/track', { data: Array.from({ length: 12 }, (_, i) => ({ id: i, title: `T${i}`, rank: i, readable: true, artist: { name: `A${i}` } })) });
    const text = await deezer.searchTracksText('anything', 3);
    expect(text.map((t) => t.id)).toEqual(['11', '10', '9']);
    expect(hits[0]).toContain('limit=6');
  });

  it('parseTrackRef accepts URIs, links with a locale, and bare ids of 5+ digits', () => {
    expect(deezer.parseTrackRef('deezer:track:12345')).toBe(12345);
    expect(deezer.parseTrackRef('https://www.deezer.com/en/track/3135556?utm=x')).toBe(3135556);
    expect(deezer.parseTrackRef(' 987654 ')).toBe(987654);
    expect(deezer.parseTrackRef('1234')).toBeUndefined();
    expect(deezer.parseTrackRef('spotify:track:abc')).toBeUndefined();
  });

  it('pickArtist flags a tiny exact match next to a giant near-name as low confidence', () => {
    const a = (id: number, name: string, nbFan: number) => ({ id, name, nbFan });
    expect(deezer.pickArtist('Marina', [a(1, 'Marina', 40), a(2, 'MARINA', 2_000_000)])).toMatchObject({ artist: { id: 2 }, confidence: 'high' });
    expect(deezer.pickArtist('Sylvan', [a(3, 'Sylvan', 30), a(4, 'Sylvan Esso', 900_000)])).toMatchObject({ artist: { id: 3 }, confidence: 'low' });
  });
});
