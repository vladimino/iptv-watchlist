# ADR 0119: Durable canonical write receipts for cross-domain operations (schema 19)

**Status:** Accepted (implements the owner decision recorded in [ADR 0117](0117-film-person-d1-handoff-owner-decisions.md) decision 5; code introduced offline, schema NOT applied, no production operation authorized)  
**Original decision date:** 2026-11-11  
**Recorded at:** 2026-11-11  
**Approval source:** Owner approval comment of 11 Nov 2026, 12:03 Madrid, on the [AIR-374 card](https://trello.com/c/ha7ais3w) (owner decision 5); the independent Controller reviews of P2a and P2b made the receipt a binding prerequisite of P3 live producer wiring  
**Related work:** [AIR-374](https://trello.com/c/ha7ais3w), [ADR 0117](0117-film-person-d1-handoff-owner-decisions.md), [ADR 0099](0099-canonical-film-person-d1-authority.md), [schema reference](../reference/data/d1-schema.md#durable-canonical-write-receipt-schema-v19), [offline evidence](../evidence/d1-migration/air-374-p2c-canonical-write-receipts-offline-2026-11-11.md)  
**Supersedes:** None  
**Superseded by:** None

## Context

[ADR 0117](0117-film-person-d1-handoff-owner-decisions.md) owner decision 5 requires that operations from EPG, Discovery, metadata and ratings into canonical Film/Person have durable receipts stored in the existing D1 (no new event platform), stable idempotency and request ids, bounded safe retries and a separate reconciliation of pending and failed operations; a periodic reconcile is only a safety net, and the absence of a record without a receipt is never safe. The fenced writers of P2a and P2b are idempotent by content and by the entity revision CAS, but they keep no durable record of a request: after a lost answer, the only evidence that a write landed is its content, and a change nobody recorded cannot be told from a safe one. The Controller reviews of those PRs state that content replay is not a substitute and that the receipt requirement cannot be waived. Schema 18 has no such table (`film_localization_source` carries a `request_id` for one writer only).

## Decision

1. **A table, `canonical_write_receipt`, in the existing D1, schema 19** (`migrations/0019_canonical_write_receipt.sql`). One row per cross-domain canonical operation, keyed by the stable request id: operation kind, origin, target (kind, id), the SHA-256 digest of the planned content, the planned and applied entity revision, the marker generation at plan time, state (`pending`, `applied`, `failed`, `unknown`, `abandoned`), attempts, `next_attempt_at`, a short lowercase error class, and timestamps. **No payload, title, name, message or personal data is stored**; the CHECK constraints admit identifiers and digests only.
2. **The marker fence in SQL.** Triggers allow an insert or update only while the marker is `d1`/`open`, and an insert only under the live generation. At `r2`, `prepared` and `held` the table stays empty or frozen and a producer cannot write it; reads are always allowed. The state machine is in SQL too: `pending` to any state; `failed` to `pending`, `applied` or `abandoned`; `unknown` to `pending`, `applied`, `failed` or `abandoned`; `applied` and `abandoned` are terminal; identity columns (id, operation, origin, target, digest, creation time) never change; the attempt counter moves only with a new attempt; rows are never deleted.
3. **The protocol** (`src/canonical-receipts.js`, dormant, unbundled, nothing imports it; `src/canonical-mutations.js` is wrapped, not edited): record `pending` (attempt 1) in a batch carrying the same fence head as every canonical mutation; run the writer's own fenced commit; mark `applied`. A writer that appends `appliedStatements()` to its own batch makes `applied` atomic with the content; one that does not is marked by a second batch, and a crash between them leaves `pending`, which is safe. A definite rollback marks `failed`, a permanent refusal marks `abandoned`, any other outcome marks `unknown`; a `pending` receipt past its attempt window is treated as `unknown`.
4. **Reconciliation by readback, never by assumption.** A due non-terminal receipt is settled by reading the target and comparing its content digest with the planned one: equal means applied (only the receipt was lost; the writer does not run again), different or absent means the same request id is replayed. Retries are bounded: at most 5 attempts, a stored backoff of 1 min, 5 min, 30 min then 2 h, an attempt window of 2 min, and abandonment after 7 days; the bounds are read from stored fields (`attempts`, `next_attempt_at`, `created_at`) against a clock the caller passes in. There is **no timer, cron or Scheduled Task** here. `reconcilePlan` is pure; `reconcileReceipts` is the one bounded pass (at most 50 receipts, one target read each) that a later reconciler (P3) calls; this ADR schedules nothing.
5. **`unreceipted`.** A `canonical_revision` row whose current revision has no applied receipt with that applied revision is reported `unreceipted` (`no_receipt`, or `receipt_not_applied` when a non-terminal receipt exists) and `safe` is false. An absent receipt is never treated as safe. Writes outside the protocol (owner tools, the P5 loader) are reported the same way until they register their own operation kind.
6. **Registration points.** `OPERATION_KINDS` is the closed, code-reviewed set (the SQL accepts any lowercase identifier); `defineOperation` takes the adopter's `readback` and `replay`; `requestIdOf` derives the stable id from the origin, the operation and a digest of the source key. P2a and P2b writers, and the P3 producers, adopt it later; this change edits none of their files.
7. **No receipt table, no canonical write.** `receiptedWrite` refuses with `receipt_schema_missing` when schema 19 is absent, so a producer never writes canonical unreceipted.

## Alternatives considered

- **Content replay only** (the P2a/P2b state): rejected by owner decision 5 and the Controller reviews; it cannot prove an operation's outcome nor detect a change that nobody recorded.
- **A receipt per writer, like `request_id` on `film_localization_source`:** one table per writer and no shared reconciliation; rejected for the cross-domain case. That column stays as it is.
- **A new event store or queue:** excluded by owner decision 5 (no new event platform).
- **A scheduled reconciler:** excluded; no new cron or Scheduled Task without a separate GO. The pass is a function a later, separately authorized caller may run.

## Consequences

- One more table. A new cross-domain write costs two extra batches (the pending insert and the applied mark; the mark is skipped when the writer appends `appliedStatements()` to its own batch) and eight reads (one availability check, five marker reads, two receipt reads), pinned by the offline test; an already applied request id costs no batch. The table grows by one row per operation; **pruning terminal rows is not decided here** (rows are never deleted) and needs its own decision before volume matters.
- A receipt left `pending` while the marker is `held` is frozen, not guessed; it settles after `held` returns to `open`. The forward-fix drill for `held` to `open` ([ADR 0117](0117-film-person-d1-handoff-owner-decisions.md) decision 3) must include a reconcile pass.
- The in-flight window means a crashed attempt blocks its request id for at most two minutes.
- `scripts/film-person-capture.mjs` still expects schema 18; the apply GO for 0019 must update that expectation in the same change.

## Recovery and migration boundary

The migration is introduced in code only. **Applying it to production D1 is a separate owner GO with its own read-only preflight and readback** (`SELECT version FROM schema_contract` is 19, zero rows in `canonical_write_receipt`, the marker unchanged); nothing in the repository or a deploy applies it, and applying it writes no row. Until it is applied no producer may be wired (P3 is blocked on it). A code rollback does not remove the table; because the table only records, an empty or ignored table changes no canonical state. No flag, schedule, marker move or production access is part of this decision.

## Evidence

- **Original decision:** [AIR-374 owner comment of 11 Nov 2026](https://trello.com/c/ha7ais3w), recorded in [ADR 0117](0117-film-person-d1-handoff-owner-decisions.md).
- **Implementation:** PR for P2c (offline): `migrations/0019_canonical_write_receipt.sql`, `src/canonical-receipts.js`, `tests/canonical-receipts.mjs`, `tests/canonical-receipts-mutation.mjs`.
- **Dated verification:** [offline evidence](../evidence/d1-migration/air-374-p2c-canonical-write-receipts-offline-2026-11-11.md), sqlite stand-in only.
- **Uncertainty:** D1's multi-statement request is modelled by a transaction in the stand-in; its rollback, error text and latency are not measured. The retry bounds are proposals, not measured against production volumes.

## Follow-ups

- P3a to P3d: each producer adopts `receiptedWrite` or `appliedStatements` and registers its operation; the reconciler that calls `reconcileReceipts` and its trigger need a separate GO.
- A decision on pruning terminal receipts.
- The apply GO for schema 19 (preflight, readback, capture expectation).
