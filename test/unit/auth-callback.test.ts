/**
 * The loopback OAuth callback on 127.0.0.1: any web page open during the
 * 5-minute login window can make the browser hit it, so a stray request must
 * neither end the login nor get its text reflected into the page unescaped.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const home = await fs.mkdtemp(path.join(os.tmpdir(), 'lineupify-auth-'));
process.env.LINEUPIFY_HOME = home;
process.env.LINEUPIFY_LOG = 'error';

const spotify = await import('../../src/sources/spotify.js');
const PAYLOAD = '<img src=x onerror=alert(1)>\n' + 'x'.repeat(300);

afterAll(async () => {
  spotify.cancelPendingAuth();
  await fs.rm(home, { recursive: true, force: true }).catch(() => undefined);
});

describe('loopback callback', () => {
  it('ignores requests without the right state and never reflects raw HTML', async () => {
    const { url, port } = await spotify.startAuth('a'.repeat(32), 0);
    const state = new URL(url).searchParams.get('state')!;
    const base = `http://127.0.0.1:${port}/callback`;

    // A stray request (an <img src> on any page is enough) must not cancel the login.
    let res = await fetch(`${base}?x=1`);
    expect(res.status).toBe(400);
    expect(spotify.pendingAuthResult()).toBeUndefined();
    expect(spotify.pendingAuth()?.port).toBe(port);

    // error= without the state is a stray request too: same 400, nothing reflected.
    res = await fetch(`${base}?error=${encodeURIComponent(PAYLOAD)}`);
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain('<img');
    expect(spotify.pendingAuthResult()).toBeUndefined();

    // Anything but /callback is a 404.
    res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(404);

    // The real consent-page cancel carries the state: the login ends, the text is escaped.
    res = await fetch(`${base}?error=${encodeURIComponent(PAYLOAD)}&state=${encodeURIComponent(state)}`);
    const body = await res.text();
    expect(body).not.toContain('<img');
    expect(body).toContain('&lt;img');
    const result = spotify.pendingAuthResult();
    expect(result?.error).toMatchObject({ code: 'AUTH_DENIED' });
    // The message reaches the model: cleaned (no newline) and length-capped.
    expect(result?.error?.message).not.toContain('\n');
    expect(result?.error?.message.length).toBeLessThan(120);
  });
});
