/** Shared domain types for Lineupify. Keep this file free of runtime imports. */

export type Tier = 'headliner' | 'sub' | 'undercard' | 'flat';
/**
 * Where a draft's tracks live and where it can be published. "spotify" needs a
 * connected account; "deezer" needs nothing (Deezer's public API is keyless)
 * but cannot publish, because Deezer stopped issuing API credentials in 2025.
 */
export type Provider = 'spotify' | 'deezer';
export type SourceName = 'deezer' | 'lastfm' | 'spotify' | 'listenbrainz';
export type OrderMode = 'interleave' | 'lineup' | 'shuffle' | 'by_day' | 'known_first';

/** An artist as it appears on a lineup, before resolution. */
export interface LineupArtist {
  name: string;
  tier?: Tier;
  day?: string;
  stage?: string;
}

/** A song candidate produced by a source, before it is matched to Spotify. */
export interface Candidate {
  source: SourceName;
  title: string;
  titleShort: string;
  titleVersion: string;
  leadArtist: string;
  leadArtistId?: string;
  contributors: string[];
  role: 'lead' | 'featured';
  rank: number;
  isrc?: string;
  deezerTrackId?: number;
  /** Set when the candidate came straight from Spotify (album fallback). */
  spotifyUri?: string;
  spotify?: SpotifyTrack;
  durationMs?: number;
  explicit?: boolean;
  album?: string;
  /** Deezer tempo; null when Deezer has no value. */
  bpm?: number | null;
  /** Deezer popularity rank of the recording (higher is more popular). */
  deezerRank?: number;
  releaseDate?: string;
}

export interface ResolvedArtist {
  /** Canonical display name from the source. */
  name: string;
  source: SourceName | 'user';
  deezerId?: number;
  spotifyArtistId?: string;
  lastfmName?: string;
  nbFan?: number;
  confidence: 'high' | 'low';
}

export interface DraftArtist {
  /** Normalized key, unique within a draft. */
  key: string;
  /** Name as given on the lineup. */
  name: string;
  tier: Tier;
  day?: string;
  stage?: string;
  status: 'pending' | 'resolved' | 'unresolved' | 'excluded';
  resolved?: ResolvedArtist;
  reason?: string;
  queriesTried?: string[];
  /** How many tracks this artist should contribute. */
  target: number;
  /** Set when versions (live/remix/...) had to be allowed to fill the quota. */
  allowedVersions?: boolean;
  /** Filled by compare_taste. */
  known?: boolean;
  spotifyArtistId?: string;
  /** Where a seeded artist came from, e.g. "similar_to Khruangbin". Absent for artists given directly. */
  origin?: string;
  /** Exact songs to fetch for this artist (similar_songs seed) instead of its top tracks. */
  pinned?: Candidate[];
}

export interface DraftTrack {
  /** Stable short id, e.g. t_4k2p. */
  id: string;
  uri: string;
  spotifyId: string;
  name: string;
  artists: string[];
  /** Key of the DraftArtist this track is credited to. */
  artistKey: string;
  durationMs: number;
  explicit: boolean;
  isrc?: string;
  album?: string;
  matchedVia: 'isrc' | 'text' | 'spotify' | 'manual' | 'deezer';
  source: SourceName | 'manual';
  /** Set for Deezer-provider drafts (uri is then deezer:track:<id> and spotifyId is empty). */
  deezerTrackId?: number;
  /** Public web link to the track on its provider. */
  url?: string;
  role: 'lead' | 'featured';
  isVersion?: boolean;
  year?: number;
  /** The year comes from a remaster/compilation release, so the original may be older. */
  yearUncertain?: boolean;
  bpm?: number;
  /** Source popularity (Deezer rank) when known. */
  rank?: number;
}

export interface TracksPerTier {
  headliner: number;
  sub: number;
  undercard: number;
}

export interface DraftOptions {
  tracksPerTier: TracksPerTier;
  tracksPerArtist?: number;
  maxTracks: number;
  maxDurationMin?: number;
  order: OrderMode;
  shuffleSeed?: number;
  excludeArtists: string[];
  excludeExplicit: boolean;
  allowVersions: boolean;
  discoveryOnly: boolean;
  /** Refuse to publish while any artist is unresolved (off by default). */
  stopIfUnresolved: boolean;
  days?: string[];
  public: boolean;
  sources: SourceName[];
  /** Keep only tracks released in this range (inclusive). */
  yearRange?: { from?: number; to?: number };
  /** Drop tracks whose year is unknown or comes from a remaster/compilation. */
  strictYear?: boolean;
  /** Keep only tracks whose Deezer tempo is in this range. */
  bpmRange?: { min?: number; max?: number };
  /** Drop tracks with no known tempo. */
  strictBpm?: boolean;
  /** Drop a song when a more popular artist's recording of the same title exists. */
  skipCovers?: boolean;
  /** Playlist links / ids, draft ids or "library" whose tracks must not be picked. */
  excludeTracksFrom?: string[];
  /** similar_songs: drop the seed songs themselves from the result (off by default). */
  excludeSeedSongs?: boolean;
  /** similar_songs: drop every song by the seed songs' artists (off by default). */
  excludeSeedArtists?: boolean;
}

