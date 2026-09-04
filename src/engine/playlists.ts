/**
 * Read a playlist (Spotify or Deezer link/id, a playlist name from the user's
 * library, "library" for saved tracks, or a draft id) into a PlaylistSnapshot,
 * cached on disk for 12 h and refreshed when Spotify's snapshot id changes.
 * Also derives the artist profile of a snapshot and of the user's listening
 * history ("me"), which the seeds, compare and blend features build on.
 */
import type { Draft, PlaylistSnapshot, PlaylistTrack, SpotifyTrack } from '../types.js';
import { LineupifyError } from '../types.js';
import { playlistCache } from '../infra/cache.js';
import { nowIso } from '../infra/text.js';
import { fold } from './normalize.js';
import { parseYear } from './filters.js';
import { loadDraft } from './draft.js';
import * as spotify from '../sources/spotify.js';
import * as deezer from '../sources/deezer.js';

export type PlaylistRef =
  | { kind: 'spotify'; id: string }
  | { kind: 'deezer'; id: number }
  | { kind: 'me' }
  | { kind: 'library' }
  | { kind: 'draft'; id: string }
  | { kind: 'name'; name: string };

export function parsePlaylistRef(input: string): PlaylistRef {
  const s = String(input ?? '').trim();
  if (!s) throw new LineupifyError('BAD_PLAYLIST_REF', 'Empty playlist reference.');
  const low = s.toLowerCase();
  if (['me', 'taste', 'my taste', 'my top artists'].includes(low)) return { kind: 'me' };
  if (['library', 'liked', 'liked songs', 'saved', 'saved tracks', 'my library'].includes(low)) return { kind: 'library' };
  if (/^d_[a-z0-9]{3,12}$/.test(s)) return { kind: 'draft', id: s };
  let m = s.match(/^spotify:playlist:([A-Za-z0-9]{22})$/);
  if (m) return { kind: 'spotify', id: m[1]! };
  m = s.match(/open\.spotify\.com\/(?:intl-[a-z]+\/)?(?:user\/[^/]+\/)?playlist\/([A-Za-z0-9]{22})/);
  if (m) return { kind: 'spotify', id: m[1]! };
  m = s.match(/deezer\.com\/(?:[a-z]{2}\/)?playlist\/(\d+)/i);
  if (m) return { kind: 'deezer', id: Number(m[1]) };
  m = s.match(/^deezer:playlist:(\d+)$/);
  if (m) return { kind: 'deezer', id: Number(m[1]) };
  if (/^[A-Za-z0-9]{22}$/.test(s)) return { kind: 'spotify', id: s };
  if (/^https?:\/\//i.test(s)) {
    throw new LineupifyError('BAD_PLAYLIST_REF', `Unrecognised playlist link: ${s.slice(0, 80)}`, 'Use an open.spotify.com/playlist/... or deezer.com/playlist/... link, a spotify:playlist: URI, "library", or the name of a playlist in your own Spotify library.');
  }
  return { kind: 'name', name: s };
}

export function refLabel(ref: PlaylistRef): string {
  switch (ref.kind) {
    case 'me':
      return 'your listening history';
    case 'library':
      return 'your liked songs';
    case 'draft':
      return `draft ${ref.id}`;
    case 'name':
      return `"${ref.name}"`;
    case 'deezer':
      return `deezer playlist ${ref.id}`;
    default:
      return `spotify playlist ${ref.id}`;
  }
}

export function fromSpotifyTrack(t: SpotifyTrack, addedAt?: string): PlaylistTrack {
  return {
    uri: t.uri,
    spotifyId: t.id,
    name: t.name,
    artists: t.artists.map((a) => a.name),
    artistIds: t.artists.map((a) => a.id),
    album: t.albumName || undefined,
    durationMs: t.durationMs,
    explicit: t.explicit,
    isrc: t.isrc,
    year: parseYear(t.releaseDate),
    addedAt,
  };
}

function fromDeezerTrack(t: deezer.DeezerPlaylistTrack): PlaylistTrack {
  return {
    name: t.title,
    artists: [t.artistName],
    album: t.album,
    durationMs: t.durationMs,
    explicit: t.explicit,
    isrc: t.isrc,
    addedAt: t.addedAt,
    deezerTrackId: t.id,
    deezerArtistId: t.artistId,
  };
}

