# EPG checkpoint in D1: states, checks and recovery (dormant)

Status: **dormant.** [ADR 0185](../adr/0185-epg-checkpoint-d1-authority.md) (Accepted) puts the EPG run checkpoint `sync.json` and the ingest status `watchlist-ingest.json` behind `epg_checkpoint_authority`. The migration file and the code are in the repository; nothing here applies the schema, imports an object or switches the marker. Every operation that changes the state of production (apply `0030`, hold, import, activation, rollback export, retirement of the R2 arm) is a separate owner-approved step with its own plan. The [operator script](#operator-script) implements each one as a named command; having the script is not an approval to run it. This page is what an operator needs to read the state and to recover **without** making anything worse. The schema is in the [D1 schema reference](../reference/data/d1-schema.md#epg-checkpoint-authority-schema-v30-dormant-not-applied), the write contract in the [orchestration reference](../reference/orchestration-reliability.md).

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

## Operator script

`scripts/epg-checkpoint-production.mjs` is the only supported tool for the state changes below. It is read-only (`status`) unless a command flag, `--target iptv` and `--confirm <the command name>` are all given. It needs the D1 operator credentials of the other production scripts and, for R2, the read-only snapshot credentials (and the install credentials for `export-rollback` only). It prints sizes, ETags and SHA-256 digests, never a payload, and it **never retries**: after an unknown outcome it reads the marker (or the R2 objects) and reports. It never deletes a D1 row, never touches the lease or control documents, never starts or restarts a Workflow and never starts an EPG run.

| Command | Marker transition | Refuses unless |
| --- | --- | --- |
| `--apply` | none (schema 29 to 30, marker `r2/open/0`) | schema is exactly 29, tables absent, the same-day drain proof below |
| `--hold` | `r2/open/G` to `r2/held/G+1` | expected generation and the same-day drain proof below; the control, lease and certificate records it was read from are re-asserted inside the marker batch, so a record that moved after the read aborts it |
| `--release-abort` | `r2/held/G` to `r2/open/G` | the checkpoint tables hold no rows |
| `--import` | none | `r2/held/G`, empty tables, **both** R2 identities (ETag, SHA-256 of `sync.json` and of `watchlist-ingest.json`) equal to the ones passed in (a key that disappeared refuses), a complete run without watchlist |
| `--activate` | `r2/held/G` to `d1/held/G+1` | import parity read back against the R2 objects (every typed column, the body, the receipt, the ingest row) |
| `--release` | `d1/held/G` to `d1/open/G` | both frozen R2 images still have the identities passed in, the D1 rows still equal them (typed columns, body, receipt, ingest) and the run loads |
| `--hold-rollback` | `d1/open/G` to `d1/held/G+1` | the same-day drain proof on the D1 run (idle `complete` boundary with a matching certificate), re-asserted inside the batch; never mid-run |
| `--export-rollback` | none | `d1/held/G`; each R2 object is written with a conditional PUT on its frozen ETag, then read back; an object already equal is skipped; any other ETag is a foreign writer and stops |
| `--revert-authority` | `d1/held/G` to `r2/held/G+1` | both R2 objects read back byte-equal to the documents derived from the D1 rows; the D1 rows stay as inactive recovery evidence |
| `--release-rolled-back` | `r2/held/G` to `r2/open/G` | both R2 objects read fresh, equal to the identities passed in **and** to the export image reconstructed from the retained D1 rows (the caller's fingerprints are not the proof; a foreign change after the revert refuses) |

**Same-day drain proof.** It needs the Madrid day of the run and of the control record to be the current Madrid day, one run id in the checkpoint run, the control record, the published programme and its certificate, a released or expired lease, `phase=done`, a clear Discovery pause, no event debt (the pending marks, an unfinished Ratings hand-over, or a fixed watchlist event whose journal object is missing in R2; a retained `events` array alone is not debt) and a valid completion receipt (a retained `error` from an earlier attempt of the same run is history), and a next start at least 30 minutes away. The tool cannot read the Workflow with its credentials, so the operator passes `--workflow-instance-id`, `--workflow-liveness finished` and `--deployed-version-id`, read through a documented read-only path (`epg_status` owner and liveness, the deployed version id). The instance id must equal the control record's, the liveness must be `finished`, and the deployed version must equal the version the instance ran. Without that evidence the proof fails; it is never inferred from `phase=done`.

An unknown outcome of an export write is reported with an immediate read of both objects and the marker (classified `observed`, or `unclassified` when the objects cannot be read); the next export call reads both objects again before any write and resumes only the missing object, or stops on a foreign ETag. A readback that cannot be read after the writes is `readback_unreadable`, never success.

Each transition is one batch: a guard that aborts the batch when the full expected state does not hold, the update, and a fence on the number of changed rows. After a hold, wait longer than the two-second marker cache before capturing the R2 identity. A mid-run incident has no command here; see the plan evidence for the accepted limitation.
