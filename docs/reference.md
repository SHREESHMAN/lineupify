# Lineupify: tool and option reference

Every tool, every `edit_draft` op, every seed, every `create_draft` option, the CLI and `config.json`. For what Lineupify is and how to install it, see the [README](../README.md).

## Tools

| Tool | What it does | Key parameters |
|---|---|---|
| `status` | Call first. Shows connection state (and as whom), setup steps if needed, token expiry, defaults, drafts in progress, cache size, data directory and any read-only mode. | none |
| `setup` | Saves the Spotify Client ID (and optionally a Last.fm key or a fixed redirect port) to `config.json`. | `clientId`, `lastfmApiKey`, `redirectPort` |
| `connect` | Starts the Spotify login: opens the browser and returns the URL immediately. Pass `clientId` to save the app's Client ID in the same call. Refused while a draft is building. | `clientId`, `force` (switch account / re-login) |
| `disconnect` | Forgets the Spotify login; with `purge: true` and `confirm: true` deletes the whole `~/.lineupify` folder. Tells you where to remove the app's access on Spotify's side. | `purge`, `confirm` |
| `parse_lineup` | Turns raw poster text into a clean artist list with tiers, days and stages; drops dates, stage names and "tickets" lines. | `text` |
| `create_draft` | Builds a draft from artists and/or seeds (genre, similar artist, similar songs, chart, country, playlist, your taste, a blend). Returns within ~15 s; larger builds continue in the background. | `artists` and/or `seeds`, `lineup`, `name`, `tracksPerTier`, `tracksPerArtist`, `maxTracks`, `maxDurationMin`, `order`, `yearRange`, `bpmRange`, `skipCovers`, `excludeTracksFrom`, `provider`, … (see [options](#create_draft-options)) |
| `get_draft` | Shows a draft: `summary` (default), `tracks` (paged, with stable ids, year and tempo), `artists`, or `unresolved`. Waits for progress while building. Also resumes an interrupted build. | `draftId` (omit for latest), `view`, `offset`, `limit`, `waitSeconds` (max 25) |
| `edit_draft` | Applies one or more edits atomically. Ops: `remove_tracks`, `add_track`, `exclude_artist`, `set_artist_track_count`, `set_artist_source`, `move`, `shuffle`, `reorder`, `set_meta`, `filter`, `undo`. | `draftId`, `ops` (1-50), `expectedRevision` |
| `search_tracks` | Searches Spotify, or Deezer for a Deezer draft, for a track to add manually; supports `track:` / `artist:` filters. | `query`, `limit` (max 10), `provider` |
| `create_playlist` | Publishes a ready draft as a new playlist and returns its URL. Requires the draft to have been shown to the user or `confirm: true`. | `draftId`, `confirm`, `allowPartial`, `mode: "new"` |
| `update_playlist` | Replaces the tracks and details of the playlist a draft was published to. Refuses if the playlist changed inside Spotify unless `force: true`. | `draftId`, `force` |
| `set_playlist_image` | Replaces the cover of the playlist a draft was published to, from a **JPEG saved on your machine**. Spotify cannot fetch an image from a URL, and an image pasted into a chat is not a file until you save it, so `imagePath` must be a full path to a real `.jpg`. Roughly 190 KB or smaller. | `draftId`, `imagePath` |
| `compare_taste` | Marks each artist in a draft as known (in your top or followed artists) or new to you. | `draftId`, `reorderKnownFirst` |
| `read_playlist` | Reads any playlist into a list: a Spotify or Deezer link, a playlist name from your library, a draft id, or `library` (liked songs). Views: `summary`, `tracks`, `artists`. Cached 12 h. | `playlist`, `view`, `offset`, `limit`, `refresh` |
| `analyze_playlist` | Numbers about a playlist: length, artist concentration, decades, explicit share, coarse genres (Deezer) and Last.fm tags, sampled tempo. | `playlist`, `genres`, `tempo` |
| `compare_playlists` | Compares 2-4 playlists, drafts, `library` or `me` (your top and followed artists): shared artists and tracks, pairwise overlap, what is distinct to each. | `sources` |
| `merge_playlists` | One deduplicated draft from 1-6 playlists, drafts or `library`, keeping the actual tracks. | `playlists`, `name`, `order`, `excludeExplicit`, `maxTracks` |
| `expand_playlist` | More songs by the artists of a playlist, minus what it already has. | `playlist`, `limitArtists`, `tracksPerArtist`, plus the build options |
| `refresh_taste` | New songs from your own top and followed artists, minus your liked songs. | `limitArtists`, `tracksPerArtist`, `excludePlaylists`, plus the build options |
| `export_draft` | Returns the draft as Markdown, CSV (with ISRC, year, tempo, provider, URLs), M3U, `links` (one track URL per line) or `text` ("Artist - Title" per line); the last two are what transfer tools accept. With `save: true` writes a file under `~/.lineupify/exports/`. | `draftId`, `format`, `save`, `overwrite` |
| `list_drafts` | Lists saved drafts, newest first, with status and whether they were published. | none |
| `delete_draft` | Deletes a draft from disk. The Spotify playlist is not touched. | `draftId` |

Errors come back as `CODE: message` plus a `Fix:` line; every code is listed in [docs/troubleshooting.md](docs/troubleshooting.md).

## `edit_draft` operations

| Op | Fields | Notes |
|---|---|---|
| `remove_tracks` | `ids` (from `get_draft view=tracks`, preferred) and/or `indexes` (1-based) | |
| `add_track` | `track` (`spotify:track:` URI, open.spotify.com URL, or `"Artist - Title"`), `artist`, `position` | `"Artist - Title"` must match a real hit on both; use `search_tracks` first for an exact URI. |
| `exclude_artist` | `artist` | Removes the artist's tracks and stops fetching more. |
| `set_artist_track_count` | `artist`, `count` (0-50) | Raising the count fetches more tracks. |
| `set_artist_source` | `artist`, `deezerId` and/or `spotifyArtistId` | Fixes a wrong artist match and refetches. |
| `move` | `id` or `from`, `to` (1-based) | |
| `shuffle` | `seed` | |
| `reorder` | `mode`: `interleave`, `lineup`, `shuffle`, `by_day`, `known_first` | |
| `set_meta` | `name`, `description`, `public` | |
| `filter` | `explicit: true` removes explicit tracks; `versions: false` removes live/remix/edit versions | |
| `undo` | none, must be the only op | Up to 10 revisions are kept. |

While a draft is still building, only `exclude_artist`, `set_artist_track_count`, `set_artist_source`, `filter` and `set_meta` are accepted. Pass `expectedRevision` from the last `get_draft` so an edit never applies to a list you have not seen.

## Seeds: playlists without typing artists

The engine only needs an artist list. A **seed** produces one for you, alone or alongside typed artists.

| Seed | What it adds | Where it comes from |
|---|---|---|
| `{ type: "genre", value: "shoegaze" }` | The artists of that genre, mood or scene; any words work ("melancholic", "rainy sunday jazz"). | Last.fm tag top artists when a key is set; otherwise public Deezer playlists whose titles match, read and counted. |
| `{ type: "similar_to", value: "Khruangbin" }` | Artists like that one (never the artist itself). | Deezer related artists, plus Last.fm similar artists with a key. |
| `{ type: "similar_songs", value: "Ritviz - Udd Gaye", songs: ["<more links or Artist - Title>"] }` | **Songs** listened to together with the seed song(s), mostly by other artists; the exact songs are fetched, not the artists' top tracks. A song near several seeds, or found by both sources, ranks first. `limit` = similar songs per seed song (default 25, max 100); up to 10 seed songs. `excludeSeedArtists: true` for other artists only, `excludeSeedSongs: true` to drop the seeds themselves (both off by default). | Last.fm track.getSimilar with a key, plus ListenBrainz similar recordings (open data, keyless; the song is found through MusicBrainz by ISRC). Songs are matched to Spotify by ISRC via Deezer. |
| `{ type: "chart" }` | What is popular right now. | Deezer global chart (plus Last.fm chart). |
| `{ type: "country", value: "Brazil" }` | What a country listens to. | Last.fm geo charts with a key; Deezer's "Top <Country>" chart playlists otherwise. |
| `{ type: "playlist", value: "<link or name>" }` | The artists of a playlist, most frequent first. | Spotify or Deezer playlist, a name from your library, a draft, or `library`. |
| `{ type: "taste" }` | Your own top and followed artists. | Spotify top artists (3 ranges) and follows. |
| `{ type: "blend", sources: ["<playlist>", "me"] }` | Artists 2-4 people would all like: on every side directly, or in the "similar artists" of every side. `minShared` relaxes "every" to "at least N". | The sides' artists expanded through Deezer related artists. |

Each seed adds up to `limit` artists (default 30, max 100) at the `tier` you give (default `flat`, or `undercard` when the typed artists have tiers). Seeds expand in the background build; the summary shows what each produced and why one failed, and a failed seed never blocks the rest.

Recipes the assistant can run in one call:

- **Describe it:** artists it proposes + `seeds: [{ type: "genre", value: "<the words>" }]`.
- **More like this:** `seeds: [{ type: "similar_to", value: "<artist>" }]`, `tracksPerArtist: 2`.
- **Songs like these, other artists only:** `seeds: [{ type: "similar_songs", value: "<song link>", songs: [...] }]`, `excludeSeedArtists: true`, `excludeTracksFrom: ["library"]`.
- **90s hip hop:** `seeds: [{ type: "genre", value: "hip hop" }]`, `yearRange: { from: 1990, to: 1999 }`.
- **Running:** any seed + `bpmRange: { min: 160, max: 180 }`.
- **Expand my playlist:** `expand_playlist` (a `playlist` seed + `excludeTracksFrom` the same playlist).
- **New songs from my favourites:** `refresh_taste` (a `taste` seed + `excludeTracksFrom: ["library"]`).
- **Blend for a road trip:** `compare_playlists` to explain the overlap, then `seeds: [{ type: "blend", sources: [...] }]` with `excludeTracksFrom` the same sources so nothing anyone already has is repeated.
- **Merge:** `merge_playlists` keeps the actual tracks and drops duplicates.

`read_playlist`, `analyze_playlist` and `compare_playlists` return plain data lines (counts, decades, genres, tempo buckets, overlap percentages). The assistant turns them into words, tables or charts; the server never draws.

## `create_draft` options

| Option | Default | Meaning |
|---|---|---|
| `provider` | `spotify` when connected, else `deezer` | Where the tracks live. `spotify` needs a login and can publish; `deezer` needs nothing and exports instead of publishing. Also settable as a default (`config set provider deezer`) or with `LINEUPIFY_PROVIDER`. |
| `artists` | required unless `seeds` is given | Up to 400 entries. Each is a name string or `{ name, tier, day, stage }`. `tier` is `headliner`, `sub`, `undercard` or `flat`. |
| `seeds` | unset | Up to 8 `{ type, value, limit, tier }` entries; see [Seeds](#seeds-playlists-without-typing-artists). |
| `lineup` | derived from the first seed, else `"Festival lineup"` | Festival name and year, or a short theme, used for the playlist name. |
| `name` | `"<lineup> · Lineupify"` | Playlist name (max 100 chars). The template is configurable (`namingTemplate`). |
| `description` | `"<n> artists, <m> tracks. Built with Lineupify."` | Playlist description (max 300 chars). |
| `tracksPerTier` | `{ headliner: 5, sub: 3, undercard: 2 }` | Tracks per artist by tier. Artists without a tier get `undercard` when any tier is present, otherwise `flat`, which uses the `sub` count. |
| `tracksPerArtist` | unset | Same count for every artist; overrides `tracksPerTier`. |
| `maxTracks` | `250` | Cap on total tracks (1-10,000). Applied stepwise across tiers so headliners keep more. |
| `maxDurationMin` | unset | Trim the finished draft to this many minutes. |
| `order` | `interleave` | `interleave` (spreads artists), `lineup` (artist by artist), `shuffle`, `by_day`, `known_first`. |
| `excludeArtists` | `[]` | Names to skip. |
| `excludeExplicit` | `false` | Skip explicit tracks. |
| `allowVersions` | `false` | Allow live/remix/edit versions. When off, versions are used only if an artist would otherwise come up short. |
| `discoveryOnly` | `false` | Skip artists already in your top or followed artists (applies to seeded artists too). |
| `stopIfUnresolved` | `false` | Refuse to publish while any artist is still not found, so you can fix names first. |
| `days` | unset | Keep only artists tagged with these days (untagged artists are kept). |
| `public` | `false` | Make the playlist public. |
| `sources` | `["deezer", "lastfm", "spotify"]` | Ranking sources, in order. Last.fm only works with a key; Spotify is a last-resort album fallback. |
| `yearRange` | unset | `{ from, to }`: keep only tracks released in this range. A year that comes from a remaster or compilation is treated as unknown; `strictYear: true` drops unknown years too. |
| `bpmRange` | unset | `{ min, max }`: keep only tracks whose Deezer tempo is in range. Tracks without a tempo are kept unless `strictBpm: true`. |
| `skipCovers` | `false` | Drop a song when a more popular artist has the original: checked against the other artists in the draft, then with one Deezer title search per remaining track. |
| `excludeTracksFrom` | unset | Up to 8 playlists (links or names), drafts or `library` whose tracks must never be picked. |
| `excludeSeedSongs` | `false` | `similar_songs`: leave the seed songs themselves out. |
| `excludeSeedArtists` | `false` | `similar_songs`: leave out every song by the seed songs' artists ("other artists only"). |

Every summary and publish result ends with the artists that were not found or had no playable Spotify track, and what to do about them. Defaults can be changed permanently with `lineupify-mcp config set` (see [Configuration](#configuration)).

## CLI reference

Running `lineupify-mcp` with no arguments serves MCP over stdio; that is what your host runs. The subcommands below are for a normal terminal (`npx -y lineupify-mcp <command>` or, after a global install, `lineupify-mcp <command>`).

| Command | Purpose |
|---|---|
| `init` | Guided setup in one run: Client ID, Spotify login, host install, health check. Each step can be skipped. |
| `setup --client-id <id> [--port <n>] [--lastfm-key <key>]` | Save the Client ID (32 hex chars), a fixed redirect port, or a Last.fm key to `config.json`. With no flags it prints the Spotify setup steps. |
| `auth [--force]` | Log in to Spotify from the terminal (opens the browser, waits up to 5 minutes). `--force` re-logs in or switches account. |
| `logout [--purge]` | Forget the Spotify login. `--purge` also deletes `~/.lineupify` (config, caches, drafts, exports); refuses if the folder holds anything Lineupify did not create. |
| `doctor` | Checks Node.js, data directory, Client ID, redirect port/URI, token age and scopes, `GET /me`, Deezer reachability and the Last.fm key, then prints MCP config snippets for every host. Exit code 1 if anything failed. |
| `install --claude-desktop \| --claude-code \| --cursor` | Writes the `lineupify` entry into the host's config (a `.bak` copy is kept; an unparseable config is left untouched) or runs `claude mcp add` for you. |
| `config get` | Print `config.json` (Last.fm key masked). |
| `config set <key> <value>` | Change a default (keys below). |
| `config reset` | Reset all defaults; keeps Client ID, port and Last.fm key. |
| `config clear-artist <name>` | Forget the cached artist match for a name, so the next draft resolves it again. |
| `preview <lineup.txt> [--per-artist <n>]` | Dry run without Spotify: parses the file, resolves artists on Deezer/Last.fm and prints the songs that would be picked, with ISRCs. |
| `update-check` | Compare the installed version with npm. |
| `--version`, `--help` | |

Example `doctor` output:

```
OK   Node.js          22.11.0
OK   Data dir         ~/.lineupify
OK   Client ID        set (config.json)
OK   Redirect URI     http://127.0.0.1:8765/callback (port free; this exact URI must be in the app's Redirect URIs)
OK   Spotify login    Alex; refresh token valid 171 more days
OK   Spotify API      GET /me ok (alexr)
OK   Deezer           HTTP 200
OK   Last.fm key      not set (optional)
```

## Configuration

Settings are read from environment variables first, then from `~/.lineupify/config.json`. An environment variable always wins over the file.

#### Environment variables

| Variable | Purpose |
|---|---|
| `SPOTIFY_CLIENT_ID` | Spotify app Client ID. Alternative to `setup`; overrides `config.json`. |
| `SPOTIFY_REDIRECT_PORT` | Use a different loopback port for the login callback (register `http://127.0.0.1:<port>/callback` in the dashboard). Default 8765. |
| `LASTFM_API_KEY` | Enables Last.fm as a second ranking and discovery source. Free key: https://www.last.fm/api/account/create |
| `LINEUPIFY_HOME` | Data directory. Default `~/.lineupify`. |
| `LINEUPIFY_LOG` | Log level: `error`, `info` (default) or `debug`. Logs go to stderr only (your host's MCP log), never to stdout. Tokens are redacted. |
| `LINEUPIFY_READ_ONLY` | `1` disables `create_playlist` and `update_playlist`. Drafts, reads, analysis and exports keep working. `status` shows the mode. |
| `LINEUPIFY_NO_UPDATE_CHECK` | `1` stops the version check against the npm registry. |
| `LINEUPIFY_PROVIDER` | `spotify` or `deezer`: default provider for new drafts. Unset means Spotify when connected, otherwise Deezer. |

Pass them through your host's `env` block (see [docs/hosts.md](docs/hosts.md)).

#### `config.json`

```json
{
  "spotifyClientId": "0123456789abcdef0123456789abcdef",
  "spotifyRedirectPort": 8888,
  "lastfmApiKey": "…",
  "defaults": {
    "tracksPerTier": { "headliner": 5, "sub": 3, "undercard": 2 },
    "maxTracks": 250,
    "order": "interleave",
    "public": false,
    "excludeExplicit": false,
    "allowVersions": false,
    "discoveryOnly": false,
    "skipCovers": false,
    "namingTemplate": "{lineup} · Lineupify"
  }
}
```

`spotifyRedirectPort` and `lastfmApiKey` are optional. Everything under `defaults` is optional and overrides the built-in defaults listed in the options table.

#### `config set` keys

| Key | Value |
|---|---|
| `tracksPerTier.headliner`, `tracksPerTier.sub`, `tracksPerTier.undercard` | number |
| `tracksPerArtist`, `maxTracks`, `maxDurationMin` | number |
| `order` | `interleave` / `lineup` / `shuffle` / `by_day` / `known_first` |
| `public`, `excludeExplicit`, `allowVersions`, `discoveryOnly`, `stopIfUnresolved`, `skipCovers` | `true` / `false` |
| `provider` | `spotify` / `deezer` |
| `namingTemplate` | text; `{lineup}` is replaced by the lineup name |

Example: `lineupify-mcp config set tracksPerTier.headliner 8`
