/**
 * Seeds: ways to produce an artist list without typing one. Every seed
 * expands to weighted artists that the normal build then resolves, ranks and
 * matches. Sources are Deezer (keyless), Last.fm (optional key) and the
 * user's own Spotify data; Spotify's recommendation endpoints are not
 * available to new apps, so nothing here depends on them.
 */
import type { SeedSpec } from '../types.js';
import { LineupifyError } from '../types.js';
import { artistCache } from '../infra/cache.js';
import { log } from '../infra/log.js';
import { clean } from '../infra/text.js';
import { fold } from './normalize.js';
import { isAbort } from './resolve.js';
import { resolveSource } from './playlists.js';
import * as deezer from '../sources/deezer.js';
import * as lastfm from '../sources/lastfm.js';

export interface SeedArtist {
  name: string;
  weight: number;
  deezerId?: number;
  nbFan?: number;
}

export interface SeedContext {
  lastfmApiKey?: string;
  signal?: AbortSignal;
}

export interface SeedResult {
  artists: SeedArtist[];
  /** Human-readable provenance, e.g. "Deezer playlists: Dreampop, you're dreaming". */
  note: string;
}

export const DEFAULT_SEED_LIMIT = 30;
export const MAX_SEED_LIMIT = 100;

export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

/** Union of lists: same artist (folded name) sums its weights; first-seen spelling and ids are kept. */
export function mergeSeedArtists(lists: SeedArtist[][]): SeedArtist[] {
  const m = new Map<string, SeedArtist>();
  for (const list of lists) {
    for (const a of list) {
      const k = fold(a.name);
      if (!k) continue;
      const cur = m.get(k);
      if (cur) {
        cur.weight += a.weight;
        cur.deezerId = cur.deezerId ?? a.deezerId;
        cur.nbFan = cur.nbFan ?? a.nbFan;
      } else m.set(k, { ...a });
    }
  }
  return [...m.values()].sort((a, b) => b.weight - a.weight || (b.nbFan ?? 0) - (a.nbFan ?? 0));
}

function clampLimit(n: number | undefined): number {
  if (n === undefined || !Number.isFinite(n)) return DEFAULT_SEED_LIMIT;
  return Math.max(1, Math.min(MAX_SEED_LIMIT, Math.floor(n)));
}

// ---------------------------------------------------------------------------
// Deezer playlist aggregation: the keyless way to turn any words (a genre, a
// mood, a country) into artists. Public playlists whose title matches are
// read and their artists counted, weighted by position.
// ---------------------------------------------------------------------------

const OFFICIAL_USER = /\bdeezer\b/i;

