/**
 * Cover detection (skipCovers). Two checks: a free local one across the
 * artists in the draft (another artist's own top track has the same title
 * and is far more popular), then a Deezer title search for the tracks that
 * survive, cached per title+artist. Off by default; precision is decent but
 * an obscure original can lose to a famous cover.
 */
import type { Candidate, Draft, DraftTrack } from '../types.js';
import { coverCache } from '../infra/cache.js';
import { log } from '../infra/log.js';
import { fold, stripTitleDecorations, titleKey } from './normalize.js';
import { isAbort } from './resolve.js';
import { mapLimit } from './seeds.js';
import * as deezer from '../sources/deezer.js';

const LOCAL_RATIO = 2;
const REMOTE_RATIO = 3;
/** When our own popularity is unknown and we are not among the top hits, a hit this popular marks a cover. */
const REMOTE_ABSOLUTE = 200_000;

/** Pure: track ids whose title is a lead track of another, clearly more popular artist in the same draft. */
export function findLocalCovers(tracks: DraftTrack[], candidatesByArtist: Map<string, Candidate[]>, artistNames: Map<string, string>): Set<string> {
  const covers = new Set<string>();
  const index = new Map<string, { artistKey: string; rank: number }[]>();
  for (const [artistKey, cands] of candidatesByArtist) {
    for (const c of cands) {
      if (c.role !== 'lead') continue;
      const k = titleKey(c.titleShort || c.title);
      if (!k) continue;
      const list = index.get(k) ?? [];
      list.push({ artistKey, rank: c.deezerRank ?? 0 });
      index.set(k, list);
    }
  }
  for (const t of tracks) {
    const k = titleKey(t.name);
    const others = (index.get(k) ?? []).filter((x) => x.artistKey !== t.artistKey);
    if (!others.length) continue;
    const ours = t.rank ?? 0;
    const myName = fold(artistNames.get(t.artistKey) ?? '');
    const best = Math.max(...others.map((o) => o.rank));
    if (best > Math.max(1, ours) * LOCAL_RATIO && !t.artists.some((a) => others.some((o) => fold(artistNames.get(o.artistKey) ?? '') === fold(a) && fold(a) === myName))) covers.add(t.id);
  }
  return covers;
}

/** Deezer check: is there a much more popular recording of this title by someone else? */
export async function isCoverOnDeezer(track: DraftTrack, artistName: string, signal?: AbortSignal): Promise<boolean> {
  const key = `${titleKey(track.name)}|${fold(artistName)}`;
  const cached = await coverCache.get(key);
  if (cached !== undefined) return cached;
  let result = false;
  try {
    const hits = await deezer.searchTracksByTitle(stripTitleDecorations(track.name), 10, signal);
    const same = hits.filter((h) => titleKey(h.titleShort) === titleKey(track.name));
    const mine = (name: string) => fold(name) === fold(artistName) || track.artists.some((a) => fold(a) === fold(name));
    const top = same[0];
    const ours = same.find((h) => mine(h.artistName));
    if (top && !mine(top.artistName)) {
      const ourRank = ours?.rank ?? track.rank;
      result = ourRank ? top.rank > Math.max(1, ourRank) * REMOTE_RATIO : top.rank > REMOTE_ABSOLUTE;
    }
  } catch (err) {
    if (isAbort(err)) throw err;
    log.info(`cover check failed for ${track.name}`, String(err));
    return false;
  }
  await coverCache.set(key, result);
  return result;
}

/** Remove covers from a built draft. Returns descriptions of what was dropped. */
export async function dropCovers(draft: Draft, candidatesByArtist: Map<string, Candidate[]>, signal?: AbortSignal, maxRemote = 150): Promise<string[]> {
  const names = new Map(draft.artists.map((a) => [a.key, a.resolved?.name ?? a.name]));
  const local = findLocalCovers(draft.tracks, candidatesByArtist, names);
  const dropped: string[] = [];
  const keep: DraftTrack[] = [];
  const toCheck: DraftTrack[] = [];
  for (const t of draft.tracks) {
    if (local.has(t.id)) dropped.push(`${names.get(t.artistKey) ?? t.artists[0]} – ${t.name} (another artist in this draft has the original)`);
    else if (toCheck.length < maxRemote) toCheck.push(t);
    else keep.push(t);
  }
  const verdicts = await mapLimit(toCheck, 3, (t) => isCoverOnDeezer(t, names.get(t.artistKey) ?? t.artists[0] ?? '', signal));
  toCheck.forEach((t, i) => {
    if (verdicts[i]) dropped.push(`${names.get(t.artistKey) ?? t.artists[0]} – ${t.name} (a more popular recording by someone else exists)`);
    else keep.push(t);
  });
  const keepIds = new Set(keep.map((t) => t.id));
  draft.tracks = draft.tracks.filter((t) => keepIds.has(t.id));
  return dropped;
}
