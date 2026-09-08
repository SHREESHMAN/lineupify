/**
 * Two processes on one draft: a second Node process holds the build lock the
 * way another MCP host would, and this process must read instead of build.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const home = await fs.mkdtemp(path.join(os.tmpdir(), 'lineupify-lock-'));
process.env.LINEUPIFY_HOME = home;
process.env.LINEUPIFY_LOG = 'error';

const { paths, ensureDirs, LOCK_STALE_MS } = await import('../../src/infra/store.js');
const { newDraft, saveDraft } = await import('../../src/engine/draft.js');
const { lockedElsewhere, startJob } = await import('../../src/engine/jobs.js');
const drafts = await import('../../src/tools/drafts.js');

// The other "host": takes the lock exclusively and heartbeats it like jobs.ts does.
const HOLDER = `
  const fs = require('node:fs');
  const file = process.argv[process.argv.length - 1];
  fs.writeFileSync(file, JSON.stringify({ owner: 'other-host', at: new Date().toISOString() }), { flag: 'wx' });
  process.stdout.write('locked\\n');
  setInterval(() => { const now = new Date(); fs.utimesSync(file, now, now); }, 1000);
`;

let holder: ChildProcess | undefined;

async function startHolder(lockFile: string): Promise<void> {
  holder = spawn(process.execPath, ['-e', HOLDER, lockFile], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise<void>((resolve, reject) => {
    holder!.stdout!.once('data', (d: Buffer) => (String(d).includes('locked') ? resolve() : reject(new Error(String(d)))));
    holder!.once('exit', (code) => reject(new Error(`holder exited ${code}`)));
  });
}

async function stopHolder(): Promise<void> {
  if (!holder) return;
  const h = holder;
  holder = undefined;
  await new Promise<void>((resolve) => {
    h.once('exit', () => resolve());
    h.kill();
  });
}

afterAll(async () => {
  await stopHolder();
  await fs.rm(home, { recursive: true, force: true }).catch(() => undefined);
});

describe('a draft being built by another process', () => {
  it('is reported as locked elsewhere: edits and builds are refused, reads work, and release frees it', async () => {
    await ensureDirs();
    const d = newDraft({ name: 'Shared', artists: [{ name: 'Someone' }], options: { tracksPerTier: { headliner: 5, sub: 3, undercard: 2 }, maxTracks: 100, order: 'interleave', excludeArtists: [], excludeExplicit: false, allowVersions: false, discoveryOnly: false, stopIfUnresolved: false, public: false, sources: ['deezer'] }, spotifyUserId: '', provider: 'deezer' });
    await saveDraft(d);
    await startHolder(paths.draftLock(d.id));

    expect(await lockedElsewhere(d.id)).toBe(true);
    expect(await startJob(d.id, {})).toBe('locked_elsewhere');
    await expect(drafts.editDraft({ draftId: d.id, ops: [{ op: 'set_meta', name: 'Renamed' }] })).rejects.toMatchObject({ code: 'DRAFT_BUILDING_ELSEWHERE' });
    // Reading is fine: the summary comes from disk.
    const out = drafts.getDraftTool({ draftId: d.id });
    expect((await out).content[0]!.text).toContain(`Draft ${d.id}`);

    await stopHolder();
    await fs.unlink(paths.draftLock(d.id));
    expect(await lockedElsewhere(d.id)).toBe(false);
  }, 20_000);

  it('treats a lock nobody has touched for a minute as abandoned', async () => {
    const file = paths.draftLock('d_stale1');
    await fs.writeFile(file, JSON.stringify({ owner: 'dead' }));
    const old = new Date(Date.now() - LOCK_STALE_MS - 5000);
    await fs.utimes(file, old, old);
    expect(await lockedElsewhere('d_stale1')).toBe(false);
  });
});
