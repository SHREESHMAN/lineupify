/** clean(): untrusted text made safe for fixed layouts without corrupting scripts that need joiners. */
import { describe, expect, it } from 'vitest';
import { clean } from '../../src/infra/text.js';

describe('clean', () => {
  it('keeps ZWNJ and ZWJ, which Persian, Urdu, Indic scripts and emoji sequences need', () => {
    const persian = 'می\u200cخواهم'; // "I want": ZWNJ between the two parts
    expect(clean(persian)).toBe(persian);
    const hindi = 'क्\u200dष'; // conjunct forced with ZWJ
    expect(clean(hindi)).toBe(hindi);
    const family = '👨\u200d👩\u200d👧';
    expect(clean(family)).toBe(family);
    const urdu = 'اردو\u200cزبان';
    expect(clean(urdu)).toBe(urdu);
  });

  it('drops zero-width spaces, bidi marks and overrides without inserting spaces', () => {
    expect(clean('Fred\u200bagain')).toBe('Fredagain');
    expect(clean('\u202eDJ Evil\u202c')).toBe('DJ Evil');
    expect(clean('\u2066x\u2069 \u200ey\u200f')).toBe('x y');
    expect(clean('\ufeffBOM')).toBe('BOM');
  });

  it('turns control characters and line breaks into single spaces and caps length', () => {
    expect(clean('a\nb\r\nc\td e f')).toBe('a b c d e f');
    expect(clean('  spaced   out  ')).toBe('spaced out');
    expect(clean('x'.repeat(100), 10)).toBe('x'.repeat(9) + '…');
    expect(clean(undefined)).toBe('');
    expect(clean(42)).toBe('42');
  });
});
