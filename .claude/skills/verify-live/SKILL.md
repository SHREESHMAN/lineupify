---
name: verify-live
description: Exercise Lineupify against the real Spotify, Deezer and Last.fm APIs and the published npm package: live tests, smoke scripts, a stranger-style install, and a Deezer-mode build. Use before a release, after an API change, or when asked to test the whole app.
---

# Verify Lineupify live

The unit suite is offline; these steps prove the real world still matches. Nothing here publishes a playlist unless you call `create_playlist` yourself.

## 1. Offline gate first

```
npm run typecheck && npm run lint && npm test
```

## 2. Deezer (no account needed)

```
npm run test:live
```

Covers artist resolution, related artists, chart, playlist search and tracks, ISRC lookup (tempo), title search ordering.

## 3. Spotify (needs a connected account: `lineupify-mcp doctor` shows it)

```
npm run smoke:spotify                                       # every endpoint; leaves a playlist named "[delete me] Lineupify smoke"
npx tsx test/smoke/playlists.ts <public user-made playlist link>   # read, analysis, taste profile, all seed types, library read
```

Spotify-made playlists (Discover Weekly, editorial) 404 by design; use a playlist a person made.

## 4. Deezer mode end to end (no Spotify)

Run the tool handlers directly with `tsx`, e.g. a script that imports `src/tools/drafts.ts` and calls `createDraft({ provider: 'deezer', artists: [...], seeds: [{ type: 'genre', value: 'shoegaze' }], yearRange: { from: 2010 } })`, polls `getDraftTool` with `waitSeconds: 25`, then `exportDraft` with `format: 'links'`, `searchTracks({ provider: 'deezer' })`, `editDraft` `add_track`, `readPlaylistTool` / `mergePlaylistsTool` / `expandPlaylistTool` on a public Deezer playlist such as `https://www.deezer.com/playlist/1109890291` (Top France by Deezer Charts). Delete the drafts afterwards with `deleteDraft` from `src/engine/draft.ts`, or they clutter `list_drafts` (unpublished drafts are pruned after 30 days anyway).

## 5. The published package, as a stranger

```
export LINEUPIFY_HOME=$(mktemp -d)      # PowerShell: $env:LINEUPIFY_HOME = "$env:TEMP\lineupify-fresh"
export LINEUPIFY_NO_UPDATE_CHECK=1
npx -y lineupify-mcp@latest --version
npx -y lineupify-mcp@latest doctor      # Client ID missing is expected; Deezer must be OK
npx -y lineupify-mcp@latest setup --client-id nope          # must reject
printf 'Khruangbin\nWet Leg\n' > lineup.txt && npx -y lineupify-mcp@latest preview lineup.txt --per-artist 2
npx -y lineupify-mcp@latest init < /dev/null                 # must explain it is interactive and exit 2
```

Run this from a directory outside the repo so `npx` fetches from the registry rather than the local package.

## 6. Protocol

```
npm run build && node test/smoke/mcp-stdio.mjs               # initialize, tools/list (21 tools), status, parse_lineup
node test/smoke/mcp-stdio.mjs status                          # any single tool: node test/smoke/mcp-stdio.mjs <tool> '<json args>'
```

## What "good" looks like

- Seeds return sensible artists (similar_to Khruangbin → Skinshape, Sault, BALTHVS; shoegaze → Slowdive, my bloody valentine; Brazil → Anitta, Ana Castela).
- A 64-track playlist reads in under 2 s; analysis with genres and tempo under ~15 s the first time.
- Remaster years show as `2024?` and are kept unless `strictYear`; that is documented behaviour, not a bug.
- If Spotify starts returning 404/403 on an endpoint the smoke test uses, update the header of `src/sources/spotify.ts` and `SPOTIFY_API_SNAPSHOT`, then see the `api-check` skill.
