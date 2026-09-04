/** Terminal subcommands other than the interactive ones, against a temporary data directory. Network is mocked. */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const home = await fs.mkdtemp(path.join(os.tmpdir(), 'lineupify-cli-'));
process.env.LINEUPIFY_HOME = home;
process.env.LINEUPIFY_LOG = 'error';
process.env.LINEUPIFY_NO_UPDATE_CHECK = '1';
delete process.env.SPOTIFY_CLIENT_ID;

const { setFetch } = await import('../../src/infra/http.js');
setFetch(async (input) => {
  const url = String(input);
  if (url.includes('api.deezer.com/artist/1')) return Response.json({ id: 1, name: 'x' });
  if (url.includes('registry.npmjs.org')) return Response.json({ version: '0.0.1' });
  return new Response('{}', { status: 500 });
});

const cli = await import('../../src/cli.ts');
const { loadConfig } = await import('../../src/infra/config.js');
const ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

const out: string[] = [];
const err: string[] = [];
beforeAll(() => {
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void out.push(a.join(' ')));
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void err.push(a.join(' ')));
});
afterAll(async () => {
  vi.restoreAllMocks();
  setFetch((...args) => fetch(...args));
  await fs.rm(home, { recursive: true, force: true }).catch(() => undefined);
});

describe('cli', () => {
  it('help lists every command', () => {
    const h = cli.help();
    for (const c of ['init', 'setup', 'auth', 'logout', 'doctor', 'install', 'config', 'preview', 'update-check']) expect(h).toContain(`lineupify-mcp ${c}`);
  });

  it('setup validates and saves the client id, port and key', async () => {
    expect(await cli.runCli('setup', ['--client-id', 'bad'])).toBe(1);
    expect(err.at(-1)).toContain('32 hex');
    expect(await cli.runCli('setup', ['--client-id', ID, '--port', '8888', '--lastfm-key', 'lf'])).toBe(0);
    expect(await loadConfig()).toMatchObject({ spotifyClientId: ID, spotifyRedirectPort: 8888, lastfmApiKey: 'lf' });
    expect(await cli.runCli('setup', ['--port', '80'])).toBe(1);
  });

  it('config set / get / reset handle every documented key and reject bad values', async () => {
    expect(await cli.runCli('config', ['set', 'tracksPerTier.headliner', '8'])).toBe(0);
    expect(await cli.runCli('config', ['set', 'order', 'shuffle'])).toBe(0);
    expect(await cli.runCli('config', ['set', 'skipCovers', 'true'])).toBe(0);
    expect(await cli.runCli('config', ['set', 'provider', 'deezer'])).toBe(0);
    expect(await cli.runCli('config', ['set', 'namingTemplate', '{lineup} mix'])).toBe(0);
    expect(await cli.runCli('config', ['set', 'order', 'sideways'])).toBe(2);
    expect(await cli.runCli('config', ['set', 'provider', 'tidal'])).toBe(2);
    expect(await cli.runCli('config', ['set', 'maxTracks', 'lots'])).toBe(2);
    expect(await cli.runCli('config', ['set', 'unknownKey', '1'])).toBe(2);
    const cfg = await loadConfig();
    expect(cfg.defaults).toMatchObject({ tracksPerTier: { headliner: 8 }, order: 'shuffle', skipCovers: true, provider: 'deezer', namingTemplate: '{lineup} mix' });
    out.length = 0;
    expect(await cli.runCli('config', ['get'])).toBe(0);
    expect(out.join('\n')).toContain('"lastfmApiKey": "***"');
    expect(await cli.runCli('config', ['reset'])).toBe(0);
    expect((await loadConfig()).defaults).toEqual({});
    expect((await loadConfig()).spotifyClientId).toBe(ID);
  });

  it('doctor reports each check and prints config snippets', async () => {
    out.length = 0;
    const code = await cli.runCli('doctor', []);
    const text = out.join('\n');
    expect(text).toContain('OK   Client ID');
    expect(text).toContain('FAIL Spotify login');
    expect(text).toContain('OK   Deezer');
    expect(text).toContain('Last.fm key');
    expect(text).toContain('"mcpServers"');
    expect(code).toBe(1);
  });

  it('update-check compares with the registry', async () => {
    out.length = 0;
    expect(await cli.runCli('update-check', [])).toBe(0);
    expect(out.at(-1)).toContain('you have');
  });

  it('logout forgets the login and can purge the data folder', async () => {
    out.length = 0;
    expect(await cli.runCli('logout', [])).toBe(0);
    expect(out.join('\n')).toContain('No Spotify login was saved');
    expect(await cli.runCli('logout', ['--purge'])).toBe(0);
    expect(await fs.stat(home).then(() => true, () => false)).toBe(false);
  });

  it('unknown command prints help and exits 2', async () => {
    expect(await cli.runCli('dance', [])).toBe(2);
    expect(err.at(-1)).toContain('Unknown command');
  });
});
