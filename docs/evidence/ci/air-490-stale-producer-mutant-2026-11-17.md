# AIR-490: stale producer mutation after AIR-497 (17 Nov 2026)

**Captured:** 17 November 2026, 09:40 Europe/Madrid. **Method:** GitHub Actions job logs of a `workflow_dispatch` of `.github/workflows/nonfunctional-tests.yml` plus a local read of `src/canonical-producer-store.js` on the same SHA. No Worker, R2, D1, Cloudflare or production write.

## What failed

Manual run [44041418097](https://github.com/vladimino/iptv-watchlist/actions/runs/44041418097) on `main` SHA `69914093aa042cb61897aa8a6ff64361d7db9b81`, `event=workflow_dispatch`, job conclusion `failure`. Artifact `nonfunctional-test-report` uploaded. This proves the workflow can start; it does not prove `schedule`.

`npm test -- --suite non-functional` started 40 files, fail-fast after two failures: `canonical-producer-driver-mutation.mjs` and `canonical-producer-driver-mutation-b.mjs`. Shared preflight in `tests/canonical-producer-driver-mutation-lib.mjs`:

`the mutation text of "a result update ignores the route gate" must occur exactly once` — `actual:1 expected:2` (the `from` string occurs zero times).

## Cause

Mutant `a result update ignores the route gate` still expected `await commit(env,gate,[fence(gate),\n  ['UPDATE ...`. `updateResult` in `src/canonical-producer-store.js` now commits `[fence(gate),...producerExtras(env,gate,{at}),\n  ['UPDATE ...` after AIR-497 (`24813e3f0ffc`). The live `if(!gate.open)return SKIPPED;` guard is still present. This is a stale harness, not a missing route gate.

Both split files fail on the same preflight, so no mutant was applied in that run.

## Fix in this change

The producer `from`/`to` pair keeps `...producerExtras(env,gate,{at}),` and `to` still removes only the route-gate line. Other producer mutants and fences are unchanged.

A full local `npm test -- --suite non-functional` then failed further stale harnesses. `canonical-catalog-titles-mutation.mjs`: `the helper needs an open gate` (and four other title-helper `from` strings) occurred more than once after AIR-499 added `catalogPeopleFromD1` and `catalogMetadataFromD1`. Those mutants are scoped to `catalogTitlesFromD1` / `TITLE_SQL` (the helper `tests/canonical-catalog-titles.mjs` actually calls). `canonical-differential-mutation.mjs`: `a producer no longer needs the person kind` still listed the old P3 `requires` array; it now drops `person_mutation` from the live `epg_commit` wiring.

Three more harnesses still expected `assertWritable` / `fenced.commit` after producer-fence bind and `writeFenced`: `canonical-film-writers-mutation.mjs` (`the marker gate is skipped`), `canonical-person-state-mutation.mjs` (person-state and conflicts gates), `canonical-receipted-writers-mutation.mjs` (`admitRatedFilm` / `retainFilm` tails). Local `npm test -- --suite non-functional` then passed all 40 files (wall 213.9 s). Core suite and `npm run build` also pass. No production source change.
