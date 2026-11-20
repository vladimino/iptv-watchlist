# View index D1 read source: implementation evidence (dormant)

**Date:** 2026-11-20 UTC. **Source tree:** `main` `c49f1b3` plus this change. **Work:** [AIR-552](https://trello.com/c/Hk2dJf2U); decision [ADR 0183](../../adr/0183-view-index-membership-from-d1-rows.md) (Accepted, option A); accepted parity evidence [production membership parity](air-552-membership-parity-production-readonly-2026-11-20.md); contract [view index read model](../../reference/domain/view-index-read-model.md); runbook [view index source](../../runbooks/view-index-source.md).

## Scope and evidence boundary

Repository change and offline tests only. **No production read or write was made for this report, no flag or binding was set, no migration was applied.** The change is dormant: the temporary selector `VIEW_INDEX_SOURCE` defaults to `r2`, which keeps every reader on the raw object exactly as before. The `d1` path exists and is tested; it is activated only by an owner-approved setting of the Worker binding, which this change does not make and a deploy does not make. Measurements below are offline Node runs on a SQLite D1 stand-in with synthetic production-shaped data; they are not Worker CPU, memory or D1 latency.

## What was implemented

- `PredictionD1.derivedIndex` (`src/prediction-d1.js`): the film ids of `prediction_pointer` and `prediction_fingerprint` in keyset pages of 300 (the existing 20,000-row cap per table), each entry built by the existing overlay rule. It refuses unless the prediction marker is `d1`.
- `viewIndexSource`, `viewIndexIsD1`, `derivedViewIndex`, `viewIndexD1Version` (`src/worker.js`): the selector (only exactly `d1` selects the D1 source), the derived view (the prediction union, then `RatingsD1.overlayView`, which adds the `ratings_view` aliases), and a version token `d1:p<generation>.q<queue generation>.r<ratings generation>` in place of an ETag. A ratings domain that is not `d1` and open refuses. The compiled seed stays a separate layer applied by the readers that apply it.
- Readers switched: `loadJSON` (and through it `readViewIndex`, programme, Finds, the queue builder, prediction diagnostics, the mood diagnostics, the catalog film route), the footer reader, Admin health, Admin limbo, the prediction recovery pin, and `LetterboxdFacts.readJSON` (ratings aliases only, as before). The second prediction overlay pass of the queue builder and of `GET /api/enrichment/view` is skipped under `d1`.
- Unchanged by design: the raw writers (`updateViewIndex`, `ensureInitialRatings`, the mood and fingerprint backfills, the Letterboxd compare-and-swap writers, which now read through a separate raw reader), the owner diagnostic export, the operator Letterboxd scripts and the snapshot tooling.
- Flag register: `VIEW_INDEX_SOURCE` in `src/feature-flags.js`, `docs/reference/feature-flags.md` and the governance checker's flag list.

## Tests (core, offline)

- `tests/view-index-d1-source.mjs`, on a real SQLite D1 with every migration and the production authorities: selector values; `r2` and `d1` serve the identical index while the raw key set equals the D1 key set, with stale raw facts never served; the raw object is never read and R2 is never written under `d1`; only `SELECT`s reach D1; typed forecast and feature gains and the removed key against the offline classifier; seed layer (own `null` wins, a rating wins, an unknown rating takes the seed, a seed-only id adds a key); footer parity and its refusal; fail-closed refusals for no binding, a held ratings cutover, a prediction marker that is not `d1` and a malformed row, none of which reads the raw object; keyset statement counts at page boundaries (0, 1, 299, 300, 301, 600, 601 rows) and the 20,000-row cap; the raw writer still writes under `d1`; the Letterboxd facts reader reads no prediction table and no raw object. A mutation of the `loadJSON` branch fails it.
- `tests/admin-limbo-api.mjs`, `tests/admin-health-api.mjs`, `tests/admin-prediction-recovery-api.mjs`: under `d1` the raw object is not read, the pin or displayed version is the D1 token, the limbo cache follows the token, and any other selector value keeps the raw object.
- `tests/feature-flags.mjs`: registration, absent and invalid values (`D1`, ` d1`, `on`, `d1,r2` and empty are `r2` and invalid).
- Local on the final checkout: see the pull request for the exact tested SHA and the results of `npm ci`, `npm run test:all` and `npm run build`.

## Offline cost measurement (not Worker cost)

Fixture: 4,947 pointer rows, 4,947 fingerprint rows and 4,494 ratings rows (the audited table sizes) in a SQLite D1 stand-in, and a synthetic raw object of 14,316,310 bytes with 5,380 entries (the audited object was 13,809,022 bytes). Five calls of `loadJSON` per source in one Node process:

| Source | Keys | D1 statements | Median wall | CPU per call | Heap growth (max) |
| --- | --- | --- | --- | --- | --- |
| `r2`: raw object parsed, then the overlays | 5,380 | 52 | 326 ms | 152 ms | 39.6 MB |
| `d1`: derived | 4,947 | 55 | 266 ms | 75 ms | 21.7 MB |

The statement counts are almost equal (the overlays read the same pages under both; `d1` adds the authority reads); what `d1` saves is reading and parsing the 14 MB object, about half the CPU and heap in this run. The key counts differ only because the synthetic raw object carries raw-only keys. Treat the figures as an order of magnitude: the Worker's CPU, the 128 MB isolate and real D1 latency are not measured, and the figures must be measured on the Worker before any switch.

## Not done, and why

- **Raw writers, the raw read path and the selector are not retired.** They stay until a controlled switch and its stabilization; retiring them is a separate authorized change (runbook).
- **Operator Letterboxd scripts and the snapshot export** still read a snapshot of the raw object. It is current only while the writers run, so they need a defined D1-derived input before the writers are retired. That is recorded in the contract and the runbook; no script was changed here.
- **The temporary flag's removal card** is required by the flag lifecycle before the rollout; it is not created by this change and is listed for the Delivery Controller in the pull request.
- **No production behavior was verified.** Parity at one instant is the [accepted audit](air-552-membership-parity-production-readonly-2026-11-20.md); a fresh comparison, the before and after readback and the Worker measurements belong to the switch plan.

## Verdict

The D1 read source is implemented, dormant and covered offline; it is not activated and nothing here proves production behavior. AIR-552 stays open until a controlled switch, readback and owner acceptance.
