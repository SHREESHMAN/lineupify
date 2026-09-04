/**
 * Manual smoke test against the live Spotify API. Needs a connected account
 * (`lineupify-mcp auth`). Exercises every endpoint Lineupify uses so a future
 * Spotify change fails loudly in one place. Run: npm run smoke:spotify
 */
/* eslint-disable no-console */
import * as spotify from '../../src/sources/spotify.js';
import { rankIsrcHits } from '../../src/engine/match.js';

async function main(): Promise<void> {
  const tokens = await spotify.loadTokens();
  if (!tokens) throw new Error('not connected; run lineupify-mcp auth');
  console.log(`connected as ${tokens.displayName || tokens.userId}; API snapshot ${spotify.SPOTIFY_API_SNAPSHOT}`);

  const me = await spotify.me();
  console.log('GET /me ok', me.id);

  const isrcHits = await spotify.searchByIsrc('GBAHS2100041'); // Fred again.. – Marea
  const best = rankIsrcHits(isrcHits, 'Fred again..');
  console.log(`search isrc: ${isrcHits.length} hits, best: ${best?.name} (${best?.albumType}, ${best?.releaseDate})`);
  if (!best) throw new Error('ISRC search returned nothing');

  const text = await spotify.searchTracks('track:Chaise Longue artist:Wet Leg', 5);
  console.log(`search text: ${text.length} hits, first: ${text[0]?.artists.map((a) => a.name).join(', ')} – ${text[0]?.name}`);

  const artists = await spotify.searchArtists('Kneecap');
  console.log(`search artist: ${artists.map((a) => a.name).join(', ')}`);
  if (artists[0]) {
    const albums = await spotify.artistAlbums(artists[0].id, 2);
    console.log(`artist albums: ${albums.map((a) => a.name).join(' | ')}`);
    if (albums[0]) {
      const tracks = await spotify.albumTracks(albums[0]);
      console.log(`album tracks: ${tracks.length}`);
    }
  }

  const top = await spotify.topArtists('medium_term');
  console.log(`top artists (6 months): ${top.length}`);
  const following = await spotify.followedArtists();
  console.log(`following: ${following.length}`);

  const created = await spotify.createPlaylist('Lineupify smoke', 'temporary playlist created by the Lineupify smoke test', false);
  console.log(`created playlist ${created.id} ${created.url}`);

  const uris: string[] = [];
  for (const q of ['artist:Fred again', 'artist:Wet Leg', 'artist:Kneecap', 'artist:Genesis', 'artist:Tyler the Creator', 'artist:Charli xcx']) {
    const hits = await spotify.searchTracks(q, 10);
    for (const h of hits) if (h.isPlayable && !uris.includes(h.uri)) uris.push(h.uri);
  }
  // Pad to more than one chunk by repeating known-good tracks? Spotify allows duplicates, so repeat to reach 150.
  while (uris.length < 150 && uris.length > 0) uris.push(uris[uris.length % Math.max(1, Math.min(uris.length, 40))]!);
  console.log(`adding ${uris.length} tracks in chunks of 100`);
  for (let i = 0; i < uris.length; i += 100) await spotify.addItems(created.id, uris.slice(i, i + 100));

  let state = await spotify.playlistState(created.id);
  console.log(`playlist state: total ${state.total}, snapshot ${state.snapshotId.slice(0, 12)}…`);

  await spotify.replaceItems(created.id, uris.slice(0, 20));
  state = await spotify.playlistState(created.id);
  console.log(`after replace: total ${state.total}`);

  await spotify.changePlaylistDetails(created.id, { name: '[delete me] Lineupify smoke', description: 'safe to delete' });
  console.log('renamed to "[delete me] Lineupify smoke" — Spotify has no delete endpoint; remove it from your library by hand.');
  console.log('ALL OK');
}

main().catch((err) => {
  console.error('SMOKE FAILED:', err);
  process.exit(1);
});
