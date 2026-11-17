# Atomic build output for parallel tests, 17 November 2026

**Trello:** [AIR-79](https://trello.com/c/485tlGLA) (found while delivering it). **Captured:** 17 November 2026 (UTC).

## Observed failure

PR #728 (documentation only), run 44183533210, job `Test shard 2 of 3`: `tests/local-api.mjs` failed with `SyntaxError: Unexpected end of input` at `dist/server/index.js:38644`. The same test passed locally on the same head. The diff touched no code.

## Cause

The suite runs files in parallel (`scripts/run-tests.mjs`, up to six jobs), and at least eleven tests run `build.mjs` themselves before they import the built bundle (for example `local-api.mjs`, `migration-export-route-absent.mjs`, `published-epg-production.mjs`, `tmdb-tv-runtime.mjs`, `owner-review-d1.mjs`). `build.mjs` deleted the whole `dist` directory and then wrote `dist/server/index.js` and `dist/server/workflow-entry.js` with plain `writeFileSync`. A test that read the bundle while another test was building saw a missing file or a partly written one.

## Change

The fix itself reached `main` in commit `50cecee` from a parallel session (the same failure, seen there as `ERR_MODULE_NOT_FOUND` in `local-api.mjs`): each output is written to a private temporary file (`<output>.<pid>.<time>.tmp`) and renamed over the target, and stale files are removed after the new ones are in place; the four tests that anchor on the write call in `build.mjs` follow the `writeAtomic` name. This change adopts that implementation unchanged when it merges `main` and adds the regression test below, which the commit on `main` did not have. Differences that the test accepts: an emptied stale directory may stay in `dist`, and a temporary file of a crashed build is not removed (it is ignored by readers and by the deploy).

## Regression test

`tests/build-atomic-dist.mjs` (core suite) starts three builds at once and reads both outputs in a loop while they run; every read must return the complete expected bytes. It also checks that every build succeeds, that none of its own builds left a temporary file and that a stale file in `dist` is removed. Other tests build into the same `dist/` in parallel, so the checks on the directory are scoped to this test's own build processes (temporary files carry the builder's process id) and to the stale entries the test creates; the review of the first head found that a whole-directory check could fail on another test's legitimate in-flight temporary file. With a loop of 40 unrelated builds running alongside, the scoped test passed four runs of four, and it still failed two runs of two against the previous `build.mjs`. Against the `build.mjs` before `50cecee` it fails (`read workflow-entry.js during a build: ENOENT`, three runs of three, and again after the merge); against the implementation on `main` it passes (three runs of three after the merge, 56 to 60 reads overlapping the builds).

## Verification

Local, after merging `main` (which carries `50cecee`) and a fresh `npm ci`: `npm run test:all` passed with the core suite at 421 of 421 files and the non-functional suite at 40 of 40, and `npm run build` was clean. `build.mjs` is identical to `main`. The first version of this change carried its own implementation; it was replaced by the one on `main` when the branch was reconciled, and the four test anchors were already the same (`writeAtomic('dist/server/...'`). The review of the first head found that the test checked the whole shared `dist/server` directory; its directory checks are scoped to the test's own build processes. CI of the pull request and its review are recorded on the pull request.
