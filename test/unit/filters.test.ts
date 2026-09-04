import { describe, expect, it } from 'vitest';
import { bpmAccepts, describeFilters, parseYear, trackYear, yearAccepts } from '../../src/engine/filters.js';

const track = (extra: Partial<{ releaseDate: string; name: string; albumType: string; albumName: string }> = {}) => ({ releaseDate: '1991-08-12', name: 'Enter Sandman', albumType: 'album', albumName: 'Metallica', ...extra });

describe('parseYear', () => {
  it('reads year, year-month and full dates', () => {
    expect(parseYear('2006')).toBe(2006);
    expect(parseYear('2006-10')).toBe(2006);
    expect(parseYear('2006-10-20')).toBe(2006);
    expect(parseYear('')).toBeUndefined();
    expect(parseYear(undefined)).toBeUndefined();
    expect(parseYear('0000')).toBeUndefined();
  });
});

describe('trackYear', () => {
  it('uses the Spotify album date and flags remasters as uncertain', () => {
    expect(trackYear(track())).toEqual({ year: 1991, uncertain: false });
    expect(trackYear(track({ releaseDate: '2021-09-10', name: 'Enter Sandman - Remastered 2021' }))).toEqual({ year: 2021, uncertain: true });
    expect(trackYear(track({ albumType: 'compilation', albumName: 'Greatest Hits' })).uncertain).toBe(true);
  });
  it('falls back to the source date', () => {
    expect(trackYear(track({ releaseDate: '' }), { releaseDate: '1991-08-12', title: 'Enter Sandman', titleVersion: '' })).toEqual({ year: 1991, uncertain: false });
    expect(trackYear(track({ releaseDate: '' }))).toEqual({ year: undefined, uncertain: false });
  });
});

describe('yearAccepts', () => {
  it('is permissive without a range and strict only when asked', () => {
    expect(yearAccepts({ year: 1991, uncertain: false }, {})).toBe(true);
    expect(yearAccepts({ year: 1991, uncertain: false }, { yearRange: { from: 1990, to: 1999 } })).toBe(true);
    expect(yearAccepts({ year: 2005, uncertain: false }, { yearRange: { from: 1990, to: 1999 } })).toBe(false);
    expect(yearAccepts({ year: 1985, uncertain: false }, { yearRange: { from: 1990 } })).toBe(false);
    expect(yearAccepts({ year: 2030, uncertain: false }, { yearRange: { to: 2024 } })).toBe(false);
    expect(yearAccepts({ year: 2021, uncertain: true }, { yearRange: { from: 1990, to: 1999 } })).toBe(true);
    expect(yearAccepts({ year: 2021, uncertain: true }, { yearRange: { from: 1990, to: 1999 }, strictYear: true })).toBe(false);
    expect(yearAccepts({ uncertain: false }, { yearRange: { from: 1990 } })).toBe(true);
    expect(yearAccepts({ uncertain: false }, { yearRange: { from: 1990 }, strictYear: true })).toBe(false);
  });
});

describe('bpmAccepts', () => {
  it('filters by tempo and keeps unknown tempo unless strict', () => {
    expect(bpmAccepts(170, {})).toBe(true);
    expect(bpmAccepts(170, { bpmRange: { min: 160, max: 180 } })).toBe(true);
    expect(bpmAccepts(120, { bpmRange: { min: 160, max: 180 } })).toBe(false);
    expect(bpmAccepts(200, { bpmRange: { max: 180 } })).toBe(false);
    expect(bpmAccepts(null, { bpmRange: { min: 160 } })).toBe(true);
    expect(bpmAccepts(undefined, { bpmRange: { min: 160 }, strictBpm: true })).toBe(false);
  });
});

describe('describeFilters', () => {
  it('lists active filters only', () => {
    expect(describeFilters({})).toEqual([]);
    expect(describeFilters({ yearRange: { from: 1990, to: 1999 }, bpmRange: { min: 160 }, skipCovers: true, excludeExplicit: true })).toEqual(['years 1990-1999', 'bpm 160-…', 'covers skipped', 'clean only']);
  });
});
