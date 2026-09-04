import { describe, expect, it } from 'vitest';
import type { PlaylistTrack } from '../../src/types.js';
import { artistFrequency, parsePlaylistRef, refLabel } from '../../src/engine/playlists.js';
import { findLocalCovers } from '../../src/engine/covers.js';

describe('parsePlaylistRef', () => {
  it('recognises Spotify links, URIs, ids and intl links', () => {
    expect(parsePlaylistRef('https://open.spotify.com/playlist/0aBcDeFgHiJkLmNoPqRsTu?si=abc')).toEqual({ kind: 'spotify', id: '0aBcDeFgHiJkLmNoPqRsTu' });
    expect(parsePlaylistRef('https://open.spotify.com/intl-de/playlist/0aBcDeFgHiJkLmNoPqRsTu')).toEqual({ kind: 'spotify', id: '0aBcDeFgHiJkLmNoPqRsTu' });
    expect(parsePlaylistRef('spotify:playlist:0aBcDeFgHiJkLmNoPqRsTu')).toEqual({ kind: 'spotify', id: '0aBcDeFgHiJkLmNoPqRsTu' });
    expect(parsePlaylistRef('0aBcDeFgHiJkLmNoPqRsTu')).toEqual({ kind: 'spotify', id: '0aBcDeFgHiJkLmNoPqRsTu' });
  });
  it('recognises Deezer, drafts, library, me and names', () => {
    expect(parsePlaylistRef('https://www.deezer.com/en/playlist/1109890291')).toEqual({ kind: 'deezer', id: 1109890291 });
    expect(parsePlaylistRef('d_jwd2k')).toEqual({ kind: 'draft', id: 'd_jwd2k' });
    expect(parsePlaylistRef('Liked Songs')).toEqual({ kind: 'library' });
    expect(parsePlaylistRef('me')).toEqual({ kind: 'me' });
    expect(parsePlaylistRef('Sunday mornings')).toEqual({ kind: 'name', name: 'Sunday mornings' });
  });
  it('rejects unknown links and empty input', () => {
    expect(() => parsePlaylistRef('https://music.apple.com/playlist/x')).toThrow(/Unrecognised/);
    expect(() => parsePlaylistRef('  ')).toThrow(/Empty/);
  });
  it('labels refs', () => {
    expect(refLabel({ kind: 'me' })).toBe('your listening history');
    expect(refLabel({ kind: 'name', name: 'x' })).toBe('"x"');
  });
});

describe('artistFrequency', () => {
  it('counts lead artists fully and featured artists half', () => {
    const tracks: PlaylistTrack[] = [
      { name: 'a', artists: ['Joji', 'BENEE'], artistIds: ['j', 'b'], durationMs: 1, explicit: false },
      { name: 'b', artists: ['Joji'], artistIds: ['j'], durationMs: 1, explicit: false },
      { name: 'c', artists: ['BENEE'], durationMs: 1, explicit: false },
    ];
    const f = artistFrequency(tracks);
    expect(f.map((a) => [a.name, a.weight, a.count])).toEqual([
      ['Joji', 2, 2],
      ['BENEE', 1.5, 2],
    ]);
    expect(f[0]!.spotifyArtistId).toBe('j');
  });
});

describe('findLocalCovers', () => {
  it('drops a title that another, far more popular artist in the draft has as a lead track', () => {
    const tracks = [
      { id: 't1', uri: 'u1', spotifyId: '1', name: 'Enter Sandman', artists: ['Motörhead'], artistKey: 'motorhead', durationMs: 1, explicit: false, matchedVia: 'isrc' as const, source: 'deezer' as const, role: 'lead' as const, rank: 100_000 },
      { id: 't2', uri: 'u2', spotifyId: '2', name: 'Enter Sandman', artists: ['Metallica'], artistKey: 'metallica', durationMs: 1, explicit: false, matchedVia: 'isrc' as const, source: 'deezer' as const, role: 'lead' as const, rank: 900_000 },
      { id: 't3', uri: 'u3', spotifyId: '3', name: 'Ace of Spades', artists: ['Motörhead'], artistKey: 'motorhead', durationMs: 1, explicit: false, matchedVia: 'isrc' as const, source: 'deezer' as const, role: 'lead' as const, rank: 800_000 },
    ];
    const cand = (title: string, lead: string, rank: number) => ({ source: 'deezer' as const, title, titleShort: title, titleVersion: '', leadArtist: lead, contributors: [lead], role: 'lead' as const, rank: 0, deezerRank: rank });
    const candidates = new Map([
      ['metallica', [cand('Enter Sandman', 'Metallica', 900_000), cand('One', 'Metallica', 800_000)]],
      ['motorhead', [cand('Ace of Spades', 'Motörhead', 800_000), cand('Enter Sandman', 'Motörhead', 100_000)]],
    ]);
    const names = new Map([
      ['metallica', 'Metallica'],
      ['motorhead', 'Motörhead'],
    ]);
    expect([...findLocalCovers(tracks, candidates, names)]).toEqual(['t1']);
  });
});
