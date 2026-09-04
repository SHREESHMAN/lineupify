import { describe, it, expect } from 'vitest';
import { pickArtist, type DeezerArtist } from '../../src/sources/deezer.js';

const a = (id: number, name: string, nbFan: number): DeezerArtist => ({ id, name, nbFan });

describe('pickArtist', () => {
  it('picks the exact-name result with the most fans, not the first one (the "Genesis" case)', () => {
    const results = [a(1, 'Genesis', 97), a(2, 'Genesis', 1_190_000), a(3, 'Genesis Owusu', 80_000)];
    const pick = pickArtist('Genesis', results);
    expect(pick?.artist.id).toBe(2);
    expect(pick?.confidence).toBe('high');
  });

  it('rejects karaoke / tribute clones even when they have more fans', () => {
    const results = [a(1, 'Genesis Karaoke', 500_000), a(2, 'Genesis Tribute Band', 90_000), a(3, 'Genesis', 1000)];
    expect(pickArtist('Genesis', results)?.artist.id).toBe(3);
    expect(pickArtist('Genesis Karaoke', [a(1, 'Genesis Karaoke', 500_000)])).toBeUndefined();
    expect(pickArtist('Genesis', [a(1, 'Genesis Karaoke', 500_000), a(2, 'Genesis (Tribute)', 9000)])).toBeUndefined();
  });

  it('matches through fold: "Simon and Garfunkel" finds "Simon & Garfunkel"', () => {
    const results = [a(7, 'Simon & Garfunkel', 2_000_000), a(8, 'Paul Simon', 900_000)];
    const pick = pickArtist('Simon and Garfunkel', results);
    expect(pick?.artist.id).toBe(7);
    expect(pick?.confidence).toBe('high');
    expect(pickArtist('SIMON & GARFUNKEL', results)?.artist.id).toBe(7);
    expect(pickArtist('A$AP Rocky', [a(1, 'ASAP Rocky', 10)])?.artist.id).toBe(1);
    expect(pickArtist('Beyonce', [a(1, 'Beyoncé', 10)])?.artist.id).toBe(1);
  });

  it('flags a tiny exact match as low confidence when a rival is vastly bigger', () => {
    const results = [a(1, 'Genesis', 10), a(2, 'Genesis Owusu', 50_000)];
    const pick = pickArtist('Genesis', results);
    expect(pick?.artist.id).toBe(1);
    expect(pick?.confidence).toBe('low');
    // Rival not big enough (< 1000x) or exact match has >= 50 fans: stays high.
    expect(pickArtist('Genesis', [a(1, 'Genesis', 10), a(2, 'Genesis Owusu', 5000)])?.confidence).toBe('high');
    expect(pickArtist('Genesis', [a(1, 'Genesis', 60), a(2, 'Genesis Owusu', 5_000_000)])?.confidence).toBe('high');
    // A clone rival never counts.
    expect(pickArtist('Genesis', [a(1, 'Genesis', 10), a(2, 'Genesis Karaoke', 5_000_000)])?.confidence).toBe('high');
  });

  it('"Fred again" finds "Fred again.." (dots are punctuation for fold)', () => {
    const results = [a(1, 'Fred again..', 800_000), a(2, 'Fred', 1_000_000)];
    const pick = pickArtist('Fred again', results);
    expect(pick?.artist.id).toBe(1);
    expect(pick?.confidence).toBe('high');
  });

  it('falls back to a loose prefix/contains match at low confidence', () => {
    expect(pickArtist('Fred again', [a(1, 'Fred again.. & Friends', 5000)])).toMatchObject({ artist: { id: 1 }, confidence: 'low' });
    expect(pickArtist('Fredagain', [a(1, 'Fred again..', 5000)])).toMatchObject({ artist: { id: 1 }, confidence: 'low' });
    expect(pickArtist('Bicep Live', [a(1, 'Bicep', 900_000)])).toMatchObject({ artist: { id: 1 }, confidence: 'low' });
    // Loose picks the largest and still ignores clones.
    expect(pickArtist('Bicep', [a(1, 'Bicep Karaoke', 100_000), a(2, 'Biceps', 200), a(3, 'Bicep Live', 4000)])?.artist.id).toBe(3);
  });

  it('refuses loose matches under 100 fans and unrelated names', () => {
    expect(pickArtist('Fred again', [a(1, 'Fred again.. & Friends', 99)])).toBeUndefined();
    expect(pickArtist('Kneecap', [a(1, 'Knee', 10), a(2, 'Some Band', 1_000_000)])).toBeUndefined();
    expect(pickArtist('Kneecap', [])).toBeUndefined();
  });
});
