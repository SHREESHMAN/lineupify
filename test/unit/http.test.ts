import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { http, setFetch, setLimit, HttpError, sleep } from '../../src/infra/http.js';

type Call = { url: string; init: RequestInit | undefined };
type Reply = ((init: RequestInit | undefined) => Response | Promise<Response>) | Error;

let calls: Call[] = [];
const realFetch = globalThis.fetch;

/** A fresh Response per call (bodies can only be read once). */
const respond = (status: number, body = '', headers: Record<string, string> = {}): Reply => () => new Response(body, { status, headers });

/** A fetch that never resolves until its signal aborts. */
const hang: Reply = (init) =>
  new Promise<Response>((_, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new Error('The operation was aborted')));
  });

/** Install a fake fetch that answers from a queue (the last entry repeats). */
function fakeFetch(replies: Reply[]): void {
  let i = 0;
  setFetch((async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const r = replies[Math.min(i++, replies.length - 1)]!;
    if (r instanceof Error) throw r;
    return r(init);
  }) as unknown as typeof fetch);
}

const HOST = 'fast.test';
const URL_ = `https://${HOST}/api`;

beforeEach(() => {
  calls = [];
  setLimit(HOST, 100_000, 100_000);
});

afterEach(() => {
  setFetch(((...args: Parameters<typeof fetch>) => realFetch(...args)) as typeof fetch);
});

