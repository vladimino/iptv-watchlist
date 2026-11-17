# AIR-523: Finds empty after an EPG generation change, RCA and batched slot replay

17 November 2026 (UTC). Code and tests on the AIR-523 branch against `main` at `1acc71b`. No production chunk, EPG, TMDB, lease reset, flag, migration or Workflow create. The only production access was read-only aggregate `SELECT` on D1 `iptv`.

## Production observations (read-only)

| Source | Result |
| --- | --- |
| Card AIR-523, aggregates by EPG run | Catalog Films with `basis='discovery'` shows: 14 Nov 5 724, 15 Nov 5 895, 16 Nov 6 381, **17 Nov run `ae4c4209-3894-41aa-8798-bb82a2d11a2b`: 2 Films, 8 shows** |
| D1, published run `ae4c4209-…`, 17 Nov | 8 531 current verified observations, **3 observations with assigned rows, 8 assigned rows** |
| Card, Discovery status at the time | `paused/backoff`, 7 805 unresolved, last chunk `partial` / `wall_budget`, `checked=0`, `tmdbCalls=0`, `touched=1`, `preCommitMs=26 944` |

`readCompletedProgramme` builds `catalogFilms` only from the current run's `published_epg_show` rows with `basis='discovery'`, so `GET /api/catalog/available` returned an empty list with HTTP 200 and Finds hid the empty section. The data itself (Films, predictions, admissions, decisions) was intact.

## Mechanism

A new EPG run starts without assigned rows. The only restore path was the replay inside the paged chunk's cheap pass: it walked the **38-key `touches` page** of verified observations and called `assignObservationSlots` for each, about ten sequential D1 round trips per observation even when every slot was already present, after the ledger count and the unresolved page. On 16 Nov the same path measured `cheapMs≈14.7 s` for 19 replayed observations at `writeMaxMs=2802`. At that rate a run with 8 531 verified observations needs hundreds of chunks, and a `wall_budget` back-off (five minutes, ADR 0148 fairness) blocks every chunk. Why 14 to 16 Nov reached 5 724 to 6 381 Films while 17 Nov did not was not measured here; the 17 Nov run held 8 531 verified observations against 3 restored.

## Change

`replayUnassignedSlots` (`src/discovery-authority.js`) runs first in every paged chunk (`src/discovery.js`), with its own 10-second slice of the 40-second budget:

- selects only verified observations of the published run that still have a slot no row holds, by key cursor (`replayAfter`, wraps, stored with the status);
- reads decisions, free slots, members and admissions for 40 observations in four set queries and decides eligibility with the same pure rule (`slotEligibility`);
- writes through the **unchanged guarded per-slot statement** in fenced batches of 38; every ADR 0142 decision 4 guard (authority `d1`/`open` at the run, decision `verified` with that hash and TMDB id, active observation, Film record, slot free) is still evaluated inside each statement; coordinates come from the current run's observation rows;
- the per-observation replay in the cheap pass now serves only a decision the chunk has just made verified;
- the chunk is `partial` until one lap of the cursor is complete, so an unfinished replay is continued; an observation that can never be assigned is visited once per lap and does not keep the series open.

No new Task, queue, Worker, migration, flag or authority change.

## Offline verification

- `tests/discovery-bulk-replay.mjs` (new): yesterday's run with assigned rows and today's run with the same verified identities at new slots; 120 observations restored in 34 round trips, no old timestamp copied, old rows untouched, one Film per slot, published generation unchanged, no member row added, idempotent second lap; guards (slot held by another Film, duration drift, Film without record, undecided decision, member/TMDB link mismatch); stop and resume by cursor; stale run no-op; missing lease rejected.
- `tests/discovery-chunk-budget.mjs` case 23 (new): 90 verified observations with no assigned rows plus 30 unresolved candidates and a D1 modelled at 2.8 s per write batch: the first hop assigns 40 rows, still starts TMDB, stays inside 40 s with no `wall_budget`, stores the cursor and the status stays `partial`; the following hops finish the lap and assign all 90.
- `tests/discovery-slot-assignment.mjs` example 18 now asserts the batched replay restored the slots. `tests/catalog-completed-d1.mjs` and `tests/programme-catalog-d1-route.mjs` cover the reader side: a current run's assigned rows with a current prediction appear in `GET /api/catalog/available`.

## Independent review corrections (exact HEAD `1ece484`)

The review at that head (technical block) found three defects, all fixed and each pinned by a test that was shown to fail without the fix:

- **Quadratic absence probe.** On the populated 16 Nov run the planner chose the primary key by `programme_run_id` only for the correlated slot probe (reviewer's read-only proxy: 18 681 rows read against 5 with the existing `published_epg_show_by_generation` index). The two new queries and the guard in the shared insert now name that index; no migration, ownership rule unchanged. `tests/discovery-bulk-replay.mjs` case 6 asserts the `EXPLAIN QUERY PLAN` of all three statements and replays against a run holding 6 000 assigned shows.
- **Deadline bypass.** The first write group was exempt from the stop check, so slow reads could use the 10 s slice and a batch still started. The check now precedes the page's counts and every group, the first included; case 7 expires the slice after the free-slot read and at the count and asserts no batch starts and the cursor stays.
- **Cursor across generations.** `replayAfter` is used only when the stored status names the same programme run (case 23 in `tests/discovery-chunk-budget.mjs`).

## Natural-run observation after delivery (17 Nov 2026, Europe/Madrid, UTC in parentheses; read-only)

The fix merged at 20:55 (19:55 UTC) and the Worker deployed at 20:57 (19:57 UTC), Workflow version `b717b626`. The Discovery instance `discovery_ae4c4209…_0` had been created before the deploy and kept running on the previous version `26dc54da` (its chunks stored no `replayMs`). At its 20th chunk it rolled over by itself: `…_1`, created 21:18:29 (20:18:29 UTC), version `b717b626`, `…_0` complete. No restart, retry, lease reset or Workflow mutation was performed.

| Observation | Value |
| --- | --- |
| Assigned `basis='discovery'` rows, published run `ae4c4209…` | 28 at review, 482 at 21:15 (20:15 UTC), 953 at 21:27 (20:27 UTC); 8 532 verified observations |
| Last chunk of `…_1`, finished 21:25:55 (20:25:55 UTC) | `assignment.assigned=189`, `bulkObservations=80`, `bulkPages=2`, `bulkGuardSkipped=0`, `bulkComplete=false`, `timings.replayMs=5752`, `error=wall_budget`, retry +5 min |

The replay works in production and the guards skip nothing. The rate was about 39 rows a minute: a chunk restored about 190 rows and was then backed off for five minutes because no TMDB request fit after it, which would take 6 to 7 hours for about 16 600 rows. The series back-off is now skipped while the replay makes progress and has more to restore (case 24 in `tests/discovery-chunk-budget.mjs`: no `wall_budget` and no retry time with a modelled 9 s write batch; the back-off is unchanged without replay progress, shown by the same case and by mutating the condition away).

## Limits and verdict

Sqlite stand-ins, a fake clock and a modelled write cost; no live D1 latency. The 10-second slice is sized from the 16 Nov measurement of 2.8 s as the worst observed batch; at lower latency a hop restores far more rows. **Offline GO.** Acceptance remains: after merge and deploy, a natural Discovery chunk raises the assigned-row count of the published run toward the verified count (aggregate read-only `SELECT`), and the owner accepts Finds. Deployment alone does not restore the catalog; no manual retry or lease reset is authorized.
