/**
 * Boots the real server over stdio (source via tsx, fresh data dir, no
 * network needed for the calls made) and checks the MCP surface: initialize,
 * the tool list and each tool's input keys (snapshotted so an accidental
 * rename or dropped option fails CI), and two tool calls.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pkg from '../../package.json' with { type: 'json' };

const root = path.resolve(import.meta.dirname, '..', '..');
let child: ChildProcess;
let buf = '';
const pending = new Map<number, (msg: Record<string, unknown>) => void>();
let nextId = 1;
let home = '';

type Rpc = { id?: number; result?: Record<string, unknown>; error?: { code: number; message: string } };

function send(method: string, params: unknown, notify = false): Promise<Rpc> {
  const msg: Record<string, unknown> = { jsonrpc: '2.0', method, params };
  if (!notify) msg.id = nextId++;
  child.stdin!.write(JSON.stringify(msg) + '\n');
  if (notify) return Promise.resolve({});
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 20_000);
    pending.set(msg.id as number, (res) => {
      clearTimeout(timer);
      resolve(res as Rpc);
    });
  });
}

function textOf(res: Rpc): string {
  const content = (res.result?.content ?? []) as { type: string; text?: string }[];
  return content.map((c) => c.text ?? '').join('\n');
}

beforeAll(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'lineupify-server-'));
  child = spawn(process.execPath, ['--import', 'tsx', path.join(root, 'src', 'index.ts')], {
    cwd: root,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, LINEUPIFY_HOME: home, LINEUPIFY_LOG: 'error', LINEUPIFY_NO_UPDATE_CHECK: '1', SPOTIFY_CLIENT_ID: '' },
  });
  child.stderr!.on('data', () => undefined);
  child.stdout!.on('data', (chunk: Buffer) => {
    buf += chunk.toString('utf8');
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg: Rpc;
      try {
        msg = JSON.parse(line) as Rpc;
      } catch {
        throw new Error(`non-JSON on stdout: ${line.slice(0, 120)}`);
      }
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)!(msg as Record<string, unknown>);
        pending.delete(msg.id);
      }
    }
  });
}, 30_000);

afterAll(async () => {
  child.stdin?.end();
  await new Promise<void>((resolve) => {
    const killer = setTimeout(() => {
      child.kill();
      resolve();
    }, 5000);
    child.once('exit', () => {
      clearTimeout(killer);
      resolve();
    });
  });
  await fs.rm(home, { recursive: true, force: true }).catch(() => undefined);
});

describe('MCP server over stdio', () => {
  it('initializes with the package version', async () => {
    const init = await send('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
    expect(init.error).toBeUndefined();
    const info = init.result?.serverInfo as { name: string; version: string };
    expect(info.name).toBe('lineupify');
    expect(info.version).toBe(pkg.version);
    await send('notifications/initialized', {}, true);
  }, 30_000);

  it('lists every tool with a stable input surface', async () => {
    const list = await send('tools/list', {});
    const tools = (list.result?.tools ?? []) as { name: string; description: string; inputSchema: { type: string; properties?: Record<string, unknown> }; annotations?: Record<string, boolean> }[];
    expect(tools.length).toBe(21);
    for (const t of tools) {
      expect(t.description.length, t.name).toBeGreaterThan(40);
      expect(t.inputSchema.type).toBe('object');
    }
    const surface = Object.fromEntries(tools.map((t) => [t.name, { inputs: Object.keys(t.inputSchema.properties ?? {}).sort(), readOnly: !!t.annotations?.readOnlyHint, destructive: !!t.annotations?.destructiveHint }]));
    expect(surface).toMatchSnapshot();
  });

  it('answers status without any login and points at Deezer mode', async () => {
    const res = await send('tools/call', { name: 'status', arguments: {} });
    const out = textOf(res);
    expect(out).toContain(`Lineupify ${pkg.version}`);
    expect(out).toContain('Spotify: not set up');
    expect(out).toContain('Deezer mode');
  });

  it('parses a lineup', async () => {
    const res = await send('tools/call', { name: 'parse_lineup', arguments: { text: 'FRIDAY\nFRED AGAIN.. • THE 1975\nWET LEG • KNEECAP\nTICKETS ON SALE NOW' } });
    const out = textOf(res);
    expect(out).toContain('Parsed 4 artists');
    expect(out).toContain('Fred again..'.toUpperCase());
    expect(out).toContain('TICKETS ON SALE NOW');
  });

  it('returns a structured error result, not a protocol error, for a bad call', async () => {
    const res = await send('tools/call', { name: 'get_draft', arguments: { draftId: 'd_nope' } });
    expect(res.error).toBeUndefined();
    expect(res.result?.isError).toBe(true);
    expect(textOf(res)).toContain('DRAFT_NOT_FOUND');
  });
});
