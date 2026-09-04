/** search_tracks, create_playlist, update_playlist, compare_taste */
import { LineupifyError } from '../types.js';
import { clean, fmtDuration } from '../infra/text.js';
import { isRunning } from '../engine/jobs.js';
import { publishNew, updateExisting } from '../engine/playlist.js';
import { compareTaste } from '../engine/taste.js';
import { notFoundReport, summary } from '../engine/render.js';
import { applyOrder } from '../engine/draft.js';
import * as spotify from '../sources/spotify.js';
import { ensureNotLockedElsewhere, ensureWritesAllowed, getDraft, persist, text } from './shared.js';

export async function searchTracks(args: { query: string; limit?: number }) {
  const q = clean(args.query, 120);
  if (!q) throw new LineupifyError('BAD_QUERY', 'query is empty.');
  const hits = await spotify.searchTracks(q, Math.min(10, Math.max(1, args.limit ?? 5)));
  if (!hits.length) return text(`No Spotify tracks for "${q}". Try "track:<title> artist:<name>" filters.`);
  const lines = [`${hits.length} results for "${q}". Columns: uri  artist – title  album  length`];
  for (const h of hits) lines.push(`${h.uri}  ${clean(h.artists.map((a) => a.name).join(', '), 40)} – ${clean(h.name, 50)}  ${clean(h.albumName, 30)}  ${fmtDuration(h.durationMs)}${h.explicit ? ' [E]' : ''}${h.isPlayable ? '' : ' [unavailable]'}`);
  lines.push('Next: edit_draft with add_track using a uri above.');
  return text(lines.join('\n'));
}

export async function createPlaylist(args: { draftId: string; confirm?: boolean; allowPartial?: boolean; mode?: 'new' }) {
  ensureWritesAllowed('create_playlist');
  await ensureNotLockedElsewhere(args.draftId);
  const d = await getDraft(args.draftId);
  if (isRunning(d.id) || d.status === 'building') {
    if (!args.allowPartial) throw new LineupifyError('DRAFT_BUILDING', `Draft is still building (${d.progress.done}/${d.progress.total} artists).`, 'Call get_draft with waitSeconds: 25 until ready, or pass allowPartial: true to publish what exists now.');
  }
  if (d.status === 'paused' && !args.allowPartial) throw new LineupifyError('DRAFT_PAUSED', `Build is paused: ${d.error ?? ''}`, 'Resolve the issue and call get_draft to resume, or pass allowPartial: true.');
  if (!d.tracks.length) throw new LineupifyError('DRAFT_EMPTY', 'The draft has no tracks.');
  const missing = d.artists.filter((a) => a.status === 'unresolved');
  if (d.options.stopIfUnresolved && missing.length && !args.allowPartial) {
    throw new LineupifyError(
      'UNRESOLVED_ARTISTS',
      `stopIfUnresolved is on and ${missing.length} artist${missing.length === 1 ? ' was' : 's were'} not found: ${missing.map((a) => clean(a.name, 40)).join(', ')}.`,
      'Fix them first (edit_draft add_track with a Spotify link, set_artist_source, or exclude_artist; or a new draft with corrected spelling), then publish. Pass allowPartial: true to publish without them.',
    );
  }
  if (!d.viewedAt && !args.confirm) throw new LineupifyError('CONFIRM_REQUIRED', 'This draft has not been reviewed yet.', 'Show the user the summary (get_draft) or pass confirm: true if they asked to publish without review.');
  if (d.playlistId && args.mode !== 'new') {
    throw new LineupifyError('ALREADY_PUBLISHED', `This draft is already published at ${d.playlistUrl ?? d.playlistId}.`, 'Use update_playlist to push changes, or create_playlist with mode: "new" for a second playlist.');
  }
  const tokens = await spotify.getAccessToken();
  if (d.spotifyUserId && tokens.userId !== d.spotifyUserId) {
    throw new LineupifyError('SPOTIFY_USER_MISMATCH', `Draft was built for Spotify user ${d.spotifyUserId}; ${tokens.userId} is connected.`, 'Reconnect the original account or create a new draft.');
  }
  if (args.mode === 'new') {
    d.playlistId = undefined;
    d.playlistUrl = undefined;
    d.snapshotId = undefined;
    d.commit = undefined;
  }
  const r = await publishNew(d);
  const lines = [`Created playlist "${clean(d.name, 60)}" with ${r.added} tracks (${fmtDuration(d.tracks.reduce((s, t) => s + t.durationMs, 0))}).`, `URL: ${r.url}`];
  if (r.skipped.length) lines.push(`Skipped ${r.skipped.length} URIs Spotify rejected: ${r.skipped.slice(0, 5).join(', ')}`);
  if (r.verifiedTotal !== undefined && r.verifiedTotal !== r.added) lines.push(`Note: Spotify reports ${r.verifiedTotal} tracks (expected ${r.added}); playlist reads can lag a few seconds.`);
  const report = notFoundReport(d);
  if (report) lines.push('', report);
  lines.push('Next: share the URL. Later edits: edit_draft then update_playlist.');
  return text(lines.join('\n'));
}

export async function updatePlaylist(args: { draftId: string; force?: boolean }) {
  ensureWritesAllowed('update_playlist');
  await ensureNotLockedElsewhere(args.draftId);
  const d = await getDraft(args.draftId);
  if (isRunning(d.id) || d.status === 'building') throw new LineupifyError('DRAFT_BUILDING', 'Draft is still building.', 'Wait for get_draft to report ready.');
  if (!d.playlistId) throw new LineupifyError('NO_PLAYLIST', 'This draft has not been published.', 'Use create_playlist.');
  const r = await updateExisting(d, !!args.force);
  const lines = [`Updated playlist "${clean(d.name, 60)}": now ${r.added} tracks.`, `URL: ${r.url}`];
  if (r.skipped.length) lines.push(`Skipped ${r.skipped.length} URIs Spotify rejected.`);
  const report = notFoundReport(d);
  if (report) lines.push('', report);
  return text(lines.join('\n'));
}

export async function compareTasteTool(args: { draftId: string; reorderKnownFirst?: boolean }) {
  const d = await getDraft(args.draftId);
  const r = await compareTaste(d);
  if (args.reorderKnownFirst && d.status !== 'building') applyOrder(d, 'known_first');
  await persist(d, !!args.reorderKnownFirst);
  const lines = [
    `Compared against ${r.topCount} top artists and ${r.followingCount} followed artists.`,
    `Known (${r.known.length}): ${r.known.slice(0, 25).map((n) => clean(n, 30)).join(', ')}${r.known.length > 25 ? ' …' : ''}`,
    `New to you (${r.fresh.length}): ${r.fresh.slice(0, 25).map((n) => clean(n, 30)).join(', ')}${r.fresh.length > 25 ? ' …' : ''}`,
  ];
  if (r.unresolved.length) lines.push(`Not matched on Spotify (${r.unresolved.length}): ${r.unresolved.slice(0, 10).map((n) => clean(n, 30)).join(', ')}`);
  lines.push(args.reorderKnownFirst ? 'Draft reordered: known artists first.' : 'Next: edit_draft reorder mode known_first to put familiar artists first, or create a discoveryOnly draft to skip them.');
  lines.push('', summary(d));
  return text(lines.join('\n'));
}
