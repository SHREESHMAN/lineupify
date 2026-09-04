/**
 * Spotify: PKCE auth over an ephemeral loopback port, a token store that is
 * safe across several Lineupify processes, and the handful of Web API calls
 * that still exist for Development Mode apps (snapshot: July 2026).
 */
import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { SpotifyTrack, Tokens } from '../types.js';
import { LineupifyError } from '../types.js';
import { http as request, HttpError } from '../infra/http.js';
import { log } from '../infra/log.js';
import { paths, readJson, waitLock, writeJsonAtomic } from '../infra/store.js';
import { promises as fs } from 'node:fs';

export const SPOTIFY_API_SNAPSHOT = '2026-07';
/**
 * user-read-private is needed for market=from_token on search and track lookups.
 * playlist-read-* and user-library-read (added in 0.2.0) let Lineupify read the
 * user's own private playlists and saved tracks; logins from 0.1.0 lack them
 * and `status` asks for a re-login.
 */
export const SCOPES = ['playlist-modify-private', 'playlist-modify-public', 'playlist-read-private', 'playlist-read-collaborative', 'user-top-read', 'user-follow-read', 'user-read-private', 'user-library-read'];
const API = 'https://api.spotify.com/v1';
const ACCOUNTS = 'https://accounts.spotify.com';
export const REFRESH_TOKEN_LIFETIME_DAYS = 182;
const AUTH_WINDOW_MS = 5 * 60_000;

// ---------------------------------------------------------------------------
// Token store
// ---------------------------------------------------------------------------

export async function loadTokens(): Promise<Tokens | undefined> {
  const t = await readJson<Tokens>(paths.tokens());
  if (!t || !t.refreshToken || !t.clientId) return undefined;
  return t;
}

export async function saveTokens(t: Tokens): Promise<void> {
  await writeJsonAtomic(paths.tokens(), t, 0o600);
}

export async function clearTokens(): Promise<void> {
  await fs.unlink(paths.tokens()).catch(() => undefined);
}

export function refreshTokenAge(t: Tokens): { daysUsed: number; daysLeft: number; expiresAt: Date } {
  const start = new Date(t.authorizedAt).getTime();
  const expiresAt = new Date(start + REFRESH_TOKEN_LIFETIME_DAYS * 86_400_000);
  const daysUsed = Math.floor((Date.now() - start) / 86_400_000);
  return { daysUsed, daysLeft: REFRESH_TOKEN_LIFETIME_DAYS - daysUsed, expiresAt };
}

interface TokenResponse {
  access_token: string;
  token_type: string;
  scope: string;
  expires_in: number;
  refresh_token?: string;
  error?: string;
  error_description?: string;
}

