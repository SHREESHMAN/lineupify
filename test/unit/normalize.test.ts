import { describe, it, expect } from 'vitest';
import {
  classifyVersion,
  detectDay,
  detectStage,
  fold,
  isHeaderToken,
  labelPresents,
  looksLikeClone,
  normalizeIsrc,
  splitAmpersand,
  splitCollab,
  stripSetSuffix,
  stripTitleDecorations,
  titleKey,
} from '../../src/engine/normalize.js';

describe('fold', () => {
  it('lowercases and strips diacritics', () => {
    expect(fold('Beyoncé')).toBe('beyonce');
    expect(fold('Motörhead')).toBe('motorhead');
    expect(fold('Sigur Rós')).toBe('sigur ros');
    expect(fold('Røyksopp')).toBe('royksopp');
    expect(fold('CHARLI XCX')).toBe('charli xcx');
  });

  it('expands ß and maps $ to s', () => {
    expect(fold('Straße')).toBe('strasse');
    expect(fold('A$AP Rocky')).toBe('asap rocky');
    expect(fold('Ke$ha')).toBe('kesha');
  });

  it('treats &, + and "and" as equivalent', () => {
    expect(fold('Simon & Garfunkel')).toBe('simon and garfunkel');
    expect(fold('Simon and Garfunkel')).toBe(fold('Simon & Garfunkel'));
    expect(fold('Mumford + Sons')).toBe(fold('Mumford and Sons'));
    expect(fold('Earth, Wind & Fire')).toBe('earth wind and fire');
  });

  it('normalizes apostrophe variants and drops them', () => {
    expect(fold("Guns N' Roses")).toBe('guns n roses');
    expect(fold('Guns N’ Roses')).toBe(fold("Guns N' Roses"));
    expect(fold('Guns N` Roses')).toBe(fold("Guns N' Roses"));
    expect(fold("Barry Can't Swim")).toBe('barry cant swim');
  });

  it('strips a leading "the "', () => {
    expect(fold('The 1975')).toBe('1975');
    expect(fold('The Cure')).toBe('cure');
    expect(fold('THE LAST DINNER PARTY')).toBe('last dinner party');
    expect(fold('Theo Parrish')).toBe('theo parrish');
  });

  it('drops catalog-varying punctuation but never returns an empty key', () => {
    expect(fold('Fontaines D.C.')).toBe('fontaines dc');
    expect(fold('Fred again..')).toBe('fred again');
    expect(fold('Tyler, The Creator')).toBe('tyler the creator');
    expect(fold('!!!')).toBe('!!!');
    expect(fold('!!!')).not.toBe('');
    expect(fold('...')).not.toBe('');
  });

  it('collapses whitespace and handles empty/nullish input', () => {
    expect(fold('  Hot   Chip  ')).toBe('hot chip');
    expect(fold('')).toBe('');
    expect(fold(undefined as unknown as string)).toBe('');
  });
});

describe('stripTitleDecorations / titleKey', () => {
  it('removes parentheticals and dash suffixes', () => {
    expect(stripTitleDecorations('Song (Remastered 2009)')).toBe('Song');
    expect(stripTitleDecorations('Song - Radio Edit')).toBe('Song');
    expect(stripTitleDecorations('Song [Live] - 2011 Remaster')).toBe('Song');
    expect(stripTitleDecorations('Blinding Lights (feat. X) {Bonus}')).toBe('Blinding Lights');
  });

  it('keeps hyphenated words that are not " - " suffixes', () => {
    expect(stripTitleDecorations('Semi-Charmed Life')).toBe('Semi-Charmed Life');
    expect(stripTitleDecorations('  Hello   World ')).toBe('Hello World');
  });

  it('titleKey folds the stripped title', () => {
    expect(titleKey('Blinding Lights (feat. X)')).toBe('blinding lights');
    expect(titleKey('Boys Don’t Cry - 2006 Remaster')).toBe('boys dont cry');
    expect(titleKey('Song (Live)')).toBe(titleKey('Song'));
  });
});

