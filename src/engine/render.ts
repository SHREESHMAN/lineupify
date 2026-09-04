/**
 * Compact, fixed-layout text views of a draft. All external strings pass
 * through `clean` so poster text or a track title can never inject a line of
 * its own.
 */
import type { Draft, DraftArtist } from '../types.js';
import { clean, fmtDuration, pad } from '../infra/text.js';
import { totalDurationMs } from './draft.js';
import { describeFilters } from './filters.js';
import { seedLabel } from './seeds.js';

export function statusWord(d: Draft): string {
  return d.status;
}

export function summary(d: Draft, opts: { connectedAs?: string } = {}): string {
  const live = d.artists.filter((a) => a.status !== 'excluded');
  const resolved = live.filter((a) => a.status === 'resolved').length;
  const unresolved = live.filter((a) => a.status === 'unresolved');
  const pending = live.filter((a) => a.status === 'pending').length;
  const low = live.filter((a) => a.resolved?.confidence === 'low').length;
  const explicit = d.tracks.filter((t) => t.explicit).length;
  const viaIsrc = d.tracks.filter((t) => t.matchedVia === 'isrc').length;
  const viaText = d.tracks.filter((t) => t.matchedVia === 'text').length;
  const provider = d.provider ?? 'spotify';
  const bySource = { deezer: 0, lastfm: 0, spotify: 0, manual: 0 };
  for (const t of d.tracks) bySource[t.source]++;
  const tierCounts = (['headliner', 'sub', 'undercard', 'flat'] as const)
    .map((tier) => {
      const arts = live.filter((a) => a.tier === tier);
      if (!arts.length) return undefined;
      const target = Math.max(...arts.map((a) => a.target));
      return `${tier} ${arts.length}×${target}`;
    })
    .filter(Boolean)
    .join(' · ');

  const lines: string[] = [];
  lines.push(`Draft ${d.id} "${clean(d.name, 60)}"  rev ${d.revision}  status ${d.status}  provider ${provider}${opts.connectedAs && provider === 'spotify' ? `  spotify: ${clean(opts.connectedAs, 30)}` : ''}${provider === 'deezer' ? '  (no login; export instead of publish)' : ''}`);
  const seeds = d.seeds ?? [];
  if (d.status === 'building') {
    const seedsDone = seeds.filter((s) => s.status !== 'pending').length;
    const phase = seeds.length && seedsDone < seeds.length ? `expanding seeds ${seedsDone}/${seeds.length} · ` : d.excludeTracks && !d.excludeTracks.resolved ? 'reading playlists to exclude · ' : '';
    lines.push(`building ${phase}${d.progress.done}/${d.progress.total} artists · ${d.tracks.length} tracks so far · ${unresolved.length} unresolved so far · call get_draft with waitSeconds: 25`);
    return lines.join('\n');
  }
  if (d.error) lines.push(`error: ${clean(d.error, 200)}`);
  for (const s of seeds) {
    lines.push(s.status === 'failed' ? `Seed ${clean(seedLabel(s), 60)}: FAILED — ${clean(s.error ?? 'no artists', 120)}` : `Seed ${clean(seedLabel(s), 60)} → ${s.added ?? 0} artists (${clean(s.note ?? '', 120)})`);
  }
  const filters = describeFilters(d.options);
  if (filters.length) lines.push(`Filters: ${filters.join(' · ')}`);
  if (d.excludeTracks?.resolved) lines.push(`Excluded tracks from: ${clean(d.excludeTracks.note ?? '', 160)} (${d.excludeTracks.uris.length + d.excludeTracks.isrcs.length} identifiers)`);
  for (const n of d.buildNotes ?? []) lines.push(clean(n, 400));
  lines.push(`Artists ${live.length} (resolved ${resolved} · unresolved ${unresolved.length}${pending ? ` · pending ${pending}` : ''}${low ? ` · low-confidence ${low}` : ''})`);
  const via = provider === 'deezer' ? `on deezer ${d.tracks.filter((t) => t.matchedVia === 'deezer').length}` : `via isrc ${viaIsrc} / text ${viaText}`;
  lines.push(`Tracks ${d.tracks.length} · ${fmtDuration(totalDurationMs(d))} · explicit ${explicit} · ${via} · sources dz ${bySource.deezer} / lfm ${bySource.lastfm} / sp ${bySource.spotify}${bySource.manual ? ` / manual ${bySource.manual}` : ''}`);
  lines.push(`Tiers ${tierCounts || 'flat'} · order ${d.options.order} · ${d.public ? 'public' : 'private'}${d.options.excludeExplicit ? ' · clean only' : ''}`);
  if (d.playlistId) lines.push(`Published: ${d.playlistUrl ?? d.playlistId}`);
  const report = notFoundReport(d);
  if (report) lines.push(report);
  lines.push(nextHint(d));
  return lines.join('\n');
}

