/**
 * ~/.lineupify layout, atomic JSON writes, and cross-process lock files.
 * Every write goes through writeJsonAtomic so a killed process never leaves
 * a half-written file behind. A corrupt file reads back as `undefined`.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { log } from './log.js';

export function homeDir(): string {
  return process.env.LINEUPIFY_HOME || path.join(os.homedir(), '.lineupify');
}

export const paths = {
  home: () => homeDir(),
  config: () => path.join(homeDir(), 'config.json'),
  tokens: () => path.join(homeDir(), 'tokens.json'),
  tokensLock: () => path.join(homeDir(), 'tokens.lock'),
  cacheDir: () => path.join(homeDir(), 'cache'),
  cache: (name: string) => path.join(homeDir(), 'cache', `${name}.json`),
  draftsDir: () => path.join(homeDir(), 'drafts'),
  draft: (id: string) => path.join(homeDir(), 'drafts', `${id}.json`),
  draftLock: (id: string) => path.join(homeDir(), 'drafts', `${id}.lock`),
  draftRevDir: (id: string) => path.join(homeDir(), 'drafts', `${id}.rev`),
  exportsDir: () => path.join(homeDir(), 'exports'),
};

export async function ensureDirs(): Promise<void> {
  for (const dir of [paths.home(), paths.cacheDir(), paths.draftsDir(), paths.exportsDir()]) {
    await fs.mkdir(dir, { recursive: true });
  }
}

export async function readJson<T>(file: string): Promise<T | undefined> {
  try {
    const raw = await fs.readFile(file, 'utf8');
    return JSON.parse(raw) as T;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return undefined;
    log.error(`unreadable json, ignoring: ${file}`, String(err));
    return undefined;
  }
}

export async function writeJsonAtomic(file: string, value: unknown, mode?: number): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), { encoding: 'utf8', mode });
  try {
    await fs.rename(tmp, file);
  } catch (err) {
    // Windows can refuse rename over an open file; retry once after a short pause.
    await new Promise((r) => setTimeout(r, 50));
    await fs.rename(tmp, file).catch(async (err2) => {
      await fs.unlink(tmp).catch(() => undefined);
      throw err2 ?? err;
    });
  }
  if (mode !== undefined) await fs.chmod(file, mode).catch(() => undefined);
}

export async function fileMtimeMs(file: string): Promise<number | undefined> {
  try {
    return (await fs.stat(file)).mtimeMs;
  } catch {
    return undefined;
  }
}

/** Age in ms of a lock file, or undefined if none. */
export async function lockAge(file: string): Promise<number | undefined> {
  const m = await fileMtimeMs(file);
  return m === undefined ? undefined : Date.now() - m;
}

export interface LockHandle {
  file: string;
  release: () => Promise<void>;
  /** Refresh the mtime so other processes see this lock as live. */
  heartbeat: () => Promise<void>;
}

export const LOCK_STALE_MS = 60_000;

/**
 * Acquire an exclusive lock file. A lock older than LOCK_STALE_MS is treated as
 * abandoned and taken over. Returns undefined when someone else holds it live.
 */
export async function tryLock(file: string, owner = `${process.pid}`): Promise<LockHandle | undefined> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await fs.open(file, 'wx');
      await handle.writeFile(JSON.stringify({ owner, at: new Date().toISOString() }));
      await handle.close();
      return {
        file,
        release: async () => {
          await fs.unlink(file).catch(() => undefined);
        },
        heartbeat: async () => {
          const now = new Date();
          await fs.utimes(file, now, now).catch(() => undefined);
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const age = await lockAge(file);
      if (age !== undefined && age > LOCK_STALE_MS) {
        log.info(`taking over stale lock ${file} (age ${Math.round(age / 1000)}s)`);
        await fs.unlink(file).catch(() => undefined);
        continue;
      }
      return undefined;
    }
  }
  return undefined;
}

/** Wait up to `timeoutMs` for a lock, polling. */
export async function waitLock(file: string, timeoutMs: number, owner?: string): Promise<LockHandle> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const h = await tryLock(file, owner);
    if (h) return h;
    if (Date.now() > deadline) throw new Error(`timed out waiting for lock ${file}`);
    await new Promise((r) => setTimeout(r, 100 + Math.random() * 100));
  }
}

/** Sanitize a user-facing name into a safe file name (no paths, no reserved names). */
export function safeFileName(name: string, fallback = 'draft'): string {
  let s = name
    .normalize('NFKD')
    .replace(/[^\w\s.-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, 80);
  if (!s) s = fallback;
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(s)) s = `${s}-file`;
  return s;
}