async function tokenRequest(form: Record<string, string>): Promise<TokenResponse> {
  const res = await request(`${ACCOUNTS}/api/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
    attempts: 2,
    limiterKey: 'accounts.spotify.com',
  });
  const body = res.json<TokenResponse>();
  if (!body) throw new LineupifyError('SPOTIFY_AUTH_FAILED', `empty token response (HTTP ${res.status})`);
  if (res.status >= 400 || body.error) {
    const err = body.error ?? `http_${res.status}`;
    if (err === 'invalid_grant') throw new LineupifyError('TOKEN_EXPIRED_RECONNECT', 'Spotify refused the refresh token (invalid_grant).', 'Run the connect tool (or `lineupify-mcp auth`) to sign in again.');
    if (err === 'invalid_client') throw new LineupifyError('SPOTIFY_CLIENT_ID_INVALID', 'Spotify does not recognise this client ID.', 'Check SPOTIFY_CLIENT_ID against your app in the Spotify developer dashboard.');
    throw new LineupifyError('SPOTIFY_AUTH_FAILED', `${err}: ${body.error_description ?? ''}`.trim());
  }
  return body;
}

/**
 * Returns a valid access token, refreshing when it expires within 60 s. Uses a
 * file lock and re-reads tokens.json so two processes never fight over a
 * rotated refresh token.
 */
export async function getAccessToken(): Promise<Tokens> {
  let t = await loadTokens();
  if (!t) throw new LineupifyError('SPOTIFY_NOT_CONNECTED', 'No Spotify account connected.', 'Call the connect tool to sign in.');
  if (t.expiresAt - Date.now() > 60_000) return t;

  const lock = await waitLock(paths.tokensLock(), 15_000);
  try {
    // Another process may have refreshed while we waited for the lock.
    const fresh = await loadTokens();
    if (fresh && fresh.expiresAt - Date.now() > 60_000) return fresh;
    t = fresh ?? t;
    try {
      return await refresh(t);
    } catch (err) {
      if (err instanceof LineupifyError && err.code === 'TOKEN_EXPIRED_RECONNECT') {
        const again = await loadTokens();
        if (again && again.refreshToken !== t.refreshToken) {
          try {
            return await refresh(again);
          } catch {
            /* fall through */
          }
        }
        await clearTokens();
      }
      throw err;
    }
  } finally {
    await lock.release();
  }
}

async function refresh(t: Tokens): Promise<Tokens> {
  const body = await tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refreshToken, client_id: t.clientId });
  const next: Tokens = {
    ...t,
    accessToken: body.access_token,
    refreshToken: body.refresh_token || t.refreshToken,
    expiresAt: Date.now() + body.expires_in * 1000,
    scope: body.scope || t.scope,
  };
  await saveTokens(next);
  log.debug('spotify token refreshed');
  return next;
}

// ---------------------------------------------------------------------------
// PKCE auth over loopback
// ---------------------------------------------------------------------------

interface AuthAttempt {
  url: string;
  redirectUri: string;
  port: number;
  state: string;
  verifier: string;
  clientId: string;
  startedAt: number;
  server: http.Server;
  done: Promise<Tokens>;
  settled: boolean;
  result?: Tokens;
  error?: Error;
}

let pending: AuthAttempt | undefined;

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const PAGE = (title: string, body: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:system-ui;max-width:32rem;margin:4rem auto;line-height:1.5"><h2>${title}</h2><p>${body}</p></body>`;

export function pendingAuth(): { url: string; ageMs: number; port: number } | undefined {
  if (!pending || pending.settled) return undefined;
  if (Date.now() - pending.startedAt > AUTH_WINDOW_MS) return undefined;
  return { url: pending.url, ageMs: Date.now() - pending.startedAt, port: pending.port };
}

/**
 * Start (or reuse) a PKCE login. Returns the URL immediately; completion is
 * observed through `pendingAuthResult` / `waitForAuth` / `loadTokens`.
 */
export async function startAuth(clientId: string, fixedPort: number): Promise<{ url: string; port: number; redirectUri: string; reused: boolean }> {
  const live = pendingAuth();
  if (live && pending && pending.clientId === clientId) {
    return { url: pending.url, port: pending.port, redirectUri: pending.redirectUri, reused: true };
  }
  if (pending && !pending.settled) pending.server.close();

  const verifier = b64url(randomBytes(48));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  const state = b64url(randomBytes(16));

  const server = http.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(fixedPort, '127.0.0.1', () => resolve());
  }).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      throw new LineupifyError('REDIRECT_PORT_BUSY', `Port ${fixedPort} is already in use on this machine.`, `Close the program using it, or pick another port with the setup tool (redirectPort) and add http://127.0.0.1:<port>/callback to the app's Redirect URIs in the Spotify dashboard.`);
    }
    throw err;
  });
  const port = (server.address() as AddressInfo).port;
  const redirectUri = `http://127.0.0.1:${port}/callback`;

  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    code_challenge_method: 'S256',
    code_challenge: challenge,
    state,
    scope: SCOPES.join(' '),
  });
  const url = `${ACCOUNTS}/authorize?${params.toString()}`;

  let resolveDone!: (t: Tokens) => void;
  let rejectDone!: (e: Error) => void;
  const done = new Promise<Tokens>((res, rej) => {
    resolveDone = res;
    rejectDone = rej;
  });
  done.catch(() => undefined);

  const attempt: AuthAttempt = { url, redirectUri, port, state, verifier, clientId, startedAt: Date.now(), server, done, settled: false };
  pending = attempt;

  const settle = (err?: Error, tokens?: Tokens) => {
    if (attempt.settled) return;
    attempt.settled = true;
    attempt.error = err;
    attempt.result = tokens;
    clearTimeout(timer);
    server.close();
    if (tokens) resolveDone(tokens);
    else rejectDone(err ?? new Error('auth cancelled'));
  };

  const timer = setTimeout(() => settle(new LineupifyError('AUTH_TIMEOUT', 'Login window expired after 5 minutes.', 'Call connect again.')), AUTH_WINDOW_MS);

  server.on('request', async (req, res) => {
    const u = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    if (u.pathname !== '/callback') {
      res.writeHead(404).end();
      return;
    }
    if (attempt.settled) {
      res.writeHead(200, { 'Content-Type': 'text/html' }).end(PAGE('Lineupify', 'This login has already completed. You can close this tab.'));
      return;
    }
    const err = u.searchParams.get('error');
    const code = u.searchParams.get('code');
    const st = u.searchParams.get('state');
    if (err) {
      res.writeHead(200, { 'Content-Type': 'text/html' }).end(PAGE('Login cancelled', `Spotify reported: ${err}. You can close this tab.`));
      settle(new LineupifyError('AUTH_DENIED', `Spotify login failed: ${err}`));
      return;
    }
    if (!code || st !== state) {
      res.writeHead(400, { 'Content-Type': 'text/html' }).end(PAGE('Login failed', 'State mismatch. Start the login again from Lineupify.'));
      settle(new LineupifyError('AUTH_STATE_MISMATCH', 'OAuth state mismatch.'));
      return;
    }
    try {
      const body = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: clientId, code_verifier: verifier });
      const partial: Tokens = {
        clientId,
        accessToken: body.access_token,
        refreshToken: body.refresh_token ?? '',
        expiresAt: Date.now() + body.expires_in * 1000,
        authorizedAt: new Date().toISOString(),
        scope: body.scope,
        userId: '',
        displayName: '',
      };
      const me = await meWith(partial.accessToken);
      const tokens: Tokens = { ...partial, userId: me.id, displayName: me.displayName };
      await saveTokens(tokens);
      res.writeHead(200, { 'Content-Type': 'text/html' }).end(PAGE('Connected to Spotify', `Signed in as <b>${escapeHtml(me.displayName || me.id)}</b>. You can close this tab and go back to your assistant.`));
      settle(undefined, tokens);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      res.writeHead(200, { 'Content-Type': 'text/html' }).end(PAGE('Login failed', `${escapeHtml(msg)}. You can close this tab.`));
      settle(e instanceof Error ? e : new Error(msg));
    }
  });

  return { url, port, redirectUri, reused: false };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** Result of the pending attempt, if it has finished. */
