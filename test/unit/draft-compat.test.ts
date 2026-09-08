/**
 * A draft written by 0.2.x (no provider, no url/deezerTrackId on tracks, a
 * rules array, seeds without labels) must keep loading, rendering, exporting,
 * editing and publishing under the current version. The fixture is a
 * checked-in file so a type change that breaks old drafts fails here.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const home = await fs.mkdtemp(path.join(os.tmpdir(), 'lineupify-compat-'));
process.env.LINEUPIFY_HOME = home;
process.env.LINEUPIFY_LOG = 'error';

const fixture = path.resolve(import.meta.dirname, '..', 'fixtures', 'drafts', 'd_02xok.json');
const ID = 'd_02xok';

const { ensureDirs, paths } = await import('../../src/infra/store.js');
const { loadDraft, hasPendingWork } = await import('../../src/engine/draft.js');
const { summary, tracksView, artistsView, unresolvedView } = await import('../../src/engine/render.js');
const { parsePlaylistRef, readPlaylist } = await import('../../src/engine/playlists.js');
const { assertPublishable } = await import('../../src/tools/playlist.js');
const drafts = await import('../../src/tools/drafts.js');

const textOf = (r: { content: { type: string; text?: string }[] }) => r.content.map((c) => c.text ?? '').join('\n');

beforeAll(async () => {
  await ensureDirs();
  await fs.copyFile(fixture, paths.draft(ID));
});
afterAll(async () => {
  await fs.rm(home, { recursive: true, force: true }).catch(() => undefined);
});

describe('a 0.2.x draft under the current version', () => {
  it('loads with the Spotify provider implied and nothing pending', async () => {
    const d = (await loadDraft(ID))!;
    expect(d).toBeTruthy();
    expect(d.provider).toBeUndefined();
    expect(hasPendingWork(d)).toBe(false);
    expect(() => assertPublishable(d)).not.toThrow();
  });

  it('renders every view, including the seed without a label and the failed seed', async () => {
    const d = (await loadDraft(ID))!;
    const s = summary(d, { connectedAs: 'Alex' });
    expect(s).toContain('provider spotify');
    expect(s).toContain('spotify: Alex');
    expect(s).toContain('Seed similar_to "Fred again.." → 1 artists');
    expect(s).toContain('Seed genre "zzz nothing": FAILED');
    expect(s).toContain('Tracks 4');
    expect(s).toContain('via isrc 3 / text 1');
    expect(s).toContain('sources dz 3 / lfm 1 / sp 0');
    expect(s).toContain('Published: https://open.spotify.com/playlist/3cEYpjA9oz9GiPac4AsH4n');
    expect(s).toContain('Not found on Deezer or Spotify (1): DJ Fluffhead');
    const t = tracksView(d, 0, 50);
    expect(t).toContain('t_c81z  #2   Wet Leg – Chaise Longue');
    expect(t).toContain('2022?');
    expect(t).toContain('143bpm');
    expect(t).toContain('[feat]');
    expect(artistsView(d, 0, 50)).toContain('from similar_to "Fred again.."');
    expect(unresolvedView(d)).toContain('DJ Fluffhead: not found in Deezer, Last.fm or Spotify');
  });

  it('exports with Spotify links derived from the id when the track has no url', async () => {
    const links = textOf(await drafts.exportDraft({ draftId: ID, format: 'links' })).split('\n');
    expect(links).toEqual([
      'https://open.spotify.com/track/2xLMifQCjDGFmkHkpNLD9h',
      'https://open.spotify.com/track/6Ow4v1Ejf9DdDp1QsHqHUp',
      'https://open.spotify.com/track/0KKkJNfGyhkQ5aFogxQAPU',
      'https://open.spotify.com/track/1Fid2jjqsHViMjXuiUTIQ4',
    ]);
    const csv = textOf(await drafts.exportDraft({ draftId: ID, format: 'csv' }));
    expect(csv).toContain('"spotify","spotify:track:2xLMifQCjDGFmkHkpNLD9h","https://open.spotify.com/track/2xLMifQCjDGFmkHkpNLD9h"');
    const m3u = textOf(await drafts.exportDraft({ draftId: ID, format: 'm3u' }));
    expect(m3u).toContain("#EXTINF:292,Fred again.. - Marea (we've lost dancing)");
  });

  it('reads as a playlist source and can still be edited with undo', async () => {
    const snap = await readPlaylist(parsePlaylistRef(ID));
    expect(snap.source).toBe('draft');
    expect(snap.tracks.map((t) => t.artists[0])).toEqual(['Fred again..', 'Wet Leg', 'Fred again..', 'Fred again..']);
    expect(snap.tracks[0]!.uri).toBe('spotify:track:2xLMifQCjDGFmkHkpNLD9h');

    const r = await drafts.editDraft({ draftId: ID, expectedRevision: 2, ops: [{ op: 'remove_tracks', ids: ['t_9x1c'] }, { op: 'set_meta', name: 'Renamed' }] });
    expect(textOf(r)).toContain('rev 3');
    const after = (await loadDraft(ID))!;
    expect(after.tracks.length).toBe(3);
    expect(after.name).toBe('Renamed');
    const undo = await drafts.editDraft({ draftId: ID, ops: [{ op: 'undo' }] });
    expect(textOf(undo)).toContain('rev 4');
    const back = (await loadDraft(ID))!;
    expect(back.tracks.length).toBe(4);
    expect(back.name).toBe('Sunfall 2026 · Lineupify');
    expect(back.playlistId).toBe('3cEYpjA9oz9GiPac4AsH4n');
  });

  it('is listed with its published flag', async () => {
    expect(textOf(await drafts.listDraftsTool())).toMatch(new RegExp(`${ID}\\s+ready\\s+4\\s+.*"Sunfall 2026 · Lineupify"\\s+yes`));
  });
});