export function snapshotFromDraft(d: Draft): PlaylistSnapshot {
  const artistName = new Map(d.artists.map((a) => [a.key, a.name]));
  return {
    key: `draft:${d.id}`,
    source: 'draft',
    id: d.id,
    name: d.name,
    owner: 'Lineupify draft',
    url: d.playlistUrl ?? '',
    total: d.tracks.length,
    truncated: false,
    fetchedAt: d.updatedAt,
    tracks: d.tracks.map((t) => ({
      uri: t.uri,
      spotifyId: t.spotifyId,
      name: t.name,
      artists: [artistName.get(t.artistKey) ?? t.artists[0] ?? '', ...t.artists.filter((a) => fold(a) !== fold(artistName.get(t.artistKey) ?? ''))],
      album: t.album,
      durationMs: t.durationMs,
      explicit: t.explicit,
      isrc: t.isrc,
      year: t.year,
      bpm: t.bpm,
    })),
  };
}

export interface ReadOptions {
  signal?: AbortSignal;
  /** Cap on tracks read (default 1000; 3000 for the library). */
  maxTracks?: number;
  /** Ignore the cache. */
  refresh?: boolean;
}

async function readSpotify(id: string, opts: ReadOptions): Promise<PlaylistSnapshot> {
  const key = `spotify:${id}`;
  const info = await spotify.playlistInfo(id, opts.signal);
  const cached = opts.refresh ? undefined : await playlistCache.get(key);
  if (cached && cached.snapshotId === info.snapshotId && cached.snapshotId && !cached.truncated) return cached;
  const max = opts.maxTracks ?? 1000;
  const items = await spotify.playlistItems(id, max, opts.signal);
  const snap: PlaylistSnapshot = {
    key,
    source: 'spotify',
    id,
    name: info.name,
    owner: info.ownerName,
    url: info.url,
    description: info.description || undefined,
    public: info.public,
    total: items.total || info.total,
    truncated: items.truncated,
    fetchedAt: nowIso(),
    snapshotId: info.snapshotId,
    tracks: items.tracks.map((x) => fromSpotifyTrack(x.track, x.addedAt)),
  };
  await playlistCache.set(key, snap);
  return snap;
}

async function readDeezer(id: number, opts: ReadOptions): Promise<PlaylistSnapshot> {
  const key = `deezer:${id}`;
  const cached = opts.refresh ? undefined : await playlistCache.get(key);
  if (cached && !cached.truncated) return cached;
  const info = await deezer.playlistInfo(id, opts.signal);
  if (!info) throw new LineupifyError('PLAYLIST_NOT_READABLE', `Deezer has no public playlist ${id}.`, 'Check the link; private Deezer playlists cannot be read.');
  const r = await deezer.playlistTracks(id, opts.maxTracks ?? 1000, opts.signal);
  const snap: PlaylistSnapshot = {
    key,
    source: 'deezer',
    id: String(id),
    name: info.title,
    owner: info.creator ?? '',
    url: info.link,
    description: info.description || undefined,
    public: info.public,
    total: r.total,
    truncated: r.tracks.length < r.total,
    fetchedAt: nowIso(),
    tracks: r.tracks.map(fromDeezerTrack),
  };
  await playlistCache.set(key, snap);
  return snap;
}

async function readLibrary(opts: ReadOptions): Promise<PlaylistSnapshot> {
  const tokens = await spotify.getAccessToken();
  const key = `library:${tokens.userId}`;
  const cached = opts.refresh ? undefined : await playlistCache.get(key);
  if (cached) return cached;
  const r = await spotify.savedTracks(opts.maxTracks ?? 3000, opts.signal);
  const snap: PlaylistSnapshot = {
    key,
    source: 'library',
    id: tokens.userId,
    name: 'Liked Songs',
    owner: tokens.displayName || tokens.userId,
    url: 'https://open.spotify.com/collection/tracks',
    total: r.total,
    truncated: r.truncated,
    fetchedAt: nowIso(),
    tracks: r.tracks.map((x) => fromSpotifyTrack(x.track, x.addedAt)),
  };
  await playlistCache.set(key, snap);
  return snap;
}

