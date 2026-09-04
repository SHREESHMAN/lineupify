---
name: add-feature
description: Add or change a Lineupify tool, seed type, build option, filter, provider behaviour or error code, touching every layer that must stay in sync (types, engine, tools, server schema, tests and snapshot, README, troubleshooting, changelog). Use when implementing any user-facing change.
---

# Add or change a feature

Everything user-facing flows through the same layers. Skipping one leaves the model, the docs or CI out of sync.

## Checklist, in order

1. **Types** in `src/types.ts` (no runtime imports there). Optional fields for anything an old draft on disk may lack; drafts from earlier versions must keep loading.
2. **Engine** in `src/engine/`: pure logic in a testable function first (`filters.ts`, `select.ts`, `seeds.ts` have pure helpers next to the I/O ones). Long-running work goes inside the job in `jobs.ts`, never in a tool handler: tool calls must return within ~25 s.
3. **Sources** in `src/sources/` only for new API calls. Spotify: only endpoints Development Mode apps can call (see CLAUDE.md constraints); verify with a live probe and note it in the file header. Deezer: keyless, errors as HTTP 200 bodies; go through `get()`.
4. **Tool handler** in `src/tools/`. Clean every input with `clean()` and `clampInt()`. Throw `LineupifyError(code, message, hint)`; the hint tells the model what to do next.
5. **Register** in `src/server.ts` with a zod schema and a description written for the model: what it does, when to use it, defaults, and the next step. Shared option schemas live in `buildOptionSchemas`.
6. **Provider awareness**: if the change touches tracks or accounts, decide what happens for `provider: 'deezer'` (no Spotify calls; refuse with `PROVIDER_NEEDS_SPOTIFY` or `PROVIDER_NO_PUBLISH`).
7. **Tests** in `test/unit`: pure logic gets its own file; flows go in `jobs-flow.test.ts` with the module-boundary mocks. Then refresh the tool-surface snapshot and read the diff: `npx vitest run test/unit/server.test.ts -u`. The snapshot lists every tool and its input keys; an unexpected change here is a breaking change for users' saved prompts.
8. **Docs**: README (tools table, options table, seeds table, limits if a constraint applies), `docs/troubleshooting.md` for every new error code, `docs/hosts.md` / `docs/setup-spotify.md` if setup changes, `CHANGELOG.md` under the next version (Added / Changed / Fixed).
9. `npm run typecheck && npm run lint && npm test`, then `npm run build` so the locally registered server picks it up after a host restart.

## Patterns to reuse

- Seeds: add a case in `expandSeed()` returning `{ artists, note }`; the note is shown to the user as provenance. Validate values in `cleanSeeds()` in `src/tools/drafts.ts`.
- Filters on matched tracks: a pure `xAccepts()` in `filters.ts`, applied in `processArtist()` in `jobs.ts` (remember `seen.seenSong.delete(key)` when skipping), described by `describeFilters()` for the summary.
- Exports: `exportDraft()` in `src/tools/drafts.ts`; links must follow the provider (`trackLink()`).
- Anything that reads the user's Spotify data needs a scope in `SCOPES` (`src/sources/spotify.ts`); adding one makes `status` ask existing users to reconnect, so mention it in the changelog.