export type SeedType = 'genre' | 'similar_to' | 'similar_songs' | 'chart' | 'country' | 'playlist' | 'taste' | 'blend';

/** A source of artists other than a typed list. Expanded in the background build. */
export interface SeedSpec {
  type: SeedType;
  /** genre/tag/mood text, artist name, country, or a playlist link/id/name. */
  value?: string;
  /** blend only: playlist links, draft ids or "me" (2-4). */
  sources?: string[];
  /** similar_songs only: more seed songs (links, URIs or "Artist - Title"), up to 10 with value. */
  songs?: string[];
  /** blend only: sides an artist must appear on; default all. */
  minShared?: number;
  /** Max artists this seed adds (default 30, max 100); for similar_songs, similar songs per seed song (default 25, max 100). */
  limit?: number;
  tier?: Tier;
}

export interface DraftSeed extends SeedSpec {
  id: string;
  status: 'pending' | 'done' | 'failed';
  /** Readable label set after expansion, e.g. the resolved seed song names for similar_songs. */
  label?: string;
  added?: number;
  note?: string;
  error?: string;
}

/** A track read from a playlist, library or draft. */
export interface PlaylistTrack {
  uri?: string;
  spotifyId?: string;
  name: string;
  artists: string[];
  artistIds?: string[];
  album?: string;
  durationMs: number;
  explicit: boolean;
  isrc?: string;
  year?: number;
  addedAt?: string;
  deezerTrackId?: number;
  deezerArtistId?: number;
  bpm?: number;
}

export interface PlaylistSnapshot {
  /** Cache key, e.g. "spotify:<id>" or "deezer:<id>". */
  key: string;
  source: 'spotify' | 'deezer' | 'library' | 'draft';
  id: string;
  name: string;
  owner: string;
  url: string;
  description?: string;
  public?: boolean;
  total: number;
  truncated: boolean;
  fetchedAt: string;
  snapshotId?: string;
  tracks: PlaylistTrack[];
}

export interface DraftRule {
  op: 'exclude_artist' | 'set_artist_track_count' | 'filter' | 'set_meta';
  payload: Record<string, unknown>;
}

export interface Draft {
  id: string;
  name: string;
  description: string;
  public: boolean;
  createdAt: string;
  updatedAt: string;
  revision: number;
  status: 'building' | 'ready' | 'paused' | 'failed';
  progress: { done: number; total: number };
  error?: string;
  /** Spotify user id the draft was built for (empty for Deezer-provider drafts). */
  spotifyUserId: string;
  /** Absent in drafts from 0.2.x, which are Spotify. */
  provider?: Provider;
  options: DraftOptions;
  artists: DraftArtist[];
  tracks: DraftTrack[];
  /** Rules applied while building (edit_draft ops accepted during a build). */
  rules: DraftRule[];
  playlistId?: string;
  playlistUrl?: string;
  snapshotId?: string;
  /** Commit checkpoint: index of the last successfully added 100-track chunk. */
  commit?: { chunkIndex: number; total: number };
  viewedAt?: string;
  /** Draft artists confirmed known/new via compare_taste. */
  tasteCheckedAt?: string;
  /** Seeds still to expand or already expanded into artists. */
  seeds?: DraftSeed[];
  /** Tracks that must not be picked, resolved from options.excludeTracksFrom by the build. */
  excludeTracks?: { uris: string[]; isrcs: string[]; songKeys: string[]; resolved: boolean; note?: string };
  /** Notes from the last build worth showing (e.g. what skipCovers removed). */
  buildNotes?: string[];
}

/**
 * A track on either provider in the shape the engine works with. For Spotify
 * it is the API object; for Deezer, uri is deezer:track:<id>, id is the Deezer
 * id as a string, artist ids are empty and albumType is "".
 */
export interface SpotifyTrack {
  uri: string;
  id: string;
  name: string;
  artists: { id: string; name: string }[];
  albumName: string;
  albumType: 'album' | 'single' | 'compilation' | string;
  releaseDate: string;
  trackNumber: number;
  durationMs: number;
  explicit: boolean;
  isrc?: string;
  isPlayable: boolean;
  /** Present on Deezer-provider tracks. */
  deezerTrackId?: number;
}

export interface Tokens {
  clientId: string;
  accessToken: string;
  refreshToken: string;
  /** Epoch ms when accessToken expires. */
  expiresAt: number;
  /** ISO timestamp of the original authorization; refresh tokens die 6 months later. */
  authorizedAt: string;
  scope: string;
  userId: string;
  displayName: string;
}

export interface Config {
  spotifyClientId?: string;
  spotifyRedirectPort?: number;
  lastfmApiKey?: string;
  defaults: Partial<DraftOptions> & { namingTemplate?: string; provider?: Provider };
}

export class LineupifyError extends Error {
  constructor(
    public code: string,
    message: string,
    public hint?: string,
    public status?: number,
  ) {
    super(message);
    this.name = 'LineupifyError';
  }
}
