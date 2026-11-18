# AIR-533: pre-finalize critical path of the daily EPG, offline change and measurement plan

Status: offline code change, telemetry and an offline benchmark. **No production measurement of the change exists yet**; the "before" numbers below are the natural run of 18 November 2026 from [AIR-420](air-420-seal-finalize-scan-natural-run-2026-11-18.md). No production write, flag, Task, lease or cron was touched. Times UTC.

## Changed (proven hot path only)

`seal_stage` archive (`planDiscoveryLedger`, `src/worker.js`). Baseline of 18 November: archive 146.8 s of a 236.2 s stage, of which R2 puts 86.3 s, full fences 39.4 s and reads 18.9 s, 64 segments, 81.6 MB, all issued one after another.

- Segment read, merge, serialization and create-only put of up to `ARCHIVE_SEGMENT_CONCURRENCY` = 3 segments now overlap. Memory bound: three segment texts and parsed objects (about 1.3 MB serialized each) in flight at once.
- Unchanged: every segment is a create-only object under the run's write id, the manifest names the segments in order, the archive pointer moves only after a full fence and a compare-and-swap, history, first absence, re-entry and idempotent replay are untouched, and no storage format changed.
- Failure semantics (review of PR 766): a window is joined with `Promise.allSettled` before any error leaves `planDiscoveryLedger`, so no segment read or put is still running when the caller releases the Discovery lease. A shared `windowFailed` flag stops every sibling put that has not started, and every put re-checks, immediately before it starts, that the last full fence is younger than 20 s (one shared refresh for the window). A deterministic test blocks two sibling reads for 60 ms, fails the first, and asserts that all three reads finished, no segment put started, and the lease was released after the last archive operation; the test fails if the loop is changed back to `Promise.all`.
- Fence accounting (re-review of PR 766): a fence refreshed by the put guard inside a window restarts the count of writes since the last full fence, so the window being written is counted against the refreshed fence once (conservatively, as if all its puts followed it). A deterministic test with a 25 s simulated read followed by instant puts asserts that no more than eight segment puts begin between two full fences; with the accounting removed it observes 11.
- Fence cadence: one `segmentFence(windowSize)` before each window counts the window's writes, so a full fence still runs after at most 8 writes or 20 s (Discovery lease 90 s). The fence now also precedes the window's reads, which is stricter than before.
- Telemetry meaning: `readMs` and `putMs` of `seal_stage_archive` are now the summed time of the overlapping operations (identical to wall time only when nothing overlaps), so they can exceed `elapsedMs`; compare wall time through `elapsedMs`.
- Expected effect (a model, see the benchmark below, not a production measurement): put and read wall time of the archive falls by about 65-75 s of the 105 s; fences (39.4 s) are not reduced.

## Telemetry added (no behaviour change)

- `seal_ledger` phase logs carry `statements` and `bytes` per step beside `batches` and `writeMs`, so the per-statement and per-byte cost of a D1 round trip can be computed from the next natural run.
- `metadataSync` logs one `metadata_sync_breakdown` per step on **every** outcome (`outcome` is `ok`, `incomplete` for an unsettled canonical step, `handled_error` or `thrown`) with `films`, `loadMs`, `fetchMs`, `localizeMs`, `canonicalMs`, `tailMs`, `totalMs`; milliseconds and counts only, no Film id. Results, retries and exceptions of the step are unchanged (a test drives all four outcomes through the real function).
- `seal_stage_plan` (63.7 s on 18 November) logs `totalMs`, measured from the entry of the plan, and its parts in order, which add up to `totalMs` with the remainder `restMs`; `elapsedMs` keeps its historical scope (it starts after the active-ledger read and the archive pointer read, which is why the 18 November figure of 63.7 s excludes `viewMs`) and is never larger than `totalMs`. The parts: `viewMs` (the predecessor's active ledger), `manifestMs` (archive pointer and manifest), `reentryMs` and `reentrySegments` (re-entry segment reads), `collectMs` (streamed read, parse and classify of the active ledger against the scan) and `alsoMs` (the alsoArchived chain). The natural run after deploy therefore splits the plan; nothing about it was changed.

## Offline benchmark of the archive loop

`scripts/discovery-archive-window-benchmark.mjs` runs the Worker's own bounded commit (`publishGenerationWithLedger`, synthetic objects, no network, no R2, no D1) on a store of the 18 November shape: 64 archive segments, 80.1 MB, 46 000 archived objects, about 20.5k active, 3.5k departures (86.1 MB written). R2 latency on segment objects is simulated from the AIR-420 constants (64 puts 86.3 s, 64 reads 18.9 s) at a scale of 0.02; the commit's CPU is real and not scaled, so only the difference between concurrencies is meaningful. Two repetitions per level, same machine, one run of the script:

| Concurrency | Wall (s) | Peak heap above start (MB, Node) | Saving against 1, modelled at production scale |
| --- | --- | --- | --- |
| 1 (before AIR-533) | 7.10 / 7.39 | 246.9 / 243.1 | n/a |
| 2 | 5.82 / 6.06 | 254.4 / 256.1 | about 52-64 s |
| 3 (shipped) | 5.63 / 5.74 | 256.4 / 261.5 | about 68-73 s |

Reading: overlap saves roughly two thirds of the simulated segment I/O (the model puts the segment reads and puts at about 105 s); three in flight add about 10 s over two for about 2-5 MB more heap, and 9-18 MB more than the sequential path. Node's heap is not the Workers isolate limit and `heapUsed` includes garbage not yet collected, so the heap column is a relative figure; the isolate peak of the production step is not measured. `ARCHIVE_SEGMENT_CONCURRENCY` is the single constant to lower to 2 if the owner prefers the smaller memory cost. A natural production run stays the acceptance gate.

## Deliberately left unchanged

- **`seal_ledger`**: 176 batches, about 107 s writeMs, about 0.6 s per batch. `src/discovery-authority.js` already packs rows (multi-row upserts, shows 16 rows per insert, deletes per 80 keys) and carries fence values between batches. The remaining knobs (`STATEMENT_CAP` 40, step budget `SEAL_REQUEST_BUDGET_MS` 32 s) change D1 or Workflow limits and need the per-statement figures above first. Batches cannot be parallelised: each moves the cursor by compare-and-set. No change without that evidence; AIR-423 is not repeated.
- **`beginSync` / `metadataSync` / `epgSync` preprocessing**: no operation was proven redundant, and skipping metadata or Film facts is out of scope. Only the breakdown was added.
- **`seal_stage_plan` (63.7 s)**: now split by counters (above); no change to the plan itself until the natural run shows which part dominates.
- Which operations must run in every EPG remains the owner's architecture question; the sequence and semantics are unchanged.

## Acceptance still open

Before/after on a comparable workload (20-24k active, about 3.5k departures, about 64 segments) needs the natural run after deploy; then compare `seal_stage_archive` `putMs`, `readMs`, `elapsedMs` with 16-18 November. This change alone does not meet the 15-minute full-publication target, which is shared with AIR-532.

**Documentation impact:** this file, its row in [evidence registry](../README.md), and [orchestration reliability](../../reference/orchestration-reliability.md) (new log fields), plus the benchmark script `scripts/discovery-archive-window-benchmark.mjs`. No topology, authority or storage format changed, so no architecture diagram or ADR.
