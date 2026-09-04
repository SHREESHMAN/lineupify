# Security

## Reporting a vulnerability

Open a private security advisory on the GitHub repository (Security → Report a vulnerability), or email the address in the package's `author` field with "lineupify security" in the subject. Please do not file public issues for security problems. You will get an acknowledgement within 7 days and a fix or a plan within 30 days for confirmed issues.

## What Lineupify can and cannot do with your Spotify account

Lineupify runs on your machine with a Spotify app you created. It has no server of its own and no access to your account beyond the token stored on your disk.

| Can | Cannot |
|---|---|
| Create playlists (private by default) and replace the tracks of playlists it created | Delete or unfollow playlists (there is no such call in the code, and Spotify's API has no delete) |
| Read your playlists, liked songs, top and followed artists | Change your library, follows, saved songs or account settings |
| Read public playlists made by people | Read Spotify-made playlists (Discover Weekly, Blend, editorial) — Spotify blocks that for new apps |
| Open your browser once to log in | Log in without you clicking "Agree" |

The eight OAuth scopes and the tool that needs each one are listed in the README under *Privacy and data*.

## Switches

- `LINEUPIFY_READ_ONLY=1` disables `create_playlist` and `update_playlist`. Drafts, reads, analysis and exports keep working. Set it in the MCP server's `env` block.
- `LINEUPIFY_NO_UPDATE_CHECK=1` stops the version check against `registry.npmjs.org`.
- `disconnect` (tool) or `lineupify-mcp logout` forgets the login; `purge: true` / `--purge` deletes the whole data folder. Spotify-side access is removed at <https://www.spotify.com/account/apps/>.
- The MCP host can disable the server entirely (Claude Desktop: Settings → Developer; Claude Code: `claude mcp remove lineupify`).

## Design notes

- OAuth uses PKCE over a loopback redirect. There is no client secret, so nothing secret exists besides your own tokens.
- Tokens are written to `~/.lineupify/tokens.json`. On macOS and Linux the file is mode 0600. On Windows the mode call is a no-op and the file is protected by your user profile's default permissions, like other CLIs' credential files.
- Tool output only ever contains cleaned strings: control characters are stripped, lengths are capped, and external text (poster text, track titles, playlist descriptions, Deezer playlist names) is placed inside fixed table layouts so it cannot pose as an instruction.
- Logs go to stderr only, with tokens, authorization codes and API keys redacted.
- Write tools carry MCP annotations (`destructiveHint`, `readOnlyHint`) so hosts that prompt for permission can distinguish them.
- `create_playlist` refuses until the draft has been shown (or the model passes `confirm: true`). This is a convention, not a guarantee: any MCP server is driven by the model, so review what it proposes before publishing, or run read-only.
