import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLineupText } from '../../src/engine/lineup.js';
import { isHeaderToken } from '../../src/engine/normalize.js';

interface Expectation {
  description?: string;
  tiered: boolean;
  minArtists?: number;
  exactCount?: number;
  mustContain: string[];
  mustNotContain: string[];
  discarded: string[];
  daysDetected?: string[];
  daysInclude?: string[];
  stagesDetected?: string[];
  days?: Record<string, string>;
  stages?: Record<string, string>;
  tiers?: Record<string, string>;
  noTiers?: boolean;
  noDays?: boolean;
}

const dir = fileURLToPath(new URL('../fixtures/posters/', import.meta.url));
const fixtures = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith('.txt'))
  .sort()
  .map((f) => {
    const base = f.replace(/\.txt$/, '');
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    const exp = JSON.parse(fs.readFileSync(path.join(dir, `${base}.json`), 'utf8')) as Expectation;
    return { base, text, exp };
  });

describe('parseLineupText fixtures', () => {
  it('has eight poster fixtures each with an expectation file', () => {
    expect(fixtures.length).toBe(8);
  });

  describe.each(fixtures)('$base', ({ text, exp }) => {
    const result = parseLineupText(text);
    const names = result.artists.map((a) => a.name);
    const lower = new Set(names.map((n) => n.toLowerCase()));
    const byName = new Map(result.artists.map((a) => [a.name, a]));

    it('keeps every expected artist exactly once', () => {
      for (const n of exp.mustContain) {
        expect(names, `missing "${n}"`).toContain(n);
        expect(names.filter((x) => x === n).length, `"${n}" appears more than once`).toBe(1);
      }
    });

    it('never turns poster furniture (headers, dates, stages, tickets) into artists', () => {
      for (const n of exp.mustNotContain) {
        expect(lower.has(n.toLowerCase()), `"${n}" should not be an artist`).toBe(false);
      }
    });

    it('lands headers in discarded', () => {
      for (const n of exp.discarded) {
        expect(result.discarded, `"${n}" should be discarded`).toContain(n);
      }
      for (const d of result.discarded) {
        expect(lower.has(d.toLowerCase()), `"${d}" is both discarded and an artist`).toBe(false);
      }
    });

    it(`tiered is ${exp.tiered}`, () => {
      expect(result.tiered).toBe(exp.tiered);
    });

    it('reports artist count in the expected range', () => {
      if (exp.minArtists !== undefined) expect(names.length).toBeGreaterThanOrEqual(exp.minArtists);
      if (exp.exactCount !== undefined) expect(names.length).toBe(exp.exactCount);
    });

    it('detects days and stages', () => {
      if (exp.daysDetected) expect(result.days).toEqual(exp.daysDetected);
      if (exp.daysInclude) for (const d of exp.daysInclude) expect(result.days).toContain(d);
      if (exp.stagesDetected) expect(result.stages).toEqual(exp.stagesDetected);
    });

    it('assigns the right day to artists', () => {
      for (const [name, day] of Object.entries(exp.days ?? {})) {
        expect(byName.get(name)?.day, `day of "${name}"`).toBe(day);
      }
      if (exp.noDays) for (const a of result.artists) expect(a.day).toBeUndefined();
    });

    it('assigns the right stage to artists', () => {
      for (const [name, stage] of Object.entries(exp.stages ?? {})) {
        expect(byName.get(name)?.stage, `stage of "${name}"`).toBe(stage);
      }
    });

    it('assigns tiers by position within a block', () => {
      for (const [name, tier] of Object.entries(exp.tiers ?? {})) {
        expect(byName.get(name)?.tier, `tier of "${name}"`).toBe(tier);
      }
      if (exp.noTiers) for (const a of result.artists) expect(a.tier).toBeUndefined();
      if (exp.tiered) for (const a of result.artists) expect(a.tier).toBeDefined();
    });

    it('produces clean, unique names', () => {
      expect(new Set(names.map((n) => n.toLowerCase())).size).toBe(names.length);
      for (const n of names) {
        expect(n).toBe(n.trim());
        expect(n).not.toMatch(/[•|·]/);
        expect(n.length).toBeGreaterThan(0);
        expect(isHeaderToken(n), `"${n}" is a header token`).toBe(false);
      }
    });
  });
});

describe('parseLineupText basics', () => {
  it('returns an empty result for empty input', () => {
    expect(parseLineupText('')).toEqual({ artists: [], discarded: [], tiered: false, days: [], stages: [] });
    expect(parseLineupText(undefined as unknown as string).artists).toEqual([]);
  });

  it('keeps the first occurrence (and its day) when an artist plays twice', () => {
    const r = parseLineupText('FRIDAY\nA • B • C\nD • E\nSATURDAY\nA • F\nG • H • I');
    const a = r.artists.find((x) => x.name === 'A');
    expect(a?.day).toBe('friday');
    expect(r.artists.filter((x) => x.name === 'A').length).toBe(1);
  });

  it('a day header with names on the same line is not treated as a header line', () => {
    const r = parseLineupText('FRIDAY • A • B\nC • D • E\nF • G');
    expect(r.artists.map((x) => x.name)).toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'G']);
    expect(r.discarded).toContain('FRIDAY');
  });

  it('strips "Label presents" prefixes', () => {
    const r = parseLineupText('Defected presents Sam Divine\nOther');
    expect(r.artists.map((x) => x.name)).toEqual(['Sam Divine', 'Other']);
  });

  it('is not tiered with fewer than three rows', () => {
    const r = parseLineupText('A • B • C\nD • E');
    expect(r.tiered).toBe(false);
    expect(r.artists.every((a) => a.tier === undefined)).toBe(true);
  });
});
