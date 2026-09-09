---
name: api-check
description: Diagnose and adapt to changes in the Spotify, Deezer or Last.fm APIs that Lineupify depends on: which endpoints are used, how to probe them live, what has already been removed, and where to record a new snapshot. Use when a build fails with SPOTIFY_HTTP_ERROR/403/404, seeds return nothing, or before trusting a new endpoint.
---

# API check

Lineupify survives on a shrinking Spotify surface plus keyless Deezer. When something breaks, find out which side moved before touching code.

## What is used, and what is already gone

Spotify (Development Mode app, PKCE, `src/sources/spotify.ts`; the file header lists the verified set and `SPOTIFY_API_SNAPSHOT` the month):
- Used: `/search` (limit ≤ 10, `market=from_token` needs `user-read-private`), `/artists/{id}/albums`, `/albums/{id}/tracks`, `/tracks/{id}`, `/me`, `/me/top/artists`, `/me/following`, `/me/playlists`, `/me/tracks`, `/playlists/{id}`, `/playlists/{id}/items` (items are under `item`, 50 per page), `/me/playlists` POST, `/playlists/{id}/items` POST/PUT, `/playlists/{id}` PUT.
- Removed for new apps and never to be reintroduced: recommendations, related artists, artist top tracks, audio features/analysis, popularity, genres on artist objects, batch `?ids=`, browse/featured/category endpoints, Spotify-made playlists (404).
- `POST /users/{user_id}/playlists` returns **403** for a Development Mode app; `POST /me/playlists` is the one that works and is what Lineupify uses. Verified 2026-09-09 while probing cover upload. Do not hand-write the `/users/` form from memory.
- `PUT /playlists/{id}/images` **works** for Development Mode apps (verified 2026-09-09): needs the `ugc-image-upload` scope, body is the base64 text of a JPEG with `Content-Type: image/jpeg`, response is 202 with an empty body, cap is 256 KB on the base64 payload.
- Scopes are granted per app+user, not per token: approving a new scope through *any* grant on the same app means an existing refresh token receives the union on its next refresh, with `authorizedAt` unchanged. So after adding a scope, a user who re-approves once is fixed everywhere; a user who never approves it keeps the old set and `status` keeps asking them to reconnect.

Deezer (`src/sources/deezer.ts`, keyless, errors as HTTP 200 bodies with `error.code`: 4 = quota → backoff, 800 = no data):
- Used: `/search/artist`, `/artist/{id}/top`, `/artist/{id}/related`, `/artist/{id}/albums` (genre_id), `/track/{id}`, `/track/isrc:{isrc}` (bpm, rank, release_date), `/search/track` (not rank-ordered; sort yourself), `/search/playlist`, `/playlist/{id}`, `/playlist/{id}/tracks`, `/chart/0/artists`, `/genre`.
- Known wrong: `/genre/{id}/artists` and `/chart/{genre}` return the global chart for any genre; do not use them.
- **Search syntax broke silently (2026-09).** On `/search/track`, any query containing the `artist:` field returns `{data: [], total: 0}` with HTTP 200 and no error. `track:"..."` alone still works, and plain text works. `findTrack` uses plain text because of this. When a lookup starts finding nothing, probe the raw query before touching the parsing: an empty result set is indistinguishable from a legitimate miss, which is exactly how this reached a release.
- Writes: impossible (app registration closed since 2025).

Last.fm (`src/sources/lastfm.ts`, optional key): `artist.gettoptracks`, `tag.gettopartists`, `artist.getsimilar`, `geo.gettopartists`, `chart.gettopartists`, `artist.gettoptags`, `artist.getinfo` (key validation). Non-commercial use only.

## Probe

Deezer, no auth:
```
curl -s "https://api.deezer.com/artist/27/related?limit=3"
curl -s "https://api.deezer.com/track/isrc:GBAYE0601498"
curl -s "https://api.deezer.com/search/playlist?q=shoegaze&limit=3"
```

Spotify, with the saved login (runs inside the project so the token store is used):
```
npx tsx -e "import('./src/sources/spotify.js').then(async s => console.log(JSON.stringify(await s.api('/playlists/<id>', { query: { fields: 'id,name,owner(id)' } }))))"
npm run smoke:spotify
```

Last.fm: `npx tsx -e "import('./src/sources/lastfm.js').then(async l => console.log(await l.tagTopArtists(process.env.LASTFM_API_KEY, 'shoegaze', 5)))"` with the key exported.

## Adapt

1. Reproduce with a probe, not from the error text alone. A 403 can be scope, user-management, or a removed endpoint; `mapError()` in `spotify.ts` distinguishes quota, rate limit and scope.
2. If Spotify removed something: drop the call, route through Deezer or Last.fm, update the header comment and `SPOTIFY_API_SNAPSHOT`, add a bullet to README *Limits* and `CHANGELOG.md`.
3. If a response shape changed: fix the parser, add a canned-JSON unit test (see `test/unit/lastfm.test.ts` and `playlist-read.test.ts` for the `setFetch` pattern), rerun the live suite.
4. If a new scope is needed: add it to `SCOPES`; `status` and `doctor` will tell existing users to reconnect. Document the scope in the README privacy table.
5. Rate limits live in `LIMITS` in `src/infra/http.ts` (Spotify 4/s, Deezer 8/s, Last.fm 4/s); raise concurrency only with a probe showing headroom.
