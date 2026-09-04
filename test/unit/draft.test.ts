import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Draft, DraftOptions, DraftTrack, LineupArtist, SpotifyTrack } from '../../src/types.js';

// LINEUPIFY_HOME must point at a scratch dir before any module that reads paths is imported.
const tempDirs: string[] = [];
async function freshHome(): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'lineupify-draft-test-'));
  tempDirs.push(d);
  process.env.LINEUPIFY_HOME = d;
  return d;
}

let draftMod: typeof import('../../src/engine/draft.js');
let storeMod: typeof import('../../src/infra/store.js');
let selectMod: typeof import('../../src/engine/select.js');

beforeAll(async () => {
  await freshHome();
  draftMod = await import('../../src/engine/draft.js');
  storeMod = await import('../../src/infra/store.js');
  selectMod = await import('../../src/engine/select.js');
});

beforeEach(async () => {
  await freshHome();
});

afterAll(async () => {
  for (const d of tempDirs) await fs.rm(d, { recursive: true, force: true }).catch(() => undefined);
});

const options = (extra: Partial<DraftOptions> = {}): DraftOptions => ({
  tracksPerTier: { headliner: 5, sub: 3, undercard: 2 },
  maxTracks: 100,
  order: 'interleave',
  excludeArtists: [],
  excludeExplicit: false,
  allowVersions: false,
  discoveryOnly: false,
  public: false,
  sources: ['deezer'],
  ...extra,
});

const lineup: LineupArtist[] = [
  { name: 'The 1975', tier: 'headliner', day: 'friday', stage: 'Main Stage' },
  { name: 'Charli XCX', tier: 'sub', day: 'friday' },
  { name: 'The Cure', tier: 'sub', day: 'sunday' },
  { name: 'Kneecap', day: 'saturday' },
];

function spotifyTrack(id: string, name: string, artists: { id: string; name: string }[], extra: Partial<SpotifyTrack> = {}): SpotifyTrack {
  return {
    uri: `spotify:track:${id}`,
    id,
    name,
    artists,
    albumName: 'Album',
    albumType: 'album',
    releaseDate: '2020-01-01',
    trackNumber: 1,
    durationMs: 200_000,
    explicit: false,
    isPlayable: true,
    ...extra,
  };
}

function track(draft: Draft, artistKey: string, n: number, extra: Partial<DraftTrack> = {}): DraftTrack {
  const uri = `spotify:track:${artistKey.replace(/\W/g, '')}${n}`;
  return {
    id: draftMod.makeTrackId(uri, new Set(draft.tracks.map((t) => t.id))),
    uri,
    spotifyId: uri.split(':').pop()!,
    name: `Song ${n}`,
    artists: [artistKey],
    artistKey,
    durationMs: 180_000,
    explicit: false,
    matchedVia: 'text',
    source: 'deezer',
    role: 'lead',
    ...extra,
  };
}

/** A finished draft: Fred (2 tracks, second explicit), Charli (2 tracks, first is a live version), Kneecap (1 track). */
function readyDraft(): Draft {
  const d = draftMod.newDraft({
    name: 'Test Fest',
    artists: [
      { name: 'Fred again..', tier: 'headliner' },
      { name: 'Charli XCX', tier: 'sub' },
      { name: 'Kneecap', tier: 'undercard' },
    ],
    options: options(),
    spotifyUserId: 'user1',
  });
  for (const a of d.artists) a.status = 'resolved';
  d.artists[0]!.target = 2;
  d.artists[1]!.target = 2;
  d.artists[2]!.target = 1;
  d.tracks.push(track(d, 'fred again', 1));
  d.tracks.push(track(d, 'fred again', 2, { explicit: true }));
  d.tracks.push(track(d, 'charli xcx', 1, { isVersion: true, name: 'Song 1 (Live)' }));
  d.tracks.push(track(d, 'charli xcx', 2));
  d.tracks.push(track(d, 'kneecap', 1));
  d.status = 'ready';
  return d;
}

