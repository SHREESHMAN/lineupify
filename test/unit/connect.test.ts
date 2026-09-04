/** connect with clientId, setup validation, disconnect messaging — Spotify auth and the browser are mocked. */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Tokens } from '../../src/types.js';

const home = await fs.mkdtemp(path.join(os.tmpdir(), 'lineupify-connect-'));
process.env.LINEUPIFY_HOME = home;
process.env.LINEUPIFY_LOG = 'error';
process.env.LINEUPIFY_NO_UPDATE_CHECK = '1';
delete process.env.SPOTIFY_CLIENT_ID;

let saved: Tokens | undefined;
const authCalls: { clientId: string; port: number }[] = [];

vi.mock('open', () => ({ default: async () => ({ unref() {} }) }));
vi.mock('../../src/sources/spotify.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/sources/spotify.js')>();
  return {
    ...orig,
    loadTokens: async () => saved,
    clearTokens: async () => {
      saved = undefined;
    },
    cancelPendingAuth: () => undefined,
    pendingAuth: () => undefined,
    pendingAuthResult: () => undefined,
    startAuth: async (clientId: string, port: number) => {
      authCalls.push({ clientId, port });
      return { url: `https://accounts.spotify.com/authorize?client_id=${clientId}`, port, redirectUri: `http://127.0.0.1:${port}/callback`, reused: false };
    },
  };
});

const connect = await import('../../src/tools/connect.js');
const { loadConfig } = await import('../../src/infra/config.js');
const textOf = (r: { content: { type: string; text?: string }[] }) => r.content.map((c) => c.text ?? '').join('\n');
const ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

beforeAll(async () => {
  await (await import('../../src/infra/store.js')).ensureDirs();
});
afterAll(async () => {
  await fs.rm(home, { recursive: true, force: true }).catch(() => undefined);
});

describe('validateClientId', () => {
  it('accepts 32 hex chars, trims, rejects everything else', () => {
    expect(connect.validateClientId(` ${ID} `)).toBe(ID);
    expect(() => connect.validateClientId('not-an-id')).toThrow(/32 hex/);
    expect(() => connect.validateClientId(ID.slice(0, 31))).toThrow(/32 hex/);
  });
});

describe('connect', () => {
  it('refuses without a client id and explains the setup', async () => {
    await expect(connect.connect({})).rejects.toMatchObject({ code: 'NO_CLIENT_ID' });
  });

  it('saves a passed clientId, then starts the login', async () => {
    await expect(connect.connect({ clientId: 'bad' })).rejects.toMatchObject({ code: 'BAD_CLIENT_ID' });
    const out = textOf(await connect.connect({ clientId: ID }));
    expect(out).toContain(`client_id=${ID}`);
    expect((await loadConfig()).spotifyClientId).toBe(ID);
    expect(authCalls.at(-1)).toMatchObject({ clientId: ID, port: 8765 });
  });

  it('reports an existing login unless forced, and a new clientId implies force', async () => {
    saved = { clientId: ID, accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3600_000, authorizedAt: new Date().toISOString(), scope: '', userId: 'u1', displayName: 'Tester' };
    expect(textOf(await connect.connect({}))).toContain('Already connected as Tester');
    const n = authCalls.length;
    const other = 'f'.repeat(32);
    expect(textOf(await connect.connect({ clientId: other }))).toContain(`client_id=${other}`);
    expect(authCalls.length).toBe(n + 1);
    expect(textOf(await connect.connect({ force: true }))).toContain('accounts.spotify.com');
  });

  it('setup validates the id too', async () => {
    await expect(connect.setup({ clientId: 'zz' })).rejects.toMatchObject({ code: 'BAD_CLIENT_ID' });
    expect(textOf(await connect.setup({ clientId: ID }))).toContain('client ID saved');
  });
});