describe('stripSetSuffix', () => {
  it('strips performance-type parentheticals', () => {
    expect(stripSetSuffix('Wet Leg (DJ set)')).toEqual({ stripped: 'Wet Leg', suffix: 'DJ set' });
    expect(stripSetSuffix('WET LEG (DJ SET)')).toEqual({ stripped: 'WET LEG', suffix: 'DJ SET' });
    expect(stripSetSuffix('Bicep (Live)')).toEqual({ stripped: 'Bicep', suffix: 'Live' });
    expect(stripSetSuffix('Bicep [Live Set]')).toEqual({ stripped: 'Bicep', suffix: 'Live Set' });
    expect(stripSetSuffix('Fred again.. (Hybrid Live)')).toEqual({ stripped: 'Fred again..', suffix: 'Hybrid Live' });
    expect(stripSetSuffix('Artist (UK)')).toEqual({ stripped: 'Artist', suffix: 'UK' });
    expect(stripSetSuffix('Artist (2024)')).toEqual({ stripped: 'Artist', suffix: '2024' });
  });

  it('handles the dash form', () => {
    expect(stripSetSuffix('Artist - DJ set')).toEqual({ stripped: 'Artist', suffix: 'DJ set' });
    expect(stripSetSuffix('Artist – Live')).toEqual({ stripped: 'Artist', suffix: 'Live' });
  });

  it('leaves non-suffix parentheticals and plain names alone', () => {
    expect(stripSetSuffix('Anderson .Paak (feat. Bruno)')).toEqual({ stripped: 'Anderson .Paak (feat. Bruno)' });
    expect(stripSetSuffix('Plain Name')).toEqual({ stripped: 'Plain Name' });
    expect(stripSetSuffix('  Padded  ')).toEqual({ stripped: 'Padded' });
    expect(stripSetSuffix('Simon & Garfunkel')).toEqual({ stripped: 'Simon & Garfunkel' });
  });
});

describe('splitCollab', () => {
  it('splits b2b / x / vs collaborations', () => {
    expect(splitCollab('Skrillex b2b Four Tet b2b Fred again..')).toEqual(['Skrillex', 'Four Tet', 'Fred again..']);
    expect(splitCollab('SKRILLEX B2B FOUR TET B2B FRED AGAIN..')).toEqual(['SKRILLEX', 'FOUR TET', 'FRED AGAIN..']);
    expect(splitCollab('Mura Masa x Shygirl')).toEqual(['Mura Masa', 'Shygirl']);
    expect(splitCollab('MURA MASA X SHYGIRL')).toEqual(['MURA MASA', 'SHYGIRL']);
    expect(splitCollab('A × B')).toEqual(['A', 'B']);
    expect(splitCollab('Jay-Z vs Nas')).toEqual(['Jay-Z', 'Nas']);
    expect(splitCollab('Jay-Z vs. Nas')).toEqual(['Jay-Z', 'Nas']);
    expect(splitCollab('A versus B')).toEqual(['A', 'B']);
    expect(splitCollab('A b3b B b3b C')).toEqual(['A', 'B', 'C']);
  });

  it('does not split names that merely contain x', () => {
    expect(splitCollab('Charli xcx')).toBeUndefined();
    expect(splitCollab('CHARLI XCX')).toBeUndefined();
    expect(splitCollab('Lil Nas X')).toBeUndefined();
    expect(splitCollab('Xzibit')).toBeUndefined();
    expect(splitCollab('Jamie xx')).toBeUndefined();
    expect(splitCollab('Plain Name')).toBeUndefined();
  });
});

describe('splitAmpersand', () => {
  it('splits on &, + and " and "', () => {
    expect(splitAmpersand('Simon & Garfunkel')).toEqual(['Simon', 'Garfunkel']);
    expect(splitAmpersand('Simon&Garfunkel')).toEqual(['Simon', 'Garfunkel']);
    expect(splitAmpersand('Mumford + Sons')).toEqual(['Mumford', 'Sons']);
    expect(splitAmpersand('Above and Beyond')).toEqual(['Above', 'Beyond']);
    expect(splitAmpersand('Earth, Wind & Fire')).toEqual(['Earth, Wind', 'Fire']);
  });

  it('does not split "and" inside words or names without separators', () => {
    expect(splitAmpersand('Andrew Bird')).toBeUndefined();
    expect(splitAmpersand('Sandra')).toBeUndefined();
    expect(splitAmpersand('Kneecap')).toBeUndefined();
  });
});

