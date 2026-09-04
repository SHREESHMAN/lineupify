/**
 * Terminal subcommands: setup, auth, doctor, install, config, preview,
 * update-check. These print to stdout on purpose (they never run under MCP).
 */
/* eslint-disable no-console */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { LineupifyError, type Config } from './types.js';
import { loadConfig, resolveSettings, saveConfig } from './infra/config.js';
import { ensureDirs, paths, readJson, writeJsonAtomic } from './infra/store.js';
import { http } from './infra/http.js';
import { artistCache, flushAllCaches } from './infra/cache.js';
import { fold } from './engine/normalize.js';
import { parseLineupText } from './engine/lineup.js';
import { resolveOrSplit, type ResolveResult } from './engine/resolve.js';
import { ensureIsrc } from './engine/match.js';
import { previewPick } from './engine/jobs.js';
import { effectiveTier, targetFor } from './engine/select.js';
import * as spotify from './sources/spotify.js';
import * as lastfm from './sources/lastfm.js';
import readline from 'node:readline/promises';
import { disconnectAccount, saveClientId, SETUP_STEPS, validateClientId, VERSION } from './tools/connect.js';

const DASHBOARD_URL = 'https://developer.spotify.com/dashboard';

async function openInBrowser(url: string): Promise<boolean> {
  try {
    const open = (await import('open')).default;
    const child = await open(url, { wait: false });
    child.unref?.();
    return true;
  } catch {
    return false;
  }
}