export function pendingAuthResult(): { tokens?: Tokens; error?: Error } | undefined {
  if (!pending || !pending.settled) return undefined;
  return { tokens: pending.result, error: pending.error };
}

export async function waitForAuth(timeoutMs: number): Promise<Tokens | undefined> {
  if (!pending) return undefined;
  const attempt = pending;
  const timeout = new Promise<undefined>((r) => setTimeout(() => r(undefined), timeoutMs));
  return Promise.race([attempt.done, timeout]);
}

export function cancelPendingAuth(): void {
  if (pending && !pending.settled) {
    pending.settled = true;
    pending.server.close();
  }
  pending = undefined;
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

interface ApiOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  signal?: AbortSignal;
  /** Internal: set after a 401 retry. */
  retried?: boolean;
}

function mapError(err: HttpError): LineupifyError {
  let reason = '';
  try {
    const j = JSON.parse(err.body) as { error?: { reason?: string; message?: string } | string };
    reason = typeof j.error === 'string' ? j.error : (j.error?.reason ?? j.error?.message ?? '');
  } catch {
    /* ignore */
  }
  if (err.status === 429 && /QUOTA_EXCEEDED/i.test(reason + err.body)) {
    return new LineupifyError('SPOTIFY_QUOTA_EXCEEDED', 'Your Spotify developer quota for today is used up.', 'Wait for the quota to reset, then call get_draft to resume. Cached results are kept.', 429);
  }
  if (err.status === 429) {
    return new LineupifyError('SPOTIFY_RATE_LIMITED', `Spotify rate limit; retry after ${Math.round((err.retryAfterMs ?? 0) / 1000)}s.`, 'Wait a moment, then call get_draft to resume.');
  }
  if (err.status === 403 && /insufficient client scope/i.test(reason + err.body)) {
    return new LineupifyError('SPOTIFY_SCOPE_MISSING', 'The saved Spotify login lacks a permission this version needs.', 'Call connect with force: true (or run `lineupify-mcp auth --force`) to sign in again and grant the updated permissions.', 403);
  }
  if (err.status === 403) {
    return new LineupifyError('SPOTIFY_FORBIDDEN', `Spotify refused the request (403). ${reason}`.trim(), 'Development Mode apps only work for the app owner (who needs Spotify Premium) and users added under User Management in the developer dashboard. Check your app and reconnect.', 403);
  }
  return new LineupifyError('SPOTIFY_HTTP_ERROR', `Spotify returned HTTP ${err.status}. ${reason}`.trim(), undefined, err.status);
}

