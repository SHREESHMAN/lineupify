/**
 * Song-level similarity: "songs like these, by other artists". Two open
 * sources are merged: Last.fm track.getSimilar (co-listening, needs the key)
 * and ListenBrainz similar recordings (open session data, keyless). Each seed
 * song's neighbours are scored, songs found by both sources rank higher, and
 * the result is grouped by artist with the songs pinned so the build fetches
 * exactly those instead of the artist's top tracks.
 */
import type { Candidate, SeedSpec, SpotifyTrack } from '../types.js';
import { LineupifyError } from '../types.js';
import { log } from '../infra/log.js';
import { clean } from '../infra/text.js';
import { fold, stripTitleDecorations } from './normalize.js';
import { isAbort } from './resolve.js';
import { songKey } from './select.js';
import * as lastfm from '../sources/lastfm.js';
import * as lb from '../sources/listenbrainz.js';

export type SimilarSource = 'lastfm' | 'listenbrainz';

export interface SimilarSong {
  title: string;
  artist: string;
  /** Combined 0..~2.25 score; higher is closer. */
  score: number;
  sources: SimilarSource[];
  mbid?: string;
}

export interface SimilarList {
  source: SimilarSource;
  songs: { title: string; artist: string; score: number; mbid?: string }[];
}

/** Per-source max similar songs for one seed song. */
export const SIMILAR_MAX_PER_SONG = 100;
export const SIMILAR_DEFAULT_PER_SONG = 25;
const MAX_SEED_SONGS = 10;
const BOTH_SOURCES_BONUS = 0.25;

/**
 * Pure: merge the lists for one seed song. Each list is taken in its own
 * order (both sources already sort by closeness) and a song's contribution
 * is 1 / (1 + position / 10), so the two sources weigh the same however
 * their raw scores are scaled. Contributions are summed per song and songs
 * present in both lists get a bonus. Ties keep the earlier position.
 */
export function mergeSimilarSongs(lists: SimilarList[]): SimilarSong[] {
  const m = new Map<string, SimilarSong & { order: number }>();
  let order = 0;
  for (const list of lists) {
    const sorted = [...list.songs].sort((a, b) => b.score - a.score);
    for (const [i, s] of sorted.entries()) {
      const title = stripTitleDecorations(s.title) || s.title;
      const key = songKey(title, s.artist);
      if (!key || !fold(s.artist)) continue;
      const norm = 1 / (1 + i / 10);
      const cur = m.get(key);
      if (cur) {
        cur.score += norm;
        if (!cur.sources.includes(list.source)) cur.sources.push(list.source);
        cur.mbid = cur.mbid ?? s.mbid;
      } else m.set(key, { title: s.title, artist: s.artist, score: norm, sources: [list.source], mbid: s.mbid, order: order++ });
    }
  }
  const out = [...m.values()].map((s) => ({ ...s, score: s.score + (s.sources.length > 1 ? BOTH_SOURCES_BONUS : 0) }));
  out.sort((a, b) => b.score - a.score || a.order - b.order);
  return out.map(({ order: _o, ...s }) => s);
}

/**
 * Pure: the lead artist of a credit string. Similarity sources return
 * "Tanishk Bagchi, Arijit Singh & Asees Kaur" or "A feat. B" as one artist;
 * the draft groups by the first name and keeps the rest as contributors.
 */
export function leadOfCredit(credit: string): { lead: string; all: string[] } {
  const all = credit
    .split(/\s*(?:,|&|\+|;|\/|\bfeat\.?|\bft\.?|\bfeaturing|\bwith|\bx\b|\bvs\.?)\s*/i)
    .map((s) => s.trim())
    .filter(Boolean);
  return { lead: all[0] ?? credit.trim(), all: all.length ? all : [credit.trim()] };
}