export function help(): string {
  return [
    `lineupify-mcp ${VERSION} — festival lineup -> Spotify playlist, as an MCP server`,
    '',
    'Usage:',
    '  lineupify-mcp                      serve MCP over stdio (what your MCP client runs)',
    '  lineupify-mcp init                 guided setup: Client ID, Spotify login, host install, health check',
    '  lineupify-mcp setup --client-id <id> [--port <n>] [--lastfm-key <key>]',
    '  lineupify-mcp auth [--force]       log in to Spotify from the terminal',
    '  lineupify-mcp logout [--purge]     forget the login; --purge also deletes ~/.lineupify (config, caches, drafts, exports)',
    '  lineupify-mcp doctor               check config, tokens, ports and APIs; print MCP config snippets',
    '  lineupify-mcp install --claude-desktop | --claude-code | --cursor',
    '  lineupify-mcp config get | set <key> <value> | reset | clear-artist <name>',
    '  lineupify-mcp preview <lineup.txt> [--per-artist <n>]   dry run without Spotify',
    '  lineupify-mcp update-check',
    '',
    'Config keys for `config set`: tracksPerTier.headliner|sub|undercard, tracksPerArtist, maxTracks,',
    '  order, public, excludeExplicit, allowVersions, discoveryOnly, stopIfUnresolved, skipCovers, provider, namingTemplate',
  ].join('\n');
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

export async function runCli(cmd: string, args: string[]): Promise<number> {
  await ensureDirs();
  switch (cmd) {
    case 'init':
      return cmdInit();
    case 'setup':
      return cmdSetup(args);
    case 'auth':
      return cmdAuth(args);
    case 'logout':
      return cmdLogout(args);
    case 'doctor':
      return cmdDoctor();
    case 'install':
      return cmdInstall(args);
    case 'config':
      return cmdConfig(args);
    case 'preview':
      return cmdPreview(args);
    case 'update-check':
      return cmdUpdateCheck();
    default:
      console.error(`Unknown command "${cmd}".\n\n${help()}`);
      return 2;
  }
}

async function cmdSetup(args: string[]): Promise<number> {
  const cfg = await loadConfig();
  const id = flag(args, '--client-id');
  const port = flag(args, '--port');
  const key = flag(args, '--lastfm-key');
  if (!id && !port && !key) {
    console.log(SETUP_STEPS.join('\n'));
    console.log('\nThen: lineupify-mcp setup --client-id <your client id>');
    return 1;
  }
  if (id) {
    try {
      cfg.spotifyClientId = validateClientId(id);
    } catch (err) {
      console.error((err as Error).message);
      return 1;
    }
  }
  if (port) {
    const n = Number(port);
    if (!Number.isInteger(n) || n < 1024 || n > 65535) {
      console.error('--port must be 1024-65535');
      return 1;
    }
    cfg.spotifyRedirectPort = n;
  }
  if (key) cfg.lastfmApiKey = key;
  await saveConfig(cfg);
  console.log(`Saved to ${paths.config()}. Next: lineupify-mcp auth`);
  return 0;
}

async function cmdAuth(args: string[]): Promise<number> {
  const settings = await resolveSettings();
  if (!settings.clientId) {
    console.error('No client ID. Run: lineupify-mcp setup --client-id <id>');
    return 1;
  }
  const existing = await spotify.loadTokens();
  if (existing && !args.includes('--force')) {
    console.log(`Already connected as ${existing.displayName || existing.userId}. Use --force to log in again.`);
    return 0;
  }
  const { url } = await spotify.startAuth(settings.clientId, settings.redirectPort);
  console.log('Opening Spotify login in your browser. If it does not open, visit:\n' + url);
  try {
    const open = (await import('open')).default;
    await open(url, { wait: false });
  } catch {
    /* printed above */
  }
  const tokens = await spotify.waitForAuth(5 * 60_000);
  if (!tokens) {
    const r = spotify.pendingAuthResult();
    console.error(`Login did not complete: ${r?.error?.message ?? 'timed out'}`);
    return 1;
  }
  console.log(`Connected as ${tokens.displayName || tokens.userId}.`);
  return 0;
}

async function cmdLogout(args: string[]): Promise<number> {
  const lines = await disconnectAccount({ purge: args.includes('--purge') });
  console.log(lines.join('\n'));
  return 0;
}

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

export async function runDoctor(): Promise<{ checks: Check[]; ok: boolean }> {
  const checks: Check[] = [];
  const settings = await resolveSettings();
  checks.push({ name: 'Node.js', ok: true, detail: process.versions.node });
  checks.push({ name: 'Data dir', ok: true, detail: paths.home() });
  checks.push({ name: 'Client ID', ok: !!settings.clientId, detail: settings.clientId ? `set (${process.env.SPOTIFY_CLIENT_ID ? 'env' : 'config.json'})` : 'missing — run: lineupify-mcp setup --client-id <id>' });
  {
    const busy = await portBusy(settings.redirectPort);
    checks.push({ name: 'Redirect URI', ok: !busy, detail: busy ? `port ${settings.redirectPort} is in use by another program; pick another with setup --port and update the dashboard` : `http://127.0.0.1:${settings.redirectPort}/callback (port free; this exact URI must be in the app's Redirect URIs)` });
  }
  const tokens = await spotify.loadTokens();
  if (!tokens) checks.push({ name: 'Spotify login', ok: !settings.clientId ? true : false, detail: settings.clientId ? 'not connected — run: lineupify-mcp auth' : 'not connected — Deezer mode works without it (build, read, analyse, export); run setup + auth to publish to Spotify' });
  else {
    const age = spotify.refreshTokenAge(tokens);
    checks.push({ name: 'Spotify login', ok: age.daysLeft > 0, detail: `${tokens.displayName || tokens.userId}; refresh token ${age.daysLeft > 0 ? `valid ${age.daysLeft} more days` : 'EXPIRED — run: lineupify-mcp auth --force'}` });
    const granted = new Set((tokens.scope || '').split(/\s+/));
    const missing = spotify.SCOPES.filter((sc) => !granted.has(sc));
    if (tokens.scope && missing.length) checks.push({ name: 'Spotify scopes', ok: false, detail: `missing ${missing.join(', ')} — run: lineupify-mcp auth --force` });
    try {
      const me = await spotify.me();
      checks.push({ name: 'Spotify API', ok: true, detail: `GET /me ok (${me.id})` });
    } catch (err) {
      const e = err as LineupifyError;
      checks.push({ name: 'Spotify API', ok: false, detail: `${e.code ?? 'error'}: ${e.message} ${e.hint ?? ''}` });
    }
  }
  try {
    const r = await http('https://api.deezer.com/artist/1', { attempts: 1, timeoutMs: 8000 });
    checks.push({ name: 'Deezer', ok: r.status === 200, detail: `HTTP ${r.status}` });
  } catch (err) {
    checks.push({ name: 'Deezer', ok: false, detail: String(err) });
  }
  if (settings.lastfmApiKey) checks.push({ name: 'Last.fm key', ok: await lastfm.validateKey(settings.lastfmApiKey), detail: 'validated with artist.getInfo' });
  else checks.push({ name: 'Last.fm key', ok: true, detail: 'not set (optional)' });
  return { checks, ok: checks.every((c) => c.ok) };
}

async function cmdDoctor(): Promise<number> {
  const { checks, ok } = await runDoctor();
  for (const c of checks) console.log(`${c.ok ? 'OK  ' : 'FAIL'} ${c.name.padEnd(16)} ${c.detail}`);
  console.log('');
  console.log(configSnippets());
  return ok ? 0 : 1;
}

function serverCommand(): { command: string; args: string[] } {
  const here = fileURLToPath(import.meta.url);
  const globalBin = !/_npx[\\/]/.test(here) && /node_modules[\\/]lineupify-mcp[\\/]/.test(here);
  if (globalBin) return { command: 'lineupify-mcp', args: [] };
  // Running from a source checkout (not installed from npm): point the host at this build directly.
  if (!/node_modules[\\/]/.test(here)) {
    // Prefer the bare "node" (it is on PATH whenever npm is) because paths with spaces
    // such as "C:\Program Files\nodejs\node.exe" get split by some host CLIs.
    return { command: 'node', args: [path.join(path.dirname(here), 'index.js')] };
  }
  if (process.platform === 'win32') return { command: 'cmd', args: ['/c', 'npx', '-y', 'lineupify-mcp'] };
  return { command: 'npx', args: ['-y', 'lineupify-mcp'] };
}

function configSnippets(): string {
  const { command, args } = serverCommand();
  const entry = { command, args, env: { SPOTIFY_CLIENT_ID: '<your client id, or run setup and omit env>' } };
  const json = JSON.stringify({ mcpServers: { lineupify: entry } }, null, 2);
  const cc = `claude mcp add --transport stdio --scope user lineupify -- ${[command, ...args].join(' ')}`;
  return [
    'Claude Desktop (claude_desktop_config.json) and Cursor (~/.cursor/mcp.json):',
    json,
    '',
    'Claude Code:',
    `  ${cc}`,
    '',
    'Or let Lineupify write it: lineupify-mcp install --claude-desktop | --claude-code | --cursor',
  ].join('\n');
}

function claudeDesktopConfigPath(): string {
  if (process.platform === 'win32') return path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  return path.join(os.homedir(), '.config', 'Claude', 'claude_desktop_config.json');
}

async function mergeMcpJson(file: string): Promise<void> {
  const existing = (await readJson<{ mcpServers?: Record<string, unknown> }>(file)) ?? {};
  const settings = await resolveSettings();
  const { command, args } = serverCommand();
  const entry: Record<string, unknown> = { command, args };
  if (process.env.SPOTIFY_CLIENT_ID && !settings.clientId) entry.env = { SPOTIFY_CLIENT_ID: process.env.SPOTIFY_CLIENT_ID };
  const next = { ...existing, mcpServers: { ...(existing.mcpServers ?? {}), lineupify: entry } };
  if (await fs.stat(file).then(() => true, () => false)) await fs.copyFile(file, `${file}.bak`);
  await writeJsonAtomic(file, next);
}

type Host = 'claude-desktop' | 'cursor' | 'claude-code';

const HOST_NAMES: Record<Host, string> = { 'claude-desktop': 'Claude Desktop', cursor: 'Cursor', 'claude-code': 'Claude Code' };

/** Hosts that look installed on this machine (config folder present, or the CLI on PATH). */
async function detectHosts(): Promise<Host[]> {
  const found: Host[] = [];
  const exists = (p: string) => fs.stat(p).then(() => true, () => false);
  if (await exists(path.dirname(claudeDesktopConfigPath()))) found.push('claude-desktop');
  const claude = spawnSync(process.platform === 'win32' ? 'claude.cmd' : 'claude', ['--version'], { stdio: 'ignore', shell: process.platform === 'win32' });
  if (claude.status === 0) found.push('claude-code');
  if (await exists(path.join(os.homedir(), '.cursor'))) found.push('cursor');
  return found;
}

/** Write Lineupify into one host's config. Returns what to tell the user. */
async function installInto(host: Host): Promise<{ ok: boolean; message: string }> {
  if (host === 'claude-desktop') {
    const file = claudeDesktopConfigPath();
    await mergeMcpJson(file);
    return { ok: true, message: `Added "lineupify" to ${file} (backup: ${file}.bak). Quit Claude Desktop fully (system tray / dock) and reopen it.` };
  }
  if (host === 'cursor') {
    const file = path.join(os.homedir(), '.cursor', 'mcp.json');
    await mergeMcpJson(file);
    return { ok: true, message: `Added "lineupify" to ${file}. Restart Cursor.` };
  }
  const { command, args: a } = serverCommand();
  const q = (x: string) => (/\s/.test(x) ? `"${x}"` : x);
  const cmdArgs = ['mcp', 'add', '--transport', 'stdio', '--scope', 'user', 'lineupify', '--', q(command), ...a.map(q)];
  const r = spawnSync(process.platform === 'win32' ? 'claude.cmd' : 'claude', cmdArgs, { stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status === 0) return { ok: true, message: 'Added to Claude Code (user scope).' };
  return { ok: false, message: `Could not run the claude CLI. Run this yourself:\n  claude ${cmdArgs.join(' ')}` };
}

async function cmdInstall(args: string[]): Promise<number> {
  const settings = await resolveSettings();
  if (!settings.clientId) console.log('Note: no client ID saved yet. Run `lineupify-mcp setup --client-id <id>` (or ask the assistant to call setup) before connecting.');
  const host: Host | undefined = args.includes('--claude-desktop') ? 'claude-desktop' : args.includes('--cursor') ? 'cursor' : args.includes('--claude-code') ? 'claude-code' : undefined;
  if (!host) {
    console.log('Pick a host: --claude-desktop, --claude-code or --cursor\n');
    console.log(configSnippets());
    return 2;
  }
  const r = await installInto(host);
  console.log(r.message);
  return r.ok ? 0 : 1;
}

/**
 * Guided first run: Client ID, Spotify login, host install, health check.
 * Every step can be skipped; nothing here is needed if you prefer the
 * separate setup / auth / install commands.
 */
async function cmdInit(): Promise<number> {
  if (!process.stdin.isTTY) {
    console.error('init is interactive; run it in a terminal. Non-interactive alternative: setup --client-id <id>, then auth, then install --<host>.');
    return 2;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (q: string): Promise<string> => (await rl.question(`${q} `)).trim();
  const yes = async (q: string, dflt = true): Promise<boolean> => {
    const a = (await ask(`${q} ${dflt ? '(Y/n)' : '(y/N)'}`)).toLowerCase();
    return a ? a.startsWith('y') : dflt;
  };
  try {
    console.log(`Lineupify ${VERSION} guided setup. Data folder: ${paths.home()}\n`);

    // 1. Client ID
    const settings = await resolveSettings();
    let clientId = settings.clientId;
    if (clientId) {
      console.log(`Step 1/4 · A Spotify Client ID is already saved (${clientId.slice(0, 6)}…${process.env.SPOTIFY_CLIENT_ID ? ', from SPOTIFY_CLIENT_ID' : ''}).`);
      if (!process.env.SPOTIFY_CLIENT_ID && !(await yes('Keep it?'))) clientId = undefined;
    }
    if (!clientId) {
      console.log('Step 1/4 · Create a free Spotify app (2 minutes):');
      console.log(SETUP_STEPS.slice(0, 3).map((s) => `  ${s}`).join('\n'));
      if (await yes('Open the Spotify developer dashboard in your browser now?')) {
        if (!(await openInBrowser(DASHBOARD_URL))) console.log(`  Could not open a browser. Visit ${DASHBOARD_URL}`);
      }
      for (;;) {
        const id = await ask('Paste the Client ID (or leave empty to skip):');
        if (!id) break;
        try {
          clientId = await saveClientId(id);
          console.log('  Saved.');
          break;
        } catch (err) {
          console.log(`  ${(err as Error).message}`);
        }
      }
    }

    // 2. Login
    const existing = await spotify.loadTokens();
    const granted = new Set((existing?.scope || '').split(/\s+/));
    const stale = !!existing && (spotify.refreshTokenAge(existing).daysLeft <= 0 || existing.clientId !== clientId || spotify.SCOPES.some((s) => !granted.has(s)));
    if (existing && !stale) console.log(`\nStep 2/4 · Already connected as ${existing.displayName || existing.userId}.`);
    else if (!clientId) console.log('\nStep 2/4 · Skipped: no Client ID yet.');
    else if (await yes(`\nStep 2/4 · ${existing ? 'The saved login needs a refresh. ' : ''}Log in to Spotify now? (opens your browser)`)) {
      const { url } = await spotify.startAuth(clientId, settings.redirectPort);
      if (!(await openInBrowser(url))) console.log(`  Could not open a browser. Visit:\n  ${url}`);
      console.log('  Waiting for you to approve in the browser (up to 5 minutes)…');
      const tokens = await spotify.waitForAuth(5 * 60_000);
      if (tokens) console.log(`  Connected as ${tokens.displayName || tokens.userId}.`);
      else console.log(`  Login did not complete: ${spotify.pendingAuthResult()?.error?.message ?? 'timed out'}. Run \`lineupify-mcp auth\` later.`);
    }

    // 3. Hosts
    console.log('\nStep 3/4 · Add Lineupify to your MCP host.');
    const hosts = await detectHosts();
    if (!hosts.length) {
      console.log('  No Claude Desktop, Claude Code or Cursor install detected. Config snippets for any host:\n');
      console.log(configSnippets());
    }
    for (const h of hosts) {
      if (await yes(`  ${HOST_NAMES[h]} detected. Add Lineupify to it?`)) {
        const r = await installInto(h);
        console.log(`  ${r.message}`);
      }
    }

    // 4. Doctor
    console.log('\nStep 4/4 · Health check');
    const { checks, ok } = await runDoctor();
    for (const c of checks) console.log(`  ${c.ok ? 'OK  ' : 'FAIL'} ${c.name.padEnd(16)} ${c.detail}`);
    console.log(ok ? '\nDone. Restart your host, open a new chat and say: "make me a playlist for this lineup" or "artists like Khruangbin".' : '\nSomething is not right yet; the FAIL lines above say what to fix. Re-run `lineupify-mcp init` any time.');
    return ok ? 0 : 1;
  } finally {
    rl.close();
  }
}

async function cmdConfig(args: string[]): Promise<number> {
  const [sub, key, ...valueParts] = args;
  const cfg = await loadConfig();
  if (sub === 'get' || !sub) {
    const shown: Config = { ...cfg, lastfmApiKey: cfg.lastfmApiKey ? '***' : undefined };
    console.log(JSON.stringify(shown, null, 2));
    return 0;
  }
  if (sub === 'reset') {
    await saveConfig({ spotifyClientId: cfg.spotifyClientId, spotifyRedirectPort: cfg.spotifyRedirectPort, lastfmApiKey: cfg.lastfmApiKey, defaults: {} });
    console.log('Defaults reset.');
    return 0;
  }
  if (sub === 'clear-artist') {
    const name = [key, ...valueParts].filter(Boolean).join(' ');
    if (!name) {
      console.error('Usage: config clear-artist <name>');
      return 2;
    }
    await artistCache.delete(fold(name));
    await flushAllCaches();
    console.log(`Cleared cached match for "${name}".`);
    return 0;
  }
  if (sub === 'set') {
    const value = valueParts.join(' ');
    if (!key || value === '') {
      console.error('Usage: config set <key> <value>');
      return 2;
    }
    const defaults = (cfg.defaults ?? {}) as Record<string, unknown>;
    const parsed: unknown = value === 'true' ? true : value === 'false' ? false : /^-?\d+$/.test(value) ? Number(value) : value;
    if (key.startsWith('tracksPerTier.')) {
      const tier = key.split('.')[1] as 'headliner' | 'sub' | 'undercard';
      if (!['headliner', 'sub', 'undercard'].includes(tier) || typeof parsed !== 'number') {
        console.error('tracksPerTier.<headliner|sub|undercard> <number>');
        return 2;
      }
      defaults.tracksPerTier = { ...((defaults.tracksPerTier as Record<string, number>) ?? {}), [tier]: parsed };
    } else if (['tracksPerArtist', 'maxTracks', 'maxDurationMin'].includes(key)) {
      if (typeof parsed !== 'number') {
        console.error(`${key} needs a number`);
        return 2;
      }
      defaults[key] = parsed;
    } else if (['public', 'excludeExplicit', 'allowVersions', 'discoveryOnly', 'stopIfUnresolved', 'skipCovers'].includes(key)) {
      if (typeof parsed !== 'boolean') {
        console.error(`${key} needs true or false`);
        return 2;
      }
      defaults[key] = parsed;
    } else if (key === 'order') {
      if (!['interleave', 'lineup', 'shuffle', 'by_day', 'known_first'].includes(value)) {
        console.error('order: interleave | lineup | shuffle | by_day | known_first');
        return 2;
      }
      defaults.order = value;
    } else if (key === 'namingTemplate') {
      defaults.namingTemplate = value;
    } else if (key === 'provider') {
      if (!['spotify', 'deezer'].includes(value)) {
        console.error('provider: spotify | deezer');
        return 2;
      }
      defaults.provider = value;
    } else {
      console.error(`Unknown key ${key}`);
      return 2;
    }
    cfg.defaults = defaults as Config['defaults'];
    await saveConfig(cfg);
    console.log(`${key} = ${JSON.stringify(parsed)}`);
    return 0;
  }
  console.error('Usage: config get | set <key> <value> | reset | clear-artist <name>');
  return 2;
}

async function cmdPreview(args: string[]): Promise<number> {
  const file = args.find((a) => !a.startsWith('--'));
  if (!file) {
    console.error('Usage: preview <lineup.txt> [--per-artist <n>]');
    return 2;
  }
  const raw = await fs.readFile(file, 'utf8');
  const settings = await resolveSettings();
  const per = Number(flag(args, '--per-artist')) || undefined;
  const parsed = parseLineupText(raw);
  console.log(`${parsed.artists.length} artists parsed${parsed.tiered ? ' (tiered)' : ''}; ignored: ${parsed.discarded.slice(0, 10).join(' | ')}`);
  const anyTier = parsed.artists.some((a) => !!a.tier);
  const opts = { ...settings.defaults, tracksPerArtist: per ?? settings.defaults.tracksPerArtist };
  let total = 0;
  const rctx = { sources: settings.defaults.sources, lastfmApiKey: settings.lastfmApiKey, spotifyAvailable: false };
  const show = async (name: string, tier: string, need: number, r: ResolveResult) => {
    if (!r.resolved) {
      console.log(`\n${name} [${tier}] — UNRESOLVED (${r.reason}; tried ${r.queriesTried.join(', ')})`);
      return;
    }
    const picks = previewPick(r.candidates, need, opts.allowVersions);
    console.log(`\n${name} [${tier}] -> ${r.resolved.name} (${r.resolved.source}${r.resolved.nbFan ? `, ${r.resolved.nbFan} fans` : ''}${r.resolved.confidence === 'low' ? ', LOW CONFIDENCE' : ''})`);
    for (const c of picks) {
      await ensureIsrc(c).catch(() => undefined);
      console.log(`  - ${c.title}${c.role === 'featured' ? ` (feat, lead ${c.leadArtist})` : ''}  ${c.isrc ?? 'no isrc'}`);
      total++;
    }
  };
  for (const a of parsed.artists) {
    const tier = effectiveTier(a, anyTier);
    const need = targetFor(tier, opts);
    const r = await resolveOrSplit(a.name, rctx);
    if (r.parts) {
      console.log(`\n${a.name} -> split into ${r.parts.map((p) => p.name).join(' / ')}`);
      for (const p of r.parts) await show(p.name, tier, need, p.result);
    } else await show(a.name, tier, need, r.whole);
  }
  await flushAllCaches();
  console.log(`\n${total} tracks would be selected.`);
  return 0;
}

async function cmdUpdateCheck(): Promise<number> {
  try {
    const res = await http('https://registry.npmjs.org/lineupify-mcp/latest', { attempts: 1, timeoutMs: 5000 });
    const latest = res.json<{ version?: string }>()?.version;
    if (!latest) throw new Error('no version in registry response');
    if (latest === VERSION) console.log(`${VERSION} is the latest version.`);
    else console.log(`${latest} is available (you have ${VERSION}). Update: npm i -g lineupify-mcp@latest`);
    return 0;
  } catch (err) {
    console.error(`Could not check: ${String(err)}`);
    return 1;
  }
}

async function portBusy(port: number): Promise<boolean> {
  const net = await import('node:net');
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(true));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(false)));
  });
}
