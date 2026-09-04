# Contributing to Lineupify

Thanks for helping. This page is short on purpose; the README explains what the project does and the limits it works within.

## Setup

```
git clone https://github.com/shreeshman/lineupify
cd lineupify
npm install
npm run typecheck && npm run lint && npm test
```

Node.js 20 or newer. The unit tests run offline: Spotify and Deezer are mocked at the module boundary (see `test/unit/jobs-flow.test.ts` for the pattern). Nothing in `npm test` needs a Spotify account.

## Running against the real APIs

- `npm run test:live` hits Deezer's public API (no key).
- `npm run smoke:spotify` exercises every Spotify endpoint Lineupify uses and needs a connected account (`npm run dev -- auth`, or `lineupify-mcp auth`). It creates a playlist named `[delete me] Lineupify smoke`; Spotify has no delete API, so remove it by hand.
- `npx tsx test/smoke/playlists.ts <public playlist link>` runs reads, analysis and every seed type live.

To run the server from source inside a host, register `node <repo>/dist/index.js` after `npm run build`, or `npx tsx src/index.ts` for a dev loop.

## Working with an AI assistant

`CLAUDE.md` at the repo root holds the constraints and conventions an assistant needs, and `.claude/skills/` has step-by-step skills for releases (`release`), live verification (`verify-live`), adding features (`add-feature`), Dependabot PRs (`dependabot-triage`) and API breakage (`api-check`). They are written for Claude Code but read fine as human checklists.

## Ground rules

- **Only Spotify endpoints that Development Mode apps can call.** No recommendations, related artists, top tracks, audio features, batch fetches or Spotify-made playlists. If a feature needs discovery data, get it from Deezer (keyless) or Last.fm (optional key). `src/sources/spotify.ts` has the verified list in its header.
- **Every tool call returns within 25 seconds.** Claude Desktop and Cursor kill calls at 60 s. Long work goes through the background job in `src/engine/jobs.ts` and is polled with `get_draft`.
- **Nothing is written to Spotify before `create_playlist`.** New entry points produce drafts.
- **External text is untrusted.** Anything from a poster, a track title, a playlist description or a Deezer response passes through `clean()` from `src/infra/text.ts` and is shown inside fixed table layouts.
- **stdout is the protocol channel.** Log with `src/infra/log.ts` (stderr) only; `no-console` is enforced by ESLint.
- **Pure logic lives in `src/engine/`** with unit tests; I/O lives in `src/sources/` and `src/infra/`.

## Adding a seed, an option or a tool

1. Types in `src/types.ts`.
2. Logic in `src/engine/` (seeds in `seeds.ts`, filters in `filters.ts`).
3. Wire it in `src/tools/` and register the schema in `src/server.ts` with a description a model can act on.
4. Tests, then the README tables, `docs/troubleshooting.md` for any new error code, and a line in `CHANGELOG.md` under *Unreleased*.

## Releasing (maintainers)

1. Update `CHANGELOG.md`, then `npm version minor` (or `patch`). This bumps `package.json` and, through the `version` npm script, copies the number into `manifest.json` and `server.json` in the same commit.
2. `git push --follow-tags`. The Release workflow runs the checks, publishes to npm through npm Trusted Publishing (OIDC: the package settings on npmjs.com name this repository and `release.yml` as the trusted publisher, so no token exists anywhere), builds the Claude Desktop `.mcpb` and attaches it to the GitHub release. If the version is already on npm the publish step is skipped.
3. Update the MCP Registry entry: `mcp-publisher publish` with the `server.json` in the repo root (see https://github.com/modelcontextprotocol/registry).

## Security

Do not open public issues for vulnerabilities. See [SECURITY.md](SECURITY.md).
