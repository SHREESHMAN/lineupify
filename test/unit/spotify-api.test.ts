/**
 * The real Spotify client against a canned fetch: error mapping (quota, rate
 * limit, scope, forbidden, other), the refresh lock, invalid_grant, paging,
 * request shapes for the write calls, and track parsing. Nothing here touches
 * the network; tokens live in a temporary data dir.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Tokens } from '../../src/types.js';

const home = await fs.mkdtemp(path.join(os.tmpdir(), 'lineupify-spotify-api-'));
process.env.LINEUPIFY_HOME = home;
process.env.LINEUPIFY_LOG = 'error';

const { setFetch, setLimit } = await import('../../src/infra/http.js');
const { paths, ensureDirs, readJson } = await import('../../src/infra/store.js');
const spotify = await import('../../src/sources/spotify.js');

setLimit('api.spotify.com', 1000, 1000);
setLimit('accounts.spotify.com', 1000, 1000);

type Handler = (url: URL, init: RequestInit | undefined) => Response | Promise<Response>;
const routes: { test: (url: URL) => boolean; handle: Handler }[] = [];
const calls: { method: string; path: string; body?: unknown; auth?: string }[] = [];
let refreshes = 0;

/** Register a reply; a later registration for the same path wins. */
function route(test: (url: URL) => boolean, handle: Handler): void {
  routes.unshift({ test, handle });
}

setFetch(async (input, init) => {
  const url = new URL(String(input));
  const headers = new Headers(init?.headers);
  calls.push({ method: init?.method ?? 'GET', path: url.pathname + url.search, body: init?.body ? safeJson(String(init.body)) : undefined, auth: headers.get('authorization') ?? undefined });
  if (url.hostname === 'accounts.spotify.com') {
    refreshes++;
    const form = new URLSearchParams(String(init?.body));
    if (form.get('refresh_token') === 'dead') return Response.json({ error: 'invalid_grant', error_description: 'Refresh token revoked' }, { status: 400 });
    if (form.get('client_id') === 'b'.repeat(32)) return Response.json({ error: 'invalid_client' }, { status: 400 });
    await new Promise((r) => setTimeout(r, 30));
    return Response.json({ access_token: `at-${refreshes}`, token_type: 'Bearer', scope: 'x', expires_in: 3600, refresh_token: `rt-${refreshes}` });
  }
  const r = routes.find((x) => x.test(url));
  if (!r) return new Response('not mocked: ' + url, { status: 500, headers: { 'retry-after': '99' } });
  return r.handle(url, init);
});

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

function tokens(extra: Partial<Tokens> = {}): Tokens {
  return { clientId: 'a'.repeat(32), accessToken: 'at-0', refreshToken: 'rt-0', expiresAt: Date.now() + 3600_000, authorizedAt: new Date().toISOString(), scope: '', userId: 'u', displayName: 'U', ...extra };
}

/** A 4xx that http() will not retry (retry-after above the wait cap), so mapError sees it at once. */
const fail = (status: number, body: string) => new Response(body, { status, headers: { 'retry-after': '3600' } });

beforeEach(async () => {
  await ensureDirs();
  routes.length = 0;
  calls.length = 0;
  refreshes = 0;
  await spotify.saveTokens(tokens());
});
afterAll(async () => {
  setFetch((...args) => fetch(...args));
  await fs.rm(home, { recursive: true, force: true }).catch(() => undefined);
});

