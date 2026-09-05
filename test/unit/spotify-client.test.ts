/**
 * The real Spotify client against a canned fetch: the 401 retry and the token
 * store when a second process rotates the refresh token at the same time.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Tokens } from '../../src/types.js';

const home = await fs.mkdtemp(path.join(os.tmpdir(), 'lineupify-spotify-'));
process.env.LINEUPIFY_HOME = home;
process.env.LINEUPIFY_LOG = 'error';

const { setFetch, setLimit } = await import('../../src/infra/http.js');
const { paths, ensureDirs, writeJsonAtomic, readJson } = await import('../../src/infra/store.js');
const spotify = await import('../../src/sources/spotify.js');

setLimit('api.spotify.com', 1000, 1000);
setLimit('accounts.spotify.com', 1000, 1000);

function tokens(accessToken: string, refreshToken: string, expiresAt = Date.now() + 3600_000): Tokens {
  return { clientId: 'a'.repeat(32), accessToken, refreshToken, expiresAt, authorizedAt: new Date().toISOString(), scope: '', userId: 'u', displayName: 'U' };
}

/** Which access tokens the API accepts and which refresh tokens the token endpoint accepts. */
let validAccess = new Set<string>();
let validRefresh = new Map<string, { access: string; refresh: string }>();
let onUnauthorized: (() => Promise<void>) | undefined;
const calls: string[] = [];

setFetch(async (input, init) => {
  const url = String(input);
  const headers = new Headers(init?.headers);
  if (url.startsWith('https://api.spotify.com/v1/me')) {
    const bearer = (headers.get('authorization') ?? '').replace('Bearer ', '');
    calls.push(`me:${bearer}`);
    if (validAccess.has(bearer)) return Response.json({ id: 'u', display_name: 'U' });
    await onUnauthorized?.();
    return new Response('{"error":{"status":401,"message":"The access token expired"}}', { status: 401 });
  }
  if (url.startsWith('https://accounts.spotify.com/api/token')) {
    const form = new URLSearchParams(String(init?.body));
    const rt = form.get('refresh_token') ?? '';
    calls.push(`refresh:${rt}`);
    const next = validRefresh.get(rt);
    if (!next) return Response.json({ error: 'invalid_grant', error_description: 'Refresh token revoked' }, { status: 400 });
    validAccess.add(next.access);
    return Response.json({ access_token: next.access, token_type: 'Bearer', scope: '', expires_in: 3600, refresh_token: next.refresh });
  }
  return new Response('not mocked: ' + url, { status: 500 });
});

beforeEach(async () => {
  await ensureDirs();
  calls.length = 0;
  onUnauthorized = undefined;
  validAccess = new Set();
  validRefresh = new Map();
});
afterAll(async () => {
  setFetch((...args) => fetch(...args));
  await fs.rm(home, { recursive: true, force: true }).catch(() => undefined);
});

describe('401 retry', () => {
  it('refreshes once and retries the call with the new access token', async () => {
    await spotify.saveTokens(tokens('at1', 'rt1'));
    validRefresh.set('rt1', { access: 'at2', refresh: 'rt2' });
    expect(await spotify.me()).toEqual({ id: 'u', displayName: 'U' });
    expect(calls).toEqual(['me:at1', 'refresh:rt1', 'me:at2']);
    expect((await readJson<Tokens>(paths.tokens()))?.refreshToken).toBe('rt2');
  });

  it('does not overwrite a refresh token another process rotated meanwhile', async () => {
    await spotify.saveTokens(tokens('at1', 'rt1'));
    // rt1 has already been used by the other process: Spotify would refuse it again.
    validRefresh.set('rt2', { access: 'at3', refresh: 'rt3' });
    // While our request is in flight the other process finishes its refresh and writes at2/rt2.
    onUnauthorized = async () => {
      await writeJsonAtomic(paths.tokens(), tokens('at2', 'rt2'));
      validAccess.add('at2');
    };
    expect(await spotify.me()).toEqual({ id: 'u', displayName: 'U' });
    // The retry must use the rotated token as it stands on disk, not resurrect rt1.
    expect(calls).not.toContain('refresh:rt1');
    expect(calls.at(-1)).toBe('me:at2');
    const stored = await readJson<Tokens>(paths.tokens());
    expect(stored?.refreshToken).toBe('rt2');
    expect(stored?.accessToken).toBe('at2');
  });
});
