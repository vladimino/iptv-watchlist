# D1 enrichment projector: first production measurement of the grouped write path (step (d) of ADR 0106, four natural runs)

**Captured:** 2026-11-10, four natural hourly runs started at 00:00:42, 01:00:42, 02:00:42 and 03:00:42 UTC (01:00, 02:00, 03:00 and 04:00 Madrid), with `D1_ENRICHMENT_BULK=on`. Read-only afterwards: Worker logs (`event=d1_enrichment_projection`), the `feature_flags` readback and read-only D1 `SELECT`s of the Film/Person marker, the projector window and the credit tables. No manual projector, Discovery or EPG run, no Task, cron, lease, window or budget change, no migration, no write other than the natural runs.
**Scope:** [AIR-401](https://trello.com/c/DdeTyM4m): the first bounded production measurement of the grouped write path of [ADR 0106](../../adr/0106-bulk-projector-write-path.md) (variant C), delivered inert by [AIR-399](air-399-grouped-projector-offline-2026-11-09.md). It does not change the 60 s wall budget, the 800-query budget, the 300 s cap, the lanes or the window, and it is not the L1 budget activation (step (e)) nor the natural acceptance (step (f)).
**Verdict:** **MEASURED: ONE PRODUCTIVE RUN OF FOUR; THE GROUPED PATH WORKED AND WAS FASTER PER WRITE SECOND; NO STOP ON THE GROUPS; THREE `identity_collision` ERRORS NOT CLASSIFIED.** In the one run that had time to write, 75 groups were applied with no fallback, no guard refusal and no prefetch miss, writing 348 Films and 1,419 Persons in 24.8 s of writing, about 14 Films a write second against 2.4 to 2.7 for the legacy path in comparable natural runs. In the other three runs the grouped path wrote nothing: the diff (42 to 49 s) left less than the 20 s that the path requires, while the per-entity path of the same regime wrote 5 to 18 Films in that time. Over the four runs the rate was 87 Films an hour, against 39.5 an hour in the 11 preceding legacy runs: far from the 500 an hour of ADR 0106, which this measurement does not claim and cannot show with one productive run.
**Used by:** [ADR 0106](../../adr/0106-bulk-projector-write-path.md) steps (e) and (f); [AIR-399 offline evidence](air-399-grouped-projector-offline-2026-11-09.md) (the model this calibrates against).

## How the experiment ran, including what differed from the plan

The owner gave an explicit GO on 2026-11-10 for one natural tick and set `D1_ENRICHMENT_BULK` to `on` by hand at about 00:13 Madrid (readback at 00:13: effective `on`; every other flag unchanged). The owner was to return it to `off` right after the 01:00 Madrid run. **That did not happen: the flag stayed on for four runs (01:00 to 04:00 Madrid), and the executor's check of the first run was delayed by a restart of the executor session.** The owner switched it off after 04:30 Madrid; the readback at 04:34 Madrid shows `D1_ENRICHMENT_BULK` absent, effective `off`, the other five set flags unchanged. The 05:00 Madrid run is therefore the first with the flag off again. The four runs are what the flag produced, not the single tick of the approved plan; the extra exposure is a deviation, recorded here, and no run in it stopped or touched anything beyond the normal projector writes.

## What was measured

All times in milliseconds unless stated. `heldMs` is the window from grant to release. `remaining` is the planned work still to do after the run.

| Run (Madrid, UTC) | Outcome | Window wait | `diffMs` | `writeMs` | Groups (Films / Persons) | Applied / fallbacks | Films / Persons written | `remaining` | Queries | `heldMs` | `errorCount` |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 01:00 (00:00:42) | `budget` | 27,258 | 48,011 | 0 | 0 | 0 / 0 | 0 / 0 | 19,650 | 24 | 48,929 | 0 |
| 02:00 (01:00:42) | `budget` | 16,921 | 49,075 | 0 | 0 | 0 / 0 | 0 / 0 | 20,314 | 24 | 49,977 | 0 |
| 03:00 (02:00:42) | `partial` | 1,162 | 18,659 | 24,825 | 75 (38 / 37) | 75 / 0 | 348 / 1,419 | 18,955 | 277 | 43,908 | 3 |
| 04:00 (03:00:42) | `budget` | 2,123 | 42,296 | 0 | 0 | 0 / 0 | 0 / 0 | 19,695 | 24 | 43,122 | 0 |

In all four runs `leaseLost` and `windowLost` were false, the checkpoint path was `full` (the backlog skip of [AIR-395](air-395-natural-ticks-2026-11-09.md)), and the summary carried the `bulk` object. After the runs: the Film/Person marker reads `r2`, `open`, generation 0; `projector_window` is `idle`; no credit refers to a missing Film or a missing Person.

### The productive run in detail (03:00 Madrid, 02:00:42 UTC)

| Field | Value |
| --- | --- |
| Groups | 75 (38 Film groups, 37 Person groups), group size 10 |
| `applied` / `fallbacks` / `guardRefusals` / `constraintFallbacks` / `prefetchMisses` | 75 / 0 / 0 / 0 / 0 |
| `prefetchReads` and `guards` | 2,608 each (every traced read has its in-batch assertion) |
| `statements` in write batches / `prefetchStatements` | 24,867 / 5,291 |
| `prefetchMs` / `applyMs` | 5,362 / 13,381 |
| `preWriteMs` / `writeMs` | 19,951 / 24,825 |
| `bulk.films` / `bulk.people` | 343 / 1,403 |
| `writtenFilms` / `writtenPeople` | 348 / 1,419 |
| `perWindowSecond` (films, people) | 7.81, 31.95 |
| `stop` | `budget` |

Five Films were written outside the groups (348 against 343) and three Films were reported with `identity_collision` (see below).

## Comparison with the legacy path

The legacy runs are the natural runs of the same day before the flag was turned on (13:00 to 23:00 UTC on 2026-11-09, flag off, per-entity path; `bulk` absent). A run's useful write time is `writeMs`.

| Run (UTC) | `diffMs` | `writeMs` | Films / Persons | Films per write second | Persons per write second |
| --- | --- | --- | --- | --- | --- |
| 14:00 | 22,569 | 37,300 | 101 / 319 | 2.7 | 8.6 |
| 19:00 | 24,361 | 35,775 | 87 / 309 | 2.4 | 8.6 |
| 20:00 | 26,323 | 33,590 | 79 / 335 | 2.4 | 10.0 |
| 16:00 (ended on the 800-query budget) | 14,622 | 10,478 | 107 / 355 | 10.2 | 33.9 |
| 18:00 | 35,573 | 24,264 | 17 / 57 | 0.7 | 2.3 |
| 23:00 | 38,665 | 23,206 | 18 / 83 | 0.8 | 3.6 |
| 17:00 | 42,187 | 19,412 | 10 / 51 | 0.5 | 2.6 |
| 15:00 | 47,679 | 11,893 | 6 / 34 | 0.5 | 2.9 |
| 22:00 | 48,024 | 11,536 | 5 / 30 | 0.4 | 2.6 |
| **Grouped, 02:00:42 UTC** | **18,659** | **24,825** | **348 / 1,419** | **14.0** | **57.2** |

- The 11 legacy runs wrote 435 Films and 1,598 Persons in 11 hours (39.5 Films and 145 Persons an hour). The four grouped runs wrote 348 Films and 1,419 Persons in four hours (87 Films and 355 Persons an hour), and 100 % of that came from one run.
- In the one productive run the grouped path wrote 3.3 to 4.4 times the Films of the best legacy runs (79 to 107) in a shorter write time than the long legacy runs (24.8 s against 33.6 to 37.3 s). Per write second it is 5.2 to 5.8 times the legacy runs that spent their whole 60 s budget on writing (2.4 to 2.7 Films a second). The 16:00 legacy run is not comparable: it ended on the query budget after 10.5 s of writing.
- The [AIR-399 model](air-399-grouped-projector-offline-2026-11-09.md) predicted about 0.11 to 0.21 s a Film for the grouped path in new-Film conditions; the observed 24.8 s over 348 Films (with 1,419 Persons) is 0.071 s a Film, faster than the model. The "throughput below half of the model" stop did not apply.

## Why three runs wrote nothing

The grouped path starts a group only if the time left to the run's budget end (60 s from the grant, or the window expiry if earlier) minus the reserve (15 s, `D1_ENRICHMENT_BULK_RESERVE_MS`) is at least the estimated time of a group (5 s for the first, `D1_ENRICHMENT_BULK_FIRST_GROUP_MS`): at least **20 s of the 60 s** must be left. In the three runs with no group the diff took 42.3 to 49.1 s and the first write gate a further 0.7 to 0.8 s, which leaves 10 to 17 s. The per-entity path starts steps until the budget is gone, and in the same regime wrote 5 to 18 Films (legacy runs 15:00, 17:00, 22:00 and 23:00 UTC). This explanation is read from the code (`bulkFits` in `src/d1-enrichment.js`) and from the timings; it is a property of the path, not a fault, but with the current pre-write overhead the reserve makes the grouped path write nothing in the slow runs where the legacy path writes a little.

## The three `identity_collision` errors

The productive run reported `errorCount` 3, all `identity_collision` for three Films (ids withheld here, as the card asks). They are not group fallbacks (`fallbacks` and `constraintFallbacks` are 0), so those Films were not a group's rolled-back constraint; five Films were written outside the groups. `identity_collision` is raised by the canonical Film build when a trusted external id belongs to another Film (`src/canonical-repository.js`), the same code for both paths. The three Films are not in the D1 `film` table at readback, so no stored row explains it. **The cause is not established, and whether it is "unexpected" in the sense of the card is for the owner and the Controller.** No other error was reported in the four runs.

## What this does not show

- **One productive run.** Three of four runs wrote nothing for the reason above; one run is not a distribution, no percentile is given, and the 348 Films depend on that run's fast pre-write (`diffMs` 18.7 s, the fast mode of [AIR-392](air-392-projector-pre-write-overhead-2026-11-09.md)).
- **No D1 execution time.** `prefetchMs` and `applyMs` are Worker wall times of the read and write batches; the D1 `meta` per batch was not recorded for them. The largest batch statement count was not recorded either (1,500 is the code's cap per batch); no D1 error naming a batch size occurred.
- **No Discovery/EPG effect measured.** The windows were held 43 to 50 s, inside the 300 s cap; the generation moved between runs and `windowLost` stayed false. The effect on Discovery and EPG was not read.
- **The 500 Films an hour of ADR 0106 is not shown.** The grouped path could write 348 Films in one 25 s write, but the runs that matter at a 60 s budget are the slow ones, where nothing fits.
- **The extra three runs were not planned.** Their rows are real writes of the same rows as the per-entity path would write (idempotent, ADR 0106); a code rollback would not undo them.

## STOP conditions of the card, against the runs

| Condition | Result |
| --- | --- |
| Marker, lease or window lost | None: marker `r2`/`open`/0 after the runs, `leaseLost` and `windowLost` false |
| Constraint, FK or duplicate credit | No FK or dangling credit (two checks: credit without Person, credit without Film, 0 each); three `identity_collision` Films not classified |
| Failure or unknown outcome | None (`outcome` `budget` or `partial`, no `deferred`, `errorCount` 3 only in one run) |
| Fallback above 5 % after 10 groups | 0 of 75 |
| D1 batch-size error | None |
| Deadline overrun (300 s cap) | None (`heldMs` 43 to 50 s) |
| Throughput below 50 % of the model | No (faster than the model in the productive run; no model basis in the three empty runs) |
| Critical impact on Discovery/EPG | Not measured here |

## Decision brief for step (e)

The grouped path does what ADR 0106 says in the one run that had time: no refused group, no fallback, every group applied, and more per write second than the legacy path. What stops it at the current 60 s budget is the time before the first write (19.9 s in the productive run, 43 to 49 s in the three empty ones plus the window wait) together with its 20 s requirement. A decision on the L1 wall budget (the single 300 s window, step (e)) is a separate card with its own owner GO; this measurement is its data, with the limits above, and the identity_collision question, the 15 s reserve against the slow runs and the pre-write overhead ([AIR-396](air-396-d1-first-query-latency-2026-11-09.md), [AIR-400](air-400-view-cpu-profile-offline-2026-11-09.md)) are what it should read first.