describe('http', () => {
  it('returns the body, status, headers and parses json()', async () => {
    fakeFetch([respond(200, '{"a":1,"b":[1,2]}', { 'content-type': 'application/json', 'x-test': 'yes' })]);
    const res = await http(URL_, { method: 'POST', body: 'x' });
    expect(res.status).toBe(200);
    expect(res.text).toBe('{"a":1,"b":[1,2]}');
    expect(res.json()).toEqual({ a: 1, b: [1, 2] });
    expect(res.headers.get('x-test')).toBe('yes');
    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe(URL_);
    expect(calls[0]!.init?.method).toBe('POST');
    expect(calls[0]!.init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('json() returns undefined for empty or invalid bodies', async () => {
    fakeFetch([respond(200, '')]);
    expect((await http(URL_)).json()).toBeUndefined();
    fakeFetch([respond(200, 'not json {')]);
    const res = await http(URL_);
    expect(res.json()).toBeUndefined();
    expect(res.text).toBe('not json {');
  });

  it('does not retry 4xx and does not throw', async () => {
    fakeFetch([respond(404, 'nope'), respond(200, 'ok')]);
    const res = await http(URL_);
    expect(res.status).toBe(404);
    expect(res.text).toBe('nope');
    expect(calls.length).toBe(1);
    fakeFetch([respond(400, 'bad'), respond(200, 'ok')]);
    expect((await http(URL_)).status).toBe(400);
    expect(calls.length).toBe(2);
  });

  it('retries 429 honouring a small Retry-After', async () => {
    fakeFetch([respond(429, 'slow down', { 'retry-after': '1' }), respond(200, 'ok')]);
    const t0 = Date.now();
    const res = await http(URL_);
    const elapsed = Date.now() - t0;
    expect(res.status).toBe(200);
    expect(calls.length).toBe(2);
    expect(elapsed).toBeGreaterThanOrEqual(900);
    expect(elapsed).toBeLessThan(3000);
  });

  it('throws immediately when Retry-After exceeds maxRetryAfterMs', async () => {
    fakeFetch([respond(429, 'later', { 'retry-after': '5' }), respond(200, 'ok')]);
    const t0 = Date.now();
    const err = await http(URL_, { maxRetryAfterMs: 1000 }).catch((e) => e);
    expect(Date.now() - t0).toBeLessThan(500);
    expect(err).toBeInstanceOf(HttpError);
    expect(err).toMatchObject({ status: 429, url: URL_, body: 'later', retryAfterMs: 5000 });
    expect(calls.length).toBe(1);
  });

  it('retries 5xx (Retry-After 0 makes it immediate)', async () => {
    fakeFetch([respond(503, 'down', { 'retry-after': '0' }), respond(502, 'down', { 'retry-after': '0' }), respond(200, 'ok')]);
    const t0 = Date.now();
    const res = await http(URL_);
    expect(res.status).toBe(200);
    expect(calls.length).toBe(3);
    expect(Date.now() - t0).toBeLessThan(500);
  });

  it('retries 5xx with exponential backoff when there is no Retry-After', async () => {
    fakeFetch([respond(500, 'boom'), respond(200, 'ok')]);
    const t0 = Date.now();
    const res = await http(URL_);
    const elapsed = Date.now() - t0;
    expect(res.status).toBe(200);
    expect(calls.length).toBe(2);
    expect(elapsed).toBeGreaterThanOrEqual(450);
    expect(elapsed).toBeLessThan(2000);
  });

  it('gives up after `attempts` and throws the last HttpError', async () => {
    fakeFetch([respond(503, 'down', { 'retry-after': '0' })]);
    const err = await http(URL_, { attempts: 3 }).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(503);
    expect(err.message).toBe(`HTTP 503 for ${URL_}`);
    expect(calls.length).toBe(3);
  });

  it('retries network errors', async () => {
    fakeFetch([new TypeError('fetch failed'), respond(200, 'ok')]);
    const t0 = Date.now();
    const res = await http(URL_, { attempts: 2 });
    expect(res.status).toBe(200);
    expect(calls.length).toBe(2);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(350);
  });

  it('rethrows the network error once attempts are exhausted', async () => {
    fakeFetch([new TypeError('fetch failed')]);
    await expect(http(URL_, { attempts: 1 })).rejects.toThrow('fetch failed');
    expect(calls.length).toBe(1);
  });

  it('aborts a hung request after timeoutMs', async () => {
    fakeFetch([hang]);
    const t0 = Date.now();
    await expect(http(URL_, { timeoutMs: 40, attempts: 1 })).rejects.toThrow(/abort/i);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(calls.length).toBe(1);
    expect(calls[0]!.init?.signal?.aborted).toBe(true);
  });

  it('honours an outer AbortSignal and does not retry after it fires', async () => {
    fakeFetch([hang]);
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 20);
    await expect(http(URL_, { signal: ctrl.signal, timeoutMs: 5000 })).rejects.toThrow('aborted');
    expect(calls.length).toBe(1);
    expect(calls[0]!.init?.signal?.aborted).toBe(true);
  });

  it('refuses to start when the outer signal is already aborted', async () => {
    fakeFetch([respond(200, 'ok')]);
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(http(URL_, { signal: ctrl.signal })).rejects.toThrow('aborted');
    expect(calls.length).toBe(0);
  });

  it('interrupts a Retry-After wait when the outer signal aborts', async () => {
    fakeFetch([respond(429, 'slow', { 'retry-after': '10' }), respond(200, 'ok')]);
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 30);
    const t0 = Date.now();
    await expect(http(URL_, { signal: ctrl.signal })).rejects.toThrow('aborted');
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(calls.length).toBe(1);
  });

  it('uses limiterKey instead of the URL host for rate limiting', async () => {
    fakeFetch([respond(200, 'ok')]);
    setLimit('custom-key', 100_000, 100_000);
    const res = await http('https://some.other.host/x', { limiterKey: 'custom-key' });
    expect(res.status).toBe(200);
  });
});

describe('sleep', () => {
  it('resolves after the delay and rejects on abort', async () => {
    const t0 = Date.now();
    await sleep(20);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(15);
    const ctrl = new AbortController();
    const p = sleep(10_000, ctrl.signal);
    ctrl.abort();
    await expect(p).rejects.toThrow('aborted');
    await sleep(-5);
  });
});
