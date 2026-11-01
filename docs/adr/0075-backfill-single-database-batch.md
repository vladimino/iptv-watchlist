# ADR 0075: The backfill writes one D1 batch and does not open a second database

**Status:** Proposed  
**Original decision date:** not yet accepted  
**Recorded at:** 2026-11-01  
**Approval source:** pending owner decision  
**Related work:** [AIR-316](https://trello.com/c/xgeFeYIT); historical measurements [scratch G4, 26 October 2026](../evidence/d1-migration/air-174-scratch-g4-2026-10-26.md) and [scratch G4 at the real scale, 27 October 2026](../evidence/d1-migration/air-178-scratch-g4-real-scale-2026-10-27.md)  
**Supersedes:** In part [ADR-0019](0019-live-d1-backfill-boundaries.md) decision 7, the requirement that batch atomicity be demonstrated on a scratch database before the first production write; and in part [ADR-0021](0021-staged-atomic-generation-import.md), the live obligation to repeat that demonstration, or the G4 harness, on a second database before a later backfill run. The staged generation design itself stays. The dated measurements stay evidence of those runs.  
**Superseded by:** None

## Context

ADR-0019 required the backfill executor to prove, on a scratch database, that a multi-statement request is atomic, using a deliberately failing last statement, before the first write to `iptv`. ADR-0021 bound the staged generation chunks to the size that probe had shown and required a scratch G4 run before the generation unit could be trusted. Those runs were completed and recorded. The owner then deleted the scratch database `iptv-atomicity-scratch` on 31 October 2026 and instructed that it not be restored.

The metadata-cache operator already writes one HTTP `batch` to `iptv` and does not open a second database. D1 documents that a batch runs as one transaction and rolls back when a statement fails. The backfill executor still refused to start unless a second database id was configured, and it created a probe table there on every run. A one-shot harness, `scripts/d1-scratch-g4.mjs`, still existed only to talk to that database. Nothing else calls it. The staged-generation failure, takeover, resume, fence and rollback behaviour is already covered by `tests/generation-stage.mjs` on local SQLite.

## Decision

1. **One database.** `scripts/d1-backfill.mjs` names its target with `D1_BACKFILL_ACCOUNT_ID`, `D1_BACKFILL_API_TOKEN`, `D1_BACKFILL_DATABASE_ID` and `D1_BACKFILL_DATABASE_NAME` (default `iptv`). It does not read `D1_BACKFILL_SCRATCH_DATABASE_ID`. A value left in the environment is ignored. It does not create a database, and it does not create a probe table on the target.
2. **A unit is one batch.** Each write unit is one `POST` whose body is `{batch:[{sql}, …]}`. D1 runs that batch as one transaction and rolls it back when a statement fails. The client does not send transaction-control statements. The caps stay 1,000 statements, 1 MiB and 100 KB per statement. A larger unit is `batch_too_large` and is not split across requests.
3. **An unproven write is not repeated.** A lost response, HTTP `429` or `5xx` on a write, or a success body that does not report every statement, is `write_uncertain`. That request is not sent again. The next run reconciles by reading the target back. Only reads are retried, and only within the existing bound.
4. **The live scratch harness is retired.** `scripts/d1-scratch-g4.mjs` is not a current command. Its scenario remains a local regression of the staged path, not a Cloudflare database. The dated scratch results stay historical evidence. They are not a precondition of the next backfill. The deleted database is not recreated.
5. **Code rollback does not recreate that database.** A revert to an executor that again requires a second database id will refuse to start. Do not create a database to satisfy the old check. Undoing a bad import is the target bookmark procedure, which does not need a second database.
6. **Nothing here is a production write.** Accepting this record does not authorize a backfill, a migration, an import, a flag change, a Task change or any write to D1 or R2. The metadata-cache operator's own batch, compare-and-swap and `writeState` rules are unchanged.

Not decided here: raising the batch caps, applying migration `0006`, or switching metadata-cache authority.

## Alternatives considered

- **Keep requiring the scratch database.** Rejected. The owner deleted it and said it was unnecessary. A procedure that cannot start without it is not operable.
- **Prove atomicity by creating a probe table on production `iptv`.** Rejected. A test table does not belong on the target, and a failed probe would be a write to the database the fence is meant to protect.
- **Point the G4 harness at `iptv`.** Rejected. That would write synthetic generations into the production database.
- **Leave the harness in the tree but unwired.** Rejected. An executable that still demands the deleted database is a live instruction to recreate it.

## Consequences

- A backfill run no longer depends on a second Cloudflare database or on a per-run probe.
- Atomicity of a batch rests on D1's documented batch transaction, checked by the local fake that rolls a failing last statement back. It is not re-measured against Cloudflare on every run.
- `report.json` carries `probe: null`. There is no `batch_not_atomic` or `scratch_identity_mismatch` stop.
- The historical G4 timings remain the measurements of those synthetic runs. They are not a new GO for a later production generation.
- Reverting this code without restoring an executor that can run against one database leaves the operator unable to start, and creating a database is not the fix.

## Recovery and migration boundary

No database is created, dropped or written by this decision. A bad import is still recovered from the target bookmark recorded before the write, under its own owner approval. A code revert does not restore rows and does not restore the deleted database. Do not create a replacement scratch database as part of rollback.

## Evidence

- **Original decision:** pending owner acceptance of this record
- **Implementation:** this pull request
- **Dated verification:** the scratch runs linked above remain the record of those past executions; this change adds no new production measurement
- **Uncertainty:** this repository does not re-measure Cloudflare's batch rollback at 1,000 statements on every run. The local fake models that rollback. A future Cloudflare change to batch behaviour would not be caught by a per-run probe, because that probe required a database the owner removed.

## Follow-ups

Owner acceptance or decline of this record before merge. No production backfill is queued by that acceptance.
