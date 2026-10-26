# D1 backfill execution and recovery (owner approval required)

`scripts/d1-backfill.mjs` imports one verified production baseline into the D1 database `iptv` without changing the runtime: R2 stays authoritative, the Worker has no D1 binding and keeps serving from R2. The decisions are [ADR-0019](../adr/0019-live-d1-backfill-boundaries.md); the contract (source and target identity, receipts, stop rules) is the [D1 contract](../reference/data/d1-schema.md#backfill-executor). This page is the procedure. None of its production steps is authorised by a merge, a deploy or this page: creating the database, applying the schema, reading production R2, creating credentials, running the import and any destructive recovery each need their own action-specific owner approval.

## Inputs and what each run checks

| Input | Where it comes from | Checked by the executor |
| --- | --- | --- |
| Snapshot directory | [read-only exporter](r2-snapshot-export.md), status `consistent_fenced` | every object re-hashed; status, fence and source identity re-read; NO-GO otherwise |
| Target database | `D1_BACKFILL_ACCOUNT_ID`, `D1_BACKFILL_DATABASE_ID`, `D1_BACKFILL_DATABASE_NAME` (default `iptv`) | uuid and name from the D1 API, frozen schema v1 tables, database identity receipts |
| Scratch database | `D1_BACKFILL_SCRATCH_DATABASE_ID`, never the target | atomicity probe at the configured batch size before every run |
| Credential | `D1_BACKFILL_API_TOKEN` in the environment only, scoped to D1 edit on the two databases | never written to a report, ledger or the repository |
| Acknowledged class C list | owner-reviewed JSON file, `--acknowledged` | only class C records; class A is never acknowledgeable |
| Batch limits | `D1_BACKFILL_MAX_BATCH_STATEMENTS` (default 1,000), `D1_BACKFILL_MAX_BATCH_BYTES` (default 1 MiB) | proven by the probe; larger units stop with `batch_too_large` |

Outputs go to an absolute directory outside the repository: `report.json` (status, stop reasons, probe, identity findings, counts, parity, receipt audit, classes A/B/C, adapter statistics) and `ledger.json` (every ledger row and the class C list with source key, checksum and reason). Exit code 0 is `completed`; 3 is `partial`, `stopped` or `no_go`; 2 is usage or configuration; 1 is an error.

## D1 HTTP API requirements

- `GET /accounts/{account}/d1/database/{uuid}` returns the database `uuid` and `name`; the fence compares both.
- `POST /accounts/{account}/d1/database/{uuid}/query` with a body `{sql}` executes the statements of one unit. Statements carry their values as SQL literals. The executor never sends `BEGIN`/`COMMIT`, which D1 rejects; whether a multi-statement request is all-or-nothing is exactly what the probe measures on the scratch database. The executor is correct only for a service that passes the probe at the configured size.
- Reads are single `SELECT` statements; their `results` rows are used as returned.
- Writes are not retried on a lost response (`write_uncertain`); the next run reconciles by reading back.

## Sizes, memory and duration

- Units are small except one: a film, person, fingerprint, prediction version or rating unit is tens of statements; the programme generation unit writes every film membership, show and candidate of the published generation in one statement list. At production scale (about 22,000 candidates in the latest generation, see the readiness report) that is far above the default limits. Unless the probe proves an atomic batch large enough on real D1, the run stops at that unit with `batch_too_large` and a separate staged design (for example staging tables swapped by one small statement) is needed before the production run. This is an open item for G4, not a solved one.
- Requests are sequential. Each unit costs roughly one to three reads, one write and one receipt write. A baseline of about 100,000 units is therefore several hundred thousand requests; bound each run with `--limit` and resume, which costs nothing because receipts make completed units free.
- `prepareImport` holds the mapped snapshot objects in memory (the 19 October archive was about 100 MB in total); run on a machine with a few GB of free memory.

## Procedure

1. **Dry-run on SQLite (no production access beyond the approved snapshot).** `node scripts/d1-backfill.mjs --snapshot /abs/snapshot --output /abs/run-dry --target sqlite --database /abs/dry.sqlite` with a database created from `migrations/0001_schema_v1.sql`. Review `report.json`: class A blockers, the class C list, class B families with their dispositions, parity, receipts. Repeat the dry-run twice more: `applied` must be 0.
2. **Owner acknowledges the class C list** by producing the JSON file of `{sourceKey,targetTable,targetId,reason}` records from `ledger.json` after review. The acknowledgement records a known gap; it is not lossless parity.
3. **Create the databases** (owner, separate approval): `iptv` and a scratch database; apply the frozen schema to `iptv` only.
4. **Back up before the first write.** Record the D1 bookmark of the empty target (Time Travel) and an export of it in the evidence; the bookmark is the restore point.
5. **Run in bounded batches.** `node scripts/d1-backfill.mjs --snapshot /abs/snapshot --output /abs/run-N --target d1 --limit 5000 --acknowledged /abs/class-c.json`, repeated until `completed`. The first command of each run is the probe on the scratch database; a run that does not pass it never reads the target.
6. **Rerun twice on the same baseline.** Both runs must report `applied: 0` and the same parity.
7. **Delta.** Export a fresh baseline with its own consistency proof and run with `--delta`: changed objects are re-imported, old receipts are `superseded`, anything `stale` or `foreign` is a class A blocker, and keys missing from the new inventory are anomalies for the owner, never deletions in D1.

## GO/NO-GO for one run

| Outcome in `report.json` | Meaning | Next step |
| --- | --- | --- |
| `completed`, no class A blocker, parity ok, receipts clean | the run is complete for this baseline | rerun twice; then the acceptance report |
| `partial` | `--limit` reached | run again |
| `stopped: unexpected_conflict` / `class_a_blocker` | a row could not be written as the baseline says | stop the window; investigate the named unit; no manual row edit |
| `stopped: unacknowledged_record` | a class C record outside the acknowledged list | owner reviews and extends the list, or stops |
| `no_go: snapshot_not_consistent` / `snapshot_not_production` | the input is not an accepted baseline | export again |
| `no_go: batch_not_atomic` / `batch_too_large` | the service did not prove atomicity at this size, or a unit is larger | do not write; adjust limits only with a new probe, or design staging |
| `no_go: target_identity_mismatch` / `scratch_identity_mismatch` / `schema_missing` / `database_identity_conflict` | wrong database, or not the database this lineage wrote | stop; check the environment and the database |
| `no_go: baseline_changed` | the target already holds another baseline | run with `--delta` only if a delta is intended |
| `no_go: write_uncertain` | a write response was lost | rerun; the read-back reconciles |

## Recovery and rollback

The executor never deletes, drops or resets anything. Recovery is an owner action with a written decision recorded before it is taken:

1. Stop: no further runs against the target.
2. Restore the target to the bookmark recorded in step 4 (D1 Time Travel), or delete and re-create the database and re-apply the frozen schema. Both are destructive and need their own approval.
3. Verify the identity fence on the restored database: no database identity receipt from the abandoned run remains; a restored database that still carries another baseline's receipt is refused with `baseline_changed`.
4. Re-run from step 5. Because the Worker never reads D1, none of this touches production behaviour; R2 is unchanged throughout.

The local rehearsal of this sequence (backup copy, run, restore, identity fence, re-import) is part of `tests/d1-backfill.mjs`.

## Evidence template for the production execution

Record in a dated file under `docs/evidence/d1-migration/`:

- Approvals: snapshot read, credential, database creation and schema, each run window, any recovery (who, when, what).
- Baseline: manifest aggregate SHA-256, `finishedAt`, baseline identity, exporter status and fence result.
- Target: database uuid and name, schema migration applied, restore bookmark, scratch database uuid.
- Probe: statements and bytes probed, `atomic`, `rowsAfterFailure`.
- Runs: for each run, command (without secrets), status, applied, resumed, reconciled, pending, stop reason, adapter statistics.
- Result: parity (denominator, missing, extra, mismatched), receipts audit, class A blockers (must be empty), class B families with dispositions, class C list with the acknowledgement reference, two empty reruns, delta result.
- Statement that the Worker still has no D1 binding, Scheduled Tasks and flags are unchanged, and R2 remains authoritative.
