# Lineupify (package `lineupify-mcp`)

MCP server (TypeScript, Node 20+, stdio) that builds Spotify or Deezer playlists from festival lineups, genres/moods, similar artists, other playlists, or a blend of several people's taste. Bring-your-own Spotify client ID; Deezer mode needs no account. Read the README for features; this file is for working on the code.

## Commands

```
npm ci
npm run typecheck && npm run lint && npm test   # offline; must be green before any commit
npm run coverage                                 # same suite with a report
npm run build                                    # dist/ (the registered MCP server runs dist/index.js)
npm run bundle:mcpb                              # build/lineupify-<version>.mcpb for Claude Desktop
npm run test:live                                # live Deezer (no key)
npm run smoke:spotify                            # every Spotify endpoint; needs a connected account
npx tsx test/smoke/playlists.ts <public playlist link>   # reads, analysis, seeds, live
```

Skills in `.claude/skills/` cover the recurring jobs: `release`, `verify-live`, `add-feature`, `dependabot-triage`, `api-check`.

## Layout

- `src/types.ts` shared types, no runtime imports.
- `src/sources/` I/O clients: `spotify.ts` (PKCE auth, the few Web API calls Development Mode apps still have, header lists what was verified), `deezer.ts` (keyless), `lastfm.ts` (optional key).
- `src/engine/` logic, mostly pure and unit-tested: `jobs.ts` background build (seeds → resolve → rank → match → filters → dedupe → order), `resolve.ts`, `match.ts`, `seeds.ts`, `playlists.ts` (read playlists, taste profile), `filters.ts`, `covers.ts`, `analyze.ts`, `compare.ts`, `draft.ts` (persistence, edits, undo), `render.ts` (all tool text output), `select.ts`, `normalize.ts`, `lineup.ts`.
- `src/tools/` MCP tool handlers; `src/server.ts` registers them with zod schemas and descriptions the model acts on; `src/cli.ts` terminal commands.
- `src/infra/` config (`~/.lineupify`, env vars), JSON caches, HTTP with per-host rate limits, logging (stderr only), text cleaning.
- `test/unit` offline suite (Spotify/Deezer mocked at the module boundary, see `jobs-flow.test.ts`); `test/unit/server.test.ts` boots the real server over stdio and snapshots the tool surface; `test/live`, `test/smoke` hit real APIs.
- `notes/` is gitignored local planning (roadmap, original plan). Do not reference it from tracked files.

## Hard constraints (verified against the live APIs, Sept 2026)

- Spotify Development Mode apps: 5 users, owner needs Premium, no recommendations / related artists / top tracks / audio features / genres on artist objects / batch GETs, search limit 10, Spotify-made playlists 404, playlist items come back under `item`. Never add a call to a removed endpoint. `SPOTIFY_API_SNAPSHOT` in `spotify.ts` records the verified month.
- Deezer: keyless reads only; app registration closed since 2025, so **no Deezer writes**. `/genre/{id}/artists` and `/chart/{genre}` return the global chart (use playlist search instead). Errors arrive as HTTP 200 bodies (`get()` in `deezer.ts` handles codes 4 and 800).
- Claude Desktop and Cursor kill tool calls at 60 s: every tool returns within ~25 s; long work goes through `startJob` in `jobs.ts` and is polled with `get_draft`.
- Nothing is written to Spotify before `create_playlist`. `LINEUPIFY_READ_ONLY=1` must keep disabling writes.
- Redirect URI is `http://127.0.0.1:8765/callback` exactly (http is correct for loopback; the dashboard rejects the port-less form).

## Conventions

- Every string from a poster, an API or a playlist is untrusted: pass it through `clean()` (`src/infra/text.ts`) and keep it inside fixed table layouts in `render.ts`.
- stdout is the MCP channel. Log only through `src/infra/log.ts`; ESLint enforces `no-console` in `src/`.
- Errors are `LineupifyError(code, message, hint)`. Every new code goes into `docs/troubleshooting.md`.
- A tool or option change touches, in order: `src/types.ts`, engine, `src/tools/`, `src/server.ts`, tests (run `npx vitest run test/unit/server.test.ts -u` to refresh the tool-surface snapshot and review the diff), README tables, `docs/troubleshooting.md`, `CHANGELOG.md` under the next version.
- Tests are offline by default. Mock `../../src/sources/spotify.js` / `deezer.js` with `vi.mock` and `importOriginal`; use a fresh `LINEUPIFY_HOME` temp dir per test file.
- Commit messages: subject plus a short body, no trailers of any kind (no `Co-Authored-By`).
- Version lives in `package.json`; `npm version` copies it into `manifest.json` and `server.json` via `scripts/sync-version.mjs`. Never edit those two by hand.
- Provider-aware code: a draft has `provider: 'spotify' | 'deezer'`. Deezer drafts use `deezer:track:<id>` URIs, empty `spotifyId`, and must never reach a Spotify call; refusals use `PROVIDER_NO_PUBLISH` / `PROVIDER_NEEDS_SPOTIFY`.

## Release and repo automation

- CI (`.github/workflows/ci.yml`): typecheck, lint, tests, build on Node 20/22 × Linux/Windows, on push and PR.
- Release (`.github/workflows/release.yml`): on a `v*` tag or manual dispatch. Publishes to npm through **npm Trusted Publishing (OIDC)**, no token; provenance only when the repo is public; skips npm if the version exists; builds the `.mcpb` and creates/updates the GitHub release. See the `release` skill.
- Dependabot: eslint + @eslint/js grouped, dev minors/patches grouped, TypeScript and @types/node majors ignored (typescript-eslint lags TypeScript majors; Node types track the Node 20 floor). See the `dependabot-triage` skill.
- npm package settings: 2FA required, bypass tokens disallowed; the trusted publisher is `SHREESHMAN/lineupify` + `release.yml`.

## Data on the user's machine

`~/.lineupify/` (`LINEUPIFY_HOME`): `config.json`, `tokens.json`, `cache/*.json`, `drafts/`, `exports/`. `disconnect` / `lineupify-mcp logout --purge` removes it. Tests must never touch the real folder.
