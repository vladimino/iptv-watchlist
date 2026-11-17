# Atomic build output for parallel tests, 17 November 2026

**Trello:** [AIR-79](https://trello.com/c/485tlGLA) (found while delivering it). **Captured:** 17 November 2026 (UTC).

## Observed failure

PR #728 (documentation only), run 44183533210, job `Test shard 2 of 3`: `tests/local-api.mjs` failed with `SyntaxError: Unexpected end of input` at `dist/server/index.js:38644`. The same test passed locally on the same head. The diff touched no code.

## Cause

The suite runs files in parallel (`scripts/run-tests.mjs`, up to six jobs), and at least eleven tests run `build.mjs` themselves before they import the built bundle (for example `local-api.mjs`, `migration-export-route-absent.mjs`, `published-epg-production.mjs`, `tmdb-tv-runtime.mjs`, `owner-review-d1.mjs`). `build.mjs` deleted the whole `dist` directory and then wrote `dist/server/index.js` and `dist/server/workflow-entry.js` with plain `writeFileSync`. A test that read the bundle while another test was building saw a missing file or a partly written one.

## Change

`build.mjs` writes each output to a temporary file in the same directory (`<name>.<pid>.<random>.tmp`) and renames it over the target, which is atomic on the same file system. It no longer deletes `dist`; instead it removes, by name, every entry it does not produce. A temporary file of another build that is still running is kept; one older than ten minutes (a crashed build) is removed. The bundle bytes are unchanged: `sha256` of both outputs is the same before and after the change on the same checkout.

## Regression test

`tests/build-atomic-dist.mjs` (core suite) starts three builds at once and reads both outputs in a loop while they run; every read must return the complete expected bytes. It also checks that every build succeeds, that no temporary file is left and that a stale file or directory in `dist` is removed. Before the change it failed in three runs of three (`read workflow-entry.js during a build: ENOENT`); after the change it passed five runs of five, with 60 to 94 reads overlapping the builds.

## Verification

Local, on the final checkout after a fresh `npm ci`: `npm run test:all` passed with the core suite at 419 of 419 files and the non-functional suite at 40 of 40; `npm run build` and `git diff --check` were clean; the output `sha256` matched the build before the change. A first full run stopped at `tests/admin-actions.mjs`: four tests (`admin-actions`, `admin-query`, `discovery-workflow`, `epg-diagnostic-bindings-ready`) locate the bundle text in `build.mjs` by the literal `fs.writeFileSync('dist/server/...'`, so the helper takes the full output path and those anchors now read `writeAtomic('dist/server/...'`. CI of the pull request and its review are recorded on the pull request.
