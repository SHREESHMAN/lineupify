# Installing Lineupify in your MCP host

Lineupify is a stdio MCP server. Any host that can run `npx -y lineupify-mcp` works; this page covers Claude Desktop, Claude Code and Cursor.

## Prerequisites

- **Node.js 20 or newer**, installed separately from https://nodejs.org. Claude Desktop's bundled Node is not used for classic `command`/`args` config entries; `npx` must be on your PATH. Check with `node --version` and `npx --version` in a terminal.
- A Spotify Client ID (see [setup-spotify.md](setup-spotify.md)). You can install first and add the ID afterwards through the `setup` tool.

The fastest route on any host is the built-in installer:

```
npx -y lineupify-mcp install --claude-desktop
npx -y lineupify-mcp install --claude-code
npx -y lineupify-mcp install --cursor
```

It writes the correct entry for your platform (including the `cmd /c` form on Windows) and keeps a `.bak` copy of the Claude Desktop config. `npx -y lineupify-mcp doctor` prints the same snippets without writing anything.

## The short way: `init`

```
npx -y lineupify-mcp init
```

One guided run in a terminal: it shows the Spotify app steps and opens the dashboard, takes the Client ID, logs you in through the browser, detects Claude Desktop, Claude Code and Cursor and offers to add Lineupify to each, then runs the health check. Every step can be skipped, and the separate commands below do the same things one at a time.

## Claude Desktop

**One-click bundle.** Every GitHub release ships `lineupify-<version>.mcpb`. Download it, double-click it (or drag it onto Claude Desktop), paste your Client ID into the form it shows, done. The bundle contains the server and its dependencies; Node.js is still required. Then say "connect Lineupify to Spotify" in a chat.

**Or the config file.** Config file:

| OS | Path |
|---|---|
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` (usually `C:\Users\<you>\AppData\Roaming\Claude\claude_desktop_config.json`) |
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Linux | `~/.config/Claude/claude_desktop_config.json` |

You can also open it from Claude Desktop: *Settings → Developer → Edit Config*.

macOS / Linux:

```json
{
  "mcpServers": {
    "lineupify": {
      "command": "npx",
      "args": ["-y", "lineupify-mcp"],
      "env": { "SPOTIFY_CLIENT_ID": "0123456789abcdef0123456789abcdef" }
    }
  }
}
```

Windows (the `cmd /c` wrapper is required, because Claude Desktop cannot launch `npx.cmd` directly):

```json
{
  "mcpServers": {
    "lineupify": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "lineupify-mcp"],
      "env": { "SPOTIFY_CLIENT_ID": "0123456789abcdef0123456789abcdef" }
    }
  }
}
```

Notes:

- `-y` is required. Without it `npx` prompts "Ok to proceed?" on a pipe nobody answers and the server never starts.
- The `env` block is optional. If you saved the Client ID with `setup` (chat or terminal), leave `env` out.
- Other useful `env` entries: `SPOTIFY_REDIRECT_PORT`, `LASTFM_API_KEY`, `LINEUPIFY_HOME`, `LINEUPIFY_LOG`, `LINEUPIFY_READ_ONLY` (no writes to Spotify), `LINEUPIFY_NO_UPDATE_CHECK`.
- If you already have other servers in `mcpServers`, add `lineupify` next to them; the file must remain valid JSON (watch the commas).

Or let Lineupify write it: `npx -y lineupify-mcp install --claude-desktop`.

**Restart:** Claude Desktop only reads the config at launch, and closing the window is not enough. Quit it fully from the system tray (Windows) or the dock/menu bar (macOS), then reopen it. Lineupify should appear under the tools icon in a new chat. Say "call status" to verify.

Claude Desktop times out any tool call after 60 seconds and ignores progress notifications. Lineupify is built for this: `create_draft` returns within about 15 seconds and the assistant polls with `get_draft` (`waitSeconds: 25`) until the draft is ready.

## Claude Code

One command, user scope so it is available in every project:

```
claude mcp add --transport stdio --scope user lineupify -- npx -y lineupify-mcp
```

Windows:

```
claude mcp add --transport stdio --scope user lineupify -- cmd /c npx -y lineupify-mcp
```

Passing environment variables (options go before the server name; repeat `--env` as needed):

```
claude mcp add --transport stdio --scope user --env SPOTIFY_CLIENT_ID=0123456789abcdef0123456789abcdef --env LASTFM_API_KEY=… lineupify -- npx -y lineupify-mcp
```

Or: `npx -y lineupify-mcp install --claude-code`, which runs the same `claude mcp add` for you and prints the command if the `claude` CLI is not found.

Verify with `claude mcp list` (it should show `lineupify` as connected) or by typing `/mcp` inside Claude Code. Then say "call status".

Claude Code has no 60-second limit, so `get_draft` with `waitSeconds: 25` is simply a convenience there.

## Cursor

Config file: `~/.cursor/mcp.json` (Windows: `%USERPROFILE%\.cursor\mcp.json`). Same shape as Claude Desktop:

```json
{
  "mcpServers": {
    "lineupify": {
      "command": "npx",
      "args": ["-y", "lineupify-mcp"],
      "env": { "SPOTIFY_CLIENT_ID": "0123456789abcdef0123456789abcdef" }
    }
  }
}
```

Use `"command": "cmd"` and `"args": ["/c", "npx", "-y", "lineupify-mcp"]` on Windows. Or run `npx -y lineupify-mcp install --cursor`. Restart Cursor afterwards and check *Settings → MCP* for a green `lineupify` entry.

Cursor has the same 60-second tool timeout as Claude Desktop; the polling flow above applies.

## Global install instead of npx

If you prefer not to depend on npx (faster startup, no cache surprises):

```
npm i -g lineupify-mcp
```

Then use the binary directly in the config:

```json
{
  "mcpServers": {
    "lineupify": {
      "command": "lineupify-mcp",
      "args": []
    }
  }
}
```

and for Claude Code: `claude mcp add --transport stdio --scope user lineupify -- lineupify-mcp`. When you run `install` from a global install, it writes this form automatically.

On Windows, if the host cannot find `lineupify-mcp` on its PATH, use the full path to the shim (`npm prefix -g` shows the folder; the file is `lineupify-mcp.cmd`) with `"command": "cmd", "args": ["/c", "lineupify-mcp"]`.

## Updating

`npx -y lineupify-mcp` keeps the first version it downloaded. To update:

- `npm i -g lineupify-mcp@latest`, or
- change the config to `npx -y lineupify-mcp@latest` (re-checks npm on every start), or
- `npx clear-npx-cache` and restart the host.

`status` prints "Update available: …" when a newer version is on npm; `lineupify-mcp update-check` does the same from a terminal.

## Verifying the install

In a new chat, say "call status" (or "is Lineupify connected?"). A healthy answer looks like:

```
Lineupify 0.1.0 · Spotify API snapshot 2026-07
Spotify: connected as Alex (alexr) · authorized 11 days ago, refresh token expires in 171 days
Last.fm: no key (optional; Deezer is the primary source)
Defaults: headliner 5 / sub 3 / undercard 2 · maxTracks 250 · order interleave · private
Drafts: 0
Cache: 0 artists, 0 tracks
Next: create_draft with the lineup artists (or parse_lineup first for raw poster text).
```

If Spotify is "not set up", `status` prints the four setup steps; if the Client ID is set but you are not connected, it says "Next: connect."

From a terminal, `npx -y lineupify-mcp doctor` runs the same checks plus port, Deezer and Last.fm probes.

## Running Lineupify in two hosts at once

You can install it in Claude Desktop and Claude Code at the same time. They share `~/.lineupify/`, so drafts, cache and login are common. A draft can only be built by one process at a time; the other host reads it and reports `DRAFT_BUILDING_ELSEWHERE` if you try to edit or publish while the build is running.