export async function api<T>(path: string, opts: ApiOptions = {}): Promise<T> {
  const tokens = await getAccessToken();
  return apiWithToken<T>(tokens.accessToken, path, opts);
}

async function apiWithToken<T>(accessToken: string, path: string, opts: ApiOptions = {}): Promise<T> {
  const url = new URL(path.startsWith('http') ? path : `${API}${path}`);
  for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
  let res;
  try {
    res = await request(url.toString(), {
      method: opts.method ?? 'GET',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: opts.signal,
      limiterKey: 'api.spotify.com',
    });
  } catch (err) {
    if (err instanceof HttpError) throw mapError(err);
    throw err;
  }
  if (res.status === 401 && !opts.retried) {
    // Access token revoked or expired early: force a refresh once.
    const t = await loadTokens();
    if (t) {
      await saveTokens({ ...t, expiresAt: 0 });
      const fresh = await getAccessToken();
      return apiWithToken<T>(fresh.accessToken, path, { ...opts, retried: true });
    }
  }
  if (res.status >= 400) throw mapError(new HttpError(res.status, url.toString(), res.text));
  return (res.json<T>() ?? ({} as T)) as T;
}

interface RawTrack {
  uri: string;
  id: string;
  name: string;
  artists?: { id: string; name: string }[];
  album?: { name?: string; album_type?: string; release_date?: string };
  track_number?: number;
  duration_ms?: number;
  explicit?: boolean;
  external_ids?: { isrc?: string };
  is_playable?: boolean;
  is_local?: boolean;
  type?: string;
}

function toTrack(t: RawTrack, albumOverride?: { name: string; albumType: string; releaseDate: string }): SpotifyTrack | undefined {
  if (!t || !t.uri || t.is_local || (t.type && t.type !== 'track')) return undefined;
  return {
    uri: t.uri,
    id: t.id,
    name: t.name,
    artists: (t.artists ?? []).map((a) => ({ id: a.id, name: a.name })),
    albumName: albumOverride?.name ?? t.album?.name ?? '',
    albumType: albumOverride?.albumType ?? t.album?.album_type ?? '',
    releaseDate: albumOverride?.releaseDate ?? t.album?.release_date ?? '',
    trackNumber: t.track_number ?? 0,
    durationMs: t.duration_ms ?? 0,
    explicit: !!t.explicit,
    isrc: t.external_ids?.isrc?.toUpperCase(),
    isPlayable: t.is_playable !== false,
  };
}

