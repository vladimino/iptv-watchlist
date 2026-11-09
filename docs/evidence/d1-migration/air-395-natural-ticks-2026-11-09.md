# D1 enrichment projector: the first two natural runs after the checkpoint-read changes (paged read and bucket reconciliation)

**Captured:** 2026-11-09, two natural hourly runs started at 19:00:42 UTC (20:00 Madrid) and 20:00:42 UTC (21:00 Madrid), read-only: Worker logs (`event=d1_enrichment_projection`). No manual projector, Discovery or EPG run, no flag, Task, cron, lease, window or budget change, no D1 or R2 write.
**Scope:** [AIR-395](https://trello.com/c/RbPf1nPj), the first natural production runs with the interim paged read ([PR #452](https://github.com/vladimino/iptv-watchlist/pull/452)) and the bucket reconciliation ([PR #453](https://github.com/vladimino/iptv-watchlist/pull/453)) deployed. It compares them with the four [AIR-392](air-392-projector-pre-write-overhead-2026-11-09.md) runs and with the [offline benchmark](air-395-checkpoint-reconciliation-offline-2026-11-09.md). It does not change any budget or schedule and is not an acceptance of any projector throughput.
**Verdict:** **NO SPEEDUP, SMALL SAMPLE.** The bucket path was not used in either run (`checkpointMode: full`, `skipped: backlog`). The paged read of about 33,000 checkpoints took 0.31 and 0.52 s, but the `COUNT(*)` that now precedes it took 14.4 and 18.0 s as measured wall time of its phase, so the two together (14.7 and 18.5 s) were not shorter than the single read they replace (6.4 to 11.2 s in AIR-392). `preWriteMs` was 24.8 and 26.7 s and the runs wrote 87 and 79 Films and 309 and 335 Persons; the target of the card (at least 500 changed Films an hour) is not reached and `remaining` did not shrink. The hypothesis that the cost of `diff.storedRead` was the transfer of 32,000 rows is not supported by these two runs; the cause of the phase wall time is not established.
**Used by:** [ADR 0106](../../adr/0106-bulk-projector-write-path.md) (the pre-write overhead that every window pays), [AIR-392 evidence](air-392-projector-pre-write-overhead-2026-11-09.md), [AIR-395 offline evidence](air-395-checkpoint-reconciliation-offline-2026-11-09.md).

## What was deployed, and when

| Change | Merge commit on `main` | Post-merge CI/CD run | `Deploy verified build` finished |
| --- | --- | --- | --- |
| Interim paged read (PR #452) | `dd1bf3813e7b2d52cedaff69478cffdd7444d1aa` | [#1965](https://github.com/vladimino/iptv-watchlist/actions/runs/42669872896), `Test and build` and `Deploy to Cloudflare` success | 2026-11-09 19:04 Madrid (18:04 UTC) |
| Bucket reconciliation (PR #453) | `79b2cd0d6e68f052eeb57881c80e3d03e668f8e6` | [#1971](https://github.com/vladimino/iptv-watchlist/actions/runs/42674506128), `Test and build` and `Deploy to Cloudflare` success | 2026-11-09 19:35 Madrid (18:35 UTC) |

The 20:00 and 21:00 Madrid runs are the first two hourly runs after both deployments, so both run the code of #452 and #453 together. The run of 19:00 Madrid (18:00 UTC) started before #452 was deployed and is not part of this table.

## What was measured

All times in milliseconds unless stated; the fields are the additive `timing`, `phases` and `detail` groups of the run summary (see the [monitoring runbook](../../runbooks/monitoring.md#d1-projector-run-phase-timing-air-392)). The AIR-392 column gives the range over its four runs.

| Field | AIR-392 (four runs) | 20:00 Madrid (19:00:42 UTC) | 21:00 Madrid (20:00:42 UTC) |
| --- | --- | --- | --- |
| `checkpointMode` / `checkpointBuckets` | (not present) | `full`; `skipped: backlog`, `expected` 7,514, `missing` 18,462 | `full`; `skipped: backlog`, `expected` 7,520, `missing` 18,542 |
| `diff.checkpointCount` (one `COUNT(*)`; wall time of the phase) | (not present) | 14,391 (1 query) | 17,978 (1 query) |
| `diff.storedRead` (rows read) | 6,424 to 11,178 (1 query; 31,772 to 32,691 rows) | 310 (7 queries; 32,826 rows) | 520 (7 queries; 33,221 rows) |
| `diff.checkpointCount` plus `diff.storedRead` | 6,424 to 11,178 | 14,701 | 18,498 |
| `loadMs` | 2,637 to 29,018 | 8,619 | 6,926 |
| `store.readBlock` (`read.resolution`) | 1,194 to 18,956 | 5,143 | 3,814 |
| `diffMs` | 14,622 to 47,679 | 24,361 | 26,323 |
| `windowMs` (request to grant) | 515 to 8,013 | 1,071 | 26,441 |
| `preWriteMs` | 14,811 to 49,226 | 24,816 | 26,724 |
| `writeMs` | 10,478 to 37,300 | 35,775 | 33,590 |
| Films / Persons written | 6 to 107 / 34 to 355 | 87 / 309 | 79 / 335 |
| `changedFilms` / `changedPeople` | | 4,881 / 13,781 | (not tabulated) |
| `remaining` | | 18,266 | 18,329 |
| `stored` (`projection_state` rows) | | 32,826 | 33,221 |
| `queries` counted / budget | 825 in the run that hit it / 800 | 703 / 800 | 701 / 800 |
| `heldMs` / `outcome` | 25 s to 60 s / `budget` | 60,395 / `budget` | 60,191 / `budget` |
| `errorCount`, `leaseLost`, `windowLost` | | 0, false, false | 0, false, false |

The accounting of the 20:00 Madrid run is exact: `diffMs` (24,361) equals `loadMs` (8,619) plus the sum of the `diff.*` phases (15,742), with a residual of 0. The 21:00 Madrid figures above are the fields that were read; the remaining `diff.*` phases were not tabulated.

## What the two runs show, and what they do not

**Measured.**
1. The bucket path was not taken in either run: the backlog check (`checkpointBuckets.skipped: backlog`, a view of about 48,500 entities against about 33,000 stored rows) sent both runs to the whole-table read, as the [offline evidence](air-395-checkpoint-reconciliation-offline-2026-11-09.md) expected. No `diff.checkpointDigest` or `diff.checkpointRows` exists in either run.
2. The paged read itself returned 32,826 and 33,221 rows in seven queries each, in 0.31 and 0.52 s; the row counts equal `stored`.
3. The phase `diff.checkpointCount` (one `COUNT(*)` query) took 14.4 and 18.0 s of wall time. Together with the read it was 14.7 and 18.5 s, against 6.4 to 11.2 s for the single read of AIR-392.
4. `preWriteMs` was 24.8 and 26.7 s (AIR-392: 14.8 to 49.2 s), within the AIR-392 range. Both runs ended on `budget` after about 60 s of hold, with 701 to 703 of 800 queries counted.
5. The runs wrote 87 and 79 Films and 309 and 335 Persons; `remaining` went from 18,266 to 18,329.

**Interpretation, not established.**
- The paged read does not show a gain over the old single read in these two runs: the time moved from `diff.storedRead` to `diff.checkpointCount`. A transfer cost proportional to the number of rows would not let a 33,000-row page read take 0.3 to 0.5 s while one aggregate takes 14 to 18 s; the hypothesis behind the digest (the cost scales with the rows moved) is therefore not supported by these runs. It is also not refuted: two runs cannot separate it from a latency that falls on the first heavy query.
- The 14.4 and 18.0 s are the wall time of the phase as seen by the Worker. They are **not** the SQL execution time of the `COUNT(*)`: queueing behind another D1 operation, connection or session setup, Worker CPU and transport are all possible and none is measured. The fields do not record D1 `served_by` or `sql_duration_ms`.
- Why the first heavy query is slow is not known. The follow-up that separates execution from waiting is [AIR-396](https://trello.com/c/7mVG4T4D).

## Limits of the measurement

- Two runs in two consecutive hours of one day, after the same deployments. This is not a distribution and no statistical statement is made; the AIR-392 range comes from four runs of another day part.
- Read-only provenance: Worker logs (`event=d1_enrichment_projection`, fields under `source`), queried through the Cloudflare telemetry API after both runs; no D1 query was needed. Nothing was run or changed in production.
- `windowMs` differed (1.1 s and 26.4 s); the budget clock restarts at the grant, so `preWriteMs` excludes it.
- The effect on Discovery and EPG was not measured here; the hold stayed at about 60 s and inside the ADR 0103 cap of 300 s from request to release (the 21:00 Madrid run: 26.4 s wait plus 60.2 s hold plus release).

## Effect on the budgets

No change of any budget, schedule or flag. The checkpoint read now costs eight queries (one count and seven page queries) where it cost one, so about seven more of the 800 queries of a run; in these two runs 701 and 703 queries were counted and both ended on the 60 s wall time (`heldMs` 60.4 and 60.2 s), not on the query limit. A run that reaches the query limit earlier, as the 16:01 UTC run of AIR-392 did at 25 s of hold, would have about seven fewer queries for writes.

## Conclusion and follow-ups

The two runs do not show a speedup and the throughput target of AIR-395 is not met. The bucket code stays in `main` inert until the backlog drains (it falls back to the whole-table read while a view holds far more entities than the table has rows); reverting it or the paged read would be an ordinary code PR and would not touch data.

Follow-ups, each its own card and gate:
- [AIR-396](https://trello.com/c/7mVG4T4D): root-cause analysis of the first heavy D1 query and of `COUNT(*)`.
- [AIR-397](https://trello.com/c/O1yieGvC): the `read.resolution` read (3.8 and 5.1 s here, 16.5 to 19 s in the slow AIR-392 runs).
- [AIR-398](https://trello.com/c/UaxgcH6l): hardening of the bucket hash for non-ASCII and non-BMP id suffixes.
- [AIR-399](https://trello.com/c/zyqL80T3): the grouped write path (variant C of ADR 0106), offline implementation.

The decision on the status of AIR-395 (accepting a negative result) belongs to the owner and the Controller and is not made here.
