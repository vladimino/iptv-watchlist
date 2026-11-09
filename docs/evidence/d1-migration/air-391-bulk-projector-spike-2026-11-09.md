# D1 enrichment projector: throughput spike (baseline, offline benchmark, three variants)

**Captured:** 2026-11-09 (Madrid afternoon, UTC 09:00–11:00), read-only: Worker logs (`event=d1_enrichment_projection`, 30 h), D1 `SELECT` aggregates, Cloudflare documentation. The benchmark is offline (in-memory SQLite, virtual clock). No projector run, window, flag, cron, Task, Workflow, migration or production write.
**Scope:** [AIR-391](https://trello.com/c/9hvEhvfJ). Where the time of one hourly projector run goes, and which change reaches at least 500 changed Films an hour. It decides nothing by itself; the proposal is [ADR 0106](../../adr/0106-bulk-projector-write-path.md) (Proposed).
**Verdict:** **The write phase is round-trip bound today and statement bound after grouping; R2 and the diff are a separate per-window cost of 6 to 33 s.** In the measured structure a Film costs about 11 D1 round trips and 71 statements; a bulk write that prefetches the repository's reads in one round trip and applies a group of Films in one fenced batch costs 0.1 to 0.2 round trips per Film with the same rows. At the calibrated latency that is about 3.5 to 4 times the current Film rate. 500 Films an hour needs a larger wall budget as well (150 to 300 s, inside the 300 s hold of ADR 0103), because the load that runs after the window grant takes 6 to 33 s.
**Used by:** [ADR 0106](../../adr/0106-bulk-projector-write-path.md), [ADR 0056](../../adr/0056-d1-enrichment-write-through.md) decision 7, [ADR 0103](../../adr/0103-projector-exclusive-window.md) decision 6.

## 1. Baseline from recorded events (no new load)

Hourly cron runs of 2026-11-09 (UTC), fields of the run summary. `held` is the exclusive window hold, `wait` the time to get it.

| Run | Outcome | Load ms | View ms | Window wait | Held | Queries | Films / Persons written | Changed Films / Persons |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 04:01 | budget | 5,192 | 422 | 11.9 s | 49.2 s | 822 | 0 / 775 | 4,417 / 13,537 |
| 05:02 | budget | 32,171 | 2,063 | 40.5 s | 63.2 s | 120 | 0 / 100 | 4,512 / 13,233 |
| 06:01 | budget | 5,728 | 485 | 0.8 s | 43.5 s | 822 | 0 / 775 | 4,589 / 13,553 |
| 07:01 | budget | 5,830 | 453 | 12.0 s | 48.6 s | 822 | 0 / 775 | 4,645 / 13,064 |
| 08:02 (fixed code) | budget | 28,830 | 2,200 | 31.4 s | 64.8 s | 113 | 9 / 55 | 4,737 / 12,692 |
| 09:02 (fixed code) | budget | 32,926 | 2,237 | 15.0 s | 60.4 s | 74 | 8 / 25 | 4,730 / 12,641 |

What the table says:

- Two kinds of run. A fast run loads in about 5.5 s and writes for 37 to 43 s; a slow run loads in 17 to 33 s and has 10 to 25 s left of the 60 s budget. The load is **inside** the hold because the budget clock restarts at the grant.
- Persons alone: 775 Persons with 822 queries in 37.6 s and 42.5 s of write phase (06:01, 07:01), about 50 ms per query.
- Films: in the fixed runs the Film lane used 4.0 to 4.8 queries per Film and the checkpoints are about 0.7 s apart per Film, Persons of that Film included.
- Backlog and inflow, from the changed counts and what was written: Films about +55 an hour, Persons about +300 an hour (bursty, 0 to 470). The Film backlog is 4,730, of which 694 are admitted-first.
- Window wait is 0.8 to 40.5 s. It is a cost of every window, whatever is written in it.
- D1 holds 3,053 Films, 29,691 Persons and 37,321 credits (12.2 per Film, most Films 14 or fewer); the view has 7,673 Films and 40,825 Persons. The database is 1.3 GB of the 10 GB limit.

## 2. Platform limits that bear on the design (Cloudflare documentation, 2026-11-09)

| Limit | Value | Bearing |
| --- | --- | --- |
| Cron Trigger wall time | 15 min | The 60 s budget and 800 queries are **self-imposed** (ADR 0056); the window hold of 300 s (ADR 0103) is the real cap |
| CPU per invocation | 30 s default, up to 5 min (`limits.cpu_ms`) | Statement building is about 1.6 ms of CPU per Film in the benchmark, so 1,000 Films an hour is about 2 s |
| Subrequests per invocation | 10,000 on Workers Paid | A `db.batch()` counts as **one** query against the invocation limit, whatever its statements |
| D1 batch | each statement ≤ 100 KB and ≤ 100 bound parameters; no statement-count limit stated; a 2,000-statement batch is documented as fine | A group batch of 10 Films is about 770 statements |
| D1 concurrency | one database processes queries one at a time; up to 6 connections per invocation | Concurrent reads do not make writes parallel |
| Workflows | steps 10,000 default (25,000 max), CPU per invocation 30 s default, unlimited step wall time | A Workflow step can hold a longer run, but it still needs the same window |
| Database size | 10 GB | 1.3 GB used |

## 3. Method of the offline benchmark

`scripts/projector-spike-bench.mjs` (offline only, `node --experimental-sqlite --no-warnings scripts/projector-spike-bench.mjs --films 200`). It loads the **real** `src/d1-enrichment.js` and `src/canonical-repository.js` as the bundle carries them (`tests/d1-enrichment-context.mjs`), applies the real migrations 0001 to 0004 to an in-memory SQLite and runs the unmodified projector on a synthetic store shaped like production: 1 director and 11 actors per Film (12 credits), 3 new Persons per Film (production: 25 Persons for 8 Films) and the rest from a pool the database already holds. The D1 stand-in counts every read, single write, batch and statement. Time is a virtual clock: one round trip costs `rtt`, one statement inside a batch costs `stmt` on top of its batch's round trip. The captured repository inputs are replayed by variant C and the final rows are compared with the baseline's.

Calibration (two production anchors, both from section 1): 775 Persons in 37.6 to 42.5 s and about 0.7 s per Film. A grid of `rtt` 15 to 75 ms and `stmt` 0.25 to 4 ms reproduces both for `rtt` 35 to 50 ms and `stmt` 1 to 2 ms, so those are the calibrated ranges; the capacity table uses `rtt` 50 and `stmt` 1, 1.5, 2 and `rtt` 35 with `stmt` 2.

| Counter (per Film, real code) | A0 current | C bulk, group of 10 |
| --- | --- | --- |
| D1 round trips | 10.8 | 0.2 |
| of which reads | 9.0 | 0 (all reads in the group's one prefetch batch) |
| Statements in batches | 71.4 (27 for the Film, 9 for each of its 3 Persons, fence and keys) | 77.2 |
| Same rows as A0 afterwards | n/a | **yes**, every canonical table and the keys, for groups of 1, 10, 25 and 50 (timestamps of the run masked) |
| Repository read misses after the prefetch | n/a | 0 |
| JS plus in-memory SQLite time for 200 Films | 0.31 s | 0.31 s |

Statements per entity, measured on the repository: 27 per Film (plus one per credit and external id), 9 per Person.

## 4. The three variants

- **A, minimal change of the existing projector.** Keep one fenced batch per Film and 25 Persons per batch, issue the reads of a Film or group concurrently (the 6 D1 connections), and put a Film's own Persons in the Film's batch. Round trips fall from 10.8 to about 4 per Film (modelled from the measured counters, not run). The statement count does not change.
- **B, resumable Cloudflare Workflow with a durable plan.** Not built. Analysis: the Discovery generation moves about 17 times a minute, so a plan made in one window is not valid in the next without per-entity revalidation, which the owner rejected in [PR #429](https://github.com/vladimino/iptv-watchlist/pull/429) as disproportionate. Without it every window must load and diff again, so a Workflow's steps repeat the 6 to 33 s load and the 1 to 40 s wait for each window. A Workflow removes no wait, no load and no statement.
- **C, bulk write into the existing repository.** Built as the prototype above: pass 1 traces the repository's reads, one batch of SELECTs fetches them, pass 2 runs the same `projectFilm`/`projectPerson` against that read cache and collects the writes, one fenced batch applies a group atomically. The repository and its statements are not changed.
- **B plus C** adds nothing to C for throughput; B would only make sense for more than one window an hour with an incremental load, and that is a separate owner decision on Discovery downtime.

## 5. Capacity of one hourly run (Films an hour)

Write seconds = wall budget minus the load that follows the grant, times the Film lane's share (0.6 when Persons are also pending, 1 when only Films are). 5.5 s load = fast run, 30 s = slow run. The model is analytic over the measured counters; see the limitations.

| `rtt` / `stmt` ms | Wall, load | A0 | A1 | C (group 10) |
| --- | --- | --- | --- | --- |
| 50 / 1.5 | 60 s, fast (6 s) | 50 to 84 | 143 to 239 | 258 to 429 |
| 50 / 1.5 | 60 s, slow (30 s) | 28 to 46 | 80 to 133 | 143 to 238 |
| 50 / 1.5 | 150 s, slow | 112 to 186 | 318 to 531 | **572 to 954** |
| 50 / 1.5 | 300 s, slow | 251 to 418 | 716 to 1,194 | **1,288 to 2,146** |
| 50 / 2 | 150 s, slow | 106 to 176 | 275 to 458 | 438 to 730 |
| 50 / 2 | 300 s, slow | 238 to 396 | 619 to 1,031 | **985 to 1,642** |
| 35 / 2 | 150 s, slow | 139 to 231 | 318 to 531 | 446 to 743 |
| 50 / 1 | 150 s, slow | 118 to 197 | 378 to 630 | 826 to 1,376 |

Reading it: A0 is below the observed 8 to 9 Films in slow runs only because the real runs also write Persons and housekeeping (the model's low share 0.6 over-credits Films by about 3 times at slow loads), so read the table as ratios. C is about 3.5 to 4 times A0 and about 1.4 to 1.7 times A1. At 150 s wall in a slow run C reaches 438 to 1,376 across the calibrated cases: 500 an hour holds at the upper Film share (no Person backlog competing) or for `stmt` of 1.5 ms or less, not at the lower share with `stmt` 2. At 300 s wall C reaches 985 to 2,146, so 500 an hour holds in every calibrated case and 1,000 an hour in all but the lowest. 500 an hour is not reachable at 60 s wall in a slow run in any variant (C: 109 to 344).

Drain of the backlog at inflow 55 Films an hour: 4,730 Films at 450 an hour is about 12 hours, at 900 an hour about 5.6 hours. After that a run finishes `complete` in the fast path and the hourly cadence is enough; a permanent "non-stop" run is not needed in steady state.

Persons: the same grouping writes a Person for 9 statements and one prefetched read, about 15 ms at `stmt` 1.5, so a 60 s run could write about 1,500 Persons an hour next to Films against 775 today; the 13,000 changed-Person backlog still needs roughly 9 to 17 runs.

## 6. Where the time goes (what dominates)

1. In the current structure, serial D1 round trips: 9 reads and 2 batches for each Film (`planFilm` reads the redirect, the localization row, one external-id owner per trusted id and the kept credits one after another; `planPerson` reads one row per Person). Of the 0.52 to 0.68 s per Film at the calibrated latency, round trips are 0.38 to 0.54 s.
2. After grouping, the statement count dominates: 77 statements per Film at 1 to 2 ms each is 77 to 154 ms, which sets the ceiling of C. Most of them delete and reinsert rows that did not change (external ids, dimensions, credits). Statement-level change detection inside the repository would cut this, but it changes the repository and is not measured here.
3. The R2 snapshot and the diff are a per-window fixed cost of 5.5 to 33 s plus 0.4 to 2.2 s of view building. The synthetic benchmark cannot size R2 reads; the 5 s fast and 17 to 33 s slow modes are production facts, the cause of the slow mode is not established. It is the largest single remaining cost once C is in.
4. The window wait (0.8 to 40 s) is a cost of every window and is independent of what is written.

## Limitations

- `rtt` and `stmt` are calibrated from two production anchors, not measured. The prototype's batch of about 770 statements has never run on D1; D1's real cost of a large batch (rows written, durable replication) may differ from a linear model. The first measurement on D1 is stage (b) of the proposal, behind owner approval.
- The model credits Films with a share of the budget; it does not run the lane scheduler. Absolute A0 numbers are therefore upper bounds for Films.
- The benchmark does not include Person-only groups with FK waits, the metadata cache read, owner-review overlays or the Film sync clocks.
- C reads are prefetched before the group's writes: a trusted external id shared by two Films of one group, or a Person written twice, is not seen by the second read. The database unique index `film_external_id_one_trusted` makes that a failed batch, never a silent duplicate (the group is then retried one Film at a time).
- 5,000 Films and 13,000 Persons were not written in the benchmark; 200 Films with 600 new Persons were, and counts are per entity. Linearity to 5,000 is assumed, and is the reason for the staged measurement.