describe('error mapping', () => {
  it('429 with QUOTA_EXCEEDED in the body is the daily quota', async () => {
    route((u) => u.pathname === '/v1/me', () => fail(429, '{"error":{"status":429,"message":"API rate limit exceeded","reason":"QUOTA_EXCEEDED"}}'));
    await expect(spotify.me()).rejects.toMatchObject({ code: 'SPOTIFY_QUOTA_EXCEEDED', status: 429 });
  });

  it('plain 429 is a rate limit that names the wait', async () => {
    route((u) => u.pathname === '/v1/me', () => fail(429, '{"error":{"status":429,"message":"Too many requests"}}'));
    const err = await spotify.me().catch((e) => e);
    expect(err).toMatchObject({ code: 'SPOTIFY_RATE_LIMITED' });
    expect(err.message).toContain('3600s');
  });

  it('403 insufficient scope asks for a re-login; any other 403 explains Development Mode', async () => {
    route((u) => u.pathname === '/v1/me/tracks', () => fail(403, '{"error":{"status":403,"message":"Insufficient client scope"}}'));
    await expect(spotify.savedTracks(10)).rejects.toMatchObject({ code: 'SPOTIFY_SCOPE_MISSING', status: 403 });
    route((u) => u.pathname === '/v1/me', () => fail(403, '{"error":{"status":403,"message":"User not registered in the Developer Dashboard"}}'));
    const err = await spotify.me().catch((e) => e);
    expect(err).toMatchObject({ code: 'SPOTIFY_FORBIDDEN', status: 403 });
    expect(err.message).toContain('User not registered');
  });

  it('other statuses become SPOTIFY_HTTP_ERROR with the status and reason', async () => {
    route((u) => u.pathname === '/v1/tracks/x', () => fail(404, '{"error":{"status":404,"message":"Non existing id"}}'));
    const err = await spotify.track('x').catch((e) => e);
    expect(err).toMatchObject({ code: 'SPOTIFY_HTTP_ERROR', status: 404 });
    expect(err.message).toContain('404');
    expect(err.message).toContain('Non existing id');
  });
});

describe('token store', () => {
  it('refreshes an expiring token once even when several calls race, and rotates the refresh token', async () => {
    await spotify.saveTokens(tokens({ expiresAt: Date.now() + 10_000 }));
    route((u) => u.pathname === '/v1/me', () => Response.json({ id: 'u', display_name: 'U' }));
    const results = await Promise.all([spotify.me(), spotify.me(), spotify.me()]);
    expect(results.every((r) => r.id === 'u')).toBe(true);
    expect(refreshes).toBe(1);
    const stored = await readJson<Tokens>(paths.tokens());
    expect(stored).toMatchObject({ accessToken: 'at-1', refreshToken: 'rt-1', scope: 'x' });
    expect(stored!.expiresAt).toBeGreaterThan(Date.now() + 3000_000);
    expect(calls.filter((c) => c.path === '/v1/me').every((c) => c.auth === 'Bearer at-1')).toBe(true);
  });

  it('invalid_grant means the login is gone: TOKEN_EXPIRED_RECONNECT and tokens.json removed', async () => {
    await spotify.saveTokens(tokens({ refreshToken: 'dead', expiresAt: 0 }));
    await expect(spotify.me()).rejects.toMatchObject({ code: 'TOKEN_EXPIRED_RECONNECT' });
    expect(await spotify.loadTokens()).toBeUndefined();
    await expect(spotify.me()).rejects.toMatchObject({ code: 'SPOTIFY_NOT_CONNECTED' });
  });

  it('invalid_client names the client id', async () => {
    await spotify.saveTokens(tokens({ clientId: 'b'.repeat(32), expiresAt: 0 }));
    await expect(spotify.me()).rejects.toMatchObject({ code: 'SPOTIFY_CLIENT_ID_INVALID' });
  });

  it('refreshTokenAge counts down from the original authorization', () => {
    const t = tokens({ authorizedAt: new Date(Date.now() - 100 * 86_400_000).toISOString() });
    const age = spotify.refreshTokenAge(t);
    expect(age.daysUsed).toBe(100);
    expect(age.daysLeft).toBe(spotify.REFRESH_TOKEN_LIFETIME_DAYS - 100);
  });
});

