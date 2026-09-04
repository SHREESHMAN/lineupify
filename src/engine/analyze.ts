/**
 * Playlist analysis: numbers only, rendered as fixed-layout text. The client
 * turns them into tables or charts. Basic stats are pure; genres (Deezer's
 * coarse genres and, with a key, Last.fm tags) and tempo (Deezer by ISRC)
 * need the network and are cached per artist / recording.
 */
import type { PlaylistTrack } from '../types.js';
import { artistGenreCache, deezerTrackCache } from '../infra/cache.js';
import { log } from '../infra/log.js';
import { clean, fmtDuration } from '../infra/text.js';
import { fold } from './normalize.js';
import { isAbort } from './resolve.js';
import { artistFrequency, type WeightedArtist } from './playlists.js';
import { mapLimit, resolveDeezerArtist } from './seeds.js';
import * as deezer from '../sources/deezer.js';
import * as lastfm from '../sources/lastfm.js';

export interface Bucket {
  label: string;
  count: number;
}

export interface PlaylistStats {
  tracks: number;
  totalMs: number;
  avgMs: number;
  explicit: number;
  artists: WeightedArtist[];
  artistCount: number;
  /** Share of tracks (lead artist) held by the five most frequent artists, 0..1. */
  top5Share: number;
  decades: Bucket[];
  yearMin?: number;
  yearMax?: number;
  unknownYear: number;
  genres?: Bucket[];
  tags?: Bucket[];
  bpm?: { known: number; sampled: number; min: number; max: number; median: number; buckets: Bucket[] };
  addedSpan?: { first: string; last: string };
}

export function basicStats(tracks: PlaylistTrack[]): PlaylistStats {
  const artists = artistFrequency(tracks);
  const leadCounts = new Map<string, number>();
  for (const t of tracks) {
    const k = fold(t.artists[0] ?? '');
    leadCounts.set(k, (leadCounts.get(k) ?? 0) + 1);
  }
  const top5 = [...leadCounts.values()].sort((a, b) => b - a).slice(0, 5).reduce((s, n) => s + n, 0);
  const decades = new Map<string, number>();
  let yearMin: number | undefined;
  let yearMax: number | undefined;
  let unknownYear = 0;
  for (const t of tracks) {
    if (!t.year) {
      unknownYear++;
      continue;
    }
    const d = `${Math.floor(t.year / 10) * 10}s`;
    decades.set(d, (decades.get(d) ?? 0) + 1);
    yearMin = yearMin === undefined ? t.year : Math.min(yearMin, t.year);
    yearMax = yearMax === undefined ? t.year : Math.max(yearMax, t.year);
  }
  const totalMs = tracks.reduce((s, t) => s + t.durationMs, 0);
  const added = tracks.map((t) => t.addedAt).filter((x): x is string => !!x).sort();
  return {
    tracks: tracks.length,
    totalMs,
    avgMs: tracks.length ? totalMs / tracks.length : 0,
    explicit: tracks.filter((t) => t.explicit).length,
    artists,
    artistCount: artists.length,
    top5Share: tracks.length ? top5 / tracks.length : 0,
    decades: [...decades.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([label, count]) => ({ label, count })),
    yearMin,
    yearMax,
    unknownYear,
    addedSpan: added.length ? { first: added[0]!, last: added[added.length - 1]! } : undefined,
  };
}

export interface EnrichContext {
  lastfmApiKey?: string;
  signal?: AbortSignal;
  genres?: boolean;
  bpm?: boolean;
  /** Artists to look up for genres (default 20) and tracks to sample for tempo (default 60). */
  maxArtists?: number;
  maxTracks?: number;
}

/** Coarse genre(s) and tags for an artist, cached 30 days. Empty arrays when nothing is known. */
export async function artistGenres(name: string, ctx: EnrichContext): Promise<{ genres: string[]; tags: string[] }> {
  const key = fold(name);
  const cached = await artistGenreCache.get(key);
  if (cached && (cached.tags.length || !ctx.lastfmApiKey)) return cached;
  const out = { genres: cached?.genres ?? [], tags: cached?.tags ?? [] };
  try {
    if (!out.genres.length) {
      const dz = await resolveDeezerArtist(name, ctx.signal);
      if (dz) {
        const ids = await deezer.artistAlbumGenres(dz.id, 5, ctx.signal);
        if (ids.length) {
          const list = await deezer.genres(ctx.signal);
          const counts = new Map<number, number>();
          for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
          const best = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2);
          out.genres = best.map(([id]) => list.find((g) => g.id === id)?.name).filter((g): g is string => !!g);
        }
      }
    }
    if (ctx.lastfmApiKey && !out.tags.length) out.tags = await lastfm.artistTopTags(ctx.lastfmApiKey, name, 4, ctx.signal);
  } catch (err) {
    if (isAbort(err)) throw err;
    log.info(`genre lookup failed for ${name}`, String(err));
  }
  await artistGenreCache.set(key, out);
  return out;
}