/** Pure: order playlist search hits by fitness for aggregation. */
export function rankPlaylistCandidates(query: string, results: deezer.DeezerPlaylistRef[], opts: { officialOnly?: boolean } = {}): deezer.DeezerPlaylistRef[] {
  const words = fold(query).split(' ').filter(Boolean);
  const scored = results
    .filter((p) => p.nbTracks >= 10)
    .filter((p) => !opts.officialOnly || OFFICIAL_USER.test(p.userName ?? ''))
    .map((p) => {
      const title = fold(p.title);
      const hit = words.filter((w) => title.includes(w)).length / Math.max(1, words.length);
      const official = OFFICIAL_USER.test(p.userName ?? '');
      // A playlist whose title shares no word with the query is only trusted when a Deezer editor made it.
      if (!hit && !official) return { p, score: 0 };
      let score = hit * 4;
      if (official) score += 3;
      if (p.nbTracks >= 20 && p.nbTracks <= 500) score += 1;
      if (/\b(top|hits|best|essentials|100)\b/i.test(p.title) && !/\b(top|hits|best)\b/i.test(query)) score -= 0.5;
      return { p, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.map((x) => x.p);
}

/** Pure: count lead artists across playlists, earlier positions and earlier playlists weighing more. */
export function aggregatePlaylistArtists(lists: { tracks: { artistName: string; artistId?: number; rank?: number }[]; weight: number }[]): SeedArtist[] {
  const m = new Map<string, SeedArtist>();
  for (const list of lists) {
    const seenHere = new Set<string>();
    list.tracks.forEach((t, i) => {
      const k = fold(t.artistName);
      if (!k) return;
      const positional = 1 / (1 + i / 40);
      const cur = m.get(k) ?? { name: t.artistName, weight: 0, deezerId: t.artistId };
      // First appearance in a playlist counts fully; repeats in the same playlist add a little.
      cur.weight += list.weight * positional * (seenHere.has(k) ? 0.25 : 1);
      cur.deezerId = cur.deezerId ?? t.artistId;
      seenHere.add(k);
      m.set(k, cur);
    });
  }
  return [...m.values()].sort((a, b) => b.weight - a.weight);
}

async function deezerPlaylistSeed(query: string, limit: number, ctx: SeedContext, opts: { officialOnly?: boolean; maxPlaylists?: number } = {}): Promise<SeedResult> {
  const hits = await deezer.searchPlaylists(query, 15, ctx.signal);
  const ranked = rankPlaylistCandidates(query, hits, opts).slice(0, opts.maxPlaylists ?? 4);
  if (!ranked.length) return { artists: [], note: `no public Deezer playlists match "${clean(query, 40)}"` };
  const lists = await mapLimit(ranked, 2, async (p, i) => {
    try {
      const r = await deezer.playlistTracks(p.id, 100, ctx.signal);
      return { tracks: r.tracks, weight: 1 / (1 + i * 0.5), title: p.title };
    } catch (err) {
      if (isAbort(err)) throw err;
      log.info(`playlist ${p.id} read failed`, String(err));
      return { tracks: [], weight: 0, title: p.title };
    }
  });
  const used = lists.filter((l) => l.tracks.length);
  const artists = aggregatePlaylistArtists(used).slice(0, limit);
  return { artists, note: `Deezer playlists: ${used.map((l) => clean(l.title, 30)).join(', ')}` };
}

/** Deezer artist for a name, via the shared artist cache when possible. */
export async function resolveDeezerArtist(name: string, signal?: AbortSignal): Promise<deezer.DeezerArtist | undefined> {
  const cached = await artistCache.get(fold(name));
  if (cached?.deezerId) return { id: cached.deezerId, name: cached.name, nbFan: cached.nbFan ?? 0 };
  const results = await deezer.searchArtists(name, signal);
  const pick = deezer.pickArtist(name, results);
  if (!pick) return undefined;
  if (!cached) await artistCache.set(fold(name), { name: pick.artist.name, source: 'deezer', deezerId: pick.artist.id, nbFan: pick.artist.nbFan, confidence: pick.confidence });
  return pick.artist;
}

// ---------------------------------------------------------------------------
// Individual seeds
// ---------------------------------------------------------------------------

async function genreSeed(value: string, limit: number, ctx: SeedContext): Promise<SeedResult> {
  const parts: SeedArtist[][] = [];
  const notes: string[] = [];
  if (ctx.lastfmApiKey) {
    try {
      const tagged = await lastfm.tagTopArtists(ctx.lastfmApiKey, value, Math.min(100, limit * 2), ctx.signal);
      if (tagged.length) {
        parts.push(tagged.map((a, i) => ({ name: a.name, weight: 2 / (1 + i / 20) })));
        notes.push(`Last.fm tag "${clean(value, 30)}" (${tagged.length})`);
      }
    } catch (err) {
      if (isAbort(err)) throw err;
      log.info('lastfm tag lookup failed', String(err));
    }
  }
  const dz = await deezerPlaylistSeed(value, limit * 2, ctx);
  if (dz.artists.length) {
    parts.push(dz.artists);
    notes.push(dz.note);
  } else if (!parts.length) notes.push(dz.note);
  return { artists: mergeSeedArtists(parts).slice(0, limit), note: notes.join('; ') };
}

async function similarSeed(value: string, limit: number, ctx: SeedContext): Promise<SeedResult> {
  const parts: SeedArtist[][] = [];
  const notes: string[] = [];
  const seed = await resolveDeezerArtist(value, ctx.signal);
  if (seed) {
    const related = await deezer.relatedArtists(seed.id, Math.min(50, limit * 2), ctx.signal);
    parts.push(related.map((a, i) => ({ name: a.name, weight: 2 / (1 + i / 10), deezerId: a.id, nbFan: a.nbFan })));
    notes.push(`Deezer related to ${clean(seed.name, 30)} (${related.length})`);
  }
  if (ctx.lastfmApiKey) {
    try {
      const sim = await lastfm.similarArtists(ctx.lastfmApiKey, seed?.name ?? value, Math.min(100, limit * 2), ctx.signal);
      if (sim.length) {
        parts.push(sim.map((a) => ({ name: a.name, weight: 2 * (a.match ?? 0.5) })));
        notes.push(`Last.fm similar (${sim.length})`);
      }
    } catch (err) {
      if (isAbort(err)) throw err;
      log.info('lastfm similar lookup failed', String(err));
    }
  }
  if (!parts.length) throw new LineupifyError('SEED_ARTIST_NOT_FOUND', `Could not find "${clean(value, 40)}" on Deezer${ctx.lastfmApiKey ? ' or Last.fm' : ''}.`, 'Check the spelling, or pass the artist directly in artists.');
  // Never suggest the seed artist itself.
  const self = fold(seed?.name ?? value);
  return { artists: mergeSeedArtists(parts).filter((a) => fold(a.name) !== self).slice(0, limit), note: notes.join('; ') };
}

async function chartSeed(limit: number, ctx: SeedContext): Promise<SeedResult> {
  const parts: SeedArtist[][] = [];
  const notes: string[] = [];
  const dz = await deezer.chartArtists(Math.min(100, limit * 2), ctx.signal);
  if (dz.length) {
    parts.push(dz.map((a, i) => ({ name: a.name, weight: 2 / (1 + i / 20), deezerId: a.id, nbFan: a.nbFan })));
    notes.push(`Deezer global chart (${dz.length})`);
  }
  if (ctx.lastfmApiKey) {
    try {
      const lf = await lastfm.chartTopArtists(ctx.lastfmApiKey, Math.min(100, limit * 2), ctx.signal);
      if (lf.length) {
        parts.push(lf.map((a, i) => ({ name: a.name, weight: 2 / (1 + i / 20) })));
        notes.push(`Last.fm chart (${lf.length})`);
      }
    } catch (err) {
      if (isAbort(err)) throw err;
      log.info('lastfm chart lookup failed', String(err));
    }
  }
  return { artists: mergeSeedArtists(parts).slice(0, limit), note: notes.join('; ') || 'no chart data' };
}

const COUNTRY_NAMES: Record<string, string> = {
  us: 'United States', usa: 'United States', 'united states of america': 'United States', uk: 'United Kingdom', gb: 'United Kingdom', britain: 'United Kingdom', england: 'United Kingdom',
  br: 'Brazil', brasil: 'Brazil', fr: 'France', de: 'Germany', deutschland: 'Germany', es: 'Spain', it: 'Italy', nl: 'Netherlands', holland: 'Netherlands', be: 'Belgium', pt: 'Portugal',
  mx: 'Mexico', ar: 'Argentina', co: 'Colombia', cl: 'Chile', pe: 'Peru', ca: 'Canada', au: 'Australia', nz: 'New Zealand', jp: 'Japan', kr: 'South Korea', korea: 'South Korea',
  in: 'India', id: 'Indonesia', ph: 'Philippines', th: 'Thailand', vn: 'Vietnam', tr: 'Turkey', turkiye: 'Turkey', se: 'Sweden', no: 'Norway', dk: 'Denmark', fi: 'Finland', pl: 'Poland',
  cz: 'Czech Republic', ie: 'Ireland', ch: 'Switzerland', at: 'Austria', gr: 'Greece', ro: 'Romania', hu: 'Hungary', ua: 'Ukraine', ru: 'Russia', za: 'South Africa', ng: 'Nigeria',
  ke: 'Kenya', gh: 'Ghana', eg: 'Egypt', ma: 'Morocco', ae: 'United Arab Emirates', uae: 'United Arab Emirates', sa: 'Saudi Arabia', il: 'Israel', sg: 'Singapore', my: 'Malaysia', hk: 'Hong Kong', tw: 'Taiwan',
};

export function countryName(input: string): string {
  const k = input.trim().toLowerCase();
  return COUNTRY_NAMES[k] ?? input.trim().replace(/\b\w/g, (c) => c.toUpperCase());
}

async function countrySeed(value: string, limit: number, ctx: SeedContext): Promise<SeedResult> {
  const name = countryName(value);
  const parts: SeedArtist[][] = [];
  const notes: string[] = [];
  if (ctx.lastfmApiKey) {
    try {
      const geo = await lastfm.geoTopArtists(ctx.lastfmApiKey, name, Math.min(100, limit * 2), ctx.signal);
      if (geo.length) {
        parts.push(geo.map((a, i) => ({ name: a.name, weight: 2 / (1 + i / 20) })));
        notes.push(`Last.fm listeners in ${name} (${geo.length})`);
      }
    } catch (err) {
      if (isAbort(err)) throw err;
      log.info('lastfm geo lookup failed', String(err));
    }
  }
  // Deezer publishes "Top <Country>" chart playlists under the user "Deezer Charts".
  let dz = await deezerPlaylistSeed(`Top ${name}`, limit * 2, ctx, { officialOnly: true, maxPlaylists: 2 });
  if (!dz.artists.length) dz = await deezerPlaylistSeed(`${name} hits`, limit * 2, ctx, { maxPlaylists: 3 });
  if (dz.artists.length) {
    parts.push(dz.artists);
    notes.push(dz.note);
  } else if (!parts.length) notes.push(dz.note);
  return { artists: mergeSeedArtists(parts).slice(0, limit), note: notes.join('; ') };
}

async function playlistSeed(value: string, limit: number, ctx: SeedContext): Promise<SeedResult> {
  const src = await resolveSource(value, { signal: ctx.signal });
  const artists = src.artists.slice(0, limit).map((a) => ({ name: a.name, weight: a.weight, deezerId: a.deezerArtistId }));
  return { artists, note: `${clean(src.label, 40)} (${src.tracks.length} tracks, ${src.artists.length} artists)` };
}

async function tasteSeed(limit: number, ctx: SeedContext): Promise<SeedResult> {
  const src = await resolveSource('me', { signal: ctx.signal });
  return { artists: src.artists.slice(0, limit).map((a) => ({ name: a.name, weight: a.weight })), note: `your top and followed artists (${src.artists.length})` };
}

// ---------------------------------------------------------------------------
// Blend: artists several people (playlists, profiles) would all enjoy.
// ---------------------------------------------------------------------------

export interface BlendSide {
  label: string;
  /** Artists actually on this side. */
  direct: SeedArtist[];
  /** Artists similar to this side's top artists. */
  expanded: SeedArtist[];
}

/** Pure: rank artists by how many sides they touch (directly counts double), then weight. */
export function scoreBlend(sides: BlendSide[], minShared: number): { artists: SeedArtist[]; sidesOf: Map<string, number> } {
  type Row = { artist: SeedArtist; sides: Set<number>; directSides: Set<number>; weight: number };
  const rows = new Map<string, Row>();
  sides.forEach((side, i) => {
    const bump = (a: SeedArtist, direct: boolean) => {
      const k = fold(a.name);
      if (!k) return;
      const r = rows.get(k) ?? { artist: { ...a, weight: 0 }, sides: new Set<number>(), directSides: new Set<number>(), weight: 0 };
      r.sides.add(i);
      if (direct) r.directSides.add(i);
      r.weight += a.weight * (direct ? 2 : 1);
      r.artist.deezerId = r.artist.deezerId ?? a.deezerId;
      r.artist.nbFan = r.artist.nbFan ?? a.nbFan;
      rows.set(k, r);
    };
    side.direct.forEach((a) => bump(a, true));
    side.expanded.forEach((a) => bump(a, false));
  });
  const kept = [...rows.entries()].filter(([, r]) => r.sides.size >= minShared);
  kept.sort((a, b) => b[1].sides.size - a[1].sides.size || b[1].directSides.size - a[1].directSides.size || b[1].weight - a[1].weight);
  const sidesOf = new Map<string, number>();
  const artists = kept.map(([k, r]) => {
    sidesOf.set(k, r.sides.size);
    return { ...r.artist, weight: r.weight };
  });
  return { artists, sidesOf };
}

const BLEND_TOP_PER_SIDE = 20;
const BLEND_RELATED_PER_ARTIST = 15;

async function blendSeed(seed: SeedSpec, limit: number, ctx: SeedContext): Promise<SeedResult> {
  const sources = (seed.sources ?? []).map((s) => s.trim()).filter(Boolean);
  if (sources.length < 2) throw new LineupifyError('BLEND_NEEDS_SOURCES', 'A blend seed needs 2 to 4 sources (playlist links, draft ids or "me").');
  if (sources.length > 4) throw new LineupifyError('BLEND_TOO_MANY', 'A blend seed takes at most 4 sources.');
  const resolved = await mapLimit(sources, 2, (s) => resolveSource(s, { signal: ctx.signal }));
  const sides: BlendSide[] = await mapLimit(resolved, 2, async (src) => {
    const direct: SeedArtist[] = src.artists.slice(0, 60).map((a) => ({ name: a.name, weight: a.weight, deezerId: a.deezerArtistId }));
    const top = direct.slice(0, BLEND_TOP_PER_SIDE);
    const related = await mapLimit(top, 3, async (a) => {
      try {
        const dz = a.deezerId ? { id: a.deezerId, name: a.name, nbFan: 0 } : await resolveDeezerArtist(a.name, ctx.signal);
        if (!dz) return [] as SeedArtist[];
        const rel = await deezer.relatedArtists(dz.id, BLEND_RELATED_PER_ARTIST, ctx.signal);
        return rel.map((r, i) => ({ name: r.name, weight: (a.weight / (1 + i / 5)) * 0.5, deezerId: r.id, nbFan: r.nbFan }));
      } catch (err) {
        if (isAbort(err)) throw err;
        log.info(`related lookup failed for ${a.name}`, String(err));
        return [] as SeedArtist[];
      }
    });
    return { label: src.label, direct, expanded: mergeSeedArtists(related) };
  });
  const minShared = Math.max(2, Math.min(sides.length, seed.minShared ?? sides.length));
  const { artists, sidesOf } = scoreBlend(sides, minShared);
  const picked = artists.slice(0, limit);
  const onAll = picked.filter((a) => (sidesOf.get(fold(a.name)) ?? 0) >= sides.length).length;
  const note = `blend of ${sides.map((s) => clean(s.label, 30)).join(' + ')}: ${artists.length} artists on ${minShared}+ sides (${onAll} of the ${picked.length} picked on every side)`;
  return { artists: picked, note };
}

export async function expandSeed(seed: SeedSpec, ctx: SeedContext): Promise<SeedResult> {
  const limit = clampLimit(seed.limit);
  const value = clean(seed.value ?? '', 120);
  switch (seed.type) {
    case 'genre':
      if (!value) throw new LineupifyError('SEED_VALUE_REQUIRED', 'A genre seed needs a value, e.g. "shoegaze" or "melancholic".');
      return genreSeed(value, limit, ctx);
    case 'similar_to':
      if (!value) throw new LineupifyError('SEED_VALUE_REQUIRED', 'A similar_to seed needs an artist name.');
      return similarSeed(value, limit, ctx);
    case 'chart':
      return chartSeed(limit, ctx);
    case 'country':
      if (!value) throw new LineupifyError('SEED_VALUE_REQUIRED', 'A country seed needs a country, e.g. "Brazil" or "BR".');
      return countrySeed(value, limit, ctx);
    case 'playlist':
      if (!value) throw new LineupifyError('SEED_VALUE_REQUIRED', 'A playlist seed needs a playlist link, id or name.');
      return playlistSeed(value, limit, ctx);
    case 'taste':
      return tasteSeed(limit, ctx);
    case 'blend':
      return blendSeed(seed, limit, ctx);
    default:
      throw new LineupifyError('BAD_SEED', `Unknown seed type "${String((seed as { type?: string }).type)}".`);
  }
}

export function seedLabel(seed: SeedSpec): string {
  switch (seed.type) {
    case 'chart':
      return 'chart';
    case 'taste':
      return 'taste';
    case 'blend':
      return `blend ${(seed.sources ?? []).map((s) => clean(s, 24)).join(' + ')}`;
    default:
      return `${seed.type} "${clean(seed.value ?? '', 40)}"`;
  }
}
