/**
 * Offline end-to-end: create_draft -> background job -> get_draft -> edit ->
 * create_playlist, with Deezer and Spotify mocked at the module boundary.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import type { Candidate, SpotifyTrack, Tokens } from '../../src/types.js';

const home = await fs.mkdtemp(path.join(os.tmpdir(), 'lineupify-flow-'));
process.env.LINEUPIFY_HOME = home;
process.env.LINEUPIFY_LOG = 'error';

const tokens: Tokens = {
  clientId: 'a'.repeat(32),
  accessToken: 'at',
  refreshToken: 'rt',
  expiresAt: Date.now() + 3600_000,
  authorizedAt: new Date().toISOString(),
  scope: '',
  userId: 'user1',
  displayName: 'Tester',
};

function track(id: string, name: string, artists: { id: string; name: string }[], extra: Partial<SpotifyTrack> = {}): SpotifyTrack {
  return { uri: `spotify:track:${id}`, id, name, artists, albumName: 'Album', albumType: 'album', releaseDate: '2020-01-01', trackNumber: 1, durationMs: 200_000, explicit: false, isPlayable: true, ...extra };
}

const catalog: Record<string, SpotifyTrack> = {
  ISRC0000001: track('t1'.padEnd(22, '1'), 'Marea', [{ id: 'fred', name: 'Fred again..' }], { isrc: 'GBAHS2100041' }),
  ISRC0000002: track('t2'.padEnd(22, '2'), 'Talk of the Town', [{ id: 'fred', name: 'Fred again..' }, { id: 'sammy', name: 'Sammy Virji' }], { isrc: 'GBAHS2501582' }),
  ISRC0000003: track('t3'.padEnd(22, '3'), 'Chaise Longue', [{ id: 'wet', name: 'Wet Leg' }], { isrc: 'GBCEL2100271', explicit: true }),
  ISRC0000004: track('t4'.padEnd(22, '4'), 'Wet Dream', [{ id: 'wet', name: 'Wet Leg' }], { isrc: 'GBCEL2100272' }),
  ISRC0000005: track('t5'.padEnd(22, '5'), 'Baby Ride', [{ id: 'skr', name: 'Skrillex' }], { isrc: 'US0000000005' }),
  ISRC0000006: track('t6'.padEnd(22, '6'), 'Baby Again', [{ id: 'ft', name: 'Four Tet' }, { id: 'fred', name: 'Fred again..' }], { isrc: 'US0000000006' }),
  ISRC0000007: track('t7'.padEnd(22, '7'), 'Rumble', [{ id: 'skr', name: 'Skrillex' }], { isrc: 'US0000000007' }),
};
const byIsrc: Record<string, SpotifyTrack> = {};
for (const t of Object.values(catalog)) byIsrc[t.isrc!] = t;

const playlistCalls: { created: { name: string; isPublic: boolean }[]; added: string[][]; replaced: string[][] } = { created: [], added: [], replaced: [] };
let loggedOut = false;

vi.mock('../../src/sources/spotify.js', () => ({
  SPOTIFY_API_SNAPSHOT: 'test',
  SCOPES: [],
  loadTokens: async () => (loggedOut ? undefined : tokens),
  getAccessToken: async () => tokens,
  clearTokens: async () => {
    loggedOut = true;
  },
  cancelPendingAuth: () => undefined,
  refreshTokenAge: () => ({ daysUsed: 1, daysLeft: 180, expiresAt: new Date() }),
  pendingAuth: () => undefined,
  pendingAuthResult: () => undefined,
  me: async () => ({ id: 'user1', displayName: 'Tester' }),
  searchByIsrc: async (isrc: string) => (byIsrc[isrc] ? [byIsrc[isrc]!] : []),
  searchTracks: async (q: string) => {
    const m = q.match(/track:(.+?) artist:(.+)/);
    if (!m) return [];
    return Object.values(catalog).filter((t) => t.name.toLowerCase().startsWith(m[1]!.toLowerCase().trim()));
  },
  searchArtists: async () => [],
  artistAlbums: async () => [],
  albumTracks: async () => [],
  track: async (id: string) => Object.values(catalog).find((t) => t.id === id),
  topArtists: async () => [{ id: 'fred', name: 'Fred again..' }],
  followedArtists: async () => [{ id: 'wet', name: 'Wet Leg' }],
  createPlaylist: async (name: string, _d: string, isPublic: boolean) => {
    playlistCalls.created.push({ name, isPublic });
    return { id: 'pl1', url: 'https://open.spotify.com/playlist/pl1' };
  },
  changePlaylistDetails: async () => undefined,
  addItems: async (_id: string, uris: string[]) => {
    playlistCalls.added.push(uris);
    return 'snap1';
  },
  replaceItems: async (_id: string, uris: string[]) => {
    playlistCalls.replaced.push(uris);
    return 'snap2';
  },
  playlistState: async () => ({ snapshotId: playlistCalls.replaced.length ? 'snap2' : 'snap1', total: playlistCalls.replaced.length ? playlistCalls.replaced[0]!.length : playlistCalls.added.flat().length, name: 'x', url: 'https://open.spotify.com/playlist/pl1' }),
  playlistInfo: async (id: string) => ({ id, name: 'Source list', description: '', public: true, ownerId: 'user1', ownerName: 'Tester', snapshotId: 'src1', total: 2, url: `https://open.spotify.com/playlist/${id}` }),
  playlistItems: async () => ({ tracks: [{ track: catalog.ISRC0000001!, addedAt: '2026-01-01T00:00:00Z' }, { track: catalog.ISRC0000003!, addedAt: '2026-01-02T00:00:00Z' }], total: 2, truncated: false }),
  savedTracks: async () => ({ tracks: [{ track: catalog.ISRC0000002! }], total: 1, truncated: false }),
  myPlaylists: async () => [{ id: SRC_ID, name: 'Source list', ownerId: 'user1', total: 2 }],
}));
const SRC_ID = 'plsrc'.padEnd(22, '0');
const SRC_URL = `https://open.spotify.com/playlist/${SRC_ID}`;

const deezerArtists: Record<string, { id: number; name: string; nbFan: number }[]> = {
  'fred again..': [{ id: 1, name: 'Fred again..', nbFan: 100_000 }],
  'wet leg (dj set)': [],
  'wet leg': [{ id: 2, name: 'Wet Leg', nbFan: 60_000 }],
  skrillex: [{ id: 3, name: 'Skrillex', nbFan: 3_000_000 }],
  'four tet': [{ id: 4, name: 'Four Tet', nbFan: 400_000 }],
  'skrillex b2b four tet': [],
  'nobody famous': [],
};
function cand(deezerTrackId: number, title: string, lead: { id: number; name: string }, artistId: number, extra: Partial<Candidate> = {}): Candidate {
  return { source: 'deezer', title, titleShort: title, titleVersion: '', leadArtist: lead.name, leadArtistId: String(lead.id), contributors: [lead.name], role: lead.id === artistId ? 'lead' : 'featured', rank: deezerTrackId, deezerTrackId, ...extra };
}
const deezerTops: Record<number, Candidate[]> = {
  1: [cand(101, 'Marea', { id: 1, name: 'Fred again..' }, 1), cand(102, 'Talk of the Town', { id: 1, name: 'Fred again..' }, 1), cand(106, 'Baby Again', { id: 4, name: 'Four Tet' }, 1)],
  2: [cand(103, 'Chaise Longue', { id: 2, name: 'Wet Leg' }, 2, { explicit: true }), cand(104, 'Wet Dream', { id: 2, name: 'Wet Leg' }, 2), cand(107, 'Chaise Longue (Live)', { id: 2, name: 'Wet Leg' }, 2, { titleVersion: '(Live)' })],
  3: [cand(105, 'Baby Ride', { id: 3, name: 'Skrillex' }, 3)],
  4: [cand(106, 'Baby Again', { id: 4, name: 'Four Tet' }, 4)],
};
const deezerIsrc: Record<number, string> = { 101: 'GBAHS2100041', 102: 'GBAHS2501582', 103: 'GBCEL2100271', 104: 'GBCEL2100272', 105: 'US0000000005', 106: 'US0000000006', 107: 'GBCEL2100999' };

vi.mock('../../src/sources/deezer.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/sources/deezer.js')>();
  return {
    ...orig,
    searchArtists: async (q: string) => deezerArtists[q.toLowerCase()] ?? [],
    artistTopTracks: async (id: number) => (deezerTops[id] ?? []).map((c) => ({ ...c })),
    trackDetails: async (id: number) => ({ isrc: deezerIsrc[id], bpm: id === 101 ? 172 : id === 102 ? 120 : null }),
    relatedArtists: async (id: number) => (id === 1 ? [{ id: 2, name: 'Wet Leg', nbFan: 60_000 }, { id: 3, name: 'Skrillex', nbFan: 3_000_000 }] : []),
    chartArtists: async () => [{ id: 4, name: 'Four Tet', nbFan: 400_000 }],
    searchPlaylists: async () => [],
    playlistTracks: async () => ({ tracks: [], total: 0 }),
    searchTracksByTitle: async () => [],
    trackByIsrc: async () => undefined,
    genres: async () => [],
    artistAlbumGenres: async () => [],
  };
});
const playlistTools = await import('../../src/tools/playlists.js');

const drafts = await import('../../src/tools/drafts.js');
const playlist = await import('../../src/tools/playlist.js');
const jobs = await import('../../src/engine/jobs.js');
const { loadDraft } = await import('../../src/engine/draft.js');

function textOf(r: { content: { type: string; text?: string }[]; isError?: boolean }): string {
  return r.content.map((c) => c.text ?? '').join('\n');
}

let draftId = '';

beforeAll(async () => {
  await (await import('../../src/infra/store.js')).ensureDirs();
});
afterAll(async () => {
  await jobs.abortAllJobs();
  await fs.rm(home, { recursive: true, force: true }).catch(() => undefined);
});

describe('build -> review -> edit -> publish', () => {
  it('creates a draft, resolves artists, splits b2b and dedupes the collab', async () => {
    const r = await drafts.createDraft({
      lineup: 'Test Fest 2026',
      artists: [
        { name: 'Fred again..', tier: 'headliner' },
        { name: 'Wet Leg (DJ set)', tier: 'sub' },
        { name: 'Skrillex b2b Four Tet', tier: 'undercard' },
        { name: 'Nobody Famous', tier: 'undercard' },
      ],
      tracksPerTier: { headliner: 3, sub: 2, undercard: 1 },
    });
    const out = textOf(r);
    expect(r.isError).toBeFalsy();
    const m = out.match(/Draft (d_[a-z0-9]+)/);
    expect(m).toBeTruthy();
    draftId = m![1]!;
    await jobs.waitForJob(draftId, 10_000);
    const d = (await loadDraft(draftId))!;
    expect(d.status).toBe('ready');
    const names = d.artists.map((a) => a.name);
    expect(names).toContain('Skrillex');
    expect(names).toContain('Four Tet');
    expect(names).not.toContain('Skrillex b2b Four Tet');
    const nobody = d.artists.find((a) => a.name === 'Nobody Famous')!;
    expect(nobody.status).toBe('unresolved');
    // Fred gets Marea + Talk of the Town (lead) and Baby Again would be featured; Four Tet claims Baby Again as lead.
    const uris = d.tracks.map((t) => t.uri);
    expect(new Set(uris).size).toBe(uris.length);
    const fourTet = d.artists.find((a) => a.name === 'Four Tet')!;
    expect(d.tracks.filter((t) => t.artistKey === fourTet.key).map((t) => t.name)).toEqual(['Baby Again']);
    const fred = d.artists.find((a) => a.name === 'Fred again..')!;
    expect(d.tracks.filter((t) => t.artistKey === fred.key).map((t) => t.name).sort()).toEqual(['Marea', 'Talk of the Town']);
    const wet = d.artists.find((a) => a.name.startsWith('Wet Leg'))!;
    const wetTracks = d.tracks.filter((t) => t.artistKey === wet.key);
    expect(wetTracks.map((t) => t.name).sort()).toEqual(['Chaise Longue', 'Wet Dream']);
    expect(wetTracks.some((t) => t.isVersion)).toBe(false);
  });

  it('get_draft views and marks viewed', async () => {
    const s = textOf(await drafts.getDraftTool({ draftId }));
    expect(s).toContain('status ready');
    const t = textOf(await drafts.getDraftTool({ draftId, view: 'tracks' }));
    expect(t).toMatch(/t_[a-z0-9]{4}\s+#1/);
    const u = textOf(await drafts.getDraftTool({ draftId, view: 'unresolved' }));
    expect(u).toContain('Nobody Famous');
    const d = (await loadDraft(draftId))!;
    expect(d.viewedAt).toBeTruthy();
  });

  it('edit_draft rejects stale revision and applies ops', async () => {
    const d0 = (await loadDraft(draftId))!;
    await expect(drafts.editDraft({ draftId, expectedRevision: d0.revision + 5, ops: [{ op: 'shuffle', seed: 1 }] })).rejects.toMatchObject({ code: 'STALE_REVISION' });

    const first = d0.tracks[0]!;
    const r = await drafts.editDraft({ draftId, expectedRevision: d0.revision, ops: [{ op: 'remove_tracks', ids: [first.id] }, { op: 'filter', explicit: true }, { op: 'set_meta', name: 'My <b>Fest</b>', public: true }] });
    expect(r.isError).toBeFalsy();
    const d1 = (await loadDraft(draftId))!;
    expect(d1.revision).toBe(d0.revision + 1);
    expect(d1.tracks.find((t) => t.id === first.id)).toBeUndefined();
    expect(d1.tracks.some((t) => t.explicit)).toBe(false);
    expect(d1.name).toBe('My <b>Fest</b>'.slice(0, 100));
    expect(d1.public).toBe(true);

    const undo = await drafts.editDraft({ draftId, ops: [{ op: 'undo' }] });
    expect(undo.isError).toBeFalsy();
    const d2 = (await loadDraft(draftId))!;
    expect(d2.tracks.find((t) => t.id === first.id)).toBeTruthy();
    expect(d2.public).toBe(false);
  });

  it('add_track by URI and set_artist_track_count up triggers refetch', async () => {
    const before = (await loadDraft(draftId))!;
    const r = await drafts.editDraft({ draftId, ops: [{ op: 'add_track', track: `https://open.spotify.com/track/${catalog.ISRC0000007!.id}`, position: 1 }] });
    expect(r.isError).toBeFalsy();
    const d = (await loadDraft(draftId))!;
    expect(d.tracks.length).toBe(before.tracks.length + 1);
    expect(d.tracks[0]!.name).toBe('Rumble');
    expect(d.tracks[0]!.matchedVia).toBe('manual');
  });

  it('compare_taste marks known artists', async () => {
    const r = await playlist.compareTasteTool({ draftId });
    const s = textOf(r);
    expect(s).toMatch(/Known \(\d+\): .*Fred again/);
    expect(s).toMatch(/Known \(\d+\): .*Wet Leg/);
  });

  it('create_playlist publishes, refuses a second time, update_playlist replaces', async () => {
    const r = await playlist.createPlaylist({ draftId });
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toContain('https://open.spotify.com/playlist/pl1');
    expect(playlistCalls.created.length).toBe(1);
    const d = (await loadDraft(draftId))!;
    expect(d.playlistId).toBe('pl1');
    expect(playlistCalls.added.flat().length).toBe(d.tracks.length);

    await expect(playlist.createPlaylist({ draftId })).rejects.toMatchObject({ code: 'ALREADY_PUBLISHED' });

    await drafts.editDraft({ draftId, ops: [{ op: 'remove_tracks', indexes: [1] }] });
    const u = await playlist.updatePlaylist({ draftId });
    expect(u.isError).toBeFalsy();
    expect(playlistCalls.replaced[0]!.length).toBe(d.tracks.length - 1);
  });

  it('export_draft returns csv and saves only under exports/', async () => {
    const csv = textOf(await drafts.exportDraft({ draftId, format: 'csv' }));
    expect(csv.split('\n')[0]).toContain('spotify_uri');
    const saved = textOf(await drafts.exportDraft({ draftId, format: 'm3u', save: true }));
    expect(saved).toContain(path.join(home, 'exports'));
    await expect(drafts.exportDraft({ draftId, format: 'm3u', save: true })).rejects.toMatchObject({ code: 'FILE_EXISTS' });
  });

  it('list_drafts and delete_draft', async () => {
    expect(textOf(await drafts.listDraftsTool())).toContain(draftId);
    expect(textOf(await drafts.deleteDraftTool({ draftId }))).toContain('Deleted');
    expect(await loadDraft(draftId)).toBeUndefined();
  });
});

async function built(r: { content: { type: string; text?: string }[]; isError?: boolean }) {
  expect(r.isError).toBeFalsy();
  const id = textOf(r).match(/Draft (d_[a-z0-9]+)/)![1]!;
  await jobs.waitForJob(id, 10_000);
  return (await loadDraft(id))!;
}

describe('seeds, exclusions and filters', () => {
  it('similar_to seed expands to related artists and never the seed itself', async () => {
    const d = await built(await drafts.createDraft({ seeds: [{ type: 'similar_to', value: 'Fred again..' }], tracksPerArtist: 1 }));
    expect(d.status).toBe('ready');
    expect(d.seeds![0]).toMatchObject({ status: 'done', added: 2 });
    expect(d.artists.map((a) => a.name).sort()).toEqual(['Skrillex', 'Wet Leg']);
    expect(d.artists.every((a) => a.origin === 'similar_to "Fred again.."')).toBe(true);
    expect(d.name).toBe('Like Fred again.. · Lineupify');
    expect(d.tracks.length).toBe(2);
    const s = textOf(await drafts.getDraftTool({ draftId: d.id }));
    expect(s).toContain('Seed similar_to "Fred again.." → 2 artists');
  });

  it('a failing seed is reported and the draft fails only when nothing is left', async () => {
    const d = await built(await drafts.createDraft({ seeds: [{ type: 'similar_to', value: 'Nobody Famous' }] }));
    expect(d.status).toBe('failed');
    expect(d.error).toContain('NO_ARTISTS_FROM_SEEDS');
    expect(d.seeds![0]!.status).toBe('failed');
    const u = textOf(await drafts.getDraftTool({ draftId: d.id, view: 'unresolved' }));
    expect(u).toContain('seed similar_to "Nobody Famous" failed');
    const mixed = await built(await drafts.createDraft({ artists: ['Wet Leg'], seeds: [{ type: 'similar_to', value: 'Nobody Famous' }], tracksPerArtist: 1 }));
    expect(mixed.status).toBe('ready');
    expect(mixed.tracks.length).toBe(1);
  });

  it('excludeTracksFrom skips tracks already in the playlist', async () => {
    const d = await built(await drafts.createDraft({ artists: ['Fred again..'], tracksPerArtist: 3, excludeTracksFrom: [SRC_URL] }));
    expect(d.status).toBe('ready');
    expect(d.excludeTracks).toMatchObject({ resolved: true });
    expect(d.excludeTracks!.uris).toContain(catalog.ISRC0000001!.uri);
    expect(d.tracks.map((t) => t.name)).not.toContain('Marea');
    expect(d.tracks.map((t) => t.name)).toContain('Talk of the Town');
    expect(textOf(await drafts.getDraftTool({ draftId: d.id }))).toContain('Excluded tracks from: Source list (2 tracks)');
  });

  it('yearRange and bpmRange filter matched tracks', async () => {
    const old = await built(await drafts.createDraft({ artists: ['Wet Leg'], yearRange: { from: 2021 } }));
    expect(old.tracks.length).toBe(0);
    const ok = await built(await drafts.createDraft({ artists: ['Wet Leg'], yearRange: { from: 2019, to: 2020 } }));
    expect(ok.tracks.length).toBe(2);
    expect(ok.tracks[0]!.year).toBe(2020);
    const fast = await built(await drafts.createDraft({ artists: ['Fred again..'], tracksPerArtist: 3, bpmRange: { min: 160, max: 180 }, strictBpm: true }));
    expect(fast.tracks.map((t) => t.name)).toEqual(['Marea']);
    expect(fast.tracks[0]!.bpm).toBe(172);
    expect(textOf(await drafts.getDraftTool({ draftId: fast.id, view: 'tracks' }))).toContain('172bpm');
  });

  it('read_playlist, compare_playlists and merge_playlists work on a Spotify playlist', async () => {
    const r = textOf(await playlistTools.readPlaylistTool({ playlist: SRC_URL, view: 'tracks' }));
    expect(r).toContain('Playlist "Source list" by Tester (spotify) · 2 tracks');
    expect(r).toContain('Marea');
    const byName = textOf(await playlistTools.readPlaylistTool({ playlist: 'source list' }));
    expect(byName).toContain('Artists (2)');

    const c = textOf(await playlistTools.comparePlaylistsTool({ sources: [SRC_URL, 'me'] }));
    expect(c).toContain('your listening history (0 tracks, 2 artists)');
    expect(c).toContain('Shared by all — artists (2): Fred again.., Wet Leg');
    expect(c).toContain('artist overlap 100% (2 shared, 0 identical tracks)');

    const m = textOf(await playlistTools.mergePlaylistsTool({ playlists: [SRC_URL, SRC_URL, 'library'], name: 'Merged' }));
    expect(m).toContain('status ready');
    const id = m.match(/Draft (d_[a-z0-9]+)/)![1]!;
    const d = (await loadDraft(id))!;
    expect(d.tracks.map((t) => t.name)).toEqual(['Marea', 'Chaise Longue', 'Talk of the Town']);
    expect(d.buildNotes![0]).toContain('2 duplicates removed');
    const pub = await playlist.createPlaylist({ draftId: id, confirm: true });
    expect(pub.isError).toBeFalsy();
  });

  it('expand_playlist and refresh_taste are create_draft shortcuts', async () => {
    const e = await built(await playlistTools.expandPlaylistTool({ playlist: SRC_URL, tracksPerArtist: 2 }));
    expect(e.status).toBe('ready');
    expect(e.seeds![0]).toMatchObject({ type: 'playlist', status: 'done' });
    expect(e.artists.map((a) => a.name).sort()).toEqual(['Fred again..', 'Wet Leg']);
    expect(e.tracks.map((t) => t.name)).not.toContain('Marea');
    expect(e.tracks.map((t) => t.name)).not.toContain('Chaise Longue');
    expect(e.tracks.map((t) => t.name).sort()).toEqual(['Baby Again', 'Talk of the Town', 'Wet Dream']);

    const t = await built(await playlistTools.refreshTasteTool({ tracksPerArtist: 3 }));
    expect(t.status).toBe('ready');
    expect(t.seeds![0]).toMatchObject({ type: 'taste', status: 'done' });
    expect(t.artists.map((a) => a.name).sort()).toEqual(['Fred again..', 'Wet Leg']);
    expect(t.tracks.map((t2) => t2.name)).not.toContain('Talk of the Town');
    expect(t.name).toBe('Fresh from your favourites · Lineupify');
  });
});

describe('safety switches', () => {
  it('LINEUPIFY_READ_ONLY blocks publishing but not building or exporting', async () => {
    const d = await built(await drafts.createDraft({ artists: ['Wet Leg'], tracksPerArtist: 1 }));
    process.env.LINEUPIFY_READ_ONLY = '1';
    process.env.LINEUPIFY_NO_UPDATE_CHECK = '1';
    try {
      await expect(playlist.createPlaylist({ draftId: d.id, confirm: true })).rejects.toMatchObject({ code: 'READ_ONLY_MODE' });
      await expect(playlist.updatePlaylist({ draftId: d.id })).rejects.toMatchObject({ code: 'READ_ONLY_MODE' });
      expect(textOf(await drafts.exportDraft({ draftId: d.id, format: 'csv' }))).toContain('spotify_uri');
      const connect = await import('../../src/tools/connect.js');
      expect(textOf(await connect.status())).toContain('read-only');
    } finally {
      delete process.env.LINEUPIFY_READ_ONLY;
    }
  });

  it('disconnect forgets the login and points to Spotify for revocation; purge removes the data folder', async () => {
    const connect = await import('../../src/tools/connect.js');
    const out = textOf(await connect.disconnect({}));
    expect(out).toContain('Forgot the Spotify login for Tester');
    expect(out).toContain('https://www.spotify.com/account/apps/');
    expect(out).toContain('Kept: config, caches, drafts and exports');
    expect(await fs.stat(path.join(home, 'drafts')).then(() => true, () => false)).toBe(true);
    const purged = textOf(await connect.disconnect({ purge: true }));
    expect(purged).toContain('No Spotify login was saved');
    expect(purged).toContain(`Deleted ${home}`);
    expect(await fs.stat(home).then(() => true, () => false)).toBe(false);
  });
});