/**
 * Artists the playlist is missing: not found anywhere, or found but with no
 * playable Spotify track. Ends with what the user can do about it. Empty
 * string when everything resolved.
 */
export function notFoundReport(d: Draft): string {
  const live = d.artists.filter((a) => a.status !== 'excluded');
  const unresolved = live.filter((a) => a.status === 'unresolved');
  const counts = new Map<string, number>();
  for (const t of d.tracks) counts.set(t.artistKey, (counts.get(t.artistKey) ?? 0) + 1);
  const noTracks = live.filter((a) => a.status === 'resolved' && a.target > 0 && !(counts.get(a.key) ?? 0));
  if (!unresolved.length && !noTracks.length) return '';
  const lines: string[] = [];
  if (unresolved.length) lines.push(`Not found on Deezer or Spotify (${unresolved.length}): ${unresolved.map((a) => clean(a.name, 40)).join(', ')}`);
  const where = (d.provider ?? 'spotify') === 'deezer' ? 'Found, but no track passed the filters on Deezer' : "Found, but no playable track on Spotify in this account's market";
  if (noTracks.length) lines.push(`${where} (${noTracks.length}): ${noTracks.map((a) => clean(a.name, 40)).join(', ')}`);
  lines.push(
    'To add them anyway, tell the assistant: "add <song> by <artist>" (a Spotify track link works best, or use search_tracks), ' +
      '"use this Spotify artist for <name>: <artist link>" (set_artist_source), or "drop <name>" (exclude_artist). ' +
      'A misspelt name is fixed by creating a new draft with the corrected spelling.',
  );
  return lines.join('\n');
}

export function nextHint(d: Draft): string {
  if (d.status === 'building') return 'Next: get_draft with waitSeconds: 25 until status is ready.';
  if (d.status === 'paused') return 'Next: fix the error above (connect / wait for quota), then get_draft to resume the build.';
  if (d.status === 'failed') return 'Next: create_draft again, or edit_draft to work with what was built.';
  if (d.playlistId) return 'Next: edit_draft to change, then update_playlist to push changes to Spotify.';
  const unresolved = d.artists.filter((a) => a.status === 'unresolved').length;
  const publish = (d.provider ?? 'spotify') === 'deezer' ? 'export_draft (format links or m3u) to take the list to Deezer; Deezer drafts cannot be published directly' : 'create_playlist with confirm: true to publish';
  return `Next: get_draft view=tracks to review${unresolved ? ', get_draft view=unresolved for misses' : ''}, edit_draft to change, ${publish}.`;
}

