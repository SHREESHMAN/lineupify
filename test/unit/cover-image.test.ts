/**
 * Playlist cover upload: the JPEG/size gate, the guards around it, and the
 * request Spotify actually receives (raw base64 body, image/jpeg content type).
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Draft } from '../../src/types.js';

const home = await fs.mkdtemp(path.join(os.tmpdir(), 'lineupify-cover-'));
process.env.LINEUPIFY_HOME = home;
process.env.LINEUPIFY_LOG = 'error';

const uploads: { playlistId: string; payload: string }[] = [];

vi.mock('../../src/sources/spotify.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/sources/spotify.js')>();
  return {
    ...orig,
    loadTokens: async () => ({ clientId: 'a'.repeat(32), accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3600_000, authorizedAt: new Date().toISOString(), scope: orig.SCOPES.join(' '), userId: 'u', displayName: 'U' }),
    setPlaylistImage: async (playlistId: string, payload: string) => {
      uploads.push({ playlistId, payload });
    },
  };
});

const playlist = await import('../../src/tools/playlist.js');
const { newDraft, saveDraft } = await import('../../src/engine/draft.js');
const spotify = await import('../../src/sources/spotify.js');

const textOf = (r: { content: { type: string; text?: string }[] }) => r.content.map((c) => c.text ?? '').join('\n');
const JPEG = (bytes = 64) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(Math.max(0, bytes - 4), 0x20)]);

async function published(provider: 'spotify' | 'deezer' = 'spotify', withPlaylist = true): Promise<Draft> {
  const d = newDraft({
    name: 'Cover test',
    artists: [{ name: 'Someone' }],
    options: { tracksPerTier: { headliner: 5, sub: 3, undercard: 2 }, maxTracks: 50, order: 'lineup', excludeArtists: [], excludeExplicit: false, allowVersions: false, discoveryOnly: false, stopIfUnresolved: false, public: false, sources: ['deezer'] },
    spotifyUserId: 'u',
    provider,
  });
  d.status = 'ready';
  if (withPlaylist) {
    d.playlistId = 'pl1';
    d.playlistUrl = 'https://open.spotify.com/playlist/pl1';
  }
  await saveDraft(d);
  return d;
}

beforeEach(async () => {
  await (await import('../../src/infra/store.js')).ensureDirs();
  uploads.length = 0;
  delete process.env.LINEUPIFY_READ_ONLY;
});
afterAll(async () => {
  await fs.rm(home, { recursive: true, force: true }).catch(() => undefined);
});

describe('jpegCoverPayload', () => {
  it('accepts a JPEG and returns its base64', () => {
    const bytes = JPEG(100);
    expect(playlist.jpegCoverPayload(bytes, 'a.jpg')).toBe(bytes.toString('base64'));
  });

  it('rejects anything that is not a JPEG, however it is named', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(() => playlist.jpegCoverPayload(png, 'cover.jpg')).toThrow(/JPEG/);
    try {
      playlist.jpegCoverPayload(png, 'cover.jpg');
    } catch (err) {
      expect(err).toMatchObject({ code: 'IMAGE_NOT_JPEG' });
      expect((err as { hint: string }).hint).toContain('renamed .png will not work');
    }
    // A file too short to even hold the magic bytes is rejected, not read out of bounds.
    expect(() => playlist.jpegCoverPayload(Buffer.alloc(2), 'tiny.jpg')).toThrow(/JPEG/);
  });

  it('rejects an image whose base64 body exceeds Spotify cap', () => {
    // The cap is on the base64 payload, so the file ceiling is about three quarters of it.
    const tooBig = JPEG(Math.ceil((spotify.MAX_COVER_BASE64 * 3) / 4) + 1024);
    expect(() => playlist.jpegCoverPayload(tooBig, 'big.jpg')).toThrow(/limit/);
    try {
      playlist.jpegCoverPayload(tooBig, 'big.jpg');
    } catch (err) {
      expect(err).toMatchObject({ code: 'IMAGE_TOO_LARGE' });
    }
    // Just under the cap still passes.
    const justUnder = JPEG(Math.floor((spotify.MAX_COVER_BASE64 * 3) / 4) - 16);
    expect(playlist.jpegCoverPayload(justUnder, 'ok.jpg').length).toBeLessThanOrEqual(spotify.MAX_COVER_BASE64);
  });
});

describe('set_playlist_image', () => {
  it('uploads the file as raw base64 and says where it landed', async () => {
    const d = await published();
    const file = path.join(home, 'cover.jpg');
    const bytes = JPEG(256);
    await fs.writeFile(file, bytes);
    const out = textOf(await playlist.setPlaylistImage({ draftId: d.id, imagePath: file }));
    expect(uploads).toEqual([{ playlistId: 'pl1', payload: bytes.toString('base64') }]);
    expect(out).toContain('Cover set on "Cover test"');
    expect(out).toContain('https://open.spotify.com/playlist/pl1');
  });

  it('explains that a chat image has to be saved first when the path is not a file', async () => {
    const d = await published();
    const err = await playlist.setPlaylistImage({ draftId: d.id, imagePath: path.join(home, 'nope.jpg') }).catch((e) => e);
    expect(err).toMatchObject({ code: 'IMAGE_NOT_FOUND' });
    expect(err.hint).toContain('save it first');
    expect(uploads).toEqual([]);
  });

  it('refuses an unpublished draft, a Deezer draft, and read-only mode', async () => {
    const unpublished = await published('spotify', false);
    await expect(playlist.setPlaylistImage({ draftId: unpublished.id, imagePath: 'x.jpg' })).rejects.toMatchObject({ code: 'NO_PLAYLIST' });

    const dz = await published('deezer');
    await expect(playlist.setPlaylistImage({ draftId: dz.id, imagePath: 'x.jpg' })).rejects.toMatchObject({ code: 'PROVIDER_NO_PUBLISH' });

    const d = await published();
    process.env.LINEUPIFY_READ_ONLY = '1';
    try {
      await expect(playlist.setPlaylistImage({ draftId: d.id, imagePath: 'x.jpg' })).rejects.toMatchObject({ code: 'READ_ONLY_MODE' });
    } finally {
      delete process.env.LINEUPIFY_READ_ONLY;
    }
    expect(uploads).toEqual([]);
  });
});

describe('the image-upload scope', () => {
  it('is requested at login, so status can tell older logins to reconnect', () => {
    expect(spotify.SCOPES).toContain('ugc-image-upload');
  });
});
