/**
 * Track-level filters that need no I/O: release year (with a remaster
 * heuristic) and tempo. Kept pure so they can be unit-tested and reused by
 * the build job, the playlist reader and the analysis tool.
 */
import type { Candidate, DraftOptions, SpotifyTrack } from '../types.js';

export interface YearInfo {
  year?: number;
  /** True when the year probably describes a remaster or compilation, not the original recording. */
  uncertain: boolean;
}

const REISSUE_RE = /\b(remaster(ed)?|anniversary|deluxe|expanded|reissue|re-?release|greatest hits|best of|collection|anthology)\b/i;

export function parseYear(date: string | undefined): number | undefined {
  const m = String(date ?? '').match(/^(\d{4})/);
  if (!m) return undefined;
  const y = Number(m[1]);
  return y >= 1900 && y <= 2100 ? y : undefined;
}

/** Year of a matched track: Spotify album date first, then the source's date. */
export function trackYear(track: Pick<SpotifyTrack, 'releaseDate' | 'name' | 'albumType' | 'albumName'>, candidate?: Pick<Candidate, 'releaseDate' | 'title' | 'titleVersion'>): YearInfo {
  const year = parseYear(track.releaseDate) ?? parseYear(candidate?.releaseDate);
  const text = [track.name, track.albumName, candidate?.title, candidate?.titleVersion].filter(Boolean).join(' ');
  const uncertain = REISSUE_RE.test(text) || track.albumType === 'compilation';
  return { year, uncertain };
}

export function yearAccepts(info: YearInfo, opts: Pick<DraftOptions, 'yearRange' | 'strictYear'>): boolean {
  const r = opts.yearRange;
  if (!r || (r.from === undefined && r.to === undefined)) return true;
  if (info.year === undefined || info.uncertain) return !opts.strictYear;
  if (r.from !== undefined && info.year < r.from) return false;
  if (r.to !== undefined && info.year > r.to) return false;
  return true;
}

export function bpmAccepts(bpm: number | null | undefined, opts: Pick<DraftOptions, 'bpmRange' | 'strictBpm'>): boolean {
  const r = opts.bpmRange;
  if (!r || (r.min === undefined && r.max === undefined)) return true;
  if (!bpm) return !opts.strictBpm;
  if (r.min !== undefined && bpm < r.min) return false;
  if (r.max !== undefined && bpm > r.max) return false;
  return true;
}

export function describeFilters(opts: Partial<DraftOptions>): string[] {
  const out: string[] = [];
  const y = opts.yearRange;
  if (y && (y.from !== undefined || y.to !== undefined)) out.push(`years ${y.from ?? '…'}-${y.to ?? '…'}${opts.strictYear ? ' (strict)' : ''}`);
  const b = opts.bpmRange;
  if (b && (b.min !== undefined || b.max !== undefined)) out.push(`bpm ${b.min ?? '…'}-${b.max ?? '…'}${opts.strictBpm ? ' (strict)' : ''}`);
  if (opts.skipCovers) out.push('covers skipped');
  if (opts.excludeExplicit) out.push('clean only');
  if (opts.excludeSeedSongs) out.push('seed songs excluded');
  if (opts.excludeSeedArtists) out.push('seed artists excluded');
  return out;
}