/** Pure: union across seed songs (a song near two seeds counts twice), then group by artist in rank order. */
export function groupByArtist(songs: SimilarSong[], perArtistCap?: number): { name: string; weight: number; candidates: Candidate[] }[] {
  const groups = new Map<string, { name: string; weight: number; candidates: Candidate[]; keys: Set<string> }>();
  let rank = 0;
  for (const s of songs) {
    const { lead, all } = leadOfCredit(s.artist);
    const k = fold(lead);
    if (!k) continue;
    const g = groups.get(k) ?? { name: lead, weight: 0, candidates: [], keys: new Set<string>() };
    const key = songKey(s.title, lead);
    if (g.keys.has(key)) continue;
    if (perArtistCap !== undefined && g.candidates.length >= perArtistCap) continue;
    g.keys.add(key);
    g.weight += s.score;
    g.candidates.push({
      source: s.sources.includes('lastfm') ? 'lastfm' : 'listenbrainz',
      title: s.title,
      titleShort: stripTitleDecorations(s.title) || s.title,
      titleVersion: '',
      leadArtist: lead,
      contributors: all,
      role: 'lead',
      rank: rank++,
    });
    groups.set(k, g);
  }
  return [...groups.values()].map(({ keys: _k, ...g }) => g);
}

export interface SimilarContext {
  lastfmApiKey?: string;
  signal?: AbortSignal;
  /** Resolves a user reference (link, URI, "Artist - Title") to a track on the draft's provider. */
  lookupTrack: (ref: string) => Promise<SpotifyTrack | undefined>;
  excludeSeedSongs?: boolean;
  excludeSeedArtists?: boolean;
  tracksPerArtist?: number;
}

export interface SeedSong {
  ref: string;
  title: string;
  artist: string;
  uri?: string;
  isrc?: string;
  key: string;
}

export interface SimilarSeedResult {
  artists: { name: string; weight: number }[];
  /** Pinned candidates per folded artist name. */
  pinned: Record<string, Candidate[]>;
  seedSongs: SeedSong[];
  note: string;
}

function seedRefs(seed: SeedSpec): string[] {
  const refs = [seed.value ?? '', ...(seed.songs ?? [])].map((s) => clean(s, 200)).filter(Boolean);
  return [...new Set(refs)].slice(0, MAX_SEED_SONGS);
}

/** One seed song's neighbours from both sources. Never throws for a source that is down; returns what it got. */
async function neighboursOf(song: SeedSong, limit: number, ctx: SimilarContext): Promise<{ lists: SimilarList[]; notes: string[] }> {
  const lists: SimilarList[] = [];
  const notes: string[] = [];
  if (ctx.lastfmApiKey) {
    try {
      const sim = await lastfm.similarTracks(ctx.lastfmApiKey, song.artist, song.title, Math.min(SIMILAR_MAX_PER_SONG, limit * 2), ctx.signal);
      if (sim.length) lists.push({ source: 'lastfm', songs: sim.map((s) => ({ title: s.title, artist: s.artist, score: s.match, mbid: s.mbid })) });
      notes.push(`Last.fm ${sim.length}`);
    } catch (err) {
      if (isAbort(err)) throw err;
      log.info('lastfm similar tracks failed', String(err));
      notes.push('Last.fm error');
    }
  }
  try {
    let mbids = song.isrc ? await lb.recordingMbidsByIsrc(song.isrc, ctx.signal) : [];
    if (!mbids.length) mbids = await lb.recordingMbidsByNames(song.artist, song.title, ctx.signal);
    if (mbids.length) {
      const rows = await lb.similarRecordings(mbids[0]!, ctx.signal);
      if (rows.length) lists.push({ source: 'listenbrainz', songs: rows.map((r) => ({ title: r.title, artist: r.artist, score: r.score, mbid: r.mbid })) });
      notes.push(`ListenBrainz ${rows.length}`);
    } else notes.push('ListenBrainz: recording unknown to MusicBrainz');
  } catch (err) {
    if (isAbort(err)) throw err;
    log.info('listenbrainz similar recordings failed', String(err));
    notes.push('ListenBrainz error');
  }
  return { lists, notes };
}

