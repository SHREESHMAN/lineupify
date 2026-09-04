---
name: dependabot-triage
description: Review and land Dependabot pull requests on Lineupify: which to merge, how to handle conflicting adjacent bumps, majors that need code changes, and the ignore rules. Use when asked to check PRs, workflow runs, or dependency updates.
---

# Dependabot triage

Config: `.github/dependabot.yml`. Weekly. Groups: `eslint` (eslint + @eslint/*, always together because they peer-depend on each other), `dev-dependencies-minor` (minor/patch of other dev deps). Majors of other packages arrive one PR each. Ignored: TypeScript majors (typescript-eslint pins a range and lags), `@types/node` majors (types track the Node 20 floor in `engines`).

## Look

```
gh pr list --json number,title,mergeable --jq '.[] | "#\(.number) \(.mergeable) \(.title)"'
gh run list --limit 10 --json status,conclusion,displayTitle,event --jq '.[] | "\(.status) \(.conclusion // "-") [\(.event)] \(.displayTitle)"'
gh run view <id> --log-failed | grep -E "npm error|error TS|✖|problems"
```

## Decide

- **GitHub Actions bumps** (checkout, setup-node): merge when CI is green. `gh pr merge <n> --squash --delete-branch`.
- **Runtime deps** (`open`, `zod`, `@modelcontextprotocol/server`): read the PR body for breaking notes; `open` and the SDK matter to users. Merge when green and the notes are benign; for the MCP SDK also run `node test/smoke/mcp-stdio.mjs` after `npm run build`.
- **Dev majors** (ESLint, Vitest): CI is the judge, but read the notes. ESLint majors add default rules; the fixes are usually small and worth making on `main` (that is how ESLint 10 landed: two rule fixes, then the bump).
- **Failing at `npm ci` with ERESOLVE**: a peer range conflict (typically TypeScript vs typescript-eslint). Close the PR; the ignore rule should have caught it, so check the config.

## Conflicts between two Dependabot PRs

They edit adjacent lines (e.g. checkout and setup-node in the same workflow). Merge one, then either comment `@dependabot rebase` on the other, or apply the bump on `main` yourself and close the PR with a comment naming the commit. Applying directly is faster and deterministic:

```
git pull --ff-only origin main
sed -i 's#actions/setup-node@v4#actions/setup-node@v7#g' .github/workflows/*.yml
git commit -am "Bump actions/setup-node from 4 to 7" && git push
gh pr close <n> --comment "Applied on main in <sha>"
```

## After merging

```
git pull --ff-only origin main && npm ci && npm test
```

Keep `package-lock.json` committed; never `npm install` a dep in the same commit as unrelated code.
