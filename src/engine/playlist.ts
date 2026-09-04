/**
 * Publish a draft to Spotify. The playlist id is persisted before any track is
 * added, adds go in chunks of 100 with a checkpoint per chunk, a bad URI in a
 * chunk is isolated by bisection, and the final count is verified with retries
 * because playlist reads are eventually consistent.
 */
import type { Draft } from '../types.js';
import { LineupifyError } from '../types.js';
import { log } from '../infra/log.js';
import { sleep } from '../infra/http.js';
import { saveDraft } from './draft.js';
import * as spotify from '../sources/spotify.js';

const CHUNK = 100;

export interface PublishResult {
  playlistId: string;
  url: string;
  added: number;
  skipped: string[];
  verifiedTotal?: number;
}

function chunks<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function addWithBisect(playlistId: string, uris: string[], skipped: string[], replaceFirst: boolean): Promise<string> {
  try {
    return replaceFirst ? await spotify.replaceItems(playlistId, uris) : await spotify.addItems(playlistId, uris);
  } catch (err) {
    if (!(err instanceof LineupifyError) || err.status !== 400) throw err;
    if (uris.length === 1) {
      skipped.push(uris[0]!);
      log.info(`skipping bad uri ${uris[0]}`);
      return replaceFirst ? await spotify.replaceItems(playlistId, []) : '';
    }
    const mid = Math.floor(uris.length / 2);
    const s1 = await addWithBisect(playlistId, uris.slice(0, mid), skipped, replaceFirst);
    const s2 = await addWithBisect(playlistId, uris.slice(mid), skipped, false);
    return s2 || s1;
  }
}

async function verifyCount(playlistId: string, expected: number): Promise<number | undefined> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const st = await spotify.playlistState(playlistId);
      if (st.total === expected) return st.total;
      if (attempt < 2) await sleep(1500 * (attempt + 1));
      else return st.total;
    } catch (err) {
      log.info('verify read failed', String(err));
      if (attempt === 2) return undefined;
    }
  }
  return undefined;
}

export async function publishNew(draft: Draft): Promise<PublishResult> {
  const uris = draft.tracks.map((t) => t.uri);
  if (!uris.length) throw new LineupifyError('DRAFT_EMPTY', 'The draft has no tracks to publish.');

  let playlistId = draft.playlistId;
  let url = draft.playlistUrl ?? '';
  if (!playlistId || !draft.commit) {
    const created = await spotify.createPlaylist(draft.name, draft.description || defaultDescription(draft), draft.public);
    playlistId = created.id;
    url = created.url;
    draft.playlistId = playlistId;
    draft.playlistUrl = url;
    draft.commit = { chunkIndex: -1, total: uris.length };
    await saveDraft(draft);
  }
  return addAll(draft, playlistId, url, uris, false);
}

async function addAll(draft: Draft, playlistId: string, url: string, uris: string[], replaceFirst: boolean): Promise<PublishResult> {
  const skipped: string[] = [];
  const parts = chunks(uris, CHUNK);
  let snapshot = '';
  const start = (draft.commit?.chunkIndex ?? -1) + 1;
  for (let i = start; i < parts.length; i++) {
    snapshot = await addWithBisect(playlistId, parts[i]!, skipped, replaceFirst && i === 0);
    draft.commit = { chunkIndex: i, total: uris.length };
    await saveDraft(draft);
  }
  if (replaceFirst && parts.length === 0) snapshot = await spotify.replaceItems(playlistId, []);
  const added = uris.length - skipped.length;
  const verifiedTotal = await verifyCount(playlistId, added);
  draft.snapshotId = snapshot || (await spotify.playlistState(playlistId).then((s) => s.snapshotId).catch(() => ''));
  draft.commit = undefined;
  draft.playlistUrl = url;
  await saveDraft(draft, { bump: true });
  return { playlistId, url, added, skipped, verifiedTotal };
}

export async function updateExisting(draft: Draft, force: boolean): Promise<PublishResult> {
  if (!draft.playlistId) throw new LineupifyError('NO_PLAYLIST', 'This draft has not been published yet.', 'Use create_playlist.');
  let state;
  try {
    state = await spotify.playlistState(draft.playlistId);
  } catch (err) {
    if (err instanceof LineupifyError && (err.status === 404 || err.status === 403)) {
      throw new LineupifyError('PLAYLIST_GONE', 'The playlist no longer exists or is not editable by this account.', 'Call create_playlist with mode "new" to publish a fresh playlist.');
    }
    throw err;
  }
  if (!force && draft.snapshotId && state.snapshotId && state.snapshotId !== draft.snapshotId) {
    throw new LineupifyError('PLAYLIST_EDITED_IN_SPOTIFY', `The playlist "${state.name}" was changed in Spotify since Lineupify last wrote it (${state.total} tracks there now).`, 'Ask the user whether to overwrite it; then call update_playlist with force: true.');
  }
  await spotify.changePlaylistDetails(draft.playlistId, { name: draft.name.slice(0, 100), description: (draft.description || defaultDescription(draft)).slice(0, 300), public: draft.public });
  draft.commit = { chunkIndex: -1, total: draft.tracks.length };
  await saveDraft(draft);
  return addAll(draft, draft.playlistId, state.url, draft.tracks.map((t) => t.uri), true);
}

export function defaultDescription(draft: Draft): string {
  const n = draft.artists.filter((a) => a.status === 'resolved').length;
  return `${n} artists, ${draft.tracks.length} tracks. Built with Lineupify.`;
}