async function findByName(name: string, signal?: AbortSignal): Promise<string> {
  const mine = await spotify.myPlaylists(signal);
  const f = fold(name);
  const exact = mine.filter((p) => fold(p.name) === f);
  const loose = exact.length ? exact : mine.filter((p) => fold(p.name).includes(f));
  if (!loose.length) throw new LineupifyError('PLAYLIST_NAME_NOT_FOUND', `No playlist named "${name}" in your Spotify library (${mine.length} playlists checked).`, 'Paste the playlist link instead, or check the exact name.');
  if (loose.length > 1 && !exact.length) throw new LineupifyError('PLAYLIST_NAME_AMBIGUOUS', `${loose.length} playlists match "${name}": ${loose.slice(0, 6).map((p) => p.name).join(', ')}.`, 'Use the full name or the link.');
  return loose[0]!.id;
}

/** Read any track-bearing reference. "me" is not a track list; use tasteProfile for it. */
export async function readPlaylist(ref: PlaylistRef, opts: ReadOptions = {}): Promise<PlaylistSnapshot> {
  switch (ref.kind) {
    case 'spotify':
      return readSpotify(ref.id, opts);
    case 'deezer':
      return readDeezer(ref.id, opts);
    case 'library':
      return readLibrary(opts);
    case 'name':
      return readSpotify(await findByName(ref.name, opts.signal), opts);
    case 'draft': {
      const d = await loadDraft(ref.id);
      if (!d) throw new LineupifyError('DRAFT_NOT_FOUND', `No draft ${ref.id}.`);
      return snapshotFromDraft(d);
    }
    case 'me':
      throw new LineupifyError('NOT_A_PLAYLIST', '"me" is a listening profile, not a track list.', 'Use it with compare_playlists or a blend/taste seed; use "library" for your liked songs.');
  }
}

export interface WeightedArtist {
  name: string;
  weight: number;
  /** Tracks the artist appears on (lead or featured). */
  count: number;
  spotifyArtistId?: string;
  deezerArtistId?: number;
}

/** Artists of a track list weighted by appearances (lead 1, featured 0.5), most frequent first. */
export function artistFrequency(tracks: PlaylistTrack[]): WeightedArtist[] {
  const m = new Map<string, WeightedArtist>();
  for (const t of tracks) {
    t.artists.forEach((name, i) => {
      const k = fold(name);
      if (!k) return;
      const cur = m.get(k) ?? { name, weight: 0, count: 0 };
      cur.weight += i === 0 ? 1 : 0.5;
      cur.count += 1;
      if (!cur.spotifyArtistId && t.artistIds?.[i]) cur.spotifyArtistId = t.artistIds[i];
      if (!cur.deezerArtistId && i === 0 && t.deezerArtistId) cur.deezerArtistId = t.deezerArtistId;
      m.set(k, cur);
    });
  }
  return [...m.values()].sort((a, b) => b.weight - a.weight || b.count - a.count);
}

/** The user's top artists (4 weeks ×3, 6 months ×2, all time ×1) plus followed artists (×1). */
export async function tasteProfile(signal?: AbortSignal): Promise<WeightedArtist[]> {
  const [short, medium, long, following] = await Promise.all([
    spotify.topArtists('short_term', signal),
    spotify.topArtists('medium_term', signal),
    spotify.topArtists('long_term', signal),
    spotify.followedArtists(signal),
  ]);
  const m = new Map<string, WeightedArtist>();
  const add = (list: { id: string; name: string }[], base: number) => {
    list.forEach((a, i) => {
      const k = fold(a.name);
      const cur = m.get(k) ?? { name: a.name, weight: 0, count: 0, spotifyArtistId: a.id };
      cur.weight += base * (1 + Math.max(0, 50 - i) / 100);
      cur.count += 1;
      m.set(k, cur);
    });
  };
  add(short, 3);
  add(medium, 2);
  add(long, 1);
  add(following, 1);
  return [...m.values()].sort((a, b) => b.weight - a.weight);
}

export interface ResolvedSource {
  input: string;
  ref: PlaylistRef;
  label: string;
  artists: WeightedArtist[];
  tracks: PlaylistTrack[];
  snapshot?: PlaylistSnapshot;
}

/** Turn a user-supplied reference into artists (and tracks when it is a track list). */
export async function resolveSource(input: string, opts: ReadOptions = {}): Promise<ResolvedSource> {
  const ref = parsePlaylistRef(input);
  if (ref.kind === 'me') {
    const artists = await tasteProfile(opts.signal);
    return { input, ref, label: refLabel(ref), artists, tracks: [] };
  }
  const snapshot = await readPlaylist(ref, opts);
  return { input, ref, label: snapshot.name || refLabel(ref), artists: artistFrequency(snapshot.tracks), tracks: snapshot.tracks, snapshot };
}
