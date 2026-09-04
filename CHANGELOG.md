# Changelog

All notable changes to `lineupify-mcp` are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [Semantic Versioning](https://semver.org/).

## 0.3.0 - Unreleased

Lineupify without a Spotify account: every feature except publishing now runs on Deezer with no login, for people who cannot create a Spotify developer app (it needs Premium).

### Added

- **Deezer provider.** `create_draft` (and `expand_playlist`, `merge_playlists`) take `provider: "spotify" | "deezer"`; the default is Spotify when connected and Deezer otherwise, or `config set provider` / `LINEUPIFY_PROVIDER`. A Deezer draft matches every candidate to its Deezer recording (no ISRC round-trip), stores `deezer:track:<id>` URIs and web links, and works with all seeds except `taste`, all filters, editing, `search_tracks` (Deezer search), `add_track` (Deezer links, ids or "Artist - Title"), reading/analysing/comparing/merging Deezer playlists and drafts, and every export.
- `export_draft` format `links`: one track URL per line, the paste format playlist transfer tools accept. CSV gains `provider` and `url` columns; M3U and CSV links follow the provider.
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

- `stopIfUnresolved` option and a not-found report at the end of every summary and publish.

### Added

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