async function tempoOf(t: PlaylistTrack, signal?: AbortSignal): Promise<number | undefined> {
  if (t.bpm) return t.bpm;
  if (!t.isrc) return undefined;
  const key = `isrc:${t.isrc}`;
  let d = await deezerTrackCache.get(key);
  if (!d || d.bpm === undefined) {
    try {
      const fresh = await deezer.trackByIsrc(t.isrc, signal);
      d = fresh ?? { bpm: null };
      await deezerTrackCache.set(key, d);
    } catch (err) {
      if (isAbort(err)) throw err;
      return undefined;
    }
  }
  return d.bpm ?? undefined;
}

function sample<T>(items: T[], n: number): T[] {
  if (items.length <= n) return items;
  const step = items.length / n;
  return Array.from({ length: n }, (_, i) => items[Math.floor(i * step)]!);
}

export async function enrichStats(stats: PlaylistStats, tracks: PlaylistTrack[], ctx: EnrichContext): Promise<PlaylistStats> {
  const jobs: Promise<void>[] = [];
  if (ctx.genres !== false) {
    jobs.push(
      (async () => {
        const top = stats.artists.slice(0, ctx.maxArtists ?? 20);
        const looked = await mapLimit(top, 3, async (a) => ({ a, g: await artistGenres(a.name, ctx) }));
        const genres = new Map<string, number>();
        const tags = new Map<string, number>();
        for (const { a, g } of looked) {
          for (const name of g.genres) genres.set(name, (genres.get(name) ?? 0) + a.count);
          for (const name of g.tags) tags.set(name, (tags.get(name) ?? 0) + a.count);
        }
        stats.genres = [...genres.entries()].sort((x, y) => y[1] - x[1]).map(([label, count]) => ({ label, count }));
        stats.tags = [...tags.entries()].sort((x, y) => y[1] - x[1]).slice(0, 12).map(([label, count]) => ({ label, count }));
      })(),
    );
  }
  if (ctx.bpm !== false) {
    jobs.push(
      (async () => {
        const chosen = sample(tracks.filter((t) => t.isrc || t.bpm), ctx.maxTracks ?? 60);
        const values = (await mapLimit(chosen, 4, (t) => tempoOf(t, ctx.signal))).filter((b): b is number => !!b).sort((a, b) => a - b);
        const buckets: Bucket[] = [
          { label: '<90', count: 0 },
          { label: '90-110', count: 0 },
          { label: '110-130', count: 0 },
          { label: '130-150', count: 0 },
          { label: '150+', count: 0 },
        ];
        for (const b of values) buckets[b < 90 ? 0 : b < 110 ? 1 : b < 130 ? 2 : b < 150 ? 3 : 4]!.count++;
        stats.bpm = values.length
          ? { known: values.length, sampled: chosen.length, min: values[0]!, max: values[values.length - 1]!, median: values[Math.floor(values.length / 2)]!, buckets }
          : { known: 0, sampled: chosen.length, min: 0, max: 0, median: 0, buckets };
      })(),
    );
  }
  await Promise.all(jobs);
  return stats;
}

function pct(n: number, of: number): string {
  return of ? `${Math.round((n / of) * 100)}%` : '0%';
}

export function renderStats(s: PlaylistStats, title: string): string {
  const lines: string[] = [];
  lines.push(`Analysis of "${clean(title, 60)}": ${s.tracks} tracks · ${fmtDuration(s.totalMs)} · avg ${fmtDuration(s.avgMs)} · explicit ${s.explicit} (${pct(s.explicit, s.tracks)}) · ${s.artistCount} artists`);
  lines.push(`Top artists (share of tracks): ${s.artists.slice(0, 10).map((a) => `${clean(a.name, 25)} ${a.count}`).join(' · ')} · top 5 hold ${pct(s.top5Share * s.tracks, s.tracks)}`);
  if (s.decades.length) lines.push(`Decades: ${s.decades.map((d) => `${d.label} ${d.count}`).join(' · ')}${s.yearMin ? ` · years ${s.yearMin}-${s.yearMax}` : ''}${s.unknownYear ? ` · unknown ${s.unknownYear}` : ''}`);
  if (s.genres) lines.push(`Genres (Deezer, coarse, by track count of the top artists): ${s.genres.length ? s.genres.map((g) => `${g.label} ${g.count}`).join(' · ') : 'none found'}`);
  if (s.tags && s.tags.length) lines.push(`Tags (Last.fm): ${s.tags.map((t) => `${t.label} ${t.count}`).join(' · ')}`);
  if (s.bpm) {
    lines.push(
      s.bpm.known
        ? `Tempo (Deezer, ${s.bpm.known} of ${s.bpm.sampled} sampled): median ${Math.round(s.bpm.median)} BPM · range ${Math.round(s.bpm.min)}-${Math.round(s.bpm.max)} · ${s.bpm.buckets.map((b) => `${b.label}: ${b.count}`).join(' · ')}`
        : `Tempo: no Deezer tempo data for the sampled tracks`,
    );
  }
  if (s.addedSpan) lines.push(`Added between ${s.addedSpan.first.slice(0, 10)} and ${s.addedSpan.last.slice(0, 10)}`);
  return lines.join('\n');
}
