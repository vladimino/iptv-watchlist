# EPG checkpoint in D1: states, checks and recovery (dormant)

Status: **dormant.** [ADR 0185](../adr/0185-epg-checkpoint-d1-authority.md) (Accepted) puts the EPG run checkpoint `sync.json` and the ingest status `watchlist-ingest.json` behind `epg_checkpoint_authority`. The migration file and the code are in the repository; nothing here applies the schema, imports an object or switches the marker. Every operation that changes the state of production (apply `0030`, hold, import, activation, rollback export, retirement of the R2 arm) is a separate owner-approved step with its own plan; no tool for them exists yet. This page is what an operator needs to read the state and to recover **without** making anything worse. The schema is in the [D1 schema reference](../reference/data/d1-schema.md#epg-checkpoint-authority-schema-v30-dormant-not-applied), the write contract in the [orchestration reference](../reference/orchestration-reliability.md).

## What the Worker does in each state

| State | How it is seen | Behavior |
| --- | --- | --- |
| Tables absent, `schema_contract` below 30 | no `epg_checkpoint_%` table | The R2 objects serve, exactly as before the migration. |
| Marker `r2`, writes `open` | `SELECT mode, generation, writes FROM epg_checkpoint_authority` | The R2 objects serve. |
| Marker `r2`, writes `held` | same | Reads serve R2; every write of either key is refused (`epg_checkpoint_writes_held`). This is the import fence. |
| Marker `d1`, writes `open` | same | The rows are the only authority; R2 is neither read nor written for these keys. |
| Anything else | version 30 without the tables, a deleted or unknown marker, **a missing fence row** (`SELECT COUNT(*) FROM epg_checkpoint_cas`), an unreadable schema, no binding | **Closed**: the key is refused (`epg_checkpoint_unavailable`), never read from R2. Only the local stand-in `EPG_CHECKPOINT_DB_OPTIONAL` serves R2, and only for a database that has no checkpoint table at all. |

## Read-only checks (L0, `SELECT` only)

```sql
SELECT mode, generation, writes, (SELECT COUNT(*) FROM epg_checkpoint_cas) AS fence_rows FROM epg_checkpoint_authority;
SELECT run_id, stage, seal_phase, queue_attempted, completed_at, has_error, revision, watchlist_present, film_count FROM epg_checkpoint_run;
SELECT COUNT(*) AS rows_of_current_run FROM epg_checkpoint_film WHERE run_id = (SELECT run_id FROM epg_checkpoint_run);
SELECT COUNT(*) AS orphan_rows FROM epg_checkpoint_film WHERE run_id NOT IN (SELECT run_id FROM epg_checkpoint_run);
SELECT last_success_at, failed_at, code, consecutive_failures FROM epg_ingest_status;
SELECT write_id, revision, applied_at FROM epg_checkpoint_receipt ORDER BY revision DESC LIMIT 16;
```

Orphan rows belong to an interrupted run creation. They are harmless to every reader and are removed by the next creation. A complete run must show `watchlist_present = 0` and no row of its own.

## Failure codes and what to do

| Code | Meaning | Action |
| --- | --- | --- |
| `epg_checkpoint_conflict` | A fence refused the write: the authority generation moved, the step lease was lost or expired, the mode revision moved, or the run revision is not the one read. Nothing was written. | The step stops (class `epoch_mismatch`). The next action re-reads the run. Do not reset a lease or restart a Workflow to make it pass. |
| `epg_checkpoint_unavailable` | The marker, the schema or D1 could not be read, or a batch failed for a storage reason. | Transient storage failure (class `d1_unavailable`) or a closed state; read the marker. Never fall back to the R2 object. |
| `epg_checkpoint_malformed` | A stored run failed its own check: a missing, extra, duplicated or reordered film row, a digest, count or chunk mismatch, a typed column that contradicts the body, a complete run whose body `completedAt` differs from the typed completion time. | Unsafe evidence (class `checkpoint_malformed`, a domain quarantine for the owner). Do not edit rows. The cause is a writer that bypassed the repository or a restore; recovery is an owner-approved correction. |
| `epg_checkpoint_indeterminate` | A write whose outcome cannot be told from its receipt: the run revision advanced beyond the retained receipts, or the receipt revisions have a gap. | Unsafe evidence (class `evidence_unreadable`). The batch is **never** replayed. The next action derives what remains from the durable state (the seal units are idempotent); an owner clears the quarantine as for other unsafe evidence. |
| `epg_checkpoint_unfenced` | A write had no step lease. | A programming error or a path outside a step; nothing was written. |
| `epg_checkpoint_complete_route`, `_completion_time`, `_unbased`, `_identity`, `_shape`, `_budget` | A caller tried to complete a run through the generic save, saved an object that was never loaded, changed the run identity or the watchlist membership, or exceeded a size cap. | Nothing was written. A defect in the caller, not a data problem. |

An unknown outcome is classified from the write receipt: a receipt for the write's id means applied; no receipt with the revision unchanged, or advanced by at most 16 with consecutive receipts, means not applied; anything else is indeterminate. A single read of the latest run row never proves that a write did not happen.

## Recovery boundaries

- **Code rollback reverts no row, marker or schedule.** After an activation, a Worker version that does not know the tables would read the frozen R2 objects; going back to such a version is allowed only after the data rollback below.
- **Data rollback** (planned by the ADR, to be written into the cutover plan and approved by the owner before any use): hold writes, export the current run and the ingest status to the R2 objects with a conditional write against the frozen object's ETag, read back byte and digest parity, set the marker to `r2` with the next generation, release. There is no silent lease reset or force release on any path.
- **Completion and certificate.** In `d1` mode a run reaches `complete` only through one batch that also certifies it and clears the EPG-priority pause; a certificate that did not match leaves the run complete and `certificate: owed`, repaired by the hourly `certifyComplete` (see the [monitoring runbook](monitoring.md) for the debt). The old order (complete in R2, then certificate) applies only while the marker is `r2`.
