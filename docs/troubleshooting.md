# Troubleshooting

Start with `status` in the chat or `npx -y lineupify-mcp doctor` in a terminal; both tell you what is missing and what to do next. Tool errors always look like:

```
SPOTIFY_NOT_CONNECTED: No Spotify account connected.
Fix: Call status for setup steps, then connect.
```

Errors without a code (`ERROR: …`) are unexpected; set `LINEUPIFY_LOG=debug` in the MCP config `env` and check the host's MCP log (see "Where are the logs?").

## Error codes

### Setup and login

| Code | Meaning | Fix |
|---|---|---|
| `NO_CLIENT_ID` | No Spotify Client ID in `config.json` or `SPOTIFY_CLIENT_ID`. | Create an app ([setup-spotify.md](setup-spotify.md)) and call `setup` with the Client ID, or run `lineupify-mcp setup --client-id <id>`. |
| `BAD_CLIENT_ID` | The value given to `setup`, `connect` or `init` is not 32 hex characters. | Copy the Client ID from the app's Settings page; do not use the client secret. |
| `CLIENT_ID_OVERRIDDEN` | `connect` was given a `clientId`, but `SPOTIFY_CLIENT_ID` is set in the host config and wins. | Remove the environment variable, or pass the same id. |
| `SPOTIFY_CLIENT_ID_INVALID` | Spotify answered `invalid_client`: it does not know this ID. | Check the ID against the dashboard. If `SPOTIFY_CLIENT_ID` is set in the host config it overrides `config.json`. |
| `BAD_PORT` | `redirectPort` is outside 1024-65535. | Pick a port in that range, or `0` to go back to the default 8765. |
| `NOTHING_TO_SAVE` | `setup` was called without `clientId`, `redirectPort` or `lastfmApiKey`. | Pass at least one. |
| `REDIRECT_PORT_BUSY` | The fixed port from `SPOTIFY_REDIRECT_PORT` / `setup redirectPort` is in use. | Close the other program, choose another port (and register it in the dashboard), or unset the port to use a random one. |
| `AUTH_TIMEOUT` | Nobody completed the login within 5 minutes. | Call `connect` again and finish the login in the browser. |
| `AUTH_DENIED` | You clicked *Cancel* on the Spotify consent page, or Spotify reported an error. | Call `connect` again and click *Agree*. |
| `AUTH_STATE_MISMATCH` | The callback did not match the login Lineupify started (old tab, second attempt, or something else on the port). | Close old Spotify tabs and call `connect` again; use the URL it returns. |
| `SPOTIFY_AUTH_FAILED` | The token exchange failed for another reason (message contains Spotify's error). | Usually an incorrect redirect URI in the dashboard; see "Invalid redirect URI" below. Retry `connect`. |
| `SPOTIFY_NOT_CONNECTED` | No tokens saved. | Call `connect`. |
| `TOKEN_EXPIRED_RECONNECT` | The refresh token is older than 6 months, or Spotify refused it (`invalid_grant`). | Call `connect` with `force: true`, or run `lineupify-mcp auth --force`. |
| `JOB_RUNNING` | You tried to `connect` (switch accounts), `disconnect` or `delete_draft` while a draft is building. | Wait for the build (`get_draft` with `waitSeconds: 25`) and retry. |
| `READ_ONLY_MODE` | `LINEUPIFY_READ_ONLY` is set, so `create_playlist` and `update_playlist` are disabled. | Remove the variable from the host's MCP config and restart the host, or keep it and use `export_draft`. |

### Spotify API

| Code | Meaning | Fix |
|---|---|---|
| `SPOTIFY_SCOPE_MISSING` | The saved login was granted with an older set of permissions (Spotify answers "Insufficient client scope"). | `connect` with `force: true`, or `lineupify-mcp auth --force`. |
| `SPOTIFY_FORBIDDEN` | HTTP 403. The logged-in user is not allowed to use this app. | The account must be the app owner (who needs Premium) or be listed under *User Management* in the dashboard. Add the user or log in as the right account with `connect` `force: true`. |
| `SPOTIFY_QUOTA_EXCEEDED` | Your Development Mode daily quota (shared by all apps you own) is used up. The draft is paused. | Wait for the daily reset, then call `get_draft`; the build resumes and already-fetched results are cached. |
| `SPOTIFY_RATE_LIMITED` | HTTP 429 without a quota message; the message says how long to wait. | Wait, then `get_draft` to resume. Lineupify already retries with backoff, so this is rare. |
| `SPOTIFY_HTTP_ERROR` | Any other HTTP error from Spotify (status and reason in the message). | Retry. A 400 during publishing is handled automatically (bad URIs are skipped). A 404 on a playlist becomes `PLAYLIST_GONE`. |
| `SPOTIFY_USER_MISMATCH` | The draft was built for one Spotify user, but a different account is connected. Track availability depends on the user's market, so drafts are per user. | Reconnect the original account (`connect` with `force: true`) or create a new draft. |

### Drafts and editing

| Code | Meaning | Fix |
|---|---|---|
| `NO_ARTISTS` | `create_draft` got no usable names and no seeds. | Pass at least one artist, or a seed such as `{ type: "similar_to", value: "Khruangbin" }`. |
| `TOO_MANY_ARTISTS` | More than 400 artists. | Split the lineup by day and make one draft per day (`days` filter). |
| `BAD_SEED` | A seed has an unknown `type`. | Use `genre`, `similar_to`, `chart`, `country`, `playlist`, `taste` or `blend`. |
| `SEED_VALUE_REQUIRED` | A `genre`, `similar_to`, `country` or `playlist` seed has no `value`. | Add the words, artist, country or playlist reference. |
| `TOO_MANY_SEEDS` | More than 8 seeds. | Combine or drop some. |
| `BLEND_NEEDS_SOURCES` / `BLEND_TOO_MANY` | A `blend` seed needs 2-4 `sources`. | Pass playlist links or names, draft ids, `library` or `me`. |
| `SEED_ARTIST_NOT_FOUND` | The `similar_to` artist is not on Deezer (or Last.fm). | Check the spelling, or pass the artist directly in `artists`. |
| `NO_ARTISTS_FROM_SEEDS` | Every seed failed and no artists were given, so the build has nothing to fetch. | `get_draft view=unresolved` shows why each seed failed. Fix the values, add a Last.fm key for tag/country seeds, or pass artists. |
| `BAD_YEAR_RANGE` / `BAD_BPM_RANGE` | `from` is after `to`, or `min` above `max`. | Swap them. |
| `NO_DRAFTS` | `get_draft` without `draftId`, but there are no drafts. | Call `create_draft`. |
| `DRAFT_NOT_FOUND` | Unknown draft id (or a draft that was pruned after 30 days unpublished). | `list_drafts` shows the available ids. |
| `STALE_REVISION` | `expectedRevision` does not match the draft's current revision; someone edited it since you last looked. | Re-read with `get_draft`, then retry with the revision it shows. |
| `NO_OPS` | `edit_draft` with an empty `ops` list. | Pass at least one op. |
| `DRAFT_BUSY` | While building, only `exclude_artist`, `set_artist_track_count`, `set_artist_source`, `filter` and `set_meta` are allowed; `undo` is never allowed while building. | Wait for `status ready` (`get_draft` with `waitSeconds`), then edit. |
| `DRAFT_BUILDING_ELSEWHERE` | Another Lineupify process (a second host) holds the build lock for this draft. | Wait about a minute and retry, or just read it with `get_draft`. |
| `EDIT_UNDO_ALONE` | `undo` was combined with other ops. | Send `undo` on its own. |
| `NOTHING_TO_UNDO` | No earlier revision stored (max 10 are kept). | Nothing to do. |
| `TRACK_NOT_FOUND` | A track id or position does not exist in this draft, `move` could not find its source, or `add_track` found nothing on Spotify. | Use ids from `get_draft view=tracks`. For `add_track`, find the exact URI with `search_tracks`. |
| `ARTIST_NOT_FOUND` | The `artist` name in an edit op matches no artist in the draft. | Use the name as printed by `get_draft view=artists`. |
| `BAD_EDIT` | `set_artist_source` without `deezerId` or `spotifyArtistId`. | Pass one of them. |
| `BAD_QUERY` | `search_tracks` with an empty query. | Pass a query, e.g. `track:Marea artist:Fred again`. |
| `FILE_EXISTS` | `export_draft` with `save: true` would overwrite an existing file. | Pass `overwrite: true` or rename the draft (`set_meta`). |

### Reading, comparing and merging playlists

| Code | Meaning | Fix |
|---|---|---|
| `BAD_PLAYLIST_REF` | The reference is empty or a link Lineupify does not understand (Apple Music, YouTube, a short link). | Use an `open.spotify.com/playlist/...` or `deezer.com/playlist/...` link, a `spotify:playlist:` URI, a playlist name from your own library, a draft id, or `library`. |
| `PLAYLIST_NOT_READABLE` | Spotify (404/403) or Deezer has no readable playlist with that id. | Check the link. Spotify-made playlists (Discover Weekly, Blend, Top Hits, Daily Mix) cannot be read by new apps. Your own private playlist needs the read permission added in 0.2.0: `connect` with `force: true`. |
| `PLAYLIST_NAME_NOT_FOUND` / `PLAYLIST_NAME_AMBIGUOUS` | No, or several, playlists in your library match the name. | Paste the link, or use the exact full name. Needs `playlist-read-private` (reconnect if `status` says a permission is missing). |
| `NOT_A_PLAYLIST` | `me` was given where a track list is needed. | `me` (your listening history) works in `compare_playlists`, `blend` and `taste`; use `library` for your liked songs. |
| `PLAYLIST_EMPTY` | The playlist has no readable tracks (only episodes or local files). | Nothing to analyse. |
| `COMPARE_NEEDS_SOURCES` / `COMPARE_TOO_MANY` | `compare_playlists` needs 2-4 sources. | Adjust the list. |
| `MERGE_NEEDS_PLAYLISTS` / `MERGE_TOO_MANY` | `merge_playlists` needs 1-6 playlists. | Adjust the list. |
| `MERGE_DEEZER_UNSUPPORTED` | Deezer playlists carry no Spotify URIs, so they cannot be merged as-is. | Use `create_draft` with a `{ type: "playlist" }` seed for a Deezer playlist. |

### Publishing

| Code | Meaning | Fix |
|---|---|---|
| `DRAFT_BUILDING` | `create_playlist` / `update_playlist` while the draft is still building. | Wait for `status ready`, or pass `allowPartial: true` to `create_playlist` to publish what exists now. |
| `DRAFT_PAUSED` | The build stopped on an error (quota, expired token, connection). | Fix the cause shown in the message, call `get_draft` to resume, or `create_playlist` with `allowPartial: true`. |
| `UNRESOLVED_ARTISTS` | `stopIfUnresolved` is on and some artists were not found. | Fix them with `edit_draft` (`add_track`, `set_artist_source`, `exclude_artist`) or a new draft with corrected names; or pass `allowPartial: true`. |
| `DRAFT_EMPTY` | The draft has no tracks. | Check `get_draft view=unresolved`; add a Last.fm key, fix names, or `add_track`. |
| `CONFIRM_REQUIRED` | The draft has never been shown to the user. | Call `get_draft` (any non-summary view marks it as reviewed) or pass `confirm: true` if the user asked to publish blind. |
| `ALREADY_PUBLISHED` | This draft already has a playlist. | `update_playlist` to push changes, or `create_playlist` with `mode: "new"` for a second copy. |
| `NO_PLAYLIST` | `update_playlist` on a draft that was never published. | Use `create_playlist`. |
| `PLAYLIST_GONE` | The playlist was deleted in Spotify or is not editable by the connected account. | `create_playlist` with `mode: "new"`. |
| `PLAYLIST_EDITED_IN_SPOTIFY` | The playlist changed inside Spotify since Lineupify last wrote it; `update_playlist` would overwrite those changes. | Ask the user, then `update_playlist` with `force: true`. |

## Symptoms

### "Server disconnected" or Lineupify never appears in the host

1. Check Node: `node --version` must print 20 or higher. Lineupify exits immediately on older Node with a message in the host log.
2. Windows Claude Desktop needs `"command": "cmd", "args": ["/c", "npx", "-y", "lineupify-mcp"]`. A bare `npx` fails to launch.
3. `npx` must have `-y` (see next symptom).
4. The config file must be valid JSON; a missing comma disables every server in it.
5. Claude Desktop must be fully quit (tray / dock), not just closed, before it re-reads the config.
6. The host may run with a different PATH than your terminal (nvm, Volta, Homebrew). Use the full path to `npx` (or to `lineupify-mcp` after `npm i -g`) in `command`.
7. Run `npx -y lineupify-mcp doctor` in a terminal; if that works, the problem is in the host config, not in Lineupify.

### `npx` hangs on start

Without `-y`, `npx` prints "Need to install the following packages… Ok to proceed?" and waits for a keypress on the MCP pipe. Add `-y` to `args`.

### The browser does not open on `connect`

`connect` returns the login URL in its text; open it by hand. `status` also shows the URL while a login is pending ("login in progress … open this URL"). This is normal on servers, WSL and remote sessions. The URL is valid for 5 minutes.

### Spotify says "INVALID_CLIENT: Invalid redirect URI"

The redirect URI registered in the dashboard does not match what Lineupify sent.

- Register exactly `http://127.0.0.1:8765/callback`: `http`, IP form, with the port, no trailing slash. `localhost` is rejected by Spotify.
- If you set `SPOTIFY_REDIRECT_PORT` or `setup redirectPort`, the dashboard entry must include that port: `http://127.0.0.1:8888/callback`.
- Conversely, if the dashboard has a port but Lineupify uses a random one, either remove the port from the dashboard or configure the same port.
- `doctor` prints which URI you need to have registered.

### 403 on `GET /me` (`SPOTIFY_FORBIDDEN`) right after logging in

You signed in with a Spotify account that is not the app owner and is not listed under *User Management*, or the app owner does not have Premium. Add the user in the dashboard (Settings → User Management: full name + Spotify account email), or log out of spotify.com and `connect` with `force: true` as the correct account.

### Port already in use (`REDIRECT_PORT_BUSY`)

Only happens with a fixed port. `doctor` shows whether the port is free. Change it (and update the dashboard) or remove the setting to use a fixed port 8765.

### The wrong artist was matched

Names like "Marina", "Sylvan Esso" vs. "Sylvan", or a tribute act can resolve to the wrong Deezer artist. `get_draft view=artists` shows `matched "…"` and `low-confidence` notes; `get_draft view=unresolved` lists the doubtful ones.

Fix it in the draft with `edit_draft` `set_artist_source`:

- `deezerId`: the number at the end of the artist's deezer.com URL (`https://www.deezer.com/artist/12345`).
- `spotifyArtistId`: the id in the artist's open.spotify.com URL (`https://open.spotify.com/artist/<id>`).

Lineupify drops the wrong tracks, refetches for that artist and remembers the override in the artist cache. To forget a cached match instead (so the next draft resolves from scratch), run `lineupify-mcp config clear-artist "<name>"`.

### Small artists are missing

Unresolved artists show `not found in Deezer, Last.fm or Spotify` in `get_draft view=unresolved`, together with the spellings tried. Options:

- Add a Last.fm key (`LASTFM_API_KEY` or `setup lastfmApiKey`); Last.fm covers more underground acts.
- Check the spelling on the poster (parsers sometimes glue two names or keep a stage name); create a new draft with the corrected name.
- Add songs by hand: `search_tracks` then `edit_draft` `add_track` with the URI.
- If the act simply is not on Spotify, `exclude_artist` keeps the summary clean.

### The Spotify playlist has fewer tracks than the draft

- `create_playlist` prints `Skipped N URIs Spotify rejected` when Spotify refused some tracks (removed or region-locked). Those are dropped; the rest is added.
- The note `Spotify reports X tracks (expected Y)` is usually eventual consistency: playlist reads lag a few seconds after writes. Refresh the Spotify app.
- If the count is still wrong after a minute, run `update_playlist`; it replaces the whole list from the draft.

### `DRAFT_BUILDING_ELSEWHERE`

A second Lineupify process (another host, or a previous process that has not exited yet) holds the lock on this draft. Locks expire 60 seconds after the other process stops touching them. Wait a minute and retry, or read the draft with `get_draft`.

### `STALE_REVISION`

The draft changed between the `get_draft` you based the edit on and the `edit_draft` call (for example the build finished and bumped the revision). Re-read with `get_draft`, check the list, and retry with the current `expectedRevision`.

### The build stopped ("paused")

`get_draft` shows `status paused` with the reason (`SPOTIFY_QUOTA_EXCEEDED`, `TOKEN_EXPIRED_RECONNECT`, a closed host, …). Fix the cause if needed, then call `get_draft` again: it resumes from the last checkpoint. Progress is saved after every artist, so nothing already fetched is repeated.

### `status` says "refresh token expires in N days" or "EXPIRED"

Spotify refresh tokens die 6 months after the original login. `connect` with `force: true` (or `lineupify-mcp auth --force`) and sign in again.

### Old version keeps running

`npx -y lineupify-mcp` caches the first version it downloaded. `npm i -g lineupify-mcp@latest`, or change the host config to `lineupify-mcp@latest`, then fully restart the host. `status` prints "Update available" when this applies.

### Where are the logs?

Lineupify logs to stderr only (never stdout, which carries the MCP protocol). Hosts collect it:

- Claude Desktop: `%APPDATA%\Claude\logs\mcp-server-lineupify.log` (Windows), `~/Library/Logs/Claude/mcp-server-lineupify.log` (macOS), `~/.config/Claude/logs/` (Linux).
- Claude Code: `claude mcp list` for connection state; run with `--debug` for server stderr.
- Cursor: *Output* panel → *MCP Logs*.

Set `LINEUPIFY_LOG=debug` in the `env` block for request-level detail. Tokens and authorization codes are redacted before writing.

### Starting over

Delete `~/.lineupify/` (or your `LINEUPIFY_HOME`). This removes the Client ID, tokens, cache, drafts and exports. Playlists already created in Spotify are not affected.
