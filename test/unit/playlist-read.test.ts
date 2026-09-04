/** Spotify playlist reading: pagination, the read cap, snapshot-id caching, episodes and local files. HTTP is mocked; tokens are on disk. */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const home = await fs.mkdtemp(path.join(os.tmpdir(), 'lineupify-read-'));
process.env.LINEUPIFY_HOME = home;
process.env.LINEUPIFY_LOG = 'error';

const { setFetch } = await import('../../src/infra/http.js');
const spotify = await import('../../src/sources/spotify.js');
const { readPlaylist, parsePlaylistRef } = await import('../../src/engine/playlists.js');

const PL = 'plread'.padEnd(22, '0');
let snapshotId = 'snap-1';
let total = 120;
const hits: string[] = [];

function item(i: number, extra: Record<string, unknown> = {}) {
  return { added_at: '2026-01-01T00:00:00Z', is_local: false, item: { uri: `spotify:track:${String(i).padStart(22, 't')}`, id: String(i).padStart(22, 't'), name: `Song ${i}`, type: 'track', is_local: false, artists: [{ id: 'a1', name: 'Artist' }], album: { id: 'al', name: 'Album', album_type: 'album', release_date: '2019-05-01' }, duration_ms: 200_000, explicit: false, external_ids: { isrc: `ISRC${String(i).padStart(8, '0')}` }, is_playable: true, ...extra } };
}

setFetch(async (input) => {
  const url = new URL(String(input));
  hits.push(url.pathname + url.search);
  if (url.pathname === `/v1/playlists/${PL}`) {
    return Response.json({ id: PL, name: 'Read me', description: '', public: true, owner: { id: 'u1', display_name: 'Owner' }, snapshot_id: snapshotId, items: { total }, external_urls: { spotify: `https://open.spotify.com/playlist/${PL}` } });
  }
  if (url.pathname === `/v1/playlists/${PL}/items`) {
    const offset = Number(url.searchParams.get('offset') ?? 0);
    const limit = Number(url.searchParams.get('limit') ?? 50);
    const items = [];
    for (let i = offset; i < Math.min(total, offset + limit); i++) {
      if (i === 3) items.push({ ...item(i), is_local: true });
      else if (i === 4) items.push({ added_at: 'x', is_local: false, item: { type: 'episode', uri: 'spotify:episode:xyz', id: 'xyz', name: 'Podcast' } });
      else items.push(item(i));
    }
    const next = offset + limit < total ? 'more' : null;
    return Response.json({ total, next, items });
  }
  if (url.pathname === '/v1/playlists/missing') return new Response(JSON.stringify({ error: { status: 404, message: 'Not found' } }), { status: 404 });
  return new Response('{}', { status: 500 });
});

beforeAll(async () => {
  await (await import('../../src/infra/store.js')).ensureDirs();
  await spotify.saveTokens({ clientId: 'a'.repeat(32), accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3600_000, authorizedAt: new Date().toISOString(), scope: spotify.SCOPES.join(' '), userId: 'u1', displayName: 'Tester' });
});
afterAll(async () => {
  setFetch((...args) => fetch(...args));
  await fs.rm(home, { recursive: true, force: true }).catch(() => undefined);
});

describe('reading a Spotify playlist', () => {
  it('pages through items, skipping local files and episodes', async () => {
    const snap = await readPlaylist(parsePlaylistRef(`https://open.spotify.com/playlist/${PL}`));
    expect(snap.tracks.length).toBe(118);
    expect(snap.total).toBe(120);
    expect(snap.truncated).toBe(false);
    expect(snap.tracks[0]).toMatchObject({ name: 'Song 0', year: 2019, isrc: 'ISRC00000000', artistIds: ['a1'] });
    expect(hits.filter((h) => h.includes('/items')).length).toBe(3);
  });

  it('serves the cache while the snapshot id is unchanged, re-reads when it changes or on refresh', async () => {
    hits.length = 0;
    await readPlaylist(parsePlaylistRef(PL));
    expect(hits.filter((h) => h.includes('/items')).length).toBe(0);
    snapshotId = 'snap-2';
    await readPlaylist(parsePlaylistRef(PL));
    expect(hits.filter((h) => h.includes('/items')).length).toBe(3);
    hits.length = 0;
    await readPlaylist(parsePlaylistRef(PL), { refresh: true });
    expect(hits.filter((h) => h.includes('/items')).length).toBe(3);
  });

  it('caps very long playlists and says so', async () => {
    total = 300;
    snapshotId = 'snap-3';
    const snap = await readPlaylist(parsePlaylistRef(PL), { maxTracks: 100 });
    expect(snap.tracks.length).toBeLessThanOrEqual(100);
    expect(snap.truncated).toBe(true);
    expect(snap.total).toBe(300);
  });

  it('turns a 404 into a readable error', async () => {
    await expect(spotify.playlistInfo('missing')).rejects.toMatchObject({ code: 'PLAYLIST_NOT_READABLE' });
  });
});
