# AIR-532: watchlist retention, before and after (offline benchmark)

**Date:** 2026-11-18 (UTC). **Source:** `node scripts/bench-watchlist-retention.mjs <N>` on the sqlite D1 stand-in (`tests/d1-standin.mjs`), schema chain up to the current migration, marker `open` generation 2, receipt baseline seeded, N Films with a trusted `tmdb` and `letterboxd` id. **No production read or write.** A "round trip" is one `first()/all()/run()` or one `batch()` call, as in ADR 0106.

## Method and limits

- Each scan feeds `watchlistRetentionWork` and `applyRatedAdmissionRetention` slice by slice at `UNIT_CAP=12`, exactly like `persistScan`, and counts every D1 call.
- The numbers are round trips, not wall time. The stand-in's wall time is process spawn cost and says nothing about production latency; production per-slice latency, the real cursor size and the ~75–80 s per slice of 18 November were **not** re-measured here.
- Baseline = `main` at 26c57ee, measured with N=12 (one slice). The 400-Film "before" total is that figure times 34 slices, an extrapolation, not a run.

## Result

| Scenario (N=400) | Before (round trips) | After | Write batches before / after | Slices |
|---|---|---|---|---|
| Day 1, first observation (400 changes) | 389 per slice, ~13 200 | 7 213 (212 per slice) | 24 per slice / 801 (800 Films + the watermark) | 34 |
| Day 2, unchanged watchlist | 389 per slice, ~13 200 | **1 613 (47 per slice)** | 24 per slice (all 12 rewritten) / **1 for the whole scan (the watermark), 0 per Film** | 34 |
| Day 3, +1 / -1 | 436 per 13 Films | 1 644 | 26 per 13 Films / 5 (two Film changes and the watermark) | 34 |

Unchanged day: about **8× fewer D1 round trips and no Film write** (one watermark write per scan); every unit ends as `noop`. First observation: about 1.8× fewer round trips.

The "after" numbers were taken on the code merged with `origin/main` of 18 November (ADR 0162, Film/Person D1-only), whose `readAuthority` reads the table inventory and the version before the marker rows. The marker rows are one statement, so the gate costs 3 reads instead of 5.

Per slice of 12 Films, unchanged day, on N=12: 389 before; 173 with the delta alone; 47 with the delta and the read batching (53 for the first slice of a scan, which also moves the watermark) (`readAuthority` marker rows in one statement, one statement per Film plan, one external-id read, one redirect+film read, route once per slice).

## The three directions of the card

1. **Delta (applied):** a scan that repeats the stored boolean writes no Film row ([ADR 0173](../../adr/0173-watchlist-retention-observed-at-is-state-start.md), owner decision of 18 November). `observed_at` is the start of the current state. The independent review of PR #771 found that this alone lets a late contradictory observation overwrite a newer confirmation (true at 10 Nov, unchanged 18 Nov, delayed false of 15 Nov was applied; reproduced). The owner chose a single-row scan watermark, migration `0025`, one fenced write per scan; the guard is checked in the plan and again inside the write batch. Without the table (schema genuinely below 25) the producer rewrites `observed_at` every scan as before; at schema 25 a missing table fails closed. The second independent review found that the watermark alone is not rollback-safe: Worker code that never reads it (a revert after the apply) accepts the same late `false`. Migration `0025` therefore also carries two guard triggers on `film_retention`, so the ordering holds for any writer (tested with a direct `retainFilm` call that ignores the watermark). The no-op benefit does not exist on code deploy alone; it starts only after an owner-approved apply of `0025`. Existing rows inherit the old rule and hold the last pre-activation confirmation in `observed_at`, not a recorded state start; no backfill is made.
2. **Batching (applied to reads):** `readAuthority` marker rows 3→1 statement (gate 5→3 after ADR 0162), `planRetention` 4→1, `resolveExistingRetentionFilm` up to 5→2, route once per slice. Writes stay one fenced batch per changed Film; grouped writes were not done, because each Film needs its own revision fence and receipt, and the unchanged path no longer writes.
3. **Producer overhead (applied):** the repeated marker/route reads above. Reconciliation (`reconcileOwnOrigin`), receipts and fail-closed behaviour are unchanged. `UNIT_CAP` is **not** raised: no failure-test or production measurement justifies it.

## Not proven

- The product target of ≤15 minutes from due to `publishedAt`. The slice count is still 34 for 400 Films. At roughly 46 round trips per slice the scan should be a small fraction of the 44 minutes, but that depends on the real D1 latency, which was not measured. It must be shown on a natural run.
- Independent platform failures (`WorkflowInternalError`, idle gaps) are separate and not addressed here.

## Regression coverage added

`tests/canonical-rated-admission-producer.mjs` (including the review P1: true at t1, unchanged at t3, delayed false at t2 stays stale; an older pending receipt is not replayed after the newer scan; the watermark moves between plan and write and the batch refuses; exit and re-add under the watermark; the watermark only moves forward; a real schema 24 database keeps the previous behaviour; schema 25 without the table fails closed; the rollback contract: code that ignores the watermark is refused by the database for a late contradictory write and works normally at or after the watermark, and a direct contradicting UPDATE is refused; with both guard triggers disabled the test fails): unchanged daily scan keeps `observed_at`, request id, revision and creates no receipt; exit and re-add update; a Film that stays gone keeps its exit time; a concurrent revision bump between plan and write is retried through the carried intent with no second row; a transient write failure aborts the slice fail-closed and the same event completes it with one receipt per changed Film; replay of a finished event writes nothing; a stale `observedAt` never moves a Film back; mass add and mass exit of 12 Films. Existing tests keep the held/unavailable route, identity collision, redirect and single-writer cases. The unit-cost pins of `tests/canonical-receipts.mjs` (8→6 reads) and `tests/film-person-e6-measure.mjs` (36/38→30/32, 14→12) moved with the batched marker read, with their mutation anchors.