async function meWith(accessToken: string): Promise<{ id: string; displayName: string }> {
  const m = await apiWithToken<{ id: string; display_name?: string }>(accessToken, '/me');
  return { id: m.id, displayName: m.display_name ?? '' };
}

export async function me(): Promise<{ id: string; displayName: string }> {
  const m = await api<{ id: string; display_name?: string }>('/me');
  return { id: m.id, displayName: m.display_name ?? '' };
}

export async function searchTracks(q: string, limit = 5, signal?: AbortSignal): Promise<SpotifyTrack[]> {
  const r = await api<{ tracks?: { items?: RawTrack[] } }>('/search', { query: { q, type: 'track', limit: Math.min(10, limit), market: 'from_token' }, signal });
  return (r.tracks?.items ?? []).map((t) => toTrack(t)).filter((t): t is SpotifyTrack => !!t);
}

export async function searchByIsrc(isrc: string, signal?: AbortSignal): Promise<SpotifyTrack[]> {
  return searchTracks(`isrc:${isrc}`, 10, signal);
}

export async function searchArtists(name: string, signal?: AbortSignal): Promise<{ id: string; name: string }[]> {
  const r = await api<{ artists?: { items?: { id: string; name: string }[] } }>('/search', { query: { q: `artist:${name.replace(/[^\p{L}\p{N}\s'.-]/gu, ' ')}`, type: 'artist', limit: 5 }, signal });
  return (r.artists?.items ?? []).map((a) => ({ id: a.id, name: a.name }));
}

export async function artistAlbums(artistId: string, limit = 3, signal?: AbortSignal): Promise<{ id: string; name: string; albumType: string; releaseDate: string }[]> {
  const r = await api<{ items?: { id: string; name: string; album_type: string; release_date: string }[] }>(`/artists/${artistId}/albums`, {
    query: { include_groups: 'album,single', limit, market: 'from_token' },
    signal,
  });
  return (r.items ?? []).map((a) => ({ id: a.id, name: a.name, albumType: a.album_type, releaseDate: a.release_date }));
}

export async function albumTracks(album: { id: string; name: string; albumType: string; releaseDate: string }, signal?: AbortSignal): Promise<SpotifyTrack[]> {
  const r = await api<{ items?: RawTrack[] }>(`/albums/${album.id}/tracks`, { query: { limit: 20, market: 'from_token' }, signal });
  return (r.items ?? []).map((t) => toTrack(t, { name: album.name, albumType: album.albumType, releaseDate: album.releaseDate })).filter((t): t is SpotifyTrack => !!t);
}

export async function track(id: string, signal?: AbortSignal): Promise<SpotifyTrack | undefined> {
  const t = await api<RawTrack>(`/tracks/${id}`, { query: { market: 'from_token' }, signal });
  return toTrack(t);
}

export async function topArtists(range: 'short_term' | 'medium_term' | 'long_term', signal?: AbortSignal): Promise<{ id: string; name: string }[]> {
  const r = await api<{ items?: { id: string; name: string }[] }>('/me/top/artists', { query: { time_range: range, limit: 50 }, signal });
  return (r.items ?? []).map((a) => ({ id: a.id, name: a.name }));
}

export async function followedArtists(signal?: AbortSignal): Promise<{ id: string; name: string }[]> {
  const out: { id: string; name: string }[] = [];
  let after: string | undefined;
  for (let page = 0; page < 20; page++) {
    const r = await api<{ artists?: { items?: { id: string; name: string }[]; cursors?: { after?: string } } }>('/me/following', {
      query: { type: 'artist', limit: 50, after },
      signal,
    });
    const items = r.artists?.items ?? [];
    out.push(...items.map((a) => ({ id: a.id, name: a.name })));
    after = r.artists?.cursors?.after ?? undefined;
    if (!after || items.length < 50) break;
  }
  return out;
}

