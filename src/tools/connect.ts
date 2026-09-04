/** status, setup, connect */
import { createRequire } from 'node:module';
import { LineupifyError } from '../types.js';
import { DEFAULT_REDIRECT_PORT, loadConfig, resolveSettings, saveConfig } from '../infra/config.js';
import { promises as fs } from 'node:fs';
import { artistCache, playlistCache, spotifyTrackCache } from '../infra/cache.js';
import { http } from '../infra/http.js';
import { log } from '../infra/log.js';
import { paths } from '../infra/store.js';
import { clean } from '../infra/text.js';
import { listDrafts } from '../engine/draft.js';
import { isRunning } from '../engine/jobs.js';
import * as spotify from '../sources/spotify.js';
import { readOnlyMode, text } from './shared.js';

export const SPOTIFY_APPS_URL = 'https://www.spotify.com/account/apps/';

/**
 * Forget the Spotify login (and, with purge, every file Lineupify keeps).
 * Spotify has no API to revoke a token; the user removes the app at
 * SPOTIFY_APPS_URL. Refused while a draft is building.
 */
export async function disconnectAccount(opts: { purge?: boolean }): Promise<string[]> {
  const drafts = await listDrafts();
  if (drafts.some((d) => isRunning(d.id))) throw new LineupifyError('JOB_RUNNING', 'A draft is building right now.', 'Wait for it to finish (get_draft with waitSeconds), then disconnect.');
  spotify.cancelPendingAuth();
  const tokens = await spotify.loadTokens();
  await spotify.clearTokens();
  const lines: string[] = [];
  lines.push(tokens ? `Forgot the Spotify login for ${clean(tokens.displayName || tokens.userId, 40)} (tokens.json deleted).` : 'No Spotify login was saved.');
  if (opts.purge) {
    const home = paths.home();
    await fs.rm(home, { recursive: true, force: true });
    lines.push(`Deleted ${home}: config (client ID, defaults, Last.fm key), caches, drafts and exports.`);
  } else {
    lines.push(`Kept: config, caches, drafts and exports under ${paths.home()} (purge: true removes them too).`);
  }
  lines.push(`Lineupify cannot revoke the token on Spotify's side. To remove its access entirely, open ${SPOTIFY_APPS_URL} and click "Remove access" next to your app.`);
  return lines;
}

const require = createRequire(import.meta.url);
export const VERSION: string = (require('../../package.json') as { version: string }).version;

