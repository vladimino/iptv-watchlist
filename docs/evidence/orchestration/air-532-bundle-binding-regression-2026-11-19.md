# AIR-532: the Worker bundle lacked the retention watermark bindings (19 Nov 2026)

Date: 19 Nov 2026. Source of the production facts: the owner's read-only observation recorded on the [AIR-532](https://trello.com/c/mGPwomMX) card (MCP `epg_status`, `epg_pipeline_status`; about 17:43-17:45 Madrid, 15:43-15:45 UTC). This note was written by the executor from that record and from the source of `main`; no production query or write was made for it.

## What happened

After [PR #771](https://github.com/vladimino/iptv-watchlist/pull/771) was deployed and migration `0025` was applied, the natural EPG run of 19 Nov (due 16:00 UTC, 17:00 Madrid) did not publish. The card record shows `publishedAt` null after 43+ minutes, `syncRun.stage seal`, `sealPhase finalize`, `error 'readRetentionWatermark is not defined'`, four consecutive failures (cap 5), a cooldown, the publication pointer not moved, and Discovery paused (`epg_committed`, 12 chunks pending). It was not D1 schema corruption and not a timing problem.

## Root cause

`src/canonical-rated-admission-producer.js` imports `advanceRetentionWatermark` and `readRetentionWatermark` from `./film-admission.js`. `build.mjs` builds the Worker with `scopedImports(file, name, preamble)`: it **strips every ES import** from the module and prepends a hand-written preamble that destructures the already-scoped bindings. The preamble of the producer named the previous functions but not these two, so in the generated Worker scope both were undefined and `applyRatedAdmissionRetention` threw at the first call (`finalize_scan`). Even with `readRetentionWatermark` restored the next call would have failed at `advanceRetentionWatermark`.

## Why the tests did not see it

Every test of PR #771 imported the **source modules** as real ES modules, where the import resolves. The bundle the Worker actually runs was never executed: the tests that read `dist/server/index.js` slice other scopes. The preamble is a second, hand-maintained copy of the import list, and nothing compared it with the imports.

## Fix

- `build.mjs`: the preamble of `CanonicalRatedAdmission` destructures both functions from `CanonicalFilmAdmission`.
- `scripts/bundle-scope.mjs` (`scopedImports`): the build now **fails** when a module imports a name, uses it in its body, and the preamble does not provide it ("imports and uses X but the scope preamble does not provide it: it would be undefined in the Worker"). An import the module never uses needs no binding; an aliased import is checked under its local name.
- Review of all 23 scoped modules with that check found two more gaps of the same class, in the dormant producer chain (it runs only with `PRODUCER_WORKFLOW`): `canonical-producer-store.js` used `readChain` without a binding, and `canonical-producer-workflow.js` used `database`, `many`, `buildEpgPlan`, `completeChain`, `parseReleasePin` and `pinChainReleases` without bindings. All six are exported by their scoped modules and were added to the preambles; nothing else in those modules changed.
- `tests/canonical-rated-admission-bundle.mjs` (core): builds the bundle every time (a stale local `dist` cannot stand in), executes the generated scope chain in a `vm`, and on a schema-25 D1 stand-in runs `CanonicalRatedAdmission.applyRatedAdmissionRetention` through a first observation (watermark advanced) and an unchanged later scan (no-op, no row, receipt or revision rewrite, watermark moved). It also unit-tests the new build check.

## Verification of the guard (mutants)

Removing `readRetentionWatermark` from the preamble fails the build check; removing `advanceRetentionWatermark` fails it too. With the build check disabled and `readRetentionWatermark` removed, the bundle test reproduces the production symptom exactly: `ReferenceError: readRetentionWatermark is not defined`.

## Not changed and not authorized

No migration, D1 or R2 write, EPG or Discovery run, Workflow retry or restart, quarantine clearing, lease reset, flag or Task was made. This fix does not recover the 19 Nov run. Deploying or rolling back while the run is unfinished is forbidden by `docs/runbooks/deployment.md` (ADR 0144/0145): recovery needs its own owner-approved plan, and the code must not be merged or deployed automatically while the gate holds.