describe('reads', () => {
  it('search caps the limit at 10 and asks for the user market', async () => {
    route((u) => u.pathname === '/v1/search', () => Response.json({ tracks: { items: [{ uri: 'spotify:track:a', id: 'a', name: 'A', artists: [{ id: 'x', name: 'X' }], album: { name: 'Al', album_type: 'album', release_date: '2020-05-01' }, duration_ms: 1000, explicit: true, external_ids: { isrc: 'gbabc2000001' }, is_playable: true }, { uri: 'spotify:local:x', id: 'l', name: 'Local', is_local: true }, { uri: 'spotify:episode:e', id: 'e', name: 'Pod', type: 'episode' }] } }));
    const hits = await spotify.searchTracks('track:A artist:X', 50);
    expect(hits.map((h) => h.id)).toEqual(['a']);
    expect(hits[0]).toMatchObject({ isrc: 'GBABC2000001', explicit: true, albumType: 'album', releaseDate: '2020-05-01', isPlayable: true });
    const q = new URL('https://x' + calls.at(-1)!.path).searchParams;
    expect(q.get('limit')).toBe('10');
    expect(q.get('market')).toBe('from_token');
    expect(q.get('type')).toBe('track');
  });

  it('lookupTrack "Artist - Title" refuses a hit that is a different song', async () => {
    const { lookupTrack } = await import('../../src/engine/match.js');
    const hit = (id: string, name: string, artist: string, playable = true) => ({ uri: `spotify:track:${id}`, id, name, artists: [{ id: 'x', name: artist }], album: { name: 'Al', album_type: 'album', release_date: '2020' }, duration_ms: 1000, is_playable: playable });
    route((u) => u.pathname === '/v1/search', () => Response.json({ tracks: { items: [hit('wrong', 'Rumble (Remix)', 'Someone Else'), hit('right', 'Rumble', 'Skrillex', false), hit('right2', 'Rumble', 'Skrillex, Fred again.., Flowdan')] } }));
    expect((await lookupTrack('Skrillex - Rumble'))?.id).toBe('right2');
    route((u) => u.pathname === '/v1/search', () => Response.json({ tracks: { items: [hit('other', 'Bangarang', 'Skrillex')] } }));
    expect(await lookupTrack('Skrillex - Rumble')).toBeUndefined();
    // A free-text query (no dash) still takes the first playable hit.
    expect((await lookupTrack('Bangarang'))?.id).toBe('other');
  });

  it('followedArtists walks the cursor until a short page', async () => {
    const page = (n: number, after?: string) => ({ artists: { items: Array.from({ length: n }, (_, i) => ({ id: `${after ?? 'p0'}-${i}`, name: `A${i}` })), cursors: { after } } });
    route((u) => u.pathname === '/v1/me/following', (u) => Response.json(u.searchParams.get('after') === 'c1' ? page(7) : page(50, 'c1')));
    const all = await spotify.followedArtists();
    expect(all.length).toBe(57);
    expect(calls.filter((c) => c.path.startsWith('/v1/me/following')).length).toBe(2);
  });

  it('playlistState falls back to the items endpoint when the playlist object has no total', async () => {
    route((u) => u.pathname === '/v1/playlists/p1', () => Response.json({ snapshot_id: 'snap', name: 'P', external_urls: { spotify: 'https://open.spotify.com/playlist/p1' } }));
    route((u) => u.pathname === '/v1/playlists/p1/items', () => Response.json({ total: 42 }));
    expect(await spotify.playlistState('p1')).toEqual({ snapshotId: 'snap', total: 42, name: 'P', url: 'https://open.spotify.com/playlist/p1' });
  });
});

describe('writes', () => {
  it('createPlaylist truncates name and description and returns the URL', async () => {
    route((u) => u.pathname === '/v1/me/playlists', () => Response.json({ id: 'new1', external_urls: { spotify: 'https://open.spotify.com/playlist/new1' } }));
    const r = await spotify.createPlaylist('n'.repeat(150), 'd'.repeat(400), true);
    expect(r).toEqual({ id: 'new1', url: 'https://open.spotify.com/playlist/new1' });
    const c = calls.find((x) => x.path === '/v1/me/playlists')!;
    expect(c.method).toBe('POST');
    expect(c.body).toMatchObject({ public: true });
    expect((c.body as { name: string }).name.length).toBe(100);
    expect((c.body as { description: string }).description.length).toBe(300);
  });

  it('addItems posts and replaceItems puts the uris, both returning the snapshot id', async () => {
    route((u) => u.pathname === '/v1/playlists/p1/items', (_u, init) => Response.json({ snapshot_id: init?.method === 'PUT' ? 'after-put' : 'after-post' }));
    expect(await spotify.addItems('p1', ['spotify:track:a'])).toBe('after-post');
    expect(await spotify.replaceItems('p1', [])).toBe('after-put');
    const [post, put] = calls.filter((c) => c.path === '/v1/playlists/p1/items');
    expect(post).toMatchObject({ method: 'POST', body: { uris: ['spotify:track:a'] } });
    expect(put).toMatchObject({ method: 'PUT', body: { uris: [] } });
  });

  it('changePlaylistDetails puts only the given fields', async () => {
    route((u) => u.pathname === '/v1/playlists/p1', () => new Response('', { status: 200 }));
    await spotify.changePlaylistDetails('p1', { name: 'N' });
    expect(calls.at(-1)).toMatchObject({ method: 'PUT', path: '/v1/playlists/p1', body: { name: 'N' } });
  });
});