export async function similarSongsSeed(seed: SeedSpec, limit: number, ctx: SimilarContext): Promise<SimilarSeedResult> {
  const refs = seedRefs(seed);
  if (!refs.length) throw new LineupifyError('SEED_VALUE_REQUIRED', 'A similar_songs seed needs value (one song) or songs (a list): Spotify links/URIs or "Artist - Title".');
  const perSong = Math.max(1, Math.min(SIMILAR_MAX_PER_SONG, limit));

  const seedSongs: SeedSong[] = [];
  const missing: string[] = [];
  for (const ref of refs) {
    if (ctx.signal?.aborted) throw new Error('aborted');
    let t: SpotifyTrack | undefined;
    try {
      t = await ctx.lookupTrack(ref);
    } catch (err) {
      if (isAbort(err)) throw err;
      log.info(`seed song lookup failed for "${ref}"`, String(err));
    }
    if (!t || !t.artists[0]?.name) {
      missing.push(ref);
      continue;
    }
    const artist = t.artists[0].name;
    seedSongs.push({ ref, title: t.name, artist, uri: t.uri, isrc: t.isrc, key: songKey(t.name, artist) });
  }
  if (!seedSongs.length) {
    throw new LineupifyError('SEED_SONG_NOT_FOUND', `None of the seed songs could be found: ${missing.map((m) => clean(m, 40)).join(', ')}.`, 'Use a Spotify track link, or "Artist - Title" spelled as on Spotify; search_tracks finds the exact track.');
  }

  const perSeed: SimilarSong[][] = [];
  const noteParts: string[] = [];
  for (const song of seedSongs) {
    const { lists, notes } = await neighboursOf(song, perSong, ctx);
    const merged = mergeSimilarSongs(lists).slice(0, perSong);
    perSeed.push(merged);
    noteParts.push(`"${clean(song.artist, 24)} – ${clean(song.title, 30)}": ${notes.join(', ')}${merged.length ? '' : ' (nothing usable)'}`);
  }

  // Union across seed songs: a neighbour of several seeds is the best kind.
  const union = mergeSimilarSongs(perSeed.map((songs) => ({ source: 'lastfm' as const, songs: songs.map((s) => ({ title: s.title, artist: s.artist, score: s.score, mbid: s.mbid })) })));
  const sourcesOf = new Map<string, SimilarSource[]>();
  for (const list of perSeed) for (const s of list) {
    const k = songKey(s.title, s.artist);
    const cur = sourcesOf.get(k) ?? [];
    for (const src of s.sources) if (!cur.includes(src)) cur.push(src);
    sourcesOf.set(k, cur);
  }
  let songs = union.map((s) => ({ ...s, sources: sourcesOf.get(songKey(s.title, s.artist)) ?? s.sources }));

  const seedKeys = new Set(seedSongs.map((s) => s.key));
  const seedArtists = new Set(seedSongs.map((s) => fold(s.artist)));
  const before = songs.length;
  if (ctx.excludeSeedSongs) songs = songs.filter((s) => !seedKeys.has(songKey(s.title, s.artist)));
  if (ctx.excludeSeedArtists) songs = songs.filter((s) => !seedArtists.has(fold(s.artist)));
  const removed = before - songs.length;

  const groups = groupByArtist(songs, ctx.tracksPerArtist);
  const pinned: Record<string, Candidate[]> = {};
  for (const g of groups) pinned[fold(g.name)] = g.candidates;
  const total = groups.reduce((n, g) => n + g.candidates.length, 0);
  const both = songs.filter((s) => s.sources.length > 1).length;
  const note = [
    `${total} songs by ${groups.length} artists (${both} found by both sources)`,
    ...noteParts,
    removed ? `${removed} removed as seed ${ctx.excludeSeedArtists ? 'artists/songs' : 'songs'}` : '',
    missing.length ? `not found: ${missing.map((m) => clean(m, 30)).join(', ')}` : '',
    !ctx.lastfmApiKey ? 'no Last.fm key, ListenBrainz only' : '',
  ]
    .filter(Boolean)
    .join('; ');
  return { artists: groups.map((g) => ({ name: g.name, weight: g.weight })), pinned, seedSongs, note };
}
