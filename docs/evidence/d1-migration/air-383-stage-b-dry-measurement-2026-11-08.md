# Projector exclusive window: dry measurement (Stage B), 2026-11-08

**Purpose:** replace proposals of [ADR 0103](../../adr/0103-projector-exclusive-window.md) with measured values where a read-only or offline measurement can, and name what cannot yet be measured. **Nothing was written, applied, enabled or run.** Every production read below was a D1 `SELECT` (each response `changed_db=false`, `rows_written=0`) against the production database at about 15:48 UTC on 2026-11-08, aggregated, with no payload and no key. The schema is v17, `projector_window` does not exist (migration `0018` is not applied), `discovery_authority` is `d1` / `open`. Times are UTC; Europe/Madrid is UTC+1 on this date.

**Not measured and why.** Lease hold time, the time from a window request to its grant, and a projector run that waits for a window cannot be measured without the window, which needs the migration and the flag (two separate owner decisions). The Workers Observability reader rejects the cron and Workflow events of this Worker (its response validation fails on a missing `requestId`), so no per-chunk duration was read from logs. Each value marked *proxy* below stands in for a quantity that is not measured.

## 1. Discovery activity is episodic, not constant

`discovery_decision_history` rows per hour (decisions) and the generation range they span (`gen_span`):

| Hours (UTC) | Decisions per hour | Generation span per hour |
| --- | --- | --- |
| 2026-11-07 20:00 to 23:59 | 448, 503, 585, 537 | 900, 969, 1111, 1040 |
| 2026-11-08 01 | 220 | 496 |
| 2026-11-08 04 and 05 | 384, 388 | 714, 721 |
| 2026-11-08 06 to 09 | 557, 600, 572, 555 | about 1000 per hour |
| 2026-11-08 12 and 13 | 348, 426 | 800, 934 |
| 2026-11-08 14 | 61 (last write in the 12th minute) | 186 |
| Hours with 0 or 1 decision | 2026-11-07 13, 15 to 17; 2026-11-08 00, 02, 03, 11; 14:12 onward | none or near none |

So the 17 bumps a minute seen at 07:31 to 10:01 is the busy state, and Discovery has quiet stretches. Since 14:12 UTC the generation moved from 34,609 (the pin of the 15:00 run) to 34,664 (15:48), about 1.1 a minute without decisions.

## 2. One natural projector run (15:00 UTC) progressed without a window

`projection_run` (one row, the latest run), 2026-11-08 15:00:42 to 15:01:43 UTC, trigger `cron`: outcome `budget`, `writtenPeople` 650, `writtenFilms` 0, `queries` 692, `durationMs` 60,164, `loadMs` 7,764, `viewMs` 595, `remaining` 16,545, `leaseLost` false, pinned `discoveryGeneration` 34,609, `changedPeople` 13,775, `changedFilms` 3,420. It is a single sample, taken in a quiet stretch. Sustained progress under a busy Discovery is exactly what it does not show.

Arithmetic (one sample, not a rate): 16,545 remaining at 650 Persons a run is 25.5 runs, about 26 hourly ticks. At the 775 Persons a run seen earlier it is 21.4. The earlier estimate of 16 to 20 ticks holds only above about 830 a run, so it is not supported by this sample. Films are not drained yet (3,420 changed, none written in this run).

## 3. Shape of a busy hour (07:00 to 10:00 UTC)

From the timestamps of 1,727 decision rows: 204 write bursts, one every 52.9 s (about 1.13 a minute); a burst lasts 8.3 s on average (maximum 12 s); the idle gap between bursts is 40 to 58 s (average 44.6 s), never above 58 s. The generation span of the period is 3,127, so 15.3 bumps per cycle: 8.5 decision writes and 6.25 other bumps (continuation, checkpoint, lease and workflow-state writes). **In each of the 203 idle gaps there were 6 to 8 such bumps, never zero.** The memoryless (Poisson) model in the audit therefore describes the average only: the bumps come in a 53 s cycle. Whether the 6 to 8 other bumps sit close to the burst or spread across the gap cannot be told from this data (they carry no timestamp), so the gap is not shown to be quiet for the 21 s diff, and a retry placed in the gap is neither proved nor disproved here.

## 4. What this means for the proposed numbers (decision input, not a decision)

| Proposal in ADR 0103 | Evidence now | Verdict |
| --- | --- | --- |
| Window of at most 300 s from one absolute deadline | Run of 62 s in total (load 7.8 s, view 0.6 s, write budget 60 s). A grant that comes within about 50 s of the request leaves 120 s or more | Plausible. The wait for the in-flight chunk is not measured. *proxy:* a write burst lasts at most 12 s and the chunk lease TTL is 90 s |
| Minimum run 120 s | A run needs about 70 s from grant (load, view and 60 s write budget) | Consistent with one sample |
| 60 s write budget per run and 692 queries | One sample: 650 Persons, 692 queries, 60.2 s | Matches the sample; the rate is not established |
| Backlog of 16 to 20 ticks | 26 ticks for 650 a run (above) | Not supported; treat as about 26 until more runs are seen |
| Discovery idle at most about 8 % an hour | A busy Workflow sleeps to the window's expiry (code), not to the release, so a window of 300 s idles it for 300 s even if the projector is done in 100 s: 5.7 chunk cycles of 53 s | 8.3 % is the worst case, and it is reached whenever the window is held to its expiry; an early wake is a possible, separate improvement |

## 5. The window and the daily EPG publication

The daily EPG publication is due at 17:00 Europe/Madrid, 16:00 UTC, the same instant as the hourly cron tick (`0 * * * *`) that starts the projector. A projector that requests a window at 16:00 UTC can hold admission up to 300 s while the external daily Task reaches its seal. That Task waits about 93 s, once, and only for `lease_held`, so a `projector_window` busy of up to 300 s is the activation blocker named in the Stage A review.

**Activation precondition ([ADR 0103](../../adr/0103-projector-exclusive-window.md) decision 5).** Either the external Task can wait for `projector_window` up to the deadline (a Scheduled Task edit, its own owner decision), or an alternative EPG executor is fully proven to wait for it (the EPG executor of [ADR 0100](../../adr/0100-epg-cloudflare-workflow-executor.md) already sleeps to `nextCatchUpAt` without charging its budget, and is not yet the daily publisher). Nothing below replaces that precondition.

**Clock-based ideas are optimizations, never the route.** A time-based skip of the window request around 16:00 UTC is allowed by the ADR only as an optimization and is rejected as the primary route: the external publication writes no D1 in-flight marker, a Task start can be delayed, and its seal can overlap any fixed interval. The owner proposes a different optimization, moving the shared cron from `:00` to `:10`. That is a separately authorized scheduling change (this pull request changes no cron). It also moves the Ratings and monitor ticks, the EPG `ensure` and the Discovery reconcile, not only the projector, and it shifts the clash instead of ruling it out: neither `:10` nor a time-based exclusion proves that a window and an EPG seal cannot overlap, because a delayed Task start, a long metadata phase or a retry can still reach the seal inside a window. Neither one removes the blocker, and neither is a substitute for the precondition above.

## 6. Still open before any activation

Lease hold time and wait to grant (needs the window, so a dry run with the flag in the `dry` stage is not possible on production without the migration). The projector under a busy Discovery (the point of the window). Whether one run per tick is enough: the backlog is about 26 ticks at the sampled rate, and raising the write budget inside the window would be a separate measured decision. The file-level R2 classification is not a transitive call graph (Stage A review).
