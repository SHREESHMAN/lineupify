/**
 * Small JSON-file caches with TTL. Writes are debounced and merged with
 * whatever is on disk at flush time so several processes can share a file.
 */
import { paths, readJson, writeJsonAtomic } from './store.js';

interface Entry<T> {
  v: T;
  at: number;
}

export class JsonCache<T> {
  private map = new Map<string, Entry<T>>();
  private loaded = false;
  private dirty = false;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private name: string,
    private ttlMs: number,
  ) {}

  private async load(): Promise<void> {
    if (this.loaded) return;
    const disk = (await readJson<Record<string, Entry<T>>>(paths.cache(this.name))) ?? {};
    for (const [k, e] of Object.entries(disk)) {
      if (e && typeof e.at === 'number' && Date.now() - e.at < this.ttlMs && !this.map.has(k)) this.map.set(k, e);
    }
    this.loaded = true;
  }

  async get(key: string): Promise<T | undefined> {
    await this.load();
    const e = this.map.get(key);
    if (!e) return undefined;
    if (Date.now() - e.at > this.ttlMs) {
      this.map.delete(key);
      return undefined;
    }
    return e.v;
  }

  async set(key: string, value: T): Promise<void> {
    await this.load();
    this.map.set(key, { v: value, at: Date.now() });
    this.dirty = true;
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.flush();
      }, 800);
      this.timer.unref?.();
    }
  }

  async delete(key: string): Promise<void> {
    await this.load();
    if (this.map.delete(key)) {
      this.dirty = true;
      await this.flush(true);
    }
  }

  async size(): Promise<number> {
    await this.load();
    return this.map.size;
  }

  async flush(force = false): Promise<void> {
    if (!this.dirty && !force) return;
    this.dirty = false;
    const disk = (await readJson<Record<string, Entry<T>>>(paths.cache(this.name))) ?? {};
    const merged: Record<string, Entry<T>> = {};
    for (const [k, e] of Object.entries(disk)) if (e && Date.now() - e.at < this.ttlMs) merged[k] = e;
    for (const [k, e] of this.map) merged[k] = e;
    await writeJsonAtomic(paths.cache(this.name), merged);
  }
}

const DAY = 86_400_000;

import type { PlaylistSnapshot, ResolvedArtist } from '../types.js';

export interface CachedSpotifyTrack {
  uri: string;
  id: string;
  name: string;
  artists: { id: string; name: string }[];
  albumName: string;
  albumType: string;
  releaseDate: string;
  trackNumber: number;
  durationMs: number;
  explicit: boolean;
  isrc?: string;
  isPlayable: boolean;
  /** Present when the cached track is a Deezer recording (provider deezer, or a Deezer ISRC lookup). */
  deezerTrackId?: number;
}

export const artistCache = new JsonCache<ResolvedArtist>('artists', 30 * DAY);
export interface CachedDeezerTrack {
  isrc?: string;
  explicit?: boolean;
  durationMs?: number;
  /** Tempo; null when Deezer reports none. Absent in entries written before tempo was stored. */
  bpm?: number | null;
  rank?: number;
  releaseDate?: string;
}
/** Keyed by Deezer track id, or `isrc:<ISRC>` for lookups by ISRC. */
export const deezerTrackCache = new JsonCache<CachedDeezerTrack>('deezer-tracks', 90 * DAY);
/** Keyed by `${spotifyUserId}:isrc:${isrc}` or `${spotifyUserId}:q:${query}`; `null` marks a known miss. */
export const spotifyTrackCache = new JsonCache<CachedSpotifyTrack | null>('spotify-tracks', 30 * DAY);
/** Playlist snapshots keyed by "spotify:<id>", "deezer:<id>" or "library:<userId>". */
export const playlistCache = new JsonCache<PlaylistSnapshot>('playlists', 12 * 3600_000);
/** Coarse genres (Deezer) and tags (Last.fm) per artist, keyed by folded name. */
export const artistGenreCache = new JsonCache<{ genres: string[]; tags: string[] }>('artist-genres', 30 * DAY);
/** Cover checks keyed by `${titleKey}|${fold(artist)}`: true = a more popular original by someone else exists. */
export const coverCache = new JsonCache<boolean>('covers', 30 * DAY);

export async function flushAllCaches(): Promise<void> {
  await Promise.all([artistCache.flush(), deezerTrackCache.flush(), spotifyTrackCache.flush(), playlistCache.flush(), artistGenreCache.flush(), coverCache.flush()]);
}
