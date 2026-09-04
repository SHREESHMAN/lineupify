---
name: release
description: Cut a Lineupify release: changelog, version bump with synced manifest/server.json, tag push, watch the Release workflow, verify npm and the GitHub release, then the MCP Registry. Use when asked to release, publish, bump the version, or ship a new version.
---

# Release Lineupify

Releases are tag-driven. npm publishing uses npm Trusted Publishing (OIDC) from `.github/workflows/release.yml`; there is no token to manage.

## Preconditions

1. Working tree clean, on `main`, up to date with `origin/main`.
2. `npm run typecheck && npm run lint && npm test` green locally.
3. `CHANGELOG.md` has a section for the new version with a date (change `Unreleased` to today's date). Keep the Keep-a-Changelog structure: Added / Changed / Fixed.
4. If tools, options or error codes changed: README tables, `docs/troubleshooting.md` and the tool-surface snapshot (`npx vitest run test/unit/server.test.ts -u`, review the diff) are updated.

## Steps

```
npm version <patch|minor|major>      # bumps package.json, runs scripts/sync-version.mjs (manifest.json, server.json), commits, tags v<version>
git push --follow-tags               # pushes main and the tag; the tag starts the Release workflow
gh run watch $(gh run list --workflow Release --limit 1 --json databaseId --jq '.[0].databaseId')
```

Use `minor` for new tools/seeds/providers, `patch` for fixes and docs. Never edit `manifest.json` or `server.json` versions by hand.

## Verify

```
npm view lineupify-mcp version                      # new version, tag latest
gh release view v<version> --json assets --jq '.assets[].name'   # lineupify-<version>.mcpb attached
```

If the workflow fails:
- **E422 provenance / private repository**: the repo is private; the workflow already publishes without provenance in that case. If it still fails, check `github.event.repository.private` handling in the publish step.
- **Tag already exists** on the release step: the check uses `git ls-remote`; a manual run on an old checkout can still race. Re-run the workflow; it uploads with `--clobber`.
- **npm 4xx on publish**: the trusted publisher on npmjs.com must name `SHREESHMAN` / `lineupify` / `release.yml` with direct publish allowed, and the runner needs npm ≥ 11.5.1 (the workflow upgrades npm).
- Re-run by hand from the Actions tab or `gh workflow run release.yml --ref main`; it skips npm when the version already exists and refreshes the release asset.

## After

- Submit or update the MCP Registry entry: `server.json` in the repo root, `mcp-publisher publish` (https://github.com/modelcontextprotocol/registry). `mcpName` in `package.json` must match `server.json`'s `name`.
- The registered local MCP server (`dist/index.js`) needs `npm run build` and a host restart to run the new code.
- Do not add release notes by hand: `gh release create --generate-notes` writes them from merged PRs and commits.
