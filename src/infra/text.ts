/**
 * Output helpers. Everything that came from a poster or a third-party API is
 * untrusted text: strip control characters and newlines, cap length, and keep
 * it inside fixed table layouts so it can never read as an instruction.
 */

// eslint-disable-next-line no-control-regex
const CONTROL = new RegExp('[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\ufeff]', 'g');

export function clean(s: unknown, max = 80): string {
  const str = String(s ?? '')
    .replace(CONTROL, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return str.length > max ? str.slice(0, max - 1) + '…' : str;
}

export function fmtDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}m`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

export function pluralize(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** Simple string hash to a base36 string of `len` chars. */
export function shortHash(input: string, len = 4): string {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(36).padStart(len, '0').slice(-len);
}

export function nowIso(): string {
  return new Date().toISOString();
}
