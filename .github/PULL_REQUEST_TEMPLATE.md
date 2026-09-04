## What

<!-- One or two sentences: what changes and why. Link the issue if there is one. -->

## Checklist

- [ ] `npm run typecheck && npm run lint && npm test` pass locally
- [ ] New behaviour has a unit test (offline; mock Spotify/Deezer at the module boundary like `test/unit/jobs-flow.test.ts`)
- [ ] Tool descriptions, README tables and `docs/troubleshooting.md` updated if a tool, option or error code changed
- [ ] `CHANGELOG.md` has an entry under *Unreleased*
- [ ] No new Spotify endpoint that Development Mode apps cannot call (see README, *Limits*)
