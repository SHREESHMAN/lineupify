/** Which errors pause a build (connection trouble) versus which record an artist as unresolved. */
import { describe, expect, it } from 'vitest';
import { HttpError } from '../../src/infra/http.js';
import { isAbort, isTransient } from '../../src/engine/resolve.js';

describe('isTransient', () => {
  it('recognises undici fetch failures, timeouts and socket error codes', () => {
    expect(isTransient(new TypeError('fetch failed'))).toBe(true);
    expect(isTransient(Object.assign(new Error('timeout after 15000ms for https://api.deezer.com/x'), { name: 'TimeoutError' }))).toBe(true);
    expect(isTransient(Object.assign(new Error('getaddrinfo ENOTFOUND api.deezer.com'), { code: 'ENOTFOUND' }))).toBe(true);
    expect(isTransient(new Error('fetch failed', { cause: Object.assign(new Error('reset'), { code: 'ECONNRESET' }) }))).toBe(true);
    expect(isTransient(Object.assign(new Error('Deezer quota exceeded'), { name: 'DeezerQuotaError' }))).toBe(true);
  });

  it('treats 429 and 5xx that outlived the retries as transient, other HTTP errors as permanent', () => {
    expect(isTransient(new HttpError(503, 'https://x', ''))).toBe(true);
    expect(isTransient(new HttpError(429, 'https://x', ''))).toBe(true);
    expect(isTransient(new HttpError(404, 'https://x', ''))).toBe(false);
    expect(isTransient(new HttpError(400, 'https://x', ''))).toBe(false);
  });

  it('leaves lookup failures, plain errors and aborts alone', () => {
    expect(isTransient(new Error('Deezer error 300: no data'))).toBe(false);
    expect(isTransient(new TypeError('Cannot read properties of undefined'))).toBe(false);
    expect(isTransient('fetch failed')).toBe(false);
    const abort = new Error('aborted');
    expect(isTransient(abort)).toBe(false);
    expect(isAbort(abort)).toBe(true);
  });
});
