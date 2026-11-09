# D1 projector: why the first heavy query after the view build is slow (RCA, seven natural runs)

**Captured:** 2026-11-09, read-only: the stored `projection_run.summary_json` of the 20:00 UTC run (one D1 `SELECT`), the Worker invocation telemetry (`$workers.cpuTimeMs`, `$workers.wallTimeMs`) of the seven hourly cron invocations 14:00 to 20:00 UTC, and D1 query analytics (`d1QueriesAdaptiveGroups`) for the 19:00 and 20:00 UTC runs. No manual projector, Discovery or EPG run, no flag, Task, cron, lease, window or budget change, no production write, no GET that could write.
**Scope:** [AIR-396](https://trello.com/c/7mVG4T4D). The 14.4 and 18.0 s of `diff.checkpointCount` at 19:00 and 20:00 UTC against 0.31 and 0.52 s of the next phase, `diff.storedRead`, which reads about 33,000 checkpoints. Builds on [AIR-392](air-392-projector-pre-write-overhead-2026-11-09.md) and [AIR-395](air-395-checkpoint-reconciliation-offline-2026-11-09.md).
**Verdict:** **INCONCLUSIVE, with a leading and testable hypothesis.** The phase is a wall time, not proof that `COUNT(*)` ran for 14 to 18 s. The data supports "the slow phase is the first I/O after a long CPU-only stretch, and the Worker clock does not advance during CPU", and does not support "D1 executes that SQL slowly". It does not separate CPU from queueing or transport, and no fix is recommended from it. A small additive instrumentation (D1 `meta` per phase) is delivered to settle it on the next natural runs.
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

The 20:00 UTC run (the only one whose full stored summary is still in D1; `projection_run` holds one row) took the whole-table path (`checkpointMode: full`, `checkpointBuckets: {expected: 7520, missing: 18542, skipped: backlog}`), so its `diff.storedRead` (520 ms, 7 queries, 33,221 rows) includes a second `SELECT COUNT(*) FROM projection_state WHERE projection=?`, the same statement as the 18 s phase. The phases before the count are small (`store.*` 6.9 s, `diff.schemaContract` 66 ms, `diff.metadataCache` 259 ms, `diff.predictionAuthority` 151 ms) and the three CPU-only phases between them and the count (`diff.lifecycle`, `diff.inputs`, `diff.keys`) read 0 ms.

## Competing hypotheses

| Hypothesis | What it predicts | Evidence | Status |
| --- | --- | --- | --- |
| H1. D1 executes `COUNT(*)` slowly (scan cost) | The same statement is slow every time | The same statement ran again inside `diff.storedRead` of the same run and the whole phase took 520 ms (7 queries, 33,221 rows). Server-side `sql_duration_ms` of the other projector reads is tiny (for example 164 `discovery_decision` pages, 164,000 rows, 831 ms in total) | Not supported. A cold page cache on the first touch is not excluded (the second run of the statement is warm) |
| H2. The Worker clock is frozen during CPU, so CPU-only work between two I/O calls is charged to the next I/O phase | The slow phase is the first I/O after the view build, wherever it is, and moves when the order moves | AIR-392 (code before AIR-395): the first I/O after the build was `diff.storedRead`, 6.4 to 11.2 s. After AIR-395 reordered the diff (keys, then count): the slow phase moved to `diff.checkpointCount`, and `diff.storedRead` fell to 0.3 to 0.5 s. The three CPU phases read 0 ms in every run. The runbook already states that `Date.now()` advances only across I/O | Consistent, not proven |
| H3. Queueing or contention on D1 or a concurrent cron job in the same isolate | The phase varies with other activity; D1 analytics would show other queries running | The window is held during the diff (Discovery writers are quiet). The hourly invocation runs other jobs too. No evidence of contention found, none excluded | Open |
| H4. Transport or platform latency to the D1 primary | Replica or primary `served_by` differences, erratic times for identical queries | Every D1 `meta` read here (the `SELECT`s above) was served by the primary in MAD. The projector's own reads do not record `meta` yet | Open |

## Size check of H2

The hourly invocation consumed 8.2 to 17.5 s of CPU time over 26 to 89 s of wall time. That CPU is the same order as the slow phase (11 to 18 s). It includes everything else the invocation does (R2 parsing, the 600 to 700 write statements, the other cron jobs), so the CPU inside the count phase is at most that total minus the rest. At 19:01 and 20:01 the phase (14.4 and 18.0 s) is larger than the whole invocation's CPU (13.0 and 17.5 s), so the phase is not pure CPU either: at least 1 s is something else (latency, queueing, or CPU outside the invocation's accounting). The ratio of phase to CPU is 1.1 and 1.03. Seven points, no per-phase CPU, so this is a plausibility check, not a measurement.

## What this means

- Do **not** replace or reorder the `COUNT(*)` on this evidence: moving it moves the slow phase (it already moved once), it does not remove the time.
- If H2 holds, the time is CPU of the view build (`diff.lifecycle`, `diff.inputs`, `diff.keys` over about 52,000 entities) and the candidate follow-up is to measure and then reduce that CPU, not to touch D1.
- Nothing here changes the budget, the order of queries or the write path (ADR 0106 C and L1 stay as they are).

## Instrumentation delivered with this evidence

The projector adapter now sums the D1 `meta` of each read it makes (the database's `sql_duration_ms`, `rows_read`, whether the read was served by a replica) and adds, to every `phases` and `detail` entry whose reads carried a meta, `sqlUs` (microseconds), `dbRows`, `dbN` and `replica`. The statement `get` now uses `.all()` and takes the first row (a singleton in every call site) so that its `meta` is visible; results are unchanged. The next natural runs can then be read as: `ms - sqlUs/1000` is the part of a phase that is not D1 SQL execution (queue, transport, frozen-clock CPU). See the [monitoring runbook](../../runbooks/monitoring.md#d1-projector-run-phase-timing-air-392).

## Limitations

- Seven runs of one day; only the 20:00 UTC run has its full summary available (the table keeps one row). The 14:00 to 17:00 UTC figures are the AIR-392 evidence, the 19:00 UTC figures are those reported by AIR-395.
- D1 analytics does not list the projector's `COUNT(*)` or checkpoint page reads at all (25 to 31 query groups per run, none on `projection_state`), so the database-side duration of that statement is **not** known; the statement that it is small rests on H1's second run of the same statement and on the other reads.
- The CPU figures are per invocation (all jobs of the cron), not per phase.
- No code path was changed to test H2 (no experiment, by scope).

## Candidate follow-ups (not decisions)

1. Read the new `sqlUs`, `dbRows` and `replica` fields on two or three natural runs after deploy; if `ms - sqlUs/1000` of the count phase stays large, H2 or H3/H4 remains and the sql time is known to be small.
2. If H2 holds: measure the view build CPU separately (for example by a deterministic offline benchmark of `LifecycleReader.readLifecycle`, `enrichmentInputs` and the change keys on the 20:00 UTC input sizes), then decide on its own card.