export function tracksView(d: Draft, offset: number, limit: number): string {
  const artistName = new Map(d.artists.map((a) => [a.key, a.name]));
  const slice = d.tracks.slice(offset, offset + limit);
  const lines: string[] = [];
  lines.push(`Tracks ${offset + 1}-${offset + slice.length} of ${d.tracks.length} (rev ${d.revision}). Columns: id  #  artist – title  length  source/match`);
  slice.forEach((t, i) => {
    const idx = offset + i + 1;
    const flags = [t.explicit ? 'E' : '', t.isVersion ? 'v' : '', t.role === 'featured' ? 'feat' : ''].filter(Boolean).join(',');
    const extra = [t.year ? `${t.year}${t.yearUncertain ? '?' : ''}` : '', t.bpm ? `${Math.round(t.bpm)}bpm` : ''].filter(Boolean).join(' ');
    lines.push(`${t.id}  #${pad(String(idx), 3)} ${clean(artistName.get(t.artistKey) ?? t.artists[0], 28)} – ${clean(t.name, 48)}  ${fmtDuration(t.durationMs)}  ${srcAbbr(t.source)}/${t.matchedVia}${flags ? ` [${flags}]` : ''}${extra ? `  ${extra}` : ''}`);
  });
  if (offset + slice.length < d.tracks.length) lines.push(`… ${d.tracks.length - offset - slice.length} more: get_draft view=tracks offset=${offset + slice.length}`);
  return lines.join('\n');
}

function srcAbbr(s: string): string {
  return { deezer: 'dz', lastfm: 'lfm', spotify: 'sp', manual: 'man' }[s] ?? s;
}

export function artistsView(d: Draft, offset: number, limit: number): string {
  const counts = new Map<string, number>();
  for (const t of d.tracks) counts.set(t.artistKey, (counts.get(t.artistKey) ?? 0) + 1);
  const slice = d.artists.slice(offset, offset + limit);
  const lines: string[] = [];
  lines.push(`Artists ${offset + 1}-${offset + slice.length} of ${d.artists.length}. Columns: name  tier  status  tracks/target  source  notes`);
  for (const a of slice) {
    const notes = [
      a.resolved?.confidence === 'low' ? 'low-confidence' : '',
      a.resolved && a.resolved.name && a.resolved.name.toLowerCase() !== a.name.toLowerCase() ? `matched "${clean(a.resolved.name, 30)}"` : '',
      a.allowedVersions ? 'versions allowed' : '',
      a.known === true ? 'known' : a.known === false ? 'new' : '',
      a.day ? a.day : '',
      a.stage ? clean(a.stage, 20) : '',
      a.origin ? `from ${clean(a.origin, 40)}` : '',
    ]
      .filter(Boolean)
      .join(', ');
    lines.push(`${clean(a.name, 30)}  ${a.tier}  ${a.status}  ${counts.get(a.key) ?? 0}/${a.target}  ${a.resolved?.source ?? '-'}${notes ? `  ${notes}` : ''}`);
  }
  if (offset + slice.length < d.artists.length) lines.push(`… ${d.artists.length - offset - slice.length} more: get_draft view=artists offset=${offset + slice.length}`);
  return lines.join('\n');
}

export function unresolvedView(d: Draft): string {
  const list = d.artists.filter((a) => a.status === 'unresolved' || a.resolved?.confidence === 'low');
  const failedSeeds = (d.seeds ?? []).filter((s) => s.status === 'failed');
  if (!list.length && !failedSeeds.length) return 'All artists resolved with high confidence.';
  const lines = [`${list.length} artists need attention:`];
  for (const s of failedSeeds) lines.push(`- seed ${clean(seedLabel(s), 60)} failed: ${clean(s.error ?? 'no artists', 160)}`);
  for (const a of list) {
    if (a.status === 'unresolved') {
      lines.push(`- ${clean(a.name, 40)}: ${clean(a.reason ?? 'not found', 80)}${a.queriesTried?.length ? ` (tried ${a.queriesTried.map((q) => clean(q, 30)).join(', ')})` : ''}`);
    } else {
      lines.push(`- ${clean(a.name, 40)}: low confidence, matched "${clean(a.resolved?.name, 40)}" (${a.resolved?.source}${a.resolved?.nbFan !== undefined ? `, ${a.resolved.nbFan} fans` : ''})`);
    }
  }
  lines.push('Fix with edit_draft: exclude_artist, set_artist_source (deezerId or spotifyArtistId), or add_track for specific songs. Retry a spelling by creating a new draft with the corrected name.');
  return lines.join('\n');
}

export function artistLine(a: DraftArtist): string {
  return `${clean(a.name, 40)} (${a.tier}, ${a.status})`;
}
