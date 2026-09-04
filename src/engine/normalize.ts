/**
 * Name and title normalization. Every comparison between a lineup name, a
 * Deezer/Last.fm name and a Spotify name goes through `fold` so both sides are
 * treated identically. Query-only transformations (suffix stripping,
 * collab splitting) live here too so they can be unit-tested against real
 * poster fixtures.
 */

const APOSTROPHES = /[‘’‚‛′´`]/g;
const QUOTES = /[“”„‟″]/g;
const DASHES = /[‐-―−]/g;

/** Canonical form for equality checks. Never returns an empty string for non-empty input. */
export function fold(input: string): string {
  const raw = String(input ?? '').trim();
  if (!raw) return '';
  let s = raw
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ß/g, 'ss')
    .replace(/ø/gi, 'o')
    .replace(/æ/gi, 'ae')
    .replace(/œ/gi, 'oe')
    .replace(/đ/gi, 'd')
    .replace(/ł/gi, 'l')
    .replace(APOSTROPHES, "'")
    .replace(QUOTES, '"')
    .replace(DASHES, '-')
    .toLowerCase()
    .replace(/\$/g, 's')
    .replace(/\s*&\s*|\s*\+\s*|\s+and\s+/g, ' and ')
    .replace(/\s+/g, ' ')
    .trim();
  // Strip "the " prefix only for matching purposes.
  s = s.replace(/^the\s+/, '');
  // Drop punctuation that varies between catalogs, but keep a non-empty key.
  const stripped = s.replace(/[.,!?:;"'()[\]{}]/g, '').replace(/\s+/g, ' ').trim();
  return stripped || s || raw.toLowerCase();
}

/** Looser key used for text-search comparisons: also drops anything in parentheses and " - ..." suffixes. */
export function titleKey(title: string): string {
  return fold(stripTitleDecorations(title));
}

export function stripTitleDecorations(title: string): string {
  return String(title ?? '')
    .replace(/\s*[([{][^)\]}]*[)\]}]\s*/g, ' ')
    .replace(/\s+-\s+.*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const SET_SUFFIXES = [
  'dj set',
  'live',
  'live set',
  'hybrid set',
  'hybrid live',
  'album set',
  'full live band',
  'live band',
  'all night long',
  'extended set',
  'closing set',
  'opening set',
  'secret set',
  'piano set',
  'sunset set',
  'special set',
  'special guest',
  'solo',
  'acoustic',
  'uk',
  'us',
  'usa',
  'aus',
  'jp',
  'de',
  'fr',
  'ca',
  'nz',
];

/**
 * Strip trailing performance-type parentheticals: "Wet Leg (DJ set)" -> "Wet Leg".
 * Returns the stripped form plus the suffix found, if any.
 */
export function stripSetSuffix(name: string): { stripped: string; suffix?: string } {
  const m = name.match(/^(.*?)\s*[([{]\s*([^)\]}]+?)\s*[)\]}]\s*$/);
  if (m && m[1] && m[2]) {
    const inner = m[2].toLowerCase().trim();
    if (SET_SUFFIXES.includes(inner) || /^\d{4}$/.test(inner) || /^(dj|live|hybrid|acoustic|solo|piano|extended|closing|secret|special|album|full)\b/.test(inner)) {
      return { stripped: m[1].trim(), suffix: m[2].trim() };
    }
  }
  // "Artist - Live" / "Artist – DJ set" style
  const dash = name.match(/^(.*?)\s+[-–—]\s+(dj set|live|live set|hybrid set|acoustic)\s*$/i);
  if (dash && dash[1] && dash[2]) return { stripped: dash[1].trim(), suffix: dash[2].trim() };
  return { stripped: name.trim() };
}

/** Splits "A b2b B", "A x B", "A vs B", "A B3B B B2B C" into parts. Returns undefined when there is no separator. */
export function splitCollab(name: string): string[] | undefined {
  const parts = name
    .split(/\s+(?:b2b|b3b|b2b2b|x|×|vs\.?|versus)\s+/i)
    .map((p) => p.trim())
    .filter(Boolean);
  return parts.length > 1 ? parts : undefined;
}

/** Splits on " & ", " + " or " and " for a second attempt when the joined name fails to resolve. */
export function splitAmpersand(name: string): string[] | undefined {
  const parts = name
    .split(/\s*&\s*|\s*\+\s*|\s+and\s+/i)
    .map((p) => p.trim())
    .filter(Boolean);
  return parts.length > 1 ? parts : undefined;
}

const LABEL_PRESENTS = /^(.+?)\s+(presents|pres\.|invites|takeover|showcase)(?=\s|:|-|$)/i;
/** "Boiler Room presents X" / "Defected presents ..." -> a label or brand, not an artist. */
export function labelPresents(name: string): { label: string; rest: string } | undefined {
  const m = name.match(LABEL_PRESENTS);
  if (!m || !m[1]) return undefined;
  const rest = name.slice(m[0].length).replace(/^[:\s-]+/, '').trim();
  return { label: m[1].trim(), rest };
}

const HEADER_WORDS = [
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'mon', 'tue', 'tues', 'wed', 'thu', 'thur', 'thurs', 'fri', 'sat', 'sun',
  'day 1', 'day 2', 'day 3', 'day 4', 'day one', 'day two', 'day three',
  'weekend 1', 'weekend 2', 'weekend one', 'weekend two',
  'tickets', 'tickets on sale', 'on sale now', 'sold out', 'buy now', 'presented by', 'sponsored by',
  'and many more', 'and more', 'more tba', 'plus more', 'more to be announced', 'tba', 'tbc', 'tbd',
  'special guest', 'special guests', 'very special guest', 'very special guests', 'surprise guest',
  'lineup', 'line-up', 'line up', 'full lineup', 'phase 1', 'phase 2', 'phase one', 'phase two',
  'in alphabetical order', 'alphabetical', 'a-z', 'and', '&', 'with', 'featuring', 'feat',
  'main stage', 'mainstage', 'second stage', 'the other stage', 'other stage', 'pyramid stage', 'west holts',
  'stage', 'tent', 'arena', 'dome', 'garden', 'forest', 'beach', 'bar', 'area', 'field',
];

const HEADER_PATTERNS = [
  /^\d{1,2}(st|nd|rd|th)?\s*([-–]\s*\d{1,2}(st|nd|rd|th)?\s*)?(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?(\s+\d{2,4})?$/i,
  /^(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(st|nd|rd|th)?(\s*[-–]\s*\d{1,2}(st|nd|rd|th)?)?(,?\s+\d{4})?$/i,
  /^\d{1,2}[./-]\d{1,2}([./-]\d{2,4})?$/,
  /^(19|20)\d{2}$/,
  /^(www\.)?[a-z0-9-]+\.(com|net|org|co\.uk|de|fr|es|nl|be|io|live|fest|dk|se|no)(\/.*)?$/i,
  /^[@#][a-z0-9_]+$/i,
  /^(day|weekend|phase|stage)\s*\d+$/i,
  /^.*\b(stage|tent|arena)\s*:?\s*$/i,
  /^(free|all ages|18\+|21\+|16\+)$/i,
  /^(tickets?( on sale( now)?)?|on sale( now)?|sold out|early bird( tickets?)?|presale|pre-sale|line-?up (announced|revealed)|weekend (passes?|tickets?)|camping( available)?)$/i,
  /^(and|&|plus|\+)\s+(many\s+)?(more|others|special guests?)/i,
  /^\+\s*(more|many more|special guests?)$/i,
  /^[-–—•·|/*.]+$/,
];

/** True for tokens that are poster furniture (days, dates, stages, "tickets"), never artists. */
export function isHeaderToken(token: string): boolean {
  const raw = token.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!raw) return true;
  const t = raw.replace(/[!.:]+$/, '') || raw;
  if (HEADER_WORDS.includes(t)) return true;
  return HEADER_PATTERNS.some((re) => re.test(t));
}

const DAY_RE = /^(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun|day\s*(?:1|2|3|4|one|two|three|four)|weekend\s*(?:1|2|one|two))\b/i;
export function detectDay(token: string): string | undefined {
  const t = token.trim();
  const m = t.match(DAY_RE);
  if (!m) return undefined;
  const raw = m[1]!.toLowerCase().replace(/\s+/g, ' ');
  const map: Record<string, string> = {
    mon: 'monday', tue: 'tuesday', tues: 'tuesday', wed: 'wednesday', thu: 'thursday', thur: 'thursday',
    thurs: 'thursday', fri: 'friday', sat: 'saturday', sun: 'sunday',
  };
  return map[raw] ?? raw;
}

const STAGE_RE = /^(.{2,40}?)\s*(stage|tent|arena|dome)\b\s*:?\s*$/i;
export function detectStage(token: string): string | undefined {
  const m = token.trim().match(STAGE_RE);
  return m ? token.trim().replace(/\s*:\s*$/, '') : undefined;
}

const VERSION_RE = /\b(live|remix|rmx|edit|radio edit|karaoke|instrumental|acoustic|sped up|slowed|demo|mix|dub|bootleg|rework|refix|vip|version|extended)\b/i;
const NON_VERSION_RE = /\b(remaster(ed)?|mono|stereo|deluxe|anniversary|expanded|bonus|single version|album version|original mix|original version)\b/i;

/**
 * Classify a Deezer title_version or a title's parenthetical/dash suffix.
 * "isVersion" = alternate performance (skip by default); remasters etc. are not versions.
 */
export function classifyVersion(titleVersion: string | undefined, title: string): { isVersion: boolean } {
  const suffixes: string[] = [];
  if (titleVersion) suffixes.push(titleVersion);
  const parens = title.match(/[([{]([^)\]}]*)[)\]}]/g);
  if (parens) suffixes.push(...parens);
  const dash = title.match(/\s+-\s+(.+)$/);
  if (dash && dash[1]) suffixes.push(dash[1]);
  for (const s of suffixes) {
    const t = s.toLowerCase();
    if (NON_VERSION_RE.test(t) && !/\b(live|remix|edit|acoustic|instrumental|karaoke|demo)\b/.test(t)) continue;
    if (/\bfeat\.?\b|\bft\.?\b|\bwith\b|\bfrom\b/.test(t) && !VERSION_RE.test(t)) continue;
    if (VERSION_RE.test(t)) return { isVersion: true };
  }
  return { isVersion: false };
}

const CLONE_RE = /\b(karaoke|tribute|cover(s)?|made famous|in the style of|originally performed|instrumental version|backing track|8-bit|lullaby|string quartet|piano tribute)\b/i;
export function looksLikeClone(artistName: string): boolean {
  return CLONE_RE.test(artistName);
}

/** Convert an ISRC to canonical form or undefined when it isn't one. */
export function normalizeIsrc(isrc: unknown): string | undefined {
  if (typeof isrc !== 'string') return undefined;
  const s = isrc.replace(/[\s-]/g, '').toUpperCase();
  return /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(s) ? s : undefined;
}