describe('labelPresents', () => {
  it('extracts the artist after a brand "presents"', () => {
    expect(labelPresents('Boiler Room presents HAAi')).toEqual({ label: 'Boiler Room', rest: 'HAAi' });
    expect(labelPresents('BOILER ROOM PRESENTS HAAI')).toEqual({ label: 'BOILER ROOM', rest: 'HAAI' });
    expect(labelPresents('Defected Presents: Sam Divine')).toEqual({ label: 'Defected', rest: 'Sam Divine' });
    expect(labelPresents('Defected pres. Sam Divine')).toEqual({ label: 'Defected', rest: 'Sam Divine' });
    expect(labelPresents('Charlotte de Witte invites Enrico Sangiuliano')).toEqual({ label: 'Charlotte de Witte', rest: 'Enrico Sangiuliano' });
    expect(labelPresents('Drumcode Takeover - Adam Beyer')).toEqual({ label: 'Drumcode', rest: 'Adam Beyer' });
    expect(labelPresents('Anjuna Showcase')).toEqual({ label: 'Anjuna', rest: '' });
  });

  it('returns undefined for ordinary names', () => {
    expect(labelPresents('Kneecap')).toBeUndefined();
    expect(labelPresents('Presents')).toBeUndefined();
    expect(labelPresents('The Presidents of the USA')).toBeUndefined();
  });
});

describe('isHeaderToken', () => {
  it('recognises dates in several formats', () => {
    for (const d of ['26 JUNE', '26TH JUNE 2026', '26th Jun', '26-28 JUNE 2026', '26TH - 28TH JUNE 2026', 'JUNE 26', 'JUNE 26-28, 2026', 'Aug 30th', '26/06/2026', '26.06', '26-06-26', '2026']) {
      expect(isHeaderToken(d), d).toBe(true);
    }
  });

  it('recognises day words, stages, tickets and websites', () => {
    for (const t of [
      'FRIDAY', 'Saturday', 'SUN', 'Thurs', 'DAY 1', 'DAY 2', 'WEEKEND 1', 'Weekend Two',
      'AND MANY MORE', 'and more', 'MORE TBA', 'TBA', 'TBC', '+ SPECIAL GUESTS', '+ more', 'SPECIAL GUEST', 'VERY SPECIAL GUESTS',
      'TICKETS', 'TICKETS ON SALE', 'ON SALE NOW', 'SOLD OUT', 'PRESENTED BY', 'TICKETS ON SALE NOW',
      'MAIN STAGE', 'WEST HOLTS STAGE', 'West Holts', 'John Peel Tent', 'PYRAMID STAGE', 'The Other Stage', 'Stage 2', 'Phase 1', 'STAGE',
      'www.glastonburyfestivals.co.uk', 'GLASTONBURYFESTIVALS.CO.UK', 'WWW.PRIMAVERASOUND.COM', 'readingfestival.com/tickets', 'lineupify.live',
      '@readingfestival', '#reading2026', '18+', 'ALL AGES', 'FREE', 'LINE-UP', 'IN ALPHABETICAL ORDER', 'A-Z',
      '•', '---', '|', '', '   ', 'and', '&', 'with',
    ]) {
      expect(isHeaderToken(t), JSON.stringify(t)).toBe(true);
    }
  });

  it('ignores trailing punctuation when matching furniture', () => {
    expect(isHeaderToken('FRIDAY:')).toBe(true);
    expect(isHeaderToken('TICKETS!')).toBe(true);
    expect(isHeaderToken('Main Stage.')).toBe(true);
  });

  it('never flags real artists', () => {
    for (const t of [
      'The 1975', 'Fontaines D.C.', '!!!', 'Kneecap', 'Sunflower Bean', 'Monolink', 'Sunday Service Choir',
      'Charli XCX', 'Lil Nas X', 'A$AP Rocky', 'Tyler, The Creator', 'Earth, Wind & Fire', 'Fred again..',
      'Wet Leg (DJ set)', 'Skrillex b2b Four Tet', '999999999', 'Los Campesinos!', 'Rage Against The Machine',
      'Stage Kids', 'Beach House', 'Field Music', 'Garden City Movement', 'Tent City',
    ]) {
      expect(isHeaderToken(t), t).toBe(false);
    }
  });
});