export async function createPlaylist(name: string, description: string, isPublic: boolean): Promise<{ id: string; url: string }> {
  const r = await api<{ id: string; external_urls?: { spotify?: string } }>('/me/playlists', {
    method: 'POST',
    body: { name: name.slice(0, 100), description: description.slice(0, 300), public: isPublic },
  });
  return { id: r.id, url: r.external_urls?.spotify ?? `https://open.spotify.com/playlist/${r.id}` };
}

export async function changePlaylistDetails(id: string, details: { name?: string; description?: string; public?: boolean }): Promise<void> {
  await api(`/playlists/${id}`, { method: 'PUT', body: details });
}

export async function addItems(playlistId: string, uris: string[]): Promise<string> {
  const r = await api<{ snapshot_id?: string }>(`/playlists/${playlistId}/items`, { method: 'POST', body: { uris } });
  return r.snapshot_id ?? '';
}

export async function replaceItems(playlistId: string, uris: string[]): Promise<string> {
  const r = await api<{ snapshot_id?: string }>(`/playlists/${playlistId}/items`, { method: 'PUT', body: { uris } });
  return r.snapshot_id ?? '';
}

export async function playlistState(playlistId: string): Promise<{ snapshotId: string; total: number; name: string; url: string }> {
  const p = await api<{ snapshot_id?: string; name?: string; external_urls?: { spotify?: string }; items?: { total?: number }; tracks?: { total?: number } }>(`/playlists/${playlistId}`);
  let total = p.items?.total ?? p.tracks?.total;
  if (total === undefined) {
    const items = await api<{ total?: number }>(`/playlists/${playlistId}/items`, { query: { limit: 1 } });
    total = items.total ?? 0;
  }
  return { snapshotId: p.snapshot_id ?? '', total, name: p.name ?? '', url: p.external_urls?.spotify ?? `https://open.spotify.com/playlist/${playlistId}` };
}

// ---------------------------------------------------------------------------
// Reading playlists and the library (0.2.0). Verified 2026-09-04: playlist
// items come back under `item` (not `track`); artist objects carry no genres
// for Development Mode apps; Spotify-made playlists return 404.
// ---------------------------------------------------------------------------

export interface PlaylistInfo {
  id: string;
  name: string;
  description: string;
  public?: boolean;
  ownerId: string;
  ownerName: string;
  snapshotId: string;
  total: number;
  url: string;
}

function playlistNotFound(id: string, err: unknown): LineupifyError {
  if (err instanceof LineupifyError && (err.status === 404 || err.status === 403)) {
    return new LineupifyError(
      'PLAYLIST_NOT_READABLE',
      `Spotify could not return playlist ${id} (HTTP ${err.status}).`,
      "Check the link. Playlists made by Spotify itself (Today's Top Hits, Discover Weekly, Blend, Daily Mix, Release Radar) cannot be read by new apps; playlists made by people can, when public or in this account. If it is your own private playlist, reconnect (connect force: true) so the read permission is granted.",
      err.status,
    );
  }
  return err instanceof LineupifyError ? err : new LineupifyError('SPOTIFY_HTTP_ERROR', String(err));
}

