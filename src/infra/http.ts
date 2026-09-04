/**
 * fetch wrapper with per-host token-bucket rate limiting, timeouts, and
 * retry with Retry-After / jittered backoff on 429 and 5xx.
 */
import { log } from './log.js';

export interface HttpOptions extends RequestInit {
  timeoutMs?: number;
  /** Max attempts including the first. */
  attempts?: number;
  /** Host key used for rate limiting; defaults to URL host. */
  limiterKey?: string;
  /** A Retry-After longer than this is not waited for; the 429 is thrown instead. */
  maxRetryAfterMs?: number;
}

export interface HttpResponse {
  status: number;
  headers: Headers;
  text: string;
  json<T = unknown>(): T | undefined;
}

class TokenBucket {
  private tokens: number;
  private last = Date.now();
  constructor(
    private ratePerSec: number,
    private burst: number,
  ) {
    this.tokens = burst;
  }
  async take(): Promise<void> {
    for (;;) {
      const now = Date.now();
      this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.ratePerSec);
      this.last = now;
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      const waitMs = ((1 - this.tokens) / this.ratePerSec) * 1000;
      await sleep(waitMs);
    }
  }
}

const limiters = new Map<string, TokenBucket>();
const LIMITS: Record<string, { rate: number; burst: number }> = {
  'api.spotify.com': { rate: 4, burst: 4 },
  'accounts.spotify.com': { rate: 2, burst: 2 },
  'api.deezer.com': { rate: 8, burst: 8 },
  'ws.audioscrobbler.com': { rate: 4, burst: 4 },
  // MusicBrainz asks for at most one request per second per client.
  'musicbrainz.org': { rate: 1, burst: 1 },
  'labs.api.listenbrainz.org': { rate: 3, burst: 3 },
};

export function limiterFor(key: string): TokenBucket {
  let b = limiters.get(key);
  if (!b) {
    const cfg = LIMITS[key] ?? { rate: 5, burst: 5 };
    b = new TokenBucket(cfg.rate, cfg.burst);
    limiters.set(key, b);
  }
  return b;
}

/** Test hook: override a limiter's rate. */
export function setLimit(key: string, rate: number, burst = rate): void {
  limiters.set(key, new TokenBucket(rate, burst));
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, Math.max(0, ms));
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new Error('aborted'));
      },
      { once: true },
    );
  });
}

export class HttpError extends Error {
  constructor(
    public status: number,
    public url: string,
    public body: string,
    public retryAfterMs?: number,
  ) {
    super(`HTTP ${status} for ${url}`);
    this.name = 'HttpError';
  }
}

let fetchImpl: typeof fetch = (...args) => fetch(...args);
/** Test hook. */
export function setFetch(fn: typeof fetch): void {
  fetchImpl = fn;
}

export async function http(url: string, opts: HttpOptions = {}): Promise<HttpResponse> {
  const { timeoutMs = 15_000, attempts = 5, limiterKey, maxRetryAfterMs = 30_000, signal: rawSignal, ...init } = opts;
  const outerSignal = rawSignal ?? undefined;
  const host = limiterKey ?? new URL(url).host;
  const bucket = limiterFor(host);
  let lastErr: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (outerSignal?.aborted) throw new Error('aborted');
    await bucket.take();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const onAbort = () => ctrl.abort();
    outerSignal?.addEventListener('abort', onAbort, { once: true });
    try {
      const res = await fetchImpl(url, { ...init, signal: ctrl.signal });
      const text = await res.text();
      if (res.status === 429 || res.status >= 500) {
        const ra = res.headers.get('retry-after');
        const retryAfterMs = ra ? Number(ra) * 1000 : undefined;
        const err = new HttpError(res.status, url, text, retryAfterMs);
        lastErr = err;
        if (retryAfterMs !== undefined && retryAfterMs > maxRetryAfterMs) throw err;
        if (attempt < attempts) {
          const backoff = retryAfterMs ?? Math.min(20_000, 500 * 2 ** (attempt - 1)) + Math.random() * 300;
          log.debug(`retrying ${res.status} ${url} in ${Math.round(backoff)}ms`);
          await sleep(backoff, outerSignal);
          continue;
        }
        throw err;
      }
      return {
        status: res.status,
        headers: res.headers,
        text,
        json<T>() {
          try {
            return text ? (JSON.parse(text) as T) : undefined;
          } catch {
            return undefined;
          }
        },
      };
    } catch (err) {
      if (err instanceof HttpError) throw err;
      if (outerSignal?.aborted) throw new Error('aborted', { cause: err });
      lastErr = err;
      if (attempt < attempts) {
        const backoff = Math.min(10_000, 400 * 2 ** (attempt - 1)) + Math.random() * 200;
        log.debug(`network error on ${url}, retry in ${Math.round(backoff)}ms`, String(err));
        await sleep(backoff, outerSignal);
        continue;
      }
    } finally {
      clearTimeout(timer);
      outerSignal?.removeEventListener('abort', onAbort);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
