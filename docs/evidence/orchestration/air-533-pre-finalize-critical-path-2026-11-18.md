# AIR-533: pre-finalize critical path of the daily EPG, offline change and measurement plan

Status: offline code change plus telemetry. **No production measurement of the change exists yet**; the "before" numbers below are the natural run of 18 November 2026 from [AIR-420](air-420-seal-finalize-scan-natural-run-2026-11-18.md). No production write, flag, Task, lease or cron was touched. Times UTC.

## Changed (proven hot path only)

`seal_stage` archive (`planDiscoveryLedger`, `src/worker.js`). Baseline of 18 November: archive 146.8 s of a 236.2 s stage, of which R2 puts 86.3 s, full fences 39.4 s and reads 18.9 s, 64 segments, 81.6 MB, all issued one after another.

- Segment read, merge, serialization and create-only put of up to `ARCHIVE_SEGMENT_CONCURRENCY` = 3 segments now overlap. Memory bound: three segment texts and parsed objects (about 1.3 MB serialized each) in flight at once.
- Unchanged: every segment is a create-only object under the run's write id, the manifest names the segments in order, the archive pointer moves only after a full fence and a compare-and-swap, history, first absence, re-entry and idempotent replay are untouched, and no storage format changed.
- Fence cadence: one `segmentFence(windowSize)` before each window counts the window's writes, so a full fence still runs after at most 8 writes or 20 s (Discovery lease 90 s). The fence now also precedes the window's reads, which is stricter than before.
- Telemetry meaning: `readMs` and `putMs` of `seal_stage_archive` are now the summed time of the overlapping operations (identical to wall time only when nothing overlaps), so they can exceed `elapsedMs`; compare wall time through `elapsedMs`.
- Expected effect (a model, not a measurement): put and read wall time of the archive falls towards one third (86.3 + 18.9 s towards about 35 s), bounded by R2 per-request latency; fences (39.4 s) are not reduced.

## Telemetry added (no behaviour change)

- `seal_ledger` phase logs now carry `statements` and `bytes` per step beside `batches` and `writeMs`, so the per-statement and per-byte cost of a D1 round trip can be computed from the next natural run.
- `metadataSync` logs one `metadata_sync_breakdown` line (`films`, `loadMs`, `fetchMs`, `localizeMs`, `canonicalMs`, `saveMs`; milliseconds only, no Film id), splitting the 118 s `metadataSync` of 18 November.

## Deliberately left unchanged

- **`seal_ledger`**: 176 batches, about 107 s writeMs, about 0.6 s per batch. `src/discovery-authority.js` already packs rows (multi-row upserts, shows 16 rows per insert, deletes per 80 keys) and carries fence values between batches. The remaining knobs (`STATEMENT_CAP` 40, step budget `SEAL_REQUEST_BUDGET_MS` 32 s) change D1 or Workflow limits and need the per-statement figures above first. Batches cannot be parallelised: each moves the cursor by compare-and-set. No change without that evidence; AIR-423 is not repeated.
- **`beginSync` / `metadataSync` / `epgSync` preprocessing**: no operation was proven redundant, and skipping metadata or Film facts is out of scope. Only the breakdown was added.
- **`seal_stage_plan` (63.7 s)**: its read/parse/merge/classify split is not yet measured; no change.
- Which operations must run in every EPG remains the owner's architecture question; the sequence and semantics are unchanged.

## Acceptance still open

Before/after on a comparable workload (20-24k active, about 3.5k departures, about 64 segments) needs the natural run after deploy; then compare `seal_stage_archive` `putMs`, `readMs`, `elapsedMs` with 16-18 November. This change alone does not meet the 15-minute full-publication target, which is shared with AIR-532.

**Documentation impact:** this file, its row in [evidence registry](../README.md), and [orchestration reliability](../../reference/orchestration-reliability.md) (new log fields). No topology, authority or storage format changed, so no architecture diagram or ADR.
