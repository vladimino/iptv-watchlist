# D1 projector: why the first heavy query after the view build is slow (RCA, seven natural runs and one with D1 meta)

**Captured:** 2026-11-09, read-only: the stored `projection_run.summary_json` of the 22:00 UTC run (the first natural run after the deploy of the D1 `meta` fields, [PR #455](https://github.com/vladimino/iptv-watchlist/pull/455), CI/CD run #1977, both jobs success, deploy finished 21:21 UTC), the stored `projection_run.summary_json` of the 20:00 UTC run (one D1 `SELECT`), the Worker invocation telemetry (`$workers.cpuTimeMs`, `$workers.wallTimeMs`) of the seven hourly cron invocations 14:00 to 20:00 UTC, and D1 query analytics (`d1QueriesAdaptiveGroups`) for the 19:00 and 20:00 UTC runs. No manual projector, Discovery or EPG run, no flag, Task, cron, lease, window or budget change, no production write, no GET that could write.
**Scope:** [AIR-396](https://trello.com/c/7mVG4T4D). The 14.4 and 18.0 s of `diff.checkpointCount` at 19:00 and 20:00 UTC against 0.31 and 0.52 s of the next phase, `diff.storedRead`, which reads about 33,000 checkpoints. Builds on [AIR-392](air-392-projector-pre-write-overhead-2026-11-09.md) and [AIR-395](air-395-checkpoint-reconciliation-offline-2026-11-09.md).
**Verdict:** **ROOT CAUSE INCONCLUSIVE; one thing is established.** On the one run that carries D1 `meta` (**N = 1**, a slow-mode run), `diff.checkpointCount` took 9,608 ms of wall time of which the database spent 6.1 ms: slow D1 execution of that `COUNT(*)` is excluded **for this run**. Where the other ~9.6 s went (CPU on a clock that does not advance during CPU, queueing, or transport) is **not** established, and neither is how this generalises: one run is not a distribution. No fix is recommended; nothing here changes the budget, order of queries or write path.
**Used by:** [ADR 0106](../../adr/0106-bulk-projector-write-path.md) (the pre-write overhead every window pays).

## What was measured

| Run (UTC) | Phase named in the log | Phase ms | `preWriteMs` | Invocation CPU ms | Invocation wall ms | Source |
| --- | --- | --- | --- | --- | --- | --- |
| 14:01 | `diff.storedRead` | 11,129 | 23,251 | 11,824 | 68,787 | AIR-392 + telemetry |
| 15:01 | `diff.storedRead` | 11,178 | 49,226 | 15,690 | 65,199 | AIR-392 + telemetry |
| 16:01 | `diff.storedRead` | 6,424 | 14,811 | 12,022 | 26,074 | AIR-392 + telemetry |
| 17:01 | `diff.storedRead` | 6,692 | 43,725 | 9,157 | 67,985 | AIR-392 + telemetry |
| 18:01 | not read (run predates the capture) | n/a | n/a | 8,232 | 89,188 | telemetry only |
| 19:01 | `diff.checkpointCount` | 14,400 | 24,800 | 12,961 | 61,929 | AIR-395 + telemetry |
| 20:01 | `diff.checkpointCount` | 17,978 | 26,724 | 17,481 | 87,063 | `summary_json` + telemetry |

The 20:00 UTC run (its full `summary_json` was captured earlier from D1; `projection_run` stores a single row that each run replaces, so the 22:00 UTC summary below was read later and was not retained alongside it) took the whole-table path (`checkpointMode: full`, `checkpointBuckets: {expected: 7520, missing: 18542, skipped: backlog}`), so its `diff.storedRead` (520 ms, 7 queries, 33,221 rows) includes a second `SELECT COUNT(*) FROM projection_state WHERE projection=?`, the same statement as the 18 s phase. The phases before the count are small (`store.*` 6.9 s, `diff.schemaContract` 66 ms, `diff.metadataCache` 259 ms, `diff.predictionAuthority` 151 ms) and the three CPU-only phases between them and the count (`diff.lifecycle`, `diff.inputs`, `diff.keys`) read 0 ms.

## First natural run with D1 `meta` (22:00 UTC, N = 1)

Run started 2026-11-09 22:00:42 UTC (23:00 Madrid), after the deploy. Slow mode: `loadMs` 32,111, `store.readBlock` 20,787 (`read.resolution`), `windowMs` 23,723, `preWriteMs` 49,888, outcome `budget` after 5 Films and 30 Persons, 75 queries. Checkpoint path: `full` (`skipped: backlog`, 18,553 missing). Invocation CPU 10,490 ms, wall 86,170 ms (Worker telemetry). Every D1 read of the run was served by the primary (`replica` 0 in every phase).

| Phase | Wall `ms` | D1 SQL (`sqlUs`) | Rows read (`dbRows`) | D1 reads (`dbN`) | `ms` minus SQL |
| --- | --- | --- | --- | --- | --- |
| `diff.checkpointCount` | 9,608 | 6.1 ms (6,137 us) | 33,634 | 1 | about 9,602 ms |
| `diff.storedRead` | 2,674 | 73.7 ms | 157,268 | 7 | about 2,600 ms |
| `diff.metadataCache` | 1,481 | 21.3 ms | 638 | 4 | about 1,460 ms |
| `diff.predictionAuthority` | 559 | 0.6 ms | 213 | 3 | about 558 ms |
| `diff.membersRead` | 326 | 0.8 ms | 393 | 1 | about 325 ms |
| `diff.syncProbe` | 309 | 0.2 ms | 211 | 1 | about 309 ms |
| `diff.knownFilmsRead` | 276 | 2.2 ms | 3,551 | 1 | about 274 ms |
| `diff.storedSyncRead` | 268 | 0.6 ms | 398 | 1 | about 267 ms |
| `diff.aliasesRead` | 233 | 1.4 ms | 4,351 | 1 | about 232 ms |
| `diff.schemaContract` | 179 | 0.14 ms | 1 | 1 | about 179 ms |

What it shows, and only for this run:

- The database's own time is 0.06 % of the `diff.checkpointCount` phase. All D1 phases of the run together spent about 108 ms in SQL against about 15.7 s of wall time.
- Even trivial one-row reads took 180 to 330 ms of wall time, so this run had a general per-call overhead outside SQL, on top of which the count phase has about 9.3 s more. The per-call overhead is not specific to `COUNT(*)`.
- The invocation's CPU (10.5 s) is close to the size of the count phase (9.6 s) but is the total of all jobs of that cron run; it does not locate CPU in the phase.

## Competing hypotheses

| Hypothesis | What it predicts | Evidence | Status |
| --- | --- | --- | --- |
| H1. D1 executes `COUNT(*)` slowly (scan cost) | The same statement is slow every time | The same statement ran again inside `diff.storedRead` of the same run and the whole phase took 520 ms (7 queries, 33,221 rows). Server-side `sql_duration_ms` of the other projector reads is tiny (for example 164 `discovery_decision` pages, 164,000 rows, 831 ms in total) | **Excluded for the 22:00 UTC run (N = 1)**: 6.1 ms of SQL in 9,608 ms. Not shown for other runs (they carry no `meta`). Cold cache on the first touch cannot explain 9.6 s with 6 ms of SQL |
| H2. The Worker clock is frozen during CPU, so CPU-only work between two I/O calls is charged to the next I/O phase | The slow phase is the first I/O after the view build, wherever it is, and moves when the order moves | AIR-392 (code before AIR-395): the first I/O after the build was `diff.storedRead`, 6.4 to 11.2 s. After AIR-395 reordered the diff (keys, then count): the slow phase moved to `diff.checkpointCount`, and `diff.storedRead` fell to 0.3 to 0.5 s. The three CPU phases read 0 ms in every run. The runbook already states that `Date.now()` advances only across I/O | Consistent, not proven |
| H3. Queueing or contention on D1 or a concurrent cron job in the same isolate | The phase varies with other activity; D1 analytics would show other queries running | The window is held during the diff (Discovery writers are quiet). The hourly invocation runs other jobs too. No evidence of contention found, none excluded | Open. The invocation CPU is the same order as the phase; no per-phase CPU |
| H4. Transport or platform latency to the D1 primary | Replica or primary `served_by` differences, erratic times for identical queries | Every projector read of the 22:00 UTC run was served by the primary (`replica` 0), so a replica is not the cause. Per-call overhead of 180 to 330 ms on one-row reads in that run fits transport or queueing, or CPU-blocked event loop; not separated | Open |

## Size check of H2

The hourly invocation consumed 8.2 to 17.5 s of CPU time over 26 to 89 s of wall time. That CPU is the same order as the slow phase (11 to 18 s). It includes everything else the invocation does (R2 parsing, the 600 to 700 write statements, the other cron jobs), so the CPU inside the count phase is at most that total minus the rest. At 19:01 and 20:01 the phase (14.4 and 18.0 s) is larger than the whole invocation's CPU (13.0 and 17.5 s), so the phase is not pure CPU either: at least 1 s is something else (latency, queueing, or CPU outside the invocation's accounting). The ratio of phase to CPU is 1.1 and 1.03. Seven points, no per-phase CPU, so this is a plausibility check, not a measurement.

## What this means

- Do **not** replace or reorder the `COUNT(*)` on this evidence: moving it moves the slow phase (it already moved once), it does not remove the time.
- If H2 holds, the time is CPU of the view build (`diff.lifecycle`, `diff.inputs`, `diff.keys` over about 52,000 entities) and the candidate follow-up is to measure and then reduce that CPU, not to touch D1.
- Nothing here changes the budget, the order of queries or the write path (ADR 0106 C and L1 stay as they are).

## Instrumentation delivered with this evidence

PR #455 added to the projector adapter a sum of the D1 `meta` of each read (the database's `sql_duration_ms`, `rows_read`, whether the read was served by a replica), written to every `phases` and `detail` entry whose reads carried a meta as `sqlUs` (microseconds), `dbRows`, `dbN` and `replica`. The statement `get` reads through `.all()` and takes the first row so that its `meta` is visible; results are unchanged. It works in production as designed (the 22:00 UTC run above). See the [monitoring runbook](../../runbooks/monitoring.md#d1-projector-run-phase-timing-air-392).

## Limitations

- **D1 `meta` exists for one run (N = 1)**, in slow mode. A fast-mode run, a different day or a Discovery burst may differ; the distribution of `ms - sqlUs/1000` needs its own sample.
- Seven runs of one day without `meta`. `projection_run` keeps a single row that each run replaces: the 20:00 UTC summary was captured before the 22:00 UTC run replaced it, and the 22:00 UTC summary was read afterwards, so only one summary was available at a time and the other is quoted from that capture. The 14:00 to 17:00 UTC figures are the AIR-392 evidence, the 19:00 UTC figures are those reported by AIR-395.
- D1 analytics does not list the projector's `COUNT(*)` or checkpoint page reads at all (25 to 31 query groups per run, none on `projection_state`), so for the runs without `meta` (14:00 to 20:00 UTC) the database-side duration of that statement is **not** known; there the statement that it is small rests on H1's second run of the same statement and on the other reads. For the 22:00 UTC run it is measured directly (`sqlUs` 6,137 for `diff.checkpointCount`).
- The CPU figures are per invocation (all jobs of the cron), not per phase.
- No code path was changed to test H2 (no experiment, by scope).
- The statement that nothing but SQL excluded is limited to the SQL of that one read: queueing, transport and CPU are not separated.

## Candidate follow-ups (not decisions)

1. An offline CPU microbenchmark of the view build (`LifecycleReader.readLifecycle`, the owner overlay, `enrichmentInputs` and the change keys) on the input sizes of the 20:00 and 22:00 UTC runs (about 8,300 Films and 43,900 Persons), as its own card. A real optimisation is gated on that measurement.
2. More natural runs, as a separate sample, if the distribution of the non-SQL part matters; not required for this finding.
