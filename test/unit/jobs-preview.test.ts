import { describe, it, expect } from 'vitest';
import type { Candidate } from '../../src/types.js';
import { previewPick } from '../../src/engine/jobs.js';

let rank = 0;
function cand(title: string, lead: string, extra: Partial<Candidate> = {}): Candidate {
  return {
    source: 'deezer',
    title,
    titleShort: title.replace(/\s*[([].*$/, ''),
    titleVersion: '',
    leadArtist: lead,
    contributors: [lead],
    role: 'lead',
    rank: rank++,
    deezerTrackId: 1000 + rank,
    ...extra,
  };
}

describe('previewPick', () => {
  it('takes lead credits before featured ones regardless of rank', () => {
    const cs = [cand('Guest Spot', 'Someone Else', { role: 'featured' }), cand('Own Song', 'Kneecap'), cand('Another Own', 'Kneecap')];
    expect(previewPick(cs, 1, false).map((c) => c.title)).toEqual(['Own Song']);
    expect(previewPick(cs, 3, false).map((c) => c.title)).toEqual(['Own Song', 'Another Own', 'Guest Spot']);
    expect(previewPick(cs, 3, true).map((c) => c.title)).toEqual(['Own Song', 'Another Own', 'Guest Spot']);
  });

  it('dedupes by song key (short title + lead artist) across catalogues', () => {
    const cs = [cand('Rumble', 'Fred again..'), cand('Rumble (Radio Edit)', 'Fred again..', { titleShort: 'Rumble' }), cand('RUMBLE', 'Fred Again..'), cand('Delilah', 'Fred again..')];
    const out = previewPick(cs, 5, false);
    expect(out.map((c) => c.title)).toEqual(['Rumble', 'Delilah']);
    // Same title by a different lead artist is a different song.
    expect(previewPick([cand('Rumble', 'A'), cand('Rumble', 'B')], 5, false).length).toBe(2);
  });

  it('only admits versions in the final pass when versions are disallowed', () => {
    const cs = [cand('Rumble (Live)', 'Fred', { titleVersion: '(Live)' }), cand('Adore You', 'Fred'), cand('Marea - Remix', 'Fred', { titleShort: 'Marea' })];
    expect(previewPick(cs, 1, false).map((c) => c.title)).toEqual(['Adore You']);
    expect(previewPick(cs, 2, false).map((c) => c.title)).toEqual(['Adore You', 'Rumble (Live)']);
    expect(previewPick(cs, 3, false).map((c) => c.title)).toEqual(['Adore You', 'Rumble (Live)', 'Marea - Remix']);
  });

  it('prefers a featured original over a lead version when versions are disallowed', () => {
    const cs = [cand('Live Song (Live)', 'Fred', { titleVersion: '(Live)' }), cand('Guest', 'Other', { role: 'featured' })];
    expect(previewPick(cs, 2, false).map((c) => c.title)).toEqual(['Guest', 'Live Song (Live)']);
    expect(previewPick(cs, 2, true).map((c) => c.title)).toEqual(['Live Song (Live)', 'Guest']);
  });

  it('with versions allowed it is a single ordered pass per role', () => {
    const cs = [cand('Rumble (Live)', 'Fred', { titleVersion: '(Live)' }), cand('Adore You', 'Fred')];
    expect(previewPick(cs, 2, true).map((c) => c.title)).toEqual(['Rumble (Live)', 'Adore You']);
  });

  it('remasters are not versions and are taken in the first pass', () => {
    const cs = [cand('Song (Remastered 2009)', 'Genesis', { titleVersion: '(Remastered 2009)' }), cand('Other', 'Genesis')];
    expect(previewPick(cs, 1, false).map((c) => c.title)).toEqual(['Song (Remastered 2009)']);
  });

  it('a version whose original was already picked does not sneak in through the version pass', () => {
    const cs = [cand('Rumble', 'Fred'), cand('Rumble (Live)', 'Fred', { titleVersion: '(Live)', titleShort: 'Rumble' })];
    expect(previewPick(cs, 5, false).map((c) => c.title)).toEqual(['Rumble']);
  });

  it('respects need exactly', () => {
    const cs = Array.from({ length: 10 }, (_, i) => cand(`Song ${i}`, 'X'));
    expect(previewPick(cs, 3, false).map((c) => c.title)).toEqual(['Song 0', 'Song 1', 'Song 2']);
    expect(previewPick(cs, 0, false)).toEqual([]);
    expect(previewPick(cs, 50, false).length).toBe(10);
    expect(previewPick([], 3, false)).toEqual([]);
  });

  it('does not mutate the candidate list', () => {
    const cs = [cand('B', 'X', { role: 'featured' }), cand('A', 'X')];
    previewPick(cs, 2, false);
    expect(cs.map((c) => c.title)).toEqual(['B', 'A']);
  });
});
