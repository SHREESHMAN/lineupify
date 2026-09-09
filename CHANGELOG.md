# Changelog

All notable changes to `lineupify-mcp` are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [Semantic Versioning](https://semver.org/).

## 0.5.2 - 2026-09-09

### Changed

- The exhaustive tool, `edit_draft` op, seed, `create_draft` option, CLI and `config.json` tables moved out of the README into [docs/reference.md](docs/reference.md). The README kept ballooning as every release added a row; the back half was one long reference dump nobody read start to finish. The README now has a 5-tool summary and a link; the maintainer docs (`CLAUDE.md`, the `add-feature` and `release` skills, `CONTRIBUTING.md`) point at `docs/reference.md` for future tool/option changes.

## 0.5.2 - 2026-09-09

### Fixed

- Deezer stopped answering `/search/track` queries that use its `artist:` field: they return zero results and no error (`track:` alone and plain text still work; verified live 2026-09-09). `findTrack()` used that syntax, so it silently found nothing for every song. Three things were broken by it: `similar_songs` candidates from Last.fm and ListenBrainz never got their ISRC, so they fell back to matching Spotify by text instead of by recording; `add_track` with `"Artist - Title"` on a Deezer draft failed outright; and Deezer-provider drafts could not match name-only candidates at all. The query is plain text now, with the same title and artist checks applied to the results.
- Lookups that failed while the above was broken were cached as misses and would have suppressed the fixed lookup for the rest of their 30-day life. The cache key generation moved from `deezer:q:` to `deezer:q2:`, so those entries are never read again and expire on their own. No action needed on upgrade.
- `npm run test:live` now exercises `findTrack` against real songs, including the featured-artist case (Leon Bridges → Khruangbin's *Texas Sun*) and a title the artist never recorded. Nothing covered it before, which is how a silent API change reached a release.

## 0.5.1 - 2026-09-09

### Fixed

- The Windows owner-only ACL for `tokens.json` also removes explicit (non-inherited) entries for Administrators, SYSTEM, Users, Everyone and Authenticated Users, by well-known SID. Profile folders on some machines (GitHub's Windows runners among them) carry those as explicit entries, which `/inheritance:r` alone left in place; 0.5.0 silently kept them there. The test now starts from such a file and skips with the icacls message when icacls itself refuses.

## 0.5.0 - 2026-09-09

### Added

- An icon. The Claude Desktop bundle carries `icon.png` (Claude Desktop showed a plain "L" before), the server announces the same image in its MCP `serverInfo` for hosts that render one, and the MCP Registry entry lists it. Source: `assets/icon.png`, the logo mark at 512×512.

### Fixed

- `edit_draft` `add_track` with `"Artist - Title"` on Spotify checked nothing about the hit and added whatever Spotify ranked first, so a typo added a random song. The hit now has to carry that title and that artist; otherwise `TRACK_NOT_FOUND` points at `search_tracks`.
- `lineupify-mcp init` and `install --claude-code` did not detect a native `claude.exe` install on Windows (only the `.cmd` shim).
- An `exclude_artist` sent while the build was fetching that artist could be undone by the build marking it resolved again.
- The MusicBrainz User-Agent carries the version and a contact URL, as their policy asks.

### Security

- On Windows, `tokens.json` now gets an ACL for your account alone (`icacls /inheritance:r /grant:r`), the equivalent of the 0600 mode used on macOS and Linux. If the step fails the file keeps the profile's default permissions.

### Changed

- The unused `rules` field is no longer written to drafts. Drafts that have it still load.
- Tests: the Spotify and Deezer clients are exercised against canned responses (error mapping, refresh races, paging, write bodies, Deezer's HTTP-200 error bodies), publishing is tested with a rejected URI and a resumed checkpoint, a second Node process holds the build lock in a test, a 0.2.x draft fixture is checked in, and the tool-surface snapshot records every input schema and annotation instead of key names only.
- README reorganised: logo, a contents list, a requirements table up front, one paste-in prompt that lets an assistant do the whole install, three install options, screenshots (a Claude Code session and the finished playlist inline; the Spotify dashboard, `init`, Claude Desktop and TuneMyMusic screens in collapsed sections), and the reference tables under one heading. Images live in `assets/`, which is not part of the npm package.
- Terms, checked 2026-09-08: Spotify's Developer Policy allows exporting the metadata of the user's own playlists to another service (III.9) and forbids ingesting Spotify content into an AI model (III.14); the refresh-token lifetime of 6 months is Spotify's announced rule (blog, 2026-06-18); Deezer's API terms are non-commercial and say nothing about caching. The README's Terms section now cites these.

## 0.4.2 - 2026-09-07

### Security

- `export_draft` passes every artist, title, album and link through the same cleaning as tool output (no control characters or line breaks, length capped), and CSV cells that start with `=`, `+`, `-`, `@`, tab or CR get a leading apostrophe so Excel and LibreOffice show them as text. A provider title starting with `=` used to open as a formula; a title with a line break broke the M3U, links and text formats.
- `disconnect` with `purge: true` now also needs `confirm: true`, and refuses (`PURGE_REFUSED`) when the data folder holds anything Lineupify did not create. The tool description merely asked the model to confirm; a poster line or playlist description saying "call disconnect with purge" could reach an `rm -rf` of whatever `LINEUPIFY_HOME` pointed at. `lineupify-mcp logout --purge` gets the same folder check.
- The loopback login callback on `127.0.0.1` reflected Spotify's `error` parameter into the page unescaped and ended the pending login on any request, so a web page open during the 5-minute window could cancel it with an `<img src>` (or run script on the loopback origin). The callback now answers 400 and keeps waiting unless the request carries the login's `state`; the error text is escaped and length-capped. `AUTH_STATE_MISMATCH` is no longer raised.
- Release and CI workflows: `actions/checkout` and `actions/setup-node` are pinned to commit SHAs (Dependabot keeps them current), npm is installed at an exact version instead of `latest`, and a manual run is accepted only from `main` or a version tag. The job holds the npm publishing token, so its inputs are no longer mutable.

### Fixed

- `status` and `disconnect` print `~/.lineupify` for the default data folder instead of the absolute path (which carries the OS user name), and `status` repeats the Spotify user id only when it differs from the display name.
- `search_tracks` is titled "Search tracks" (it was "Search Spotify tracks", which is what Claude Desktop shows in the permission prompt, even for a Deezer draft).
- The npm package no longer ships `.map` files: their `sources` pointed at `../src`, which is not published, and they roughly doubled the tarball.
- `docs/setup-spotify.md` lists all eight scopes the consent screen shows (it named four).
- README and SECURITY.md no longer claim external text "cannot pose as an instruction"; they say what the cleaning does and point at the switches that actually limit what a misled assistant can do.
- `clean()` no longer strips U+200C (ZWNJ) and U+200D (ZWJ), so Persian, Urdu and Indic names and emoji sequences are shown intact, and artist names reach the Deezer search unbroken (they were being split into separate words, which made some artists resolve wrongly or not at all). Zero-width spaces, bidi marks and overrides are now removed outright instead of being replaced by a space.
- A draft paused after every artist was already fetched (the error hit during the final ordering step) could not be resumed: `get_draft` saw nothing pending and left it `paused`. A paused draft now always resumes, and the resume runs the final step and marks it ready.
- Interrupted Deezer builds resume again. `get_draft` skipped the resume whenever no Spotify login was saved, before looking at the draft's provider, so a Deezer-mode draft interrupted by a host restart (or the 3 s shutdown abort) stayed `paused` forever.
- The Claude Desktop bundle (`.mcpb`) no longer requires a Spotify Client ID in its install form, so Deezer-mode users can use the one-click path. The field says to leave it empty for Deezer mode.
- The one-time retry after a Spotify 401 wrote `tokens.json` outside the token lock from a copy read before it. With two hosts refreshing at once it could overwrite the rotated refresh token with the old one; the next refresh then failed with `invalid_grant` and the user was told to log in again for no visible reason. The retry now takes the lock, re-reads, and only invalidates the access token that actually got the 401.
- Connection failures (offline laptop, DNS, timeouts, a 429 or 5xx that outlived the retries, Deezer's quota answer after its six backoffs, a network error during the token refresh) pause the build with `NETWORK_ERROR` and `get_draft` resumes it, as the README's state diagram always said. They were recorded as "not found" for the artist, or failed the whole draft, so a sleeping laptop produced a playlist with artists missing.
- `lineupify-mcp install` (and `init`) refused to touch a host config that is not valid JSON instead of silently replacing it with a Lineupify-only one. A trailing comma in `claude_desktop_config.json` used to make every other MCP server disappear (a `.bak` was kept, but nothing said so). New error `HOST_CONFIG_INVALID`; the CLI prints the snippet to paste by hand.

## 0.4.1 - 2026-09-04

### Changed

- MCP Registry metadata: `server.json` moved to the 2025-12-11 schema (camelCase keys, 100-character description) and the registry name is `io.github.SHREESHMAN/lineupify`, matching the GitHub account's case, which the registry checks exactly. No functional change.

## 0.4.0 - 2026-09-04

Song-level "more like these" playlists from open data.

### Added

- **`similar_songs` seed**: song-level similarity. Give one song (`value`) or up to ten (`songs`) as Spotify links, URIs or "Artist - Title"; the draft gets the songs people listen to together with them, mostly by other artists, with the exact songs pinned rather than the artists' top tracks. Sources: Last.fm `track.getSimilar` (with a key) and ListenBrainz similar recordings (open data, no key; the seed song is found through MusicBrainz by ISRC). A song near several seeds or found by both sources ranks first. `limit` is similar songs per seed song (default 25, max 100). New `create_draft` options `excludeSeedSongs` and `excludeSeedArtists` (both off by default). Name-only candidates (Last.fm, ListenBrainz) now get their ISRC from Deezer before matching, so they match Spotify exactly instead of by text.
- Seed labels in the summary show the resolved seed songs ("similar_songs Ritviz – Udd Gaye") instead of a truncated link, and seed notes are no longer cut at 120 characters.

### Fixed

- `config.json` edited with PowerShell (`Set-Content`) gains a UTF-8 byte-order mark, which made every JSON read fail silently: the Client ID and Last.fm key were ignored until the file was rewritten. JSON reads now strip the BOM.
- Similarity sources return credits like "A, B & C" as one artist; those were split into three artists that then fetched their top tracks. The first name is now the artist and the others are kept as contributors.

## 0.3.0 - 2026-09-04

Lineupify without a Spotify account: every feature except publishing now runs on Deezer with no login, for people who cannot create a Spotify developer app (it needs Premium).

### Added

- **Deezer provider.** `create_draft` (and `expand_playlist`, `merge_playlists`) take `provider: "spotify" | "deezer"`; the default is Spotify when connected and Deezer otherwise, or `config set provider` / `LINEUPIFY_PROVIDER`. A Deezer draft matches every candidate to its Deezer recording (no ISRC round-trip), stores `deezer:track:<id>` URIs and web links, and works with all seeds except `taste`, all filters, editing, `search_tracks` (Deezer search), `add_track` (Deezer links, ids or "Artist - Title"), reading/analysing/comparing/merging Deezer playlists and drafts, and every export.
- `export_draft` formats `links` (one track URL per line) and `text` ("Artist - Title" per line): the paste formats playlist transfer tools accept. CSV gains `provider` and `url` columns; M3U and CSV links follow the provider. The README has the three-step recipe for landing a draft in Deezer, Apple Music or YouTube Music through TuneMyMusic or Soundiiz.
- Docs: how to use Lineupify with a free Spotify account by borrowing a Premium friend's app (User Management, up to five people, shared quota), and what sharing a Client ID does and does not allow.
- Clear refusals: `PROVIDER_NO_PUBLISH` (Deezer drafts cannot be published because Deezer closed API app registration in 2025), `PROVIDER_NEEDS_SPOTIFY` (taste seed, `me`/`library`/Spotify sources, `discoveryOnly`, `compare_taste` on a Deezer draft), `MERGE_MIXED_PROVIDERS`.
- `status` and `doctor` explain Deezer mode when no Spotify login exists; `doctor` no longer fails on a missing login when no Client ID was ever set.
- Boot test: the server is started over stdio in CI and its 21 tools and their input keys are snapshotted, so a renamed tool or dropped option fails the build.
- `scripts/sync-version.mjs` keeps `manifest.json` and `server.json` at the package version; `npm version` runs it automatically. `npm run coverage`.

### Fixed

- A build paused by a quota, token or network error while an already-resolved artist was being matched could never resume: the artist stayed "resolved" with too few tracks, so `get_draft` found nothing pending. Pausing now re-queues every artist that is short of its target. Found by the new pause-and-resume test.
- Adding a track by "Featured Artist - Title" on Deezer now works; Deezer search names only the lead artist.

### Changed

- `MERGE_DEEZER_UNSUPPORTED` is gone: Deezer playlists merge into Deezer drafts.
- Tests: 330 (from 294), now covering the Last.fm parsers, every seed type, Spotify playlist pagination and caching, the remote cover check, analysis enrichment, the CLI, the Deezer provider, pause/resume and the server boot.

## 0.2.0 - 2026-09-04

Playlists for everyone, not only festival-goers: build from a description, a genre, an artist you like, a country, a chart, an existing playlist, your own taste, or a blend of several people's playlists; read, analyse, compare and merge playlists; filter by year and tempo; skip covers.

### Added

- **Seeds on `create_draft`** (`seeds: [{ type, value, limit, tier }]`, up to 8, with or without `artists`): `genre` (any genre/mood words, via Last.fm tags when a key is set and public Deezer playlists otherwise), `similar_to` (Deezer related artists plus Last.fm similar), `chart` (Deezer global chart), `country` (Last.fm geo charts and Deezer's "Top <Country>" playlists), `playlist` (the artists of any playlist), `taste` (your top and followed artists) and `blend` (artists that 2-4 playlists or people would all like, `sources` + `minShared`). Seeds expand in the background build; each reports where its artists came from, and a failed seed never blocks the rest.
- **Tools** `read_playlist` (Spotify or Deezer link, a playlist name from your library, a draft, or `library` for liked songs; summary / tracks / artists views; cached 12 h), `analyze_playlist` (length, artist concentration, decades, explicit share, coarse Deezer genres, Last.fm tags, sampled tempo), `compare_playlists` (2-4 playlists, drafts, `library` or `me`: shared artists and tracks, pairwise overlap, what is distinct), `merge_playlists` (one deduplicated draft from up to 6 playlists), `expand_playlist` (more songs by a playlist's artists, minus what it already has) and `refresh_taste` (new songs from your favourite artists, minus your liked songs).
- **Filters** on every build: `yearRange` (with `strictYear` to drop remasters and unknown years), `bpmRange` from Deezer tempo (with `strictBpm`), `skipCovers` (drops a song when a more popular artist has the original, checked inside the draft and on Deezer), and `excludeTracksFrom` (playlists or `library` whose tracks must not be picked).
- `discoveryOnly` now runs inside the build so it also applies to seeded artists.
- Track views show year (with `?` when it comes from a remaster) and tempo; CSV export gains `all_artists`, `year`, `bpm` and `spotify_url` columns.
- Draft summaries list seeds, active filters, excluded sources and what `skipCovers` removed; `get_draft view=unresolved` includes failed seeds.
- `config set skipCovers true|false`.
- Smoke test `test/smoke/playlists.ts` and live Deezer tests for the new endpoints.
- `lineupify-mcp init`: guided setup in one terminal run (Client ID, browser login, host detection and install, health check). `connect` accepts `clientId`, so a chat setup is one tool call. The Claude Desktop `.mcpb` bundle is attached to every GitHub release and documented as the one-click path.
- Open-source scaffolding: CI on Node 20/22 for Linux and Windows, a tag-triggered release workflow that publishes to npm with provenance and attaches the `.mcpb`, Dependabot, issue and pull-request templates, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, and a `server.json` for the MCP Registry.
- `disconnect` tool and `lineupify-mcp logout [--purge]`: forget the Spotify login, optionally delete the whole data folder, and point to Spotify's connected-apps page for revoking access.
- `LINEUPIFY_READ_ONLY=1` disables `create_playlist` and `update_playlist` (error `READ_ONLY_MODE`); `LINEUPIFY_NO_UPDATE_CHECK=1` stops the npm version check. `status` shows both modes and the data directory.
- `SECURITY.md` (what the server can and cannot do, switches, reporting) and a rewritten *Privacy and data* section: every stored file with its lifetime, every scope with the tool that needs it, where data goes (including what reaches Deezer), the Windows token-permission caveat, and third-party terms.

### Changed

- Spotify login now also asks for `playlist-read-private`, `playlist-read-collaborative` and `user-library-read` (needed for private playlists, playlist names and liked songs). Existing logins keep working for everything else; `status` and `doctor` say when to reconnect with `connect force: true`.
- Draft artists are capped at 400 after seed expansion; seeds fill the remaining room in weight order.

### Notes

- Spotify-made playlists (Discover Weekly, Blend, Today's Top Hits, Daily Mix) cannot be read by new apps; user-made playlists can. Spotify artist objects carry no genres for new apps, so genre analysis uses Deezer's coarse genres and, with a key, Last.fm tags.
- Deezer's per-genre artist and chart endpoints return the global chart regardless of genre, so genre and country seeds read public Deezer playlists instead.

## 0.1.0 - 2026-09-04

Initial release.

### Added

- `stopIfUnresolved` option and a not-found report at the end of every summary and publish.
- MCP server over stdio with 14 tools: `status`, `setup`, `connect`, `parse_lineup`, `create_draft`, `get_draft`, `edit_draft`, `search_tracks`, `create_playlist`, `update_playlist`, `compare_taste`, `export_draft`, `list_drafts`, `delete_draft`.
- Bring-your-own Spotify app: PKCE login over a fixed port 8765 (`http://127.0.0.1:8765/callback`, no client secret), optional fixed port via `SPOTIFY_REDIRECT_PORT`, tokens stored with mode 0600, safe token refresh across several processes, 6-month refresh-token expiry tracking with a 30-day warning in `status`.
- Lineup parsing: poster text to artists with headliner / sub / undercard tiers, days and stages; headers, dates and ticket lines are dropped. Structured artists can be passed straight to `create_draft`.
- Song selection: artist resolution and ranking through Deezer's public API, optional Last.fm fallback (`LASTFM_API_KEY`), Spotify album fallback; matching to Spotify by ISRC with text search as a fallback; collaboration splitting ("A b2b B", "A x B", "A & B"); dedupe by URI, ISRC and song; live/remix/edit versions skipped unless needed.
- Draft options: per-tier or flat track counts, `maxTracks` (stepwise cap that favours headliners), `maxDurationMin`, five order modes (`interleave`, `lineup`, `shuffle`, `by_day`, `known_first`), explicit filter, version filter, `discoveryOnly`, `days` filter, public/private, source order.
- Background builds: `create_draft` returns within ~15 s; large lineups continue in the background with per-artist checkpoints, resume after interruption, per-draft lock files so a second host reads instead of building, and a paused state for quota / token errors.
- Draft editing with atomic multi-op edits, stable track ids, optimistic concurrency (`expectedRevision`), up to 10 undo revisions, and a restricted op set while a build is running.
- Publishing: playlist id persisted before any track is added, adds in chunks of 100 with checkpoints, bad URIs isolated by bisection, final count verified with retries; `update_playlist` refuses to overwrite a playlist changed inside Spotify unless forced.
- `compare_taste`: marks lineup artists as known (top artists over 4 weeks / 6 months / all time, or followed) or new.
- Exports as Markdown, CSV or M3U, optionally saved under `~/.lineupify/exports/`.
- CLI: `setup`, `auth`, `doctor`, `install --claude-desktop | --claude-code | --cursor`, `config get | set | reset | clear-artist`, `preview` (dry run without Spotify), `update-check`, `--version`, `--help`.
- Configuration through `~/.lineupify/config.json` (`LINEUPIFY_HOME` to relocate) and environment variables `SPOTIFY_CLIENT_ID`, `SPOTIFY_REDIRECT_PORT`, `LASTFM_API_KEY`, `LINEUPIFY_LOG`.
- On-disk caches for artist matches and Spotify track lookups; unpublished drafts pruned after 30 days.
- Spotify quota handling: `SPOTIFY_QUOTA_EXCEEDED` pauses the build and `get_draft` resumes it once the daily quota resets.
- stderr-only logging with secret redaction and a stdout guard so nothing but JSON-RPC reaches the host.
- Update notice in `status` when a newer version is on npm (checked at most every 6 hours).
- Documentation: README, Spotify app setup guide, host installation guide, troubleshooting reference.