describe('detectDay', () => {
  it('extracts and expands day names', () => {
    expect(detectDay('FRIDAY 26 JUNE')).toBe('friday');
    expect(detectDay('Saturday')).toBe('saturday');
    expect(detectDay('Sat 29 Aug')).toBe('saturday');
    expect(detectDay('SUN 30 AUG')).toBe('sunday');
    expect(detectDay('THURS')).toBe('thursday');
    expect(detectDay('Tues')).toBe('tuesday');
    expect(detectDay('Wed 3rd')).toBe('wednesday');
    expect(detectDay('DAY 2')).toBe('day 2');
    expect(detectDay('Day One')).toBe('day one');
    expect(detectDay('WEEKEND 1')).toBe('weekend 1');
    expect(detectDay('  friday  ')).toBe('friday');
  });

  it('does not match artist names that merely start with a day abbreviation', () => {
    expect(detectDay('Sunflower Bean')).toBeUndefined();
    expect(detectDay('Monolink')).toBeUndefined();
    expect(detectDay('Satori')).toBeUndefined();
    expect(detectDay('Friendly Fires')).toBeUndefined();
    expect(detectDay('The 1975')).toBeUndefined();
    expect(detectDay('Daybreak')).toBeUndefined();
    expect(detectDay('')).toBeUndefined();
  });
});

describe('detectStage', () => {
  it('returns the stage name without a trailing colon', () => {
    expect(detectStage('MAIN STAGE')).toBe('MAIN STAGE');
    expect(detectStage('West Holts Stage:')).toBe('West Holts Stage');
    expect(detectStage('  Pyramid Stage  ')).toBe('Pyramid Stage');
    expect(detectStage('John Peel Tent')).toBe('John Peel Tent');
    expect(detectStage('O2 Arena')).toBe('O2 Arena');
    expect(detectStage('The Dome')).toBe('The Dome');
  });

  it('returns undefined for artists and bare/numbered stage words', () => {
    expect(detectStage('Arctic Monkeys')).toBeUndefined();
    expect(detectStage('Stage')).toBeUndefined();
    expect(detectStage('STAGE 2')).toBeUndefined();
    expect(detectStage('Stagecoach Riders')).toBeUndefined();
    expect(detectStage('Backstage Pass Holders')).toBeUndefined();
  });
});

