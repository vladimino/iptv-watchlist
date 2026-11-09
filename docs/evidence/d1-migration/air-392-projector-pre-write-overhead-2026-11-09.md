# D1 enrichment projector: where the time before the first write goes (phase timing, four natural runs)

**Captured:** 2026-11-09, four natural hourly runs at 14:01, 15:01, 16:01 and 17:01 UTC, read-only: Worker logs (`event=d1_enrichment_projection`) and one D1 `SELECT` of `projection_run.summary_json`. Code at `779e9931` ([PR #447](https://github.com/vladimino/iptv-watchlist/pull/447)), deployed by CI/CD #1950 (both jobs success, 2026-11-09 13:58 UTC). No manual projector, Discovery or EPG run, no flag, Task, cron, lease, window or budget change, no production write.
**Scope:** [AIR-392](https://trello.com/c/ivMqVpKC). What the 14 to 49 s between the window grant and the first batch consist of, using the additive `timing`, `phases` and `detail` fields of the run summary (see the [monitoring runbook](../../runbooks/monitoring.md#d1-projector-run-phase-timing-air-392)). It does not change any budget or schedule and is not an acceptance of any projector throughput.
**Verdict:** **MEASURED, SMALL SAMPLE.** The time before the first write is large in both modes and falls almost entirely inside a few measured D1, R2 and Discovery-authority read boundaries (latency attributed to those reads), not in the repository's planning before the first batch (`firstBatchPlanMs` 26 to 683 ms). The Worker clock advances only across I/O, so these fields cannot separate CPU, parsing or routing inside a measured read from storage latency: CPU is not ruled out, and the cause of the slow mode is not established. One read of every checkpoint (`projection_state`, about 32,000 rows) costs 6 to 11 s in every run; the read of the discovery decisions (`read.resolution`) costs 1.2 s in fast runs and 16.5 to 19 s in slow runs and is the main difference between the modes. The accounting is exact: `diffMs` equals the sum of the `phases` plus `diffResidualMs` (0 ms) in all four runs.
**Used by:** [ADR 0106](../../adr/0106-bulk-projector-write-path.md) (the pre-write overhead that every window pays), [AIR-391 spike evidence](air-391-bulk-projector-spike-2026-11-09.md).

## What was measured

All times in milliseconds. `windowMs` is the ADR 0103 request to grant; the budget clock restarts at the grant, so `preWriteMs` (grant to the first batch submitted to D1, an attempt) is what a run spends before it can write, and it excludes the window wait. `loadMs` is the old `store.*` total.

| Run (UTC) | Mode (by `loadMs`) | `windowMs` | `loadMs` | `diffMs` | `diffResidualMs` | `firstBatchPlanMs` | `preWriteMs` | `writeMs` | Films / Persons written | Outcome |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 14:01 | fast | 8,013 | 9,989 | 22,569 | 0 | 242 | 23,251 | 37,300 | 101 / 319 | budget |
| 15:01 | slow | 3,049 | 26,904 | 47,679 | 0 | 639 | 49,226 | 11,893 | 6 / 34 | budget |
| 16:01 | fast | 515 | 2,637 | 14,622 | 0 | 26 | 14,811 | 10,478 | 107 / 355 | budget (800-query budget, held 25 s) |
| 17:01 | slow | 3,635 | 29,018 | 42,187 | 0 | 683 | 43,725 | 19,412 | 10 / 51 | budget |

The two slow runs spent 43.7 and 49.2 s before their first write and had 11.9 and 19.4 s left of the 60 s budget; the two fast runs spent 14.8 and 23.3 s. The planning between entering the first transaction and submitting its batch (`firstBatchPlanMs`) is small (26 to 683 ms): the repository's own reads and statement assembly are not the overhead.

## Where the pre-write time goes

Phases (sequential, additive), in milliseconds, per run. Phases below 0.1 s in every run (`store.build`, `diff.lifecycle`, `diff.ownerOverlay`, `diff.inputs`, `diff.plan`, `diff.admittedFirst`, `diff.schemaContract`, `diff.syncProbe`, `diff.storedSyncRead`, `diff.knownFilmsRead`, `diff.aliasesRead`) add 0.3 to 1.4 s together and are left out; the CPU-only phases measure 0 ms (the Worker clock does not advance during CPU work, see the runbook, so that is not evidence that they cost nothing).

| Phase | 14:01 fast | 16:01 fast | 15:01 slow | 17:01 slow |
| --- | --- | --- | --- | --- |
| `diff.storedRead` (one query, rows read in the next row) | 11,129 | 6,424 | 11,178 | 6,692 |
| rows of `diff.storedRead` | 31,772 | 32,231 | 32,191 | 32,691 |
| `store.readBlock` (R2 and discovery reads, concurrent) | 6,764 | 1,194 | 16,454 | 18,956 |
| of which `detail` `read.resolution` | 6,764 | 1,194 | 16,454 | 18,956 |
| of which `detail` `read.catalog` | 1,207 | 629 | 3,902 | 4,491 |
| `diff.membersRead` (393 rows) | 505 | 5,213 | 6,389 | 2,427 |
| `store.publishedSnapshot` (two reads) | 1,916 | 327 | 6,550 | 6,197 |
| `store.etagRecheck` (7 objects) | 610 | 854 | 1,603 | 1,474 |
| `diff.metadataCache` | 285 | 95 | 1,302 | 1,995 |
| `diff.predictionAuthority` | 189 | 38 | 546 | 741 |
| `store.ownerReview` | 275 | 58 | 1,048 | 1,089 |
| `store.handoffGuard` | 179 | 22 | 733 | 790 |
| `store.writersIdle` (two checks) | 245 | 182 | 516 | 512 |

Minimum, median and maximum per mode (two runs each, so the median is the mean of two): `diff.storedRead` fast 6.4 / 8.8 / 11.1 s, slow 6.7 / 8.9 / 11.2 s; `store.readBlock` fast 1.2 / 4.0 / 6.8 s, slow 16.5 / 17.7 / 19.0 s; `store.publishedSnapshot` fast 0.3 / 1.1 / 1.9 s, slow 6.2 / 6.4 / 6.6 s; `diff.membersRead` fast 0.5 / 2.9 / 5.2 s, slow 2.4 / 4.4 / 6.4 s.

## What the four runs show

1. **The time falls inside the measured D1, R2 and Discovery-authority read boundaries.** The CPU-only phases read 0 ms, which this clock cannot tell from CPU work (it advances only across I/O); CPU, parsing or routing inside a read (for example `read.resolution`) is part of that read's time, so these runs do not show whether the latency is storage, transport or CPU. `firstBatchPlanMs` is small, so the repository's planning before the first batch is not the overhead. The slow mode multiplies the I/O phases (`read.resolution` 2.4 to 16 times, `publishedSnapshot` 3 to 20 times, `metadataCache` 5 to 20 times, depending on which fast run is compared), a pattern that fits latency at those read boundaries better than more data (the rows read are the same in fast and slow runs); it is an attribution to those boundaries, not a cause.
2. **`diff.storedRead` is large in every mode.** One query for about 32,000 checkpoints takes 6 to 11 s whatever the mode (43 to 48 % of the pre-write time in the two fast runs, 15 to 23 % in the two slow runs). It is the longest phase of both fast runs. The row count rose from 31,772 to 32,691 over the four runs while the timings (11.1, 11.2, 6.4 and 6.7 s at 14:01, 15:01, 16:01 and 17:01) did not rise with it, so these runs do not show that the read scales with the row count; only the risk that it may, as the projection keeps growing, is established by its size.
3. **`read.resolution` explains most of the difference between the modes.** The discovery decisions (`epg/discovery-resolution.json`) are read through the Discovery authority from D1 under authority `d1`: 1.2 s in the fast run of 16:01 and 6.8 s in the fast run of 14:01, against 16.5 to 19 s in the slow runs. It is the longest read in the two slow runs and the whole `store.readBlock` wall time; in the two fast runs `diff.storedRead` is longer (11.1 s against 6.8 s, and 6.4 s against 1.2 s).
4. **`diff.membersRead` is erratic.** The same 393 rows took 0.5, 5.2, 6.4 and 2.4 s: a latency effect, not a volume effect.
5. **The fast mode is slower than assumed in the AIR-391 spike.** The spike derived 3 to 9 s of overhead for fast runs from the hold time and the estimated writes; the measured pre-write time of the two fast runs is 14.8 and 23.3 s, dominated by `diff.storedRead`. The slow mode agrees with the spike (43.7 and 49.2 s against the derived 50 to 60 s). The spike's what-if with a fast-only overhead was therefore optimistic; its conclusions for the single bounded window (decision L1 of [ADR 0106](../../adr/0106-bulk-projector-write-path.md)) are unchanged, because a 300 s window still has more than 180 s for writes with a 49 s overhead and a 9 s wait.
6. **A fast run can end on the query budget.** The run of 16:01 stopped at 25 s of hold with outcome `budget` because it reached the 800-query limit (825 counted), after 107 Films and 355 Persons; the 60 s wall time was not the limit. The queries of the diff (about 13 here) are a small part of it.

## Limitations

- Four runs of one day, two per mode; the modes are classified by `loadMs` (fast below 12 s, slow from 17 s). Nothing here is a distribution: no percentile is given, and a different day or a Discovery burst may differ.
- `read.resolution` is measured as one read through the Discovery authority; the measurement does not separate its D1 query time from the work around it (the routing, parsing of the document).
- The phases show where the time is, not why a mode is slow: whether the slow runs are a D1, R2 or platform effect is not established; the fields do not record D1 `served_by` or `sql_duration_ms`.
- The Worker clock advances only across I/O, so CPU-local work appears as 0 ms or inside the next I/O phase, and CPU, parsing and routing inside a measured read cannot be separated from storage latency. CPU is not ruled out as part of the slow mode.
- The `summary_json` of the run holds the same numbers without `leaseReleaseMs` and `runMs` (checked once on the stored row of the 14:01 run; 2,699 bytes).

## Candidate follow-ups (not decisions)

These are what the measurement points at; each needs its own card, review and GO, and none is part of AIR-392.

- Avoid reading every checkpoint on every run (the largest phase in the two fast runs; whether it grows with the checkpoint count is not shown by these four runs): for example by reading only what the run needs, or by a change-key digest. It changes the projector's diff and needs its own design.
- Look at how the discovery decisions are read for the projector (`read.resolution`, the main difference between the modes): its payload and path, and whether the projector needs the whole document.
- Possible diagnostics, not conclusions: record D1 `served_by` and the per-query `sql_duration_ms` in the diff reads to tell database time from transport time, and read the Workers CPU-time metric for the same runs, to see whether CPU is part of the slow mode.
- The grouped write path and the single 300 s window of ADR 0106 stay as accepted; this evidence only refines the overhead assumption they use.
