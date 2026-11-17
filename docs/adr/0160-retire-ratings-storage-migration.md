# ADR 0160: Retire the ratings storage migration tool and gate the pipeline on the stored schema

**Status:** Proposed  
**Original decision date:** 2026-11-17  
**Recorded at:** 2026-11-17  
**Approval source:** owner handoff on the AIR-79 card, slice D-3 (<https://trello.com/c/485tlGLA>)  
**Related work:** [AIR-79](https://trello.com/c/485tlGLA); [ADR 0090](0090-ratings-cloudflare-workflow-executor.md)  
**Supersedes:** None  
**Superseded by:** None

## Context

The ratings pipeline (Diary-first, removal-queue hand-over) was introduced behind a one-time storage migration. The owner-only MCP tool `ratings_storage_migrate` and `POST /api/letterboxd/ratings/migrate` converted the removal queue to schema version 2 and the Diary cursor to its merge form, and wrote a witness document `letterboxd/ratings/migration.json`. `migrationState()` returned `complete` only when both stored objects were in the new form, and every start, step and EPG hand-over was gated on it.

The live read-only `ratings_sync_status` of 17 Nov 2026 (13:44 UTC) reported the migration complete, the queue at schema version 2 with 0 legacy entries, and the orchestration mode `cloudflare`. Nothing in the Worker needs the conversion code any more, but the gate itself protects against something real: the version-aware queue writers must never write into a version 1 queue.

## Decision

1. Remove the MCP tool `ratings_storage_migrate`, the route `POST /api/letterboxd/ratings/migrate`, the conversion code (`migrate`, `migrateRemovalQueue`, `migrateCursor`) and the witness writes.
2. Replace the migration gate with a **storage schema guard**, `LetterboxdRatings.storageState`. The pipeline is supported only while the removal queue is at `schemaVersion` 2 and the Diary cursor is in merge form (`schemaVersion` 2 with a `writer`). This is the same condition as the former `migration === 'complete'`, so behaviour on the recorded production state is unchanged.
3. On any other stored state the guard fails closed: `start` and `step` answer `storage_unsupported`, the EPG commit enqueues nothing (`ratingsPipeline: 'blocked'`, with a `ratingsStorage` field) and keeps its removal references on the sync run, and `ratings_sync_status` reports `storage`. No code path converts, rewrites or falls back to R2 or to a version 1 form.
4. The historical witness document `letterboxd/ratings/migration.json` is left where it is. It is no longer read or written.

Not decided: any change to the stored data, flags, markers, Scheduled Tasks, bindings or the ratings executor mode.

## Alternatives considered

- **Remove the gate outright.** Rejected: the enqueue writers are version-aware but would write version 1 entries into a version 1 queue if one ever reappeared, for example after a D1 restore.
- **Keep the tool for a possible re-migration.** Rejected: a conversion tool that runs only on an owner request is unreachable code with a write path, and a restored pre-migration state needs an owner-approved operation anyway.

## Consequences

- Less code with a write path: the owner-only migration entry points and the witness writes are gone, and the status no longer reports `regressed`.
- The guard is read-only. It adds two reads (queue and cursor) where the old gate read the witness and both objects.
- A D1 restore to a point before the migration would leave the pipeline refused (`storage_unsupported`) until an owner-approved operation restores the new form. That is deliberate and fail-closed.
- `docs/reference/integrations/letterboxd-ratings.md` describes the guard.

## Recovery and migration boundary

Code rollback restores the removed tool but no stored data. Because the tool is gone, a state that fails the guard cannot be repaired from the Worker; it needs a separate owner-approved plan. This ADR authorizes no operation.

## Evidence

- **Original decision:** owner handoff on [AIR-79](https://trello.com/c/485tlGLA).
- **Implementation:** the pull request that adds this ADR.
- **Dated verification:** [AIR-79 ratings storage migration retirement](../evidence/d1-migration/air-79-ratings-storage-migration-retirement-2026-11-17.md).
- **Uncertainty:** the guard is proved by tests against the harness stores, not against production storage by this change.

## Follow-ups

Remaining AIR-79 slices (rollback toolchain, other retirements) are tracked on the card.
