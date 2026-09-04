/** Last.fm track.getSimilar and the MusicBrainz/ListenBrainz clients against canned JSON. */
import { afterAll, describe, expect, it } from 'vitest';
import { setFetch } from '../../src/infra/http.js';
import * as lastfm from '../../src/sources/lastfm.js';
import * as lb from '../../src/sources/listenbrainz.js';

const calls: string[] = [];

setFetch(async (input, init) => {
  const url = new URL(String(input));
  calls.push(url.toString());
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  if (url.hostname === 'ws.audioscrobbler.com') {
    if (url.searchParams.get('method') !== 'track.getsimilar') return json({ error: 6 });
    if (url.searchParams.get('track') === 'Unknown') return json({ error: 6, message: 'Track not found' });
    return json({ similartracks: { track: [{ name: 'Liggi', match: 1, playcount: 299009, mbid: 'm1', artist: { name: 'Ritviz' } }, { name: 'Intro', match: 0.9, artist: { name: 'Someone' } }, { name: 'Paro', match: '0.364', artist: { name: 'Aditya Rikhari' } }] } });
  }
  if (url.hostname === 'musicbrainz.org') {
    expect((init?.headers as Record<string, string>)['User-Agent']).toContain('lineupify-mcp');
    if (url.pathname.startsWith('/ws/2/isrc/')) return url.pathname.endsWith('FRX201782605') ? json({ recordings: [{ id: 'mbid-udd' }] }) : json({ error: 'Not Found' }, 404);
    if (url.pathname === '/ws/2/recording') return json({ recordings: [{ id: 'mbid-hi', score: 100 }, { id: 'mbid-lo', score: 40 }] });
  }
  if (url.hostname === 'labs.api.listenbrainz.org') {
    if (url.searchParams.get('recording_mbids') === 'mbid-udd') return json([{ recording_mbid: 'r1', recording_name: 'Choo Lo', artist_credit_name: 'The Local Train', score: 37 }, { recording_mbid: 'r2', recording_name: 'Paro', artist_credit_name: 'Aditya Rikhari', score: 33 }]);
    return json({ error: 'bad algorithm' }, 400);
  }
  return json({}, 404);
});

afterAll(() => setFetch((...args) => fetch(...args)));

describe('lastfm.similarTracks', () => {
  it('parses match scores, drops junk titles, empty on error', async () => {
    const out = await lastfm.similarTracks('k', 'Ritviz', 'Udd Gaye', 10);
    expect(out.map((t) => t.title)).toEqual(['Liggi', 'Paro']);
    expect(out[0]).toMatchObject({ artist: 'Ritviz', match: 1, playcount: 299009, mbid: 'm1' });
    expect(out[1]!.match).toBeCloseTo(0.364);
    expect(calls.at(-1)).toContain('autocorrect=1');
    expect(await lastfm.similarTracks('k', 'Ritviz', 'Unknown')).toEqual([]);
  });
});

describe('listenbrainz', () => {
  it('maps an ISRC to recording MBIDs and returns [] on 404', async () => {
    expect(await lb.recordingMbidsByIsrc('FRX201782605')).toEqual(['mbid-udd']);
    expect(await lb.recordingMbidsByIsrc('frx2-0178-2605')).toEqual(['mbid-udd']);
    expect(await lb.recordingMbidsByIsrc('GB0000000000')).toEqual([]);
    expect(await lb.recordingMbidsByIsrc('nonsense')).toEqual([]);
  });
  it('searches recordings by names keeping only high-score hits', async () => {
    expect(await lb.recordingMbidsByNames('Ritviz', 'Sathi')).toEqual(['mbid-hi']);
  });
  it('reads similar recordings and tolerates a 400', async () => {
    const rows = await lb.similarRecordings('mbid-udd');
    expect(rows.map((r) => r.title)).toEqual(['Choo Lo', 'Paro']);
    expect(calls.at(-1)).toContain(`algorithm=${lb.LB_ALGORITHM}`);
    expect(await lb.similarRecordings('other')).toEqual([]);
  });
});
