/**
 * parse_lineup: raw poster text -> structured artists.
 *
 * Posters are blocks (usually one per day or stage) of lines with several names
 * each. Separators are preferred in order: newline, bullet characters, pipes,
 * slashes, commas. Header lines (days, dates, stages, "tickets") are never
 * artists and start a new block. Tiers are inferred from position within a
 * block: the first content line is headliner, lines with few names are sub,
 * dense lines are undercard. A plain one-name-per-line list gets no tiers.
 */
import type { LineupArtist, Tier } from '../types.js';
import { detectDay, detectStage, isHeaderToken, labelPresents } from './normalize.js';

export interface ParsedLineup {
  artists: LineupArtist[];
  discarded: string[];
  tiered: boolean;
  days: string[];
  stages: string[];
}

const BULLETS = /\s*[•·●○◦▪■□★☆✦✧※|/⁄]+\s*/;

function splitLine(line: string): string[] {
  let parts: string[];
  if (BULLETS.test(line)) parts = line.split(BULLETS);
  else if (/\s{3,}|\t/.test(line)) parts = line.split(/\s{3,}|\t/);
  else if (/,/.test(line)) parts = line.split(/\s*,\s*/);
  else parts = [line];
  return parts.map((p) => p.trim().replace(/^[-–—*]+\s*|\s*[-–—*]+$/g, '')).filter(Boolean);
}

/** Re-join comma fragments like "Tyler" + "The Creator" when the fragment is a known continuation. */
const CONTINUATIONS = /^(the creator|the (?:band|machine|roots|kid|voice|weeknd)|wind & fire|wind and fire|stills(?:,| &| and)? (?:nash|young).*|jr\.?|sr\.?|iii|ii)$/i;
function rejoinFragments(parts: string[]): string[] {
  const out: string[] = [];
  for (const p of parts) {
    if (out.length && CONTINUATIONS.test(p)) {
      out[out.length - 1] = `${out[out.length - 1]}, ${p}`;
    } else out.push(p);
  }
  return out;
}

export function parseLineupText(text: string): ParsedLineup {
  const lines = String(text ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const artists: LineupArtist[] = [];
  const discarded: string[] = [];
  const seen = new Set<string>();
  const daysSeen: string[] = [];
  const stagesSeen: string[] = [];

  let currentDay: string | undefined;
  let currentStage: string | undefined;
  let blockLineIndex = 0;

  type Row = { names: string[]; day?: string; stage?: string; index: number };
  const rows: Row[] = [];

  for (const line of lines) {
    const day = detectDay(line);
    const stage = detectStage(line);
    if ((day || stage) && splitLine(line).length === 1) {
      if (day) {
        currentDay = day;
        if (!daysSeen.includes(day)) daysSeen.push(day);
      }
      if (stage) {
        currentStage = stage;
        if (!stagesSeen.includes(stage)) stagesSeen.push(stage);
      }
      discarded.push(line);
      blockLineIndex = 0;
      continue;
    }
    if (isHeaderToken(line)) {
      discarded.push(line);
      blockLineIndex = 0;
      continue;
    }
    const names = rejoinFragments(splitLine(line)).filter((n) => {
      if (isHeaderToken(n)) {
        discarded.push(n);
        return false;
      }
      return true;
    });
    if (!names.length) continue;
    rows.push({ names, day: currentDay, stage: currentStage, index: blockLineIndex });
    blockLineIndex++;
  }

  const maxPerLine = Math.max(0, ...rows.map((r) => r.names.length));
  const tiered = rows.length >= 3 && maxPerLine >= 2;

  for (const row of rows) {
    let tier: Tier | undefined;
    if (tiered) {
      if (row.index === 0 && row.names.length <= 4) tier = 'headliner';
      else if (row.index <= 1 || row.names.length <= Math.max(2, Math.ceil(maxPerLine / 2))) tier = 'sub';
      else tier = 'undercard';
    }
    for (const raw of row.names) {
      const lp = labelPresents(raw);
      const name = lp && lp.rest ? lp.rest : raw;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const entry: LineupArtist = { name };
      if (tier) entry.tier = tier;
      if (row.day) entry.day = row.day;
      if (row.stage) entry.stage = row.stage;
      artists.push(entry);
    }
  }

  return { artists, discarded, tiered, days: daysSeen, stages: stagesSeen };
}