export async function playlistInfo(id: string, signal?: AbortSignal): Promise<PlaylistInfo> {
  let p;
  try {
    p = await api<{ id: string; name?: string; description?: string; public?: boolean; owner?: { id?: string; display_name?: string }; snapshot_id?: string; items?: { total?: number }; tracks?: { total?: number }; external_urls?: { spotify?: string } }>(`/playlists/${id}`, {
      query: { fields: 'id,name,description,public,owner(id,display_name),snapshot_id,items(total),tracks(total),external_urls' },
      signal,
    });
  } catch (err) {
    throw playlistNotFound(id, err);
  }
  return {
    id: p.id ?? id,
    name: p.name ?? '',
    description: p.description ?? '',
    public: p.public,
    ownerId: p.owner?.id ?? '',
    ownerName: p.owner?.display_name || p.owner?.id || '',
    snapshotId: p.snapshot_id ?? '',
    total: p.items?.total ?? p.tracks?.total ?? 0,
    url: p.external_urls?.spotify ?? `https://open.spotify.com/playlist/${id}`,
  };
}

const ITEM_FIELDS = 'total,next,items(added_at,is_local,item(uri,id,name,type,is_local,artists(id,name),album(id,name,album_type,release_date),duration_ms,explicit,external_ids,is_playable))';

/** Tracks of a playlist in order, 50 per call, capped at `max` (episodes and local files skipped). */
export async function playlistItems(id: string, max = 1000, signal?: AbortSignal): Promise<{ tracks: { track: SpotifyTrack; addedAt?: string }[]; total: number; truncated: boolean }> {
  const out: { track: SpotifyTrack; addedAt?: string }[] = [];
  let total = 0;
  let offset = 0;
  for (;;) {
    let r;
    try {
      r = await api<{ total?: number; next?: string | null; items?: { added_at?: string; is_local?: boolean; item?: RawTrack | null }[] }>(`/playlists/${id}/items`, {
        query: { limit: 50, offset, market: 'from_token', fields: ITEM_FIELDS },
        signal,
      });
    } catch (err) {
      throw playlistNotFound(id, err);
    }
    total = r.total ?? total;
    const items = r.items ?? [];
    for (const it of items) {
      if (!it.item || it.is_local) continue;
      const t = toTrack(it.item);
      if (t) out.push({ track: t, addedAt: it.added_at });
    }
    offset += items.length;
    if (!r.next || items.length === 0 || offset >= max) break;
  }
  return { tracks: out, total, truncated: offset < total };
}

/** The user's saved tracks ("Liked Songs"), newest first, capped at `max`. Needs user-library-read. */
export async function savedTracks(max = 3000, signal?: AbortSignal): Promise<{ tracks: { track: SpotifyTrack; addedAt?: string }[]; total: number; truncated: boolean }> {
  const out: { track: SpotifyTrack; addedAt?: string }[] = [];
  let total = 0;
  let offset = 0;
  for (;;) {
    const r = await api<{ total?: number; next?: string | null; items?: { added_at?: string; track?: RawTrack | null }[] }>('/me/tracks', { query: { limit: 50, offset, market: 'from_token' }, signal });
    total = r.total ?? total;
    const items = r.items ?? [];
    for (const it of items) {
      if (!it.track) continue;
      const t = toTrack(it.track);
      if (t) out.push({ track: t, addedAt: it.added_at });
    }
    offset += items.length;
    if (!r.next || items.length === 0 || offset >= max) break;
  }
  return { tracks: out, total, truncated: offset < total };
}

/** Playlists in the user's library (own and followed), up to 500. Needs playlist-read-private for private ones. */
export async function myPlaylists(signal?: AbortSignal): Promise<{ id: string; name: string; ownerId: string; total: number }[]> {
  const out: { id: string; name: string; ownerId: string; total: number }[] = [];
  for (let offset = 0; offset < 500; offset += 50) {
    const r = await api<{ next?: string | null; items?: { id: string; name?: string; owner?: { id?: string }; items?: { total?: number }; tracks?: { total?: number } }[] }>('/me/playlists', { query: { limit: 50, offset }, signal });
    const items = r.items ?? [];
    for (const p of items) out.push({ id: p.id, name: p.name ?? '', ownerId: p.owner?.id ?? '', total: p.items?.total ?? p.tracks?.total ?? 0 });
    if (!r.next || items.length < 50) break;
  }
  return out;
}
