/**
 * The degraded-matching warning and the per-tier merge. Both exist because the
 * failure they describe is silent: a broken lookup source still returns a full
 * playlist, and an untagged artist still gets tracks, just the wrong number.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { Draft, DraftTrack, Provider } from '../../src/types.js';

const home = await fs.mkdtemp(path.join(os.tmpdir(), 'lineupify-quality-'));
process.env.LINEUPIFY_HOME = home;
process.env.LINEUPIFY_LOG = 'error';

const { matchQualityNote, summary } = await import('../../src/engine/render.js');
const { resolveTracksPerTier } = await import('../../src/tools/drafts.js');
const { newDraft } = await import('../../src/engine/draft.js');

afterAll(async () => {
  await fs.rm(home, { recursive: true, force: true }).catch(() => undefined);
});

function draftWith(via: DraftTrack['matchedVia'][], provider: Provider = 'spotify'): Draft {
  const d = newDraft({
    name: 'Quality',
    artists: [{ name: 'Someone' }],
    options: { tracksPerTier: { headliner: 5, sub: 3, undercard: 2 }, maxTracks: 100, order: 'lineup', excludeArtists: [], excludeExplicit: false, allowVersions: false, discoveryOnly: false, stopIfUnresolved: false, public: false, sources: ['deezer'] },
    spotifyUserId: 'u',
    provider,
  });
  d.status = 'ready';
  d.artists[0]!.status = 'resolved';
  d.tracks = via.map((v, i) => ({
    id: `t_${i}`, uri: `spotify:track:${i}`, spotifyId: String(i), name: `Song ${i}`, artists: ['Someone'],
    artistKey: d.artists[0]!.key, durationMs: 1000, explicit: false, matchedVia: v, source: 'deezer', role: 'lead',
  }));
  return d;
}

const times = (n: number, v: DraftTrack['matchedVia']) => Array.from({ length: n }, () => v);

describe('matchQualityNote', () => {
  it('shouts when every automatic match fell back to text, which is what a broken source looks like', () => {
    const note = matchQualityNote(draftWith(times(24, 'text')));
    expect(note).toContain('not one of the 24');
    expect(note).toContain('broken lookup source');
    // It has to reach the user, not just exist as a helper.
    expect(summary(draftWith(times(24, 'text')))).toContain('broken lookup source');
  });

  it('says nothing when ISRC matching is doing its job', () => {
    expect(matchQualityNote(draftWith(times(20, 'isrc')))).toBe('');
    expect(matchQualityNote(draftWith([...times(18, 'isrc'), ...times(2, 'text')]))).toBe('');
    expect(summary(draftWith(times(20, 'isrc')))).not.toContain('Warning');
  });

  it('notes a text-heavy majority more gently', () => {
    const note = matchQualityNote(draftWith([...times(3, 'isrc'), ...times(17, 'text')]));
    expect(note).toContain('17 of 20');
    expect(note).not.toContain('Warning');
  });

  it('stays quiet on small drafts, where a run of text matches proves nothing', () => {
    expect(matchQualityNote(draftWith(times(4, 'text')))).toBe('');
  });

  it('ignores drafts that do not match against Spotify at all', () => {
    expect(matchQualityNote(draftWith(times(20, 'deezer'), 'deezer'))).toBe('');
    // Manual adds are the user's own choice, not a matching failure.
    expect(matchQualityNote(draftWith(times(20, 'manual')))).toBe('');
  });
});

describe('resolveTracksPerTier', () => {
  const defaults = { headliner: 5, sub: 3, undercard: 2 };

  it('gives untagged artists the count the caller asked for "everyone else"', () => {
    // "6 for headliners, 3 for the rest": untagged artists become undercard, and used
    // to silently land on the built-in 2 instead of the 3 that was asked for.
    expect(resolveTracksPerTier(defaults, { headliner: 6, sub: 3 })).toEqual({ headliner: 6, sub: 3, undercard: 3 });
  });

  it('leaves an explicit undercard alone', () => {
    expect(resolveTracksPerTier(defaults, { headliner: 6, sub: 3, undercard: 1 })).toEqual({ headliner: 6, sub: 3, undercard: 1 });
  });

  it('falls back to the configured defaults when nothing or only headliner is given', () => {
    expect(resolveTracksPerTier(defaults, undefined)).toEqual(defaults);
    expect(resolveTracksPerTier(defaults, {})).toEqual(defaults);
    expect(resolveTracksPerTier(defaults, { headliner: 8 })).toEqual({ headliner: 8, sub: 3, undercard: 2 });
  });
});