const lookup = new Map<string, SpotifyTrack>([
  ['spotify:track:new1', spotifyTrack('new1', 'Nanana', [{ id: 'ar-peggy', name: 'Peggy Gou' }])],
  ['spotify:track:fred9', spotifyTrack('fred9', 'Marea', [{ id: 'ar-fred', name: 'Fred again..' }])],
]);
const deps = { lookupTrack: async (input: string) => lookup.get(input.trim()) };

describe('newDraft', () => {
  it('builds folded keys, tiers, targets and marks excluded artists', () => {
    const d = draftMod.newDraft({ name: 'Glasto', artists: lineup, options: options({ excludeArtists: ['the cure'] }), spotifyUserId: 'u1', description: 'desc' });
    expect(d.id).toMatch(/^d_[a-z0-9]{5}$/);
    expect(d.name).toBe('Glasto');
    expect(d.description).toBe('desc');
    expect(d.status).toBe('building');
    expect(d.revision).toBe(0);
    expect(d.tracks).toEqual([]);
    expect(d.rules).toEqual([]);
    expect(d.spotifyUserId).toBe('u1');
    expect(d.public).toBe(false);
    expect(d.createdAt).toBe(d.updatedAt);
    expect(d.artists.map((a) => a.key)).toEqual(['1975', 'charli xcx', 'cure', 'kneecap']);
    expect(d.artists.map((a) => a.tier)).toEqual(['headliner', 'sub', 'sub', 'undercard']);
    expect(d.artists.map((a) => a.target)).toEqual([5, 3, 3, 2]);
    expect(d.artists.map((a) => a.status)).toEqual(['pending', 'pending', 'excluded', 'pending']);
    expect(d.artists[0]).toMatchObject({ name: 'The 1975', day: 'friday', stage: 'Main Stage' });
    expect(d.progress).toEqual({ done: 0, total: 3 });
  });

  it('matches excluded artists through fold (& vs and, case)', () => {
    const d = draftMod.newDraft({ name: 'x', artists: [{ name: 'Simon & Garfunkel' }, { name: 'A$AP ROCKY' }], options: options({ excludeArtists: ['simon and garfunkel', 'asap rocky'] }), spotifyUserId: 'u' });
    expect(d.artists.every((a) => a.status === 'excluded')).toBe(true);
    expect(d.progress.total).toBe(0);
  });

  it('defaults to flat tiers (sub count) when no artist has a tier', () => {
    const d = draftMod.newDraft({ name: 'x', artists: [{ name: 'A' }, { name: 'B' }], options: options(), spotifyUserId: 'u' });
    expect(d.artists.map((a) => a.tier)).toEqual(['flat', 'flat']);
    expect(d.artists.map((a) => a.target)).toEqual([3, 3]);
  });

  it('gives duplicate names unique keys and trims names', () => {
    const d = draftMod.newDraft({ name: 'x', artists: [{ name: ' Kneecap ' }, { name: 'KNEECAP' }, { name: 'kneecap' }], options: options(), spotifyUserId: 'u' });
    expect(d.artists.map((a) => a.key)).toEqual(['kneecap', 'kneecap~2', 'kneecap~3']);
    expect(d.artists[0]!.name).toBe('Kneecap');
  });

  it('respects the public flag and tracksPerArtist override', () => {
    const d = draftMod.newDraft({ name: 'x', artists: lineup, options: options({ public: true, tracksPerArtist: 1 }), spotifyUserId: 'u' });
    expect(d.public).toBe(true);
    expect(d.artists.every((a) => a.target === 1)).toBe(true);
  });
});

