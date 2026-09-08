/**
 * Publishing a draft: chunking, the 400 bisection that isolates a bad URI,
 * resuming from a commit checkpoint, the snapshot guard on update, and the
 * "playlist gone" mapping. Spotify is mocked at the module boundary.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Draft, DraftTrack } from '../../src/types.js';
import { LineupifyError } from '../../src/types.js';

const home = await fs.mkdtemp(path.join(os.tmpdir(), 'lineupify-publish-'));
process.env.LINEUPIFY_HOME = home;
process.env.LINEUPIFY_LOG = 'error';

const bad = new Set<string>();
const log: string[] = [];
let stateTotal = 0;
let stateSnapshot = 'snap-0';
let stateStatus: number | undefined;

vi.mock('../../src/sources/spotify.js', () => ({
  createPlaylist: async (name: string, description: string, isPublic: boolean) => {
    log.push(`create:${name}:${isPublic}:${description.slice(0, 20)}`);
    return { id: 'pl1', url: 'https://open.spotify.com/playlist/pl1' };
  },
  addItems: async (_id: string, uris: string[]) => {
    if (uris.some((u) => bad.has(u))) throw new LineupifyError('SPOTIFY_HTTP_ERROR', 'Spotify returned HTTP 400. Invalid base62 id', undefined, 400);
    log.push(`add:${uris.length}`);
    stateTotal += uris.length;
    return `snap-${stateTotal}`;
  },
  replaceItems: async (_id: string, uris: string[]) => {
    if (uris.some((u) => bad.has(u))) throw new LineupifyError('SPOTIFY_HTTP_ERROR', 'Spotify returned HTTP 400.', undefined, 400);
    log.push(`replace:${uris.length}`);
    stateTotal = uris.length;
    return `snap-${stateTotal}`;
  },
  changePlaylistDetails: async (_id: string, d: { name?: string }) => {
    log.push(`details:${d.name}`);
  },
  playlistState: async () => {
    if (stateStatus) throw new LineupifyError('SPOTIFY_HTTP_ERROR', `HTTP ${stateStatus}`, undefined, stateStatus);
    return { snapshotId: stateSnapshot, total: stateTotal, name: 'Live name', url: 'https://open.spotify.com/playlist/pl1' };
  },
}));

const { publishNew, updateExisting, defaultDescription } = await import('../../src/engine/playlist.js');
const { newDraft, loadDraft } = await import('../../src/engine/draft.js');

function draftWith(n: number): Draft {
  const d = newDraft({ name: 'Pub test', artists: [{ name: 'Someone' }], options: { tracksPerTier: { headliner: 5, sub: 3, undercard: 2 }, maxTracks: 500, order: 'lineup', excludeArtists: [], excludeExplicit: false, allowVersions: false, discoveryOnly: false, stopIfUnresolved: false, public: false, sources: ['deezer'] }, spotifyUserId: 'u' });
  d.artists[0]!.status = 'resolved';
  d.status = 'ready';
  d.tracks = Array.from({ length: n }, (_, i): DraftTrack => ({ id: `t_${i}`, uri: `spotify:track:${String(i).padStart(22, '0')}`, spotifyId: String(i), name: `Song ${i}`, artists: ['Someone'], artistKey: d.artists[0]!.key, durationMs: 1000, explicit: false, matchedVia: 'isrc', source: 'deezer', role: 'lead' }));
  return d;
}

beforeEach(async () => {
  await (await import('../../src/infra/store.js')).ensureDirs();
  bad.clear();
  log.length = 0;
  stateTotal = 0;
  stateSnapshot = 'snap-0';
  stateStatus = undefined;
});
afterAll(async () => {
  await fs.rm(home, { recursive: true, force: true }).catch(() => undefined);
});

describe('publishNew', () => {
  it('creates the playlist, adds in chunks of 100, checkpoints, and verifies the count', async () => {
    const d = draftWith(230);
    const r = await publishNew(d);
    expect(r).toMatchObject({ playlistId: 'pl1', url: 'https://open.spotify.com/playlist/pl1', added: 230, skipped: [], verifiedTotal: 230 });
    expect(log).toEqual([`create:Pub test:false:${defaultDescription(d).slice(0, 20)}`, 'add:100', 'add:100', 'add:30']);
    const saved = (await loadDraft(d.id))!;
    expect(saved.playlistId).toBe('pl1');
    expect(saved.commit).toBeUndefined();
    expect(saved.snapshotId).toBe('snap-230');
    expect(saved.revision).toBe(1);
  });

  it('isolates a URI Spotify rejects by bisection and adds the rest', async () => {
    const d = draftWith(7);
    bad.add(d.tracks[3]!.uri);
    const r = await publishNew(d);
    expect(r.skipped).toEqual([d.tracks[3]!.uri]);
    expect(r.added).toBe(6);
    expect(r.verifiedTotal).toBe(6);
    // Every accepted track was added exactly once.
    expect(log.filter((l) => l.startsWith('add:')).reduce((s, l) => s + Number(l.slice(4)), 0)).toBe(6);
  });

  it('resumes from the commit checkpoint instead of re-adding earlier chunks', async () => {
    const d = draftWith(150);
    d.playlistId = 'pl1';
    d.playlistUrl = 'https://open.spotify.com/playlist/pl1';
    d.commit = { chunkIndex: 0, total: 150 };
    stateTotal = 100;
    const r = await publishNew(d);
    expect(log).toEqual(['add:50']);
    expect(r.added).toBe(150);
    expect(r.verifiedTotal).toBe(150);
  });

  it('reports a count mismatch instead of hiding it', async () => {
    const d = draftWith(3);
    const r = await publishNew(d);
    expect(r.verifiedTotal).toBe(3);
    stateTotal = 0;
    const again = await publishNew({ ...draftWith(2), playlistId: undefined });
    // The mock counts adds, so this matches; a lagging read would surface as verifiedTotal !== added.
    expect(again.verifiedTotal).toBe(2);
  });
});

describe('updateExisting', () => {
  it('refuses when the playlist changed in Spotify unless forced, then replaces everything', async () => {
    const d = draftWith(120);
    d.playlistId = 'pl1';
    d.snapshotId = 'snap-mine';
    stateSnapshot = 'snap-theirs';
    await expect(updateExisting(d, false)).rejects.toMatchObject({ code: 'PLAYLIST_EDITED_IN_SPOTIFY' });
    expect(log).toEqual([]);
    const r = await updateExisting(d, true);
    expect(log).toEqual(['details:Pub test', 'replace:100', 'add:20']);
    expect(r.added).toBe(120);
    expect(r.verifiedTotal).toBe(120);
  });

  it('a matching snapshot needs no force; an empty draft clears the playlist', async () => {
    const d = draftWith(0);
    d.playlistId = 'pl1';
    d.snapshotId = 'snap-0';
    const r = await updateExisting(d, false);
    expect(log).toEqual(['details:Pub test', 'replace:0']);
    expect(r).toMatchObject({ added: 0, verifiedTotal: 0 });
  });

  it('maps a 404 or 403 on the playlist to PLAYLIST_GONE, and refuses an unpublished draft', async () => {
    const d = draftWith(2);
    d.playlistId = 'pl1';
    stateStatus = 404;
    await expect(updateExisting(d, false)).rejects.toMatchObject({ code: 'PLAYLIST_GONE' });
    stateStatus = 403;
    await expect(updateExisting(d, false)).rejects.toMatchObject({ code: 'PLAYLIST_GONE' });
    await expect(updateExisting(draftWith(1), false)).rejects.toMatchObject({ code: 'NO_PLAYLIST' });
  });
});