describe('classifyVersion', () => {
  it('treats remasters, mono/stereo, deluxe and original mixes as NOT versions', () => {
    expect(classifyVersion('(Remastered 2009)', 'Song')).toEqual({ isVersion: false });
    expect(classifyVersion('Remastered', 'Song')).toEqual({ isVersion: false });
    expect(classifyVersion(undefined, 'Song - 2011 Remaster')).toEqual({ isVersion: false });
    expect(classifyVersion(undefined, 'Song (Mono)')).toEqual({ isVersion: false });
    expect(classifyVersion(undefined, 'Song (Deluxe Edition)')).toEqual({ isVersion: false });
    expect(classifyVersion('(Original Mix)', 'Song')).toEqual({ isVersion: false });
    expect(classifyVersion('(Album Version)', 'Song')).toEqual({ isVersion: false });
    expect(classifyVersion(undefined, 'Song (Bonus Track)')).toEqual({ isVersion: false });
  });

  it('treats live, remix, edit, acoustic, karaoke, demo, sped up as versions', () => {
    expect(classifyVersion('(Live)', 'Song')).toEqual({ isVersion: true });
    expect(classifyVersion('(Live at Wembley)', 'Song')).toEqual({ isVersion: true });
    expect(classifyVersion(undefined, 'Song (Live)')).toEqual({ isVersion: true });
    expect(classifyVersion(undefined, 'Song - Radio Edit')).toEqual({ isVersion: true });
    expect(classifyVersion(undefined, 'Song (Four Tet Remix)')).toEqual({ isVersion: true });
    expect(classifyVersion(undefined, 'Song [Acoustic]')).toEqual({ isVersion: true });
    expect(classifyVersion('(Karaoke Version)', 'Song')).toEqual({ isVersion: true });
    expect(classifyVersion(undefined, 'Song (Demo)')).toEqual({ isVersion: true });
    expect(classifyVersion(undefined, 'Song (Sped Up)')).toEqual({ isVersion: true });
    expect(classifyVersion(undefined, 'Song - Instrumental')).toEqual({ isVersion: true });
    expect(classifyVersion(undefined, 'Song (Live) - 2009 Remaster')).toEqual({ isVersion: true });
    expect(classifyVersion('(Live Remastered)', 'Song')).toEqual({ isVersion: true });
  });

  it('ignores version words that are part of the title itself', () => {
    expect(classifyVersion(undefined, 'Alive')).toEqual({ isVersion: false });
    expect(classifyVersion(undefined, 'Live Forever')).toEqual({ isVersion: false });
    expect(classifyVersion(undefined, "Livin' on a Prayer")).toEqual({ isVersion: false });
    expect(classifyVersion(undefined, 'Remix My Heart')).toEqual({ isVersion: false });
    expect(classifyVersion('', 'Demo Tape')).toEqual({ isVersion: false });
  });

  it('treats feat./with/from parentheticals as NOT versions', () => {
    expect(classifyVersion(undefined, 'Song (feat. X)')).toEqual({ isVersion: false });
    expect(classifyVersion('(feat. Drake)', 'Song')).toEqual({ isVersion: false });
    expect(classifyVersion(undefined, 'Song (with Y)')).toEqual({ isVersion: false });
    expect(classifyVersion(undefined, 'Song (from "Barbie")')).toEqual({ isVersion: false });
    expect(classifyVersion(undefined, 'Song (feat. X) [Live]')).toEqual({ isVersion: true });
  });
});

describe('looksLikeClone', () => {
  it('flags karaoke / tribute / cover accounts', () => {
    for (const n of ['Genesis Karaoke', 'Ameritz Karaoke Band', 'Genesis Tribute Band', 'Piano Tribute Players', 'Made Famous By Genesis', 'In the Style of Genesis', 'Vitamin String Quartet', 'Rockabye Baby Lullaby Renditions', '8-Bit Arcade', 'The Cover Guys', 'Instrumental Version Crew', 'Originally Performed by ABBA']) {
      expect(looksLikeClone(n), n).toBe(true);
    }
  });

  it('does not flag real artists', () => {
    for (const n of ['Genesis', 'Simon & Garfunkel', 'David Coverdale', 'Tribulation', 'Covenant', 'Peggy Gou', 'Fred again..']) {
      expect(looksLikeClone(n), n).toBe(false);
    }
  });
});

describe('normalizeIsrc', () => {
  it('canonicalizes valid ISRCs', () => {
    expect(normalizeIsrc('GBUM71029604')).toBe('GBUM71029604');
    expect(normalizeIsrc('gb-um7-10-29604')).toBe('GBUM71029604');
    expect(normalizeIsrc(' usrc17607839 ')).toBe('USRC17607839');
    expect(normalizeIsrc('US-S1Z-99-00001')).toBe('USS1Z9900001');
  });

  it('rejects non-ISRCs', () => {
    expect(normalizeIsrc('not-an-isrc')).toBeUndefined();
    expect(normalizeIsrc('GBUM7102960')).toBeUndefined();
    expect(normalizeIsrc('GBUM710296041')).toBeUndefined();
    expect(normalizeIsrc('1BUM71029604')).toBeUndefined();
    expect(normalizeIsrc('')).toBeUndefined();
    expect(normalizeIsrc(123)).toBeUndefined();
    expect(normalizeIsrc(null)).toBeUndefined();
    expect(normalizeIsrc(undefined)).toBeUndefined();
  });
});
