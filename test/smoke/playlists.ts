/**
 * Manual smoke test for the 0.2.0 read/analyse/seed paths against the live
 * Spotify and Deezer APIs. Needs a connected account and a public, user-made
 * Spotify playlist link as the first argument (Spotify-made playlists 404).
 * Run: npx tsx test/smoke/playlists.ts <playlist-link>
 */
/* eslint-disable no-console */
import * as spotify from '../../src/sources/spotify.js';
import * as deezer from '../../src/sources/deezer.js';
import { parsePlaylistRef, readPlaylist, tasteProfile } from '../../src/engine/playlists.js';
import { basicStats, enrichStats, renderStats } from '../../src/engine/analyze.js';
import { expandSeed } from '../../src/engine/seeds.js';

async function main(): Promise<void> {
  const tokens = await spotify.loadTokens();
  if (!tokens) throw new Error('not connected; run lineupify-mcp auth');
  const link = process.argv[2];
  if (!link) {
    console.error('Usage: npx tsx test/smoke/playlists.ts <public Spotify playlist link>');
    process.exit(2);
  }
  const granted = new Set((tokens.scope || '').split(/\s+/));
  const missing = spotify.SCOPES.filter((s) => !granted.has(s));
  console.log(`connected as ${tokens.displayName || tokens.userId}; missing scopes: ${missing.join(', ') || 'none'}`);

  const t0 = Date.now();
  const snap = await readPlaylist(parsePlaylistRef(link), { refresh: true });
  console.log(`read "${snap.name}" by ${snap.owner}: ${snap.tracks.length}/${snap.total} tracks in ${Date.now() - t0} ms; with ISRC ${snap.tracks.filter((t) => t.isrc).length}`);

  const t1 = Date.now();
  const stats = await enrichStats(basicStats(snap.tracks), snap.tracks, { genres: true, bpm: true });
  console.log(renderStats(stats, snap.name));
  console.log(`analysis in ${Date.now() - t1} ms`);

  const taste = await tasteProfile();
  console.log(`taste profile: ${taste.length} artists, top: ${taste.slice(0, 5).map((a) => a.name).join(', ')}`);

  for (const seed of [{ type: 'similar_to' as const, value: 'Khruangbin', limit: 10 }, { type: 'genre' as const, value: 'shoegaze', limit: 10 }, { type: 'country' as const, value: 'Brazil', limit: 10 }, { type: 'chart' as const, limit: 5 }]) {
    const t = Date.now();
    const r = await expandSeed(seed, {});
    console.log(`seed ${seed.type} ${seed.value ?? ''}: ${r.artists.length} artists in ${Date.now() - t} ms (${r.note}) -> ${r.artists.slice(0, 6).map((a) => a.name).join(', ')}`);
  }

  const hits = await deezer.searchTracksByTitle('Enter Sandman', 10);
  console.log(`cover check data: top recording of "Enter Sandman" is by ${hits[0]?.artistName} (rank ${hits[0]?.rank})`);

  if (!missing.includes('user-library-read')) {
    const lib = await spotify.savedTracks(50);
    console.log(`library: ${lib.tracks.length} of ${lib.total} saved tracks read`);
  } else console.log('library read skipped: reconnect with `lineupify-mcp auth --force` to grant user-library-read');
  console.log('ALL OK');
}

main().catch((err) => {
  console.error('SMOKE FAILED:', err);
  process.exit(1);
});