describe('makeTrackId', () => {
  it('produces short stable ids and avoids collisions', () => {
    const uri = 'spotify:track:abc';
    const id = draftMod.makeTrackId(uri, new Set());
    expect(id).toMatch(/^t_[a-z0-9]{4}$/);
    expect(draftMod.makeTrackId(uri, new Set())).toBe(id);
    const existing = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const next = draftMod.makeTrackId(uri, existing);
      expect(existing.has(next)).toBe(false);
      existing.add(next);
    }
    expect(existing.size).toBe(50);
  });

  it('artistKeyFor falls back and suffixes', () => {
    expect(draftMod.artistKeyFor('The 1975', new Set())).toBe('1975');
    expect(draftMod.artistKeyFor('The 1975', new Set(['1975']))).toBe('1975~2');
    expect(draftMod.artistKeyFor('!!!', new Set())).toBe('!!!');
  });
});

describe('persistence', () => {
  it('saveDraft/loadDraft round-trips and sets the draft dir under LINEUPIFY_HOME', async () => {
    const home = process.env.LINEUPIFY_HOME!;
    const d = draftMod.newDraft({ name: 'RT', artists: lineup, options: options(), spotifyUserId: 'u' });
    await draftMod.saveDraft(d);
    const file = storeMod.paths.draft(d.id);
    expect(file.startsWith(home)).toBe(true);
    await expect(fs.stat(file)).resolves.toBeTruthy();
    const loaded = await draftMod.loadDraft(d.id);
    expect(loaded).toEqual(JSON.parse(JSON.stringify(d)));
    expect(loaded!.revision).toBe(0);
  });

  it('loadDraft rejects malformed ids and returns undefined for unknown ones', async () => {
    expect(await draftMod.loadDraft('../config')).toBeUndefined();
    expect(await draftMod.loadDraft('nope')).toBeUndefined();
    expect(await draftMod.loadDraft('d_zzzzz')).toBeUndefined();
    await expect(draftMod.requireDraft('d_zzzzz')).rejects.toMatchObject({ code: 'DRAFT_NOT_FOUND' });
  });

  it('bumping stores the previous revision which popRevision restores', async () => {
    const d = draftMod.newDraft({ name: 'v1', artists: lineup, options: options(), spotifyUserId: 'u' });
    await draftMod.saveDraft(d);
    const prev = structuredClone(d);
    d.name = 'v2';
    await draftMod.saveDraft(d, { bump: true, previous: prev });
    expect(d.revision).toBe(1);
    expect((await draftMod.loadDraft(d.id))!.name).toBe('v2');
    const revFiles = await fs.readdir(storeMod.paths.draftRevDir(d.id));
    expect(revFiles).toEqual(['0.json']);

    const popped = await draftMod.popRevision(d);
    expect(popped?.name).toBe('v1');
    expect(popped?.revision).toBe(0);
    expect(await fs.readdir(storeMod.paths.draftRevDir(d.id))).toEqual([]);
    expect(await draftMod.popRevision(d)).toBeUndefined();
  });

  it('bump without previous only increments; revisions are capped at 10 files', async () => {
    const d = draftMod.newDraft({ name: 'v', artists: lineup, options: options(), spotifyUserId: 'u' });
    await draftMod.saveDraft(d, { bump: true });
    expect(d.revision).toBe(1);
    for (let i = 0; i < 14; i++) {
      const prev = structuredClone(d);
      d.name = `v${i}`;
      await draftMod.saveDraft(d, { bump: true, previous: prev });
    }
    expect(d.revision).toBe(15);
    const files = (await fs.readdir(storeMod.paths.draftRevDir(d.id))).map((f) => Number(f.replace('.json', ''))).sort((a, b) => a - b);
    expect(files.length).toBe(10);
    expect(files).toEqual([5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
    const popped = await draftMod.popRevision(d);
    expect(popped?.revision).toBe(14);
  });

  it('listDrafts sorts newest first and skips junk files', async () => {
    const a = draftMod.newDraft({ name: 'A', artists: lineup, options: options(), spotifyUserId: 'u' });
    const b = draftMod.newDraft({ name: 'B', artists: lineup, options: options(), spotifyUserId: 'u' });
    await storeMod.writeJsonAtomic(storeMod.paths.draft(a.id), { ...a, updatedAt: '2026-01-01T00:00:00.000Z' });
    await storeMod.writeJsonAtomic(storeMod.paths.draft(b.id), { ...b, updatedAt: '2026-02-01T00:00:00.000Z' });
    await fs.writeFile(path.join(storeMod.paths.draftsDir(), 'notes.json'), '{}');
    await fs.writeFile(path.join(storeMod.paths.draftsDir(), 'd_broken.json'), '{ corrupt');
    const list = await draftMod.listDrafts();
    expect(list.map((d) => d.name)).toEqual(['B', 'A']);
  });

  it('listDrafts returns [] when the drafts dir does not exist', async () => {
    expect(await draftMod.listDrafts()).toEqual([]);
  });

  it('deleteDraft removes the file, revisions and lock', async () => {
    const d = draftMod.newDraft({ name: 'D', artists: lineup, options: options(), spotifyUserId: 'u' });
    await draftMod.saveDraft(d);
    await draftMod.saveDraft(d, { bump: true, previous: structuredClone(d) });
    await fs.writeFile(storeMod.paths.draftLock(d.id), '{}');
    expect(await draftMod.deleteDraft(d.id)).toBe(true);
    expect(await draftMod.loadDraft(d.id)).toBeUndefined();
    await expect(fs.stat(storeMod.paths.draftRevDir(d.id))).rejects.toBeTruthy();
    await expect(fs.stat(storeMod.paths.draftLock(d.id))).rejects.toBeTruthy();
    expect(await draftMod.deleteDraft(d.id)).toBe(false);
  });

  it('pruneDrafts removes stale unpublished drafts but never published ones', async () => {
    const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
    const stale = draftMod.newDraft({ name: 'stale', artists: lineup, options: options(), spotifyUserId: 'u' });
    const published = draftMod.newDraft({ name: 'published', artists: lineup, options: options(), spotifyUserId: 'u' });
    const fresh = draftMod.newDraft({ name: 'fresh', artists: lineup, options: options(), spotifyUserId: 'u' });
    await storeMod.writeJsonAtomic(storeMod.paths.draft(stale.id), { ...stale, updatedAt: old });
    await storeMod.writeJsonAtomic(storeMod.paths.draft(published.id), { ...published, updatedAt: old, playlistId: 'pl1' });
    await draftMod.saveDraft(fresh);
    expect(await draftMod.pruneDrafts()).toBe(1);
    const names = (await draftMod.listDrafts()).map((d) => d.name).sort();
    expect(names).toEqual(['fresh', 'published']);
  });
});

describe('findArtist / totalDurationMs', () => {
  it('finds by key, folded name, resolved name and substring', () => {
    const d = readyDraft();
    d.artists[0]!.resolved = { name: 'Fred Again..', source: 'deezer', confidence: 'high' };
    expect(draftMod.findArtist(d, 'fred again')?.key).toBe('fred again');
    expect(draftMod.findArtist(d, 'FRED AGAIN..')?.key).toBe('fred again');
    expect(draftMod.findArtist(d, 'Fred Again..')?.key).toBe('fred again');
    expect(draftMod.findArtist(d, 'charli')?.key).toBe('charli xcx');
    expect(draftMod.findArtist(d, 'nobody')).toBeUndefined();
    expect(draftMod.totalDurationMs(d)).toBe(5 * 180_000);
  });
});

describe('applyEdits', () => {
  it('remove_tracks by id and by 1-based index', async () => {
    const d = readyDraft();
    const [t1, , t3] = d.tracks;
    const r = await draftMod.applyEdits(d, [{ op: 'remove_tracks', ids: [t1!.id] }], deps);
    expect(r.draft.tracks.map((t) => t.id)).not.toContain(t1!.id);
    expect(r.draft.tracks.length).toBe(4);
    expect(r.diff[0]).toContain('removed 1 track');
    expect(r.rebuildArtists).toEqual([]);

    const d2 = readyDraft();
    const r2 = await draftMod.applyEdits(d2, [{ op: 'remove_tracks', indexes: [1, 3] }], deps);
    expect(r2.draft.tracks.map((t) => t.id)).toEqual(readyDraft().tracks.filter((_, i) => i !== 0 && i !== 2).map((t) => t.id));
    expect(r2.draft.tracks.some((t) => t.id === t3!.id)).toBe(false);
    expect(r2.diff[0]).toContain('removed 2 tracks');
  });

  it('remove_tracks rejects unknown ids and out-of-range indexes', async () => {
    await expect(draftMod.applyEdits(readyDraft(), [{ op: 'remove_tracks', ids: ['t_nope'] }], deps)).rejects.toMatchObject({ code: 'TRACK_NOT_FOUND' });
    await expect(draftMod.applyEdits(readyDraft(), [{ op: 'remove_tracks', indexes: [99] }], deps)).rejects.toMatchObject({ code: 'TRACK_NOT_FOUND' });
    await expect(draftMod.applyEdits(readyDraft(), [{ op: 'remove_tracks', indexes: [0] }], deps)).rejects.toMatchObject({ code: 'TRACK_NOT_FOUND' });
  });

  it('add_track creates a flat user artist when the track artist is unknown', async () => {
    const d = readyDraft();
    const r = await draftMod.applyEdits(d, [{ op: 'add_track', track: 'spotify:track:new1' }], deps);
    expect(r.draft.artists.length).toBe(4);
    const added = r.draft.artists[3]!;
    expect(added).toMatchObject({ key: 'peggy gou', name: 'Peggy Gou', tier: 'flat', status: 'resolved', target: 0 });
    expect(added.resolved).toMatchObject({ name: 'Peggy Gou', source: 'user', confidence: 'high', spotifyArtistId: 'ar-peggy' });
    const nt = r.draft.tracks[r.draft.tracks.length - 1]!;
    expect(nt).toMatchObject({ uri: 'spotify:track:new1', spotifyId: 'new1', name: 'Nanana', artists: ['Peggy Gou'], artistKey: 'peggy gou', matchedVia: 'manual', source: 'manual', role: 'lead', album: 'Album', durationMs: 200_000, explicit: false });
    expect(nt.id).toMatch(/^t_[a-z0-9]{4}$/);
    expect(new Set(r.draft.tracks.map((t) => t.id)).size).toBe(r.draft.tracks.length);
    expect(r.diff[0]).toMatch(/^added t_[a-z0-9]{4} Peggy Gou – Nanana at #6$/);
  });

  it('add_track attaches to an existing artist by name, honours position and explicit artist', async () => {
    const d = readyDraft();
    const r = await draftMod.applyEdits(d, [{ op: 'add_track', track: 'spotify:track:fred9', position: 1 }], deps);
    expect(r.draft.artists.length).toBe(3);
    expect(r.draft.tracks[0]).toMatchObject({ uri: 'spotify:track:fred9', artistKey: 'fred again' });
    expect(r.diff[0]).toContain('at #1');

    const d2 = readyDraft();
    const r2 = await draftMod.applyEdits(d2, [{ op: 'add_track', track: 'spotify:track:new1', artist: 'Kneecap', position: 999 }], deps);
    expect(r2.draft.artists.length).toBe(3);
    expect(r2.draft.tracks[r2.draft.tracks.length - 1]!.artistKey).toBe('kneecap');
  });

  it('add_track skips duplicates and errors when lookup fails', async () => {
    const d = readyDraft();
    const r = await draftMod.applyEdits(d, [{ op: 'add_track', track: 'spotify:track:new1' }, { op: 'add_track', track: 'spotify:track:new1' }], deps);
    expect(r.draft.tracks.length).toBe(6);
    expect(r.diff[1]).toContain('skipped');
    await expect(draftMod.applyEdits(readyDraft(), [{ op: 'add_track', track: 'spotify:track:missing' }], deps)).rejects.toMatchObject({ code: 'TRACK_NOT_FOUND' });
  });

  it('exclude_artist removes their tracks and zeroes the target', async () => {
    const d = readyDraft();
    const r = await draftMod.applyEdits(d, [{ op: 'exclude_artist', artist: 'charli' }], deps);
    const a = r.draft.artists.find((x) => x.key === 'charli xcx')!;
    expect(a.status).toBe('excluded');
    expect(a.target).toBe(0);
    expect(r.draft.tracks.some((t) => t.artistKey === 'charli xcx')).toBe(false);
    expect(r.draft.tracks.length).toBe(3);
    expect(r.draft.rules).toEqual([]);
    expect(r.diff[0]).toContain('excluded Charli XCX');
    await expect(draftMod.applyEdits(readyDraft(), [{ op: 'exclude_artist', artist: 'nobody' }], deps)).rejects.toMatchObject({ code: 'ARTIST_NOT_FOUND' });
  });

  it('set_artist_track_count down removes the surplus tracks from the end', async () => {
    const d = readyDraft();
    const keep = d.tracks[0]!.id;
    const r = await draftMod.applyEdits(d, [{ op: 'set_artist_track_count', artist: 'Fred again..', count: 1 }], deps);
    const fred = r.draft.tracks.filter((t) => t.artistKey === 'fred again');
    expect(fred.map((t) => t.id)).toEqual([keep]);
    expect(r.draft.artists[0]!.target).toBe(1);
    expect(r.rebuildArtists).toEqual([]);
    expect(r.diff[0]).toBe('Fred again..: 2 -> 1 tracks');
  });

  it('set_artist_track_count up marks the artist pending and asks for a rebuild', async () => {
    const d = readyDraft();
    const r = await draftMod.applyEdits(d, [{ op: 'set_artist_track_count', artist: 'kneecap', count: 3.9 }], deps);
    const a = r.draft.artists.find((x) => x.key === 'kneecap')!;
    expect(a.status).toBe('pending');
    expect(a.target).toBe(3);
    expect(r.rebuildArtists).toEqual(['kneecap']);
    expect(r.draft.tracks.length).toBe(5);
    expect(r.diff[0]).toContain('fetching more');
  });

  it('set_artist_track_count same count is a no-op; re-enables excluded artists', async () => {
    const d = readyDraft();
    const r = await draftMod.applyEdits(d, [{ op: 'set_artist_track_count', artist: 'kneecap', count: 1 }], deps);
    expect(r.diff[0]).toContain('already 1');
    const d2 = readyDraft();
    d2.artists[2]!.status = 'excluded';
    const r2 = await draftMod.applyEdits(d2, [{ op: 'set_artist_track_count', artist: 'kneecap', count: 0 }], deps);
    expect(r2.draft.artists[2]!.status).toBe('excluded');
    expect(r2.draft.tracks.some((t) => t.artistKey === 'kneecap')).toBe(false);
    const d3 = readyDraft();
    d3.artists[2]!.status = 'excluded';
    const r3 = await draftMod.applyEdits(d3, [{ op: 'set_artist_track_count', artist: 'kneecap', count: 2 }], deps);
    expect(r3.draft.artists[2]!.status).toBe('pending');
  });

  it('move by id and by from/to, clamped to the list', async () => {
    const d = readyDraft();
    const ids = d.tracks.map((t) => t.id);
    const r = await draftMod.applyEdits(d, [{ op: 'move', id: ids[4], to: 1 }], deps);
    expect(r.draft.tracks.map((t) => t.id)).toEqual([ids[4], ids[0], ids[1], ids[2], ids[3]]);
    expect(r.diff[0]).toBe(`moved ${ids[4]} to #1`);

    const d2 = readyDraft();
    const r2 = await draftMod.applyEdits(d2, [{ op: 'move', from: 1, to: 99 }], deps);
    expect(r2.draft.tracks.map((t) => t.id)).toEqual([ids[1], ids[2], ids[3], ids[4], ids[0]]);
    await expect(draftMod.applyEdits(readyDraft(), [{ op: 'move', id: 't_nope', to: 1 }], deps)).rejects.toMatchObject({ code: 'TRACK_NOT_FOUND' });
    await expect(draftMod.applyEdits(readyDraft(), [{ op: 'move', from: 9, to: 1 }], deps)).rejects.toMatchObject({ code: 'TRACK_NOT_FOUND' });
  });

  it('shuffle is seeded and recorded in options', async () => {
    const d = readyDraft();
    const original = d.tracks.slice();
    const r = await draftMod.applyEdits(d, [{ op: 'shuffle', seed: 42 }], deps);
    expect(r.draft.options.order).toBe('shuffle');
    expect(r.draft.options.shuffleSeed).toBe(42);
    expect(r.draft.tracks.map((t) => t.id)).toEqual(selectMod.shuffle(original, 42).map((t) => t.id));
    expect(r.diff[0]).toBe('shuffled 5 tracks (seed 42)');
    const r2 = await draftMod.applyEdits(readyDraft(), [{ op: 'shuffle' }], deps);
    expect(typeof r2.draft.options.shuffleSeed).toBe('number');
  });

  it('reorder applies an ordering mode', async () => {
    const d = readyDraft();
    d.tracks.reverse();
    const r = await draftMod.applyEdits(d, [{ op: 'reorder', mode: 'lineup' }], deps);
    expect(r.draft.options.order).toBe('lineup');
    expect(r.draft.tracks.map((t) => t.artistKey)).toEqual(['fred again', 'fred again', 'charli xcx', 'charli xcx', 'kneecap']);
    expect(r.diff[0]).toBe('reordered 5 tracks (mode lineup)');
    const r2 = await draftMod.applyEdits(readyDraft(), [{ op: 'reorder', mode: 'interleave' }], deps);
    for (let i = 1; i < r2.draft.tracks.length; i++) expect(r2.draft.tracks[i]!.artistKey).not.toBe(r2.draft.tracks[i - 1]!.artistKey);
  });

  it('set_meta strips html, trims and caps lengths', async () => {
    const d = readyDraft();
    const r = await draftMod.applyEdits(d, [{ op: 'set_meta', name: `  ${'n'.repeat(150)}  `, description: '<b>Hi</b> <script>alert(1)</script>there <a href="x">link</a>', public: true }], deps);
    expect(r.draft.name).toBe('n'.repeat(100));
    expect(r.draft.description).toBe('Hi alert(1)there link');
    expect(r.draft.public).toBe(true);
    expect(r.diff).toEqual([`name: ${'n'.repeat(100)}`, 'description updated', 'public: true']);
    const r2 = await draftMod.applyEdits(readyDraft(), [{ op: 'set_meta', description: 'd'.repeat(400) }], deps);
    expect(r2.draft.description.length).toBe(300);
    expect(r2.draft.rules).toEqual([]);
  });

  it('filter explicit removes explicit tracks; filter versions removes live/remix tracks', async () => {
    const d = readyDraft();
    const r = await draftMod.applyEdits(d, [{ op: 'filter', explicit: true }], deps);
    expect(r.draft.options.excludeExplicit).toBe(true);
    expect(r.draft.tracks.some((t) => t.explicit)).toBe(false);
    expect(r.draft.tracks.length).toBe(4);
    expect(r.diff[0]).toBe('explicit filter on: removed 1');

    const d2 = readyDraft();
    const r2 = await draftMod.applyEdits(d2, [{ op: 'filter', versions: false }], deps);
    expect(r2.draft.options.allowVersions).toBe(false);
    expect(r2.draft.tracks.some((t) => t.isVersion)).toBe(false);
    expect(r2.draft.tracks.length).toBe(4);
    expect(r2.diff[0]).toContain('removed 1');

    const d3 = readyDraft();
    const r3 = await draftMod.applyEdits(d3, [{ op: 'filter', explicit: false, versions: true }], deps);
    expect(r3.draft.tracks.length).toBe(5);
    expect(r3.draft.options.allowVersions).toBe(true);
  });

  it('applies several ops in one call with a single removal pass', async () => {
    const d = readyDraft();
    const r = await draftMod.applyEdits(d, [{ op: 'filter', explicit: true }, { op: 'exclude_artist', artist: 'kneecap' }, { op: 'set_artist_track_count', artist: 'charli xcx', count: 1 }], deps);
    expect(r.draft.tracks.map((t) => t.artistKey)).toEqual(['fred again', 'charli xcx']);
  });

  it('undo restores the previous revision', async () => {
    const d = readyDraft();
    await draftMod.saveDraft(d);
    const prev = structuredClone(d);
    await draftMod.applyEdits(d, [{ op: 'remove_tracks', indexes: [1] }], deps);
    await draftMod.saveDraft(d, { bump: true, previous: prev });
    expect(d.revision).toBe(1);
    expect(d.tracks.length).toBe(4);

    const r = await draftMod.applyEdits(d, [{ op: 'undo' }], deps);
    expect(r.undone).toBe(true);
    expect(r.draft.tracks.length).toBe(5);
    expect(r.draft.revision).toBe(2);
    expect(r.diff).toEqual(['restored revision 0 as rev 2']);
    await expect(draftMod.applyEdits(r.draft, [{ op: 'undo' }], deps)).rejects.toMatchObject({ code: 'NOTHING_TO_UNDO' });
  });

  it('undo must be the only op', async () => {
    await expect(draftMod.applyEdits(readyDraft(), [{ op: 'undo' }, { op: 'shuffle', seed: 1 }], deps)).rejects.toMatchObject({ code: 'EDIT_UNDO_ALONE' });
  });

  describe('while the draft is building (DRAFT_BUSY)', () => {
    const building = () => {
      const d = readyDraft();
      d.status = 'building';
      return d;
    };

    it('rejects positional ops', async () => {
      const positional = [
        { op: 'remove_tracks', indexes: [1] },
        { op: 'add_track', track: 'spotify:track:new1' },
        { op: 'move', from: 1, to: 2 },
        { op: 'shuffle', seed: 1 },
        { op: 'reorder', mode: 'lineup' },
        { op: 'undo' },
      ] as const;
      for (const op of positional) {
        await expect(draftMod.applyEdits(building(), [op as never], deps), op.op).rejects.toMatchObject({ code: 'DRAFT_BUSY' });
      }
    });

    it('accepts rule ops and records them in draft.rules', async () => {
      const d = building();
      const r = await draftMod.applyEdits(d, [
        { op: 'exclude_artist', artist: 'kneecap' },
        { op: 'set_artist_track_count', artist: 'charli xcx', count: 4 },
        { op: 'set_meta', name: 'Renamed', public: true },
        { op: 'filter', explicit: true, versions: false },
      ], deps);
      expect(r.draft.rules).toEqual([
        { op: 'exclude_artist', payload: { key: 'kneecap' } },
        { op: 'set_artist_track_count', payload: { key: 'charli xcx', count: 4 } },
        { op: 'set_meta', payload: { op: 'set_meta', name: 'Renamed', public: true } },
        { op: 'filter', payload: { op: 'filter', explicit: true, versions: false } },
      ]);
      expect(r.draft.name).toBe('Renamed');
      expect(r.draft.artists.find((a) => a.key === 'kneecap')!.status).toBe('excluded');
      expect(r.rebuildArtists).toEqual(['charli xcx']);
      expect(r.draft.tracks.map((t) => t.artistKey)).toEqual(['fred again', 'charli xcx']);
      expect(r.draft.status).toBe('building');
    });
  });
});