let latestChecked: { at: number; version?: string } | undefined;
export function updateCheckDisabled(): boolean {
  const v = (process.env.LINEUPIFY_NO_UPDATE_CHECK ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

async function latestVersion(): Promise<string | undefined> {
  if (updateCheckDisabled()) return undefined;
  if (latestChecked && Date.now() - latestChecked.at < 6 * 3600_000) return latestChecked.version;
  latestChecked = { at: Date.now() };
  try {
    const res = await http('https://registry.npmjs.org/lineupify-mcp/latest', { attempts: 1, timeoutMs: 2500 });
    const body = res.json<{ version?: string }>();
    latestChecked.version = body?.version;
  } catch (err) {
    log.debug('update check failed', String(err));
  }
  return latestChecked.version;
}

export const SETUP_STEPS = [
  '1. Go to https://developer.spotify.com/dashboard, log in with a Spotify Premium account and click "Create app".',
  '2. Name it anything (e.g. Lineupify), choose "Web API", and set the Redirect URI to exactly: http://127.0.0.1:8765/callback  (the dashboard rejects the port-less form, and "localhost" is not allowed)',
  '   If you already have an app, open its Settings and add that Redirect URI instead.',
  '3. Copy the Client ID (no secret needed) and give it to Lineupify with the setup tool, or set SPOTIFY_CLIENT_ID in your MCP config.',
  '4. Call connect. A browser opens; sign in and approve. Done.',
];

export async function statusText(): Promise<string> {
  const settings = await resolveSettings();
  const tokens = await spotify.loadTokens();
  const pendingAuth = spotify.pendingAuth();
  const pendingResult = spotify.pendingAuthResult();
  const lines: string[] = [];
  lines.push(`Lineupify ${VERSION} · Spotify API snapshot ${spotify.SPOTIFY_API_SNAPSHOT}`);

  if (tokens) {
    const age = spotify.refreshTokenAge(tokens);
    let tokenNote = `authorized ${age.daysUsed} days ago, refresh token expires in ${age.daysLeft} days`;
    if (age.daysLeft <= 0) tokenNote = 'refresh token EXPIRED (Spotify limits them to 6 months). Call connect with force: true.';
    else if (age.daysLeft <= 30) tokenNote += ' — reconnect soon with connect force: true';
    lines.push(`Spotify: connected as ${clean(tokens.displayName || tokens.userId, 40)} (${tokens.userId}) · ${tokenNote}`);
    const granted = new Set((tokens.scope || '').split(/\s+/));
    const missing = spotify.SCOPES.filter((sc) => !granted.has(sc));
    if (tokens.scope && missing.length) lines.push(`Permissions missing (${missing.join(', ')}): call connect with force: true to re-login.`);
  } else if (pendingAuth) {
    lines.push(`Spotify: login in progress (started ${Math.round(pendingAuth.ageMs / 1000)}s ago). If no browser opened, open this URL: ${pendingAuth.url}`);
  } else if (pendingResult?.error) {
    lines.push(`Spotify: last login failed: ${clean(pendingResult.error.message, 120)}. Call connect again.`);
  } else if (settings.clientId) {
    lines.push(`Spotify: not connected. Client ID is set. Next: call connect.`);
  } else {
    lines.push('Spotify: not set up. No client ID.');
    lines.push(...SETUP_STEPS);
  }
  if (!tokens) lines.push('Deezer mode: works right now without any login. create_draft (and seeds, filters, read/analyze/compare/merge of Deezer playlists, exports) builds with Deezer tracks; only publishing to an account is unavailable, use export_draft format "links" and a transfer tool instead.');

  lines.push(`Last.fm: ${settings.lastfmApiKey ? 'key set (used as fallback ranking source)' : 'no key (optional; Deezer is the primary source)'}`);
  const d = settings.defaults;
  lines.push(`Defaults: headliner ${d.tracksPerTier.headliner} / sub ${d.tracksPerTier.sub} / undercard ${d.tracksPerTier.undercard}${d.tracksPerArtist !== undefined ? ` (flat ${d.tracksPerArtist})` : ''} · maxTracks ${d.maxTracks} · order ${d.order} · ${d.public ? 'public' : 'private'}${d.excludeExplicit ? ' · clean only' : ''}`);

  const drafts = await listDrafts();
  const building = drafts.filter((x) => x.status === 'building' || isRunning(x.id));
  lines.push(`Drafts: ${drafts.length}${building.length ? ` (building: ${building.map((x) => `${x.id} ${x.progress.done}/${x.progress.total}`).join(', ')})` : ''}${drafts.length ? ` · latest ${drafts[0]!.id} "${clean(drafts[0]!.name, 40)}" ${drafts[0]!.status}` : ''}`);
  lines.push(`Cache: ${await artistCache.size()} artists, ${await spotifyTrackCache.size()} tracks, ${await playlistCache.size()} playlist snapshots (12 h) · data dir ${paths.home()}`);
  const modes = [readOnlyMode() ? 'read-only (LINEUPIFY_READ_ONLY): create_playlist and update_playlist are disabled' : '', updateCheckDisabled() ? 'update check off (LINEUPIFY_NO_UPDATE_CHECK)' : ''].filter(Boolean);
  if (modes.length) lines.push(`Mode: ${modes.join(' · ')}`);

  const latest = await latestVersion();
  if (latest && latest !== VERSION) lines.push(`Update available: ${latest} (you run ${VERSION}). Install with: npm i -g lineupify-mcp@latest, or clear the npx cache.`);

  if (tokens) lines.push('Next: create_draft with artists and/or seeds (genre, similar_to, chart, country, playlist, taste, blend); parse_lineup first for raw poster text; read_playlist / analyze_playlist / compare_playlists for existing playlists.');
  else if (settings.clientId && !pendingAuth) lines.push('Next: connect (Spotify), or create_draft with provider "deezer" right away.');
  else if (!settings.clientId) lines.push('Next: setup with the client ID for Spotify, or create_draft with provider "deezer" right away (no account needed).');
  return lines.join('\n');
}

export const status = async () => text(await statusText());

/** A Spotify Client ID is 32 hex characters. Throws BAD_CLIENT_ID otherwise; returns the trimmed id. */
export function validateClientId(raw: string): string {
  const id = String(raw ?? '').trim();
  if (!/^[a-f0-9]{32}$/i.test(id)) throw new LineupifyError('BAD_CLIENT_ID', 'A Spotify client ID is 32 hex characters.', 'Copy it from the app page in the Spotify developer dashboard (not the client secret).');
  return id;
}

export async function saveClientId(raw: string): Promise<string> {
  const id = validateClientId(raw);
  const cfg = await loadConfig();
  cfg.spotifyClientId = id;
  await saveConfig(cfg);
  return id;
}

export async function setup(args: { clientId?: string; redirectPort?: number; lastfmApiKey?: string }) {
  const cfg = await loadConfig();
  const changes: string[] = [];
  if (args.clientId !== undefined) {
    cfg.spotifyClientId = validateClientId(args.clientId);
    changes.push('client ID saved');
  }
  if (args.redirectPort !== undefined) {
    if (args.redirectPort === 0) {
      delete cfg.spotifyRedirectPort;
      changes.push(`redirect port reset to the default ${DEFAULT_REDIRECT_PORT} (register http://127.0.0.1:${DEFAULT_REDIRECT_PORT}/callback in the dashboard)`);
    } else {
      if (args.redirectPort < 1024 || args.redirectPort > 65535) throw new LineupifyError('BAD_PORT', 'Port must be 1024-65535.');
      cfg.spotifyRedirectPort = args.redirectPort;
      changes.push(`redirect port ${args.redirectPort} (the dashboard must list http://127.0.0.1:${args.redirectPort}/callback)`);
    }
  }
  if (args.lastfmApiKey !== undefined) {
    if (args.lastfmApiKey === '') {
      delete cfg.lastfmApiKey;
      changes.push('Last.fm key removed');
    } else {
      cfg.lastfmApiKey = args.lastfmApiKey.trim();
      changes.push('Last.fm key saved');
    }
  }
  if (!changes.length) throw new LineupifyError('NOTHING_TO_SAVE', 'Pass clientId, redirectPort or lastfmApiKey.');
  await saveConfig(cfg);
  if (process.env.SPOTIFY_CLIENT_ID && args.clientId) changes.push('note: SPOTIFY_CLIENT_ID env var is set and takes precedence');
  return text(`Saved: ${changes.join('; ')}.\nNext: connect.`);
}

export async function connect(args: { force?: boolean; clientId?: string }) {
  let force = !!args.force;
  if (args.clientId !== undefined) {
    const id = await saveClientId(args.clientId);
    const existing = await spotify.loadTokens();
    if (existing && existing.clientId !== id) force = true;
  }
  const settings = await resolveSettings();
  if (!settings.clientId) {
    throw new LineupifyError('NO_CLIENT_ID', 'No Spotify client ID configured.', SETUP_STEPS.join(' '));
  }
  if (args.clientId !== undefined && settings.clientId !== validateClientId(args.clientId)) {
    throw new LineupifyError('CLIENT_ID_OVERRIDDEN', 'The SPOTIFY_CLIENT_ID environment variable is set and takes precedence over the id you passed.', 'Remove it from the MCP server config, or pass that id instead.');
  }
  const tokens = await spotify.loadTokens();
  if (tokens && !force) {
    const age = spotify.refreshTokenAge(tokens);
    if (age.daysLeft > 0) return text(`Already connected as ${clean(tokens.displayName || tokens.userId, 40)}. Pass force: true to switch accounts or re-login.`);
  }
  const drafts = await listDrafts();
  if (drafts.some((d) => isRunning(d.id))) throw new LineupifyError('JOB_RUNNING', 'A draft is building right now; cannot switch accounts.', 'Wait for it to finish (get_draft with waitSeconds), then connect again.');

  const { url, reused } = await spotify.startAuth(settings.clientId, settings.redirectPort);
  let opened = false;
  try {
    const open = (await import('open')).default;
    const child = await open(url, { wait: false });
    child.unref?.();
    opened = true;
  } catch (err) {
    log.info('could not open browser', String(err));
  }
  const lines = [
    reused ? 'Login already in progress.' : opened ? 'A browser window was opened for Spotify login.' : 'Could not open a browser automatically.',
    `If nothing opened, open this URL: ${url}`,
    'Sign in, approve, then call status to confirm the connection (the login window stays valid for 5 minutes).',
  ];
  return text(lines.join('\n'));
}

export async function disconnect(args: { purge?: boolean }) {
  const lines = await disconnectAccount({ purge: !!args.purge });
  lines.push(args.purge ? 'Next: setup with the client ID and connect to start again.' : 'Next: connect to sign in again.');
  return text(lines.join('\n'));
}
