# AIR-532: watchlist retention, before and after (offline benchmark)

**Date:** 2026-11-18 (UTC). **Source:** `node scripts/bench-watchlist-retention.mjs <N>` on the sqlite D1 stand-in (`tests/d1-standin.mjs`), schema chain up to the current migration, marker `open` generation 2, receipt baseline seeded, N Films with a trusted `tmdb` and `letterboxd` id. **No production read or write.** A "round trip" is one `first()/all()/run()` or one `batch()` call, as in ADR 0106.

## Method and limits

- Each scan feeds `watchlistRetentionWork` and `applyRatedAdmissionRetention` slice by slice at `UNIT_CAP=12`, exactly like `persistScan`, and counts every D1 call.
- The numbers are round trips, not wall time. The stand-in's wall time is process spawn cost and says nothing about production latency; production per-slice latency, the real cursor size and the ~75–80 s per slice of 18 November were **not** re-measured here.
- Baseline = `main` at 26c57ee, measured with N=12 (one slice). The 400-Film "before" total is that figure times 34 slices, an extrapolation, not a run.

## Result

| Scenario (N=400) | Before (round trips) | After | Write batches before / after | Slices |
|---|---|---|---|---|
| Day 1, first observation (400 changes) | 389 per slice, ~13 200 | 6 272 (184 per slice) | 24 per slice / 800 | 34 |
| Day 2, unchanged watchlist | 389 per slice, ~13 200 | **1 472 (43 per slice)** | 24 per slice (all 12 rewritten) / **0** | 34 |
| Day 3, +1 / -1 | 436 per 13 Films | 1 499 | 26 per 13 Films / 4 (two exits/adds written) | 34 |

Unchanged day: about **9× fewer D1 round trips and no writes**; every unit ends as `noop`. First observation: about 2.1× fewer round trips.

Where the gain comes from, per slice of 12 Films (measured one change at a time on N=12, unchanged day):

| Step | Round trips per slice |
|---|---|
| Before | 389 (173 after the delta only) |
| + marker read in 2 statements instead of 5 (`readAuthority`) | 128 |
| + one statement per Film plan, one external-id read, one redirect+film read, route read once per slice | 44 |

## The three directions of the card

1. **Delta (applied):** a scan that repeats the stored boolean writes nothing ([ADR 0173](../../adr/0173-watchlist-retention-observed-at-is-state-start.md), owner decision of 18 November). `observed_at` is the start of the current state.
2. **Batching (applied to reads):** `readAuthority` 5→2 statements, `planRetention` 4→1, `resolveExistingRetentionFilm` up to 5→2, route once per slice. Writes stay one fenced batch per changed Film; grouped writes were not done, because each Film needs its own revision fence and receipt, and the unchanged path no longer writes.
3. **Producer overhead (applied):** the repeated marker/route reads above. Reconciliation (`reconcileOwnOrigin`), receipts and fail-closed behaviour are unchanged. `UNIT_CAP` is **not** raised: no failure-test or production measurement justifies it.

## Not proven

- The product target of ≤15 minutes from due to `publishedAt`. The slice count is still 34 for 400 Films. At roughly 43 round trips per slice the scan should be a small fraction of the 44 minutes, but that depends on the real D1 latency, which was not measured. It must be shown on a natural run.
- Independent platform failures (`WorkflowInternalError`, idle gaps) are separate and not addressed here.

## Regression coverage added

`tests/canonical-rated-admission-producer.mjs`: unchanged daily scan keeps `observed_at`, request id, revision and creates no receipt; exit and re-add update; a Film that stays gone keeps its exit time; a concurrent revision bump between plan and write is retried through the carried intent with no second row; a transient write failure aborts the slice fail-closed and the same event completes it with one receipt per changed Film; replay of a finished event writes nothing; a stale `observedAt` never moves a Film back; mass add and mass exit of 12 Films. Existing tests keep the held/unavailable route, identity collision, redirect and single-writer cases. The unit-cost pins of `tests/canonical-receipts.mjs` (8→5 reads) and `tests/film-person-e6-measure.mjs` (36/38→27/29, 14→11) moved with the batched marker read, with their mutation anchors.
