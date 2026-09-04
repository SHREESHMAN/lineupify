import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LOCK_STALE_MS, fileMtimeMs, homeDir, lockAge, paths, readJson, safeFileName, tryLock, waitLock, writeJsonAtomic } from '../../src/infra/store.js';

const dirs: string[] = [];
let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lineupify-store-test-'));
  dirs.push(dir);
});

afterAll(async () => {
  for (const d of dirs) await fs.rm(d, { recursive: true, force: true }).catch(() => undefined);
});

describe('paths', () => {
  it('follow LINEUPIFY_HOME lazily', () => {
    const before = process.env.LINEUPIFY_HOME;
    try {
      process.env.LINEUPIFY_HOME = dir;
      expect(homeDir()).toBe(dir);
      expect(paths.draft('d_abc')).toBe(path.join(dir, 'drafts', 'd_abc.json'));
      expect(paths.draftRevDir('d_abc')).toBe(path.join(dir, 'drafts', 'd_abc.rev'));
      expect(paths.draftLock('d_abc')).toBe(path.join(dir, 'drafts', 'd_abc.lock'));
      expect(paths.cache('artists')).toBe(path.join(dir, 'cache', 'artists.json'));
      delete process.env.LINEUPIFY_HOME;
      expect(homeDir()).toBe(path.join(os.homedir(), '.lineupify'));
    } finally {
      if (before === undefined) delete process.env.LINEUPIFY_HOME;
      else process.env.LINEUPIFY_HOME = before;
    }
  });
});

describe('writeJsonAtomic / readJson', () => {
  it('round-trips and creates parent directories', async () => {
    const file = path.join(dir, 'a', 'b', 'x.json');
    const value = { name: 'Fred again..', n: 1, list: [1, 'two', null], nested: { ok: true } };
    await writeJsonAtomic(file, value);
    expect(await readJson(file)).toEqual(value);
    const raw = await fs.readFile(file, 'utf8');
    expect(raw).toBe(JSON.stringify(value, null, 2));
    const siblings = await fs.readdir(path.dirname(file));
    expect(siblings).toEqual(['x.json']);
  });

  it('overwrites an existing file atomically', async () => {
    const file = path.join(dir, 'x.json');
    await writeJsonAtomic(file, { v: 1 });
    await writeJsonAtomic(file, { v: 2 });
    expect(await readJson<{ v: number }>(file)).toEqual({ v: 2 });
    expect((await fs.readdir(dir)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('returns undefined for a missing file', async () => {
    expect(await readJson(path.join(dir, 'missing.json'))).toBeUndefined();
  });

  it('returns undefined for a corrupt file instead of throwing', async () => {
    const file = path.join(dir, 'corrupt.json');
    await fs.writeFile(file, '{ "half": tru');
    expect(await readJson(file)).toBeUndefined();
    await fs.writeFile(file, '');
    expect(await readJson(file)).toBeUndefined();
  });
});

describe('fileMtimeMs / lockAge', () => {
  it('report undefined for missing files and a small age for fresh ones', async () => {
    const file = path.join(dir, 'f');
    expect(await fileMtimeMs(file)).toBeUndefined();
    expect(await lockAge(file)).toBeUndefined();
    await fs.writeFile(file, 'x');
    expect(await lockAge(file)).toBeLessThan(5000);
  });
});

describe('tryLock', () => {
  it('is exclusive until released', async () => {
    const file = path.join(dir, 'locks', 'd_1.lock');
    const h1 = await tryLock(file, 'one');
    expect(h1).toBeDefined();
    expect(h1!.file).toBe(file);
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toMatchObject({ owner: 'one' });
    expect(await tryLock(file, 'two')).toBeUndefined();
    await h1!.release();
    await expect(fs.stat(file)).rejects.toBeTruthy();
    const h3 = await tryLock(file, 'three');
    expect(h3).toBeDefined();
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toMatchObject({ owner: 'three' });
    await h3!.release();
    await h3!.release(); // idempotent
  });

  it('takes over a stale lock', async () => {
    const file = path.join(dir, 'd_2.lock');
    const h1 = await tryLock(file, 'dead-process');
    expect(h1).toBeDefined();
    const old = new Date(Date.now() - LOCK_STALE_MS - 60_000);
    await fs.utimes(file, old, old);
    expect(await lockAge(file)).toBeGreaterThan(LOCK_STALE_MS);
    const h2 = await tryLock(file, 'new-process');
    expect(h2).toBeDefined();
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toMatchObject({ owner: 'new-process' });
    expect(await lockAge(file)).toBeLessThan(LOCK_STALE_MS);
    await h2!.release();
  });

  it('heartbeat keeps a lock live', async () => {
    const file = path.join(dir, 'd_3.lock');
    const h1 = await tryLock(file, 'worker');
    const old = new Date(Date.now() - LOCK_STALE_MS - 60_000);
    await fs.utimes(file, old, old);
    await h1!.heartbeat();
    expect(await lockAge(file)).toBeLessThan(LOCK_STALE_MS);
    expect(await tryLock(file, 'intruder')).toBeUndefined();
    await h1!.release();
  });

  it('waitLock times out while another holder is live', async () => {
    const file = path.join(dir, 'd_4.lock');
    const h1 = await tryLock(file, 'holder');
    const t0 = Date.now();
    await expect(waitLock(file, 150, 'waiter')).rejects.toThrow(/timed out/);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(140);
    await h1!.release();
    const h2 = await waitLock(file, 500, 'waiter');
    expect(h2).toBeDefined();
    await h2.release();
  });
});

describe('safeFileName', () => {
  it('replaces whitespace and drops unsafe characters', () => {
    expect(safeFileName('My Festival: Summer 2026!')).toBe('My-Festival-Summer-2026');
    expect(safeFileName('Glasto / 2026 \\ Pyramid')).toBe('Glasto-2026-Pyramid');
    expect(safeFileName('a<b>c|d?e*f"g')).toBe('abcdefg');
  });

  it('never yields a path', () => {
    expect(safeFileName('../../etc/passwd')).toBe('etcpasswd');
    expect(safeFileName('..\\..\\windows')).toBe('windows');
    expect(safeFileName('/abs/path')).toBe('abspath');
    expect(safeFileName('.hidden')).toBe('hidden');
    expect(safeFileName('trailing.')).toBe('trailing');
    for (const n of ['x', '../x', 'a b', 'con', '', '💥']) expect(safeFileName(n)).not.toMatch(/[\\/]/);
  });

  it('suffixes Windows reserved device names', () => {
    for (const n of ['con', 'CON', 'prn', 'aux', 'NUL', 'com1', 'COM9', 'lpt1']) expect(safeFileName(n)).toBe(`${n}-file`);
    expect(safeFileName('console')).toBe('console');
  });

  it('falls back when nothing survives and caps the length', () => {
    expect(safeFileName('')).toBe('draft');
    expect(safeFileName('???')).toBe('draft');
    expect(safeFileName('💥🎉')).toBe('draft');
    expect(safeFileName('', 'playlist')).toBe('playlist');
    expect(safeFileName('x'.repeat(200)).length).toBe(80);
  });

  it('strips diacritics', () => {
    expect(safeFileName('Beyoncé at Glasto')).toBe('Beyonce-at-Glasto');
  });
});
