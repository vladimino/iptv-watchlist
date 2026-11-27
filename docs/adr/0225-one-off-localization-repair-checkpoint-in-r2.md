# ADR 0225: The one-off repair of 16 stale Film localization rows keeps its recovery checkpoint in the existing private R2 bucket

**Status:** Proposed
**Original decision date:** 2026-11-27 (storage direction, option A)
**Recorded at:** 2026-11-27
**Approval source:** [Product Owner Concept Review decision, 2026-11-27](https://trello.com/c/Og9XxXfy#comment-6b0a0e03f249388ec3491999): «Утверждаю вариант A: существующий R2 для AIR-664». This approves the storage direction only. The final ADR disposition (`Accepted` or `Rejected`) is still owed under the [ADR merge gate](../process/agent-workflow.md#adr-merge-gate); until it is recorded here and in the registry this record is `Proposed` and the PR that carries it must not merge.
**Related work:** [AIR-664](https://trello.com/c/Og9XxXfy), [AIR-663](https://trello.com/c/UP10l6Js) (reconciler), [AIR-683](https://trello.com/c/VJYgJuOW) ([cohort evidence](../evidence/film-person/air-683-localization-cohort-diagnosis-2026-11-26.md)); [Coordinator review](https://trello.com/c/Og9XxXfy#comment-6b0a07131f26129b79a9b89f)
**Supersedes:** None. Applies [ADR 0218](0218-film-lifecycle-dimensions-revision.md) decision 3 stage 4 (unchanged).
**Superseded by:** None

## Context

The AIR-663 reconciler fixes a stale effective Film `localization` row by writing the output of the existing resolver. Its contract requires a durable per-Film **intent** (the full pre-image, post-image, digest, planned and post revision) to be recorded **before** the write, because a receipt stores no payload and a dry-run report is not a pre-image. The read-only AIR-683 census (27 November 2026) measured 16 stale Films of 13,867 and no held, absent or unavailable Film. The owner approved a one-off, narrow operation for exactly those 16 candidates, with revalidation immediately before the write, instead of a general mass-reconciliation mechanism.

Confirmed facts: no route, MCP tool, Workflow or script reached the reconciler's mutation entries; the module had no durable checkpoint implementation; canonical D1 holds Film/Person authority. The existing private R2 bucket already hosts immutable and conditionally created operational objects (`onlyIf: {etagDoesNotMatch: '*'}` in Discovery, Letterboxd sync and the published EPG).

## Decision

1. **Option A: the checkpoint lives in the existing private R2 bucket**, under the isolated prefix `film-localization-repair/air-664/`. An intent is an immutable object created with a conditional put (`etagDoesNotMatch: '*'`) **before** its D1 write. Outcomes are immutable, sequence-numbered event objects (one key per sequence), created the same way; an intent object is never rewritten. After a precondition failure, a timeout or an error the object is read back and compared **in full**: equal is an idempotent success, different is `checkpoint_conflict`, unreadable or absent counts as not recorded and nothing is written. A truncated listing fails closed.
2. **R2 holds recovery artifacts only.** Canonical D1 remains the Film/Person authority; the artifacts never become a source of Film values. R2 and D1 are not atomic: the gap is closed by the existing receipt, `recoverLocalizationReconcile` and the exact-revision restore, not by a new mechanism.
3. **One owner-only MCP entry, `film_localization_repair`,** with a **fixed 16-id cohort constant**, fixed run id and fixed write time (so a preflight digest is reproducible). Modes: `preflight` and `recover` read only; `apply` and `restore` need `confirmGo`. The operation uses the delivered exact-intent path (`readReconcileIntent`, `resumeLocalizationReconcile`, `recoverLocalizationReconcile`, `restoreLocalizationReconcile`) and never the replanning `applyLocalizationReconcile` pass. The approved Film/Person and owner-review generations are verified before the first write, before every Film and **inside every fenced batch** (extra guards); a mismatch writes nothing. Responses carry counts, ids, request ids, digests and pins, never an intent body, a value or an R2 key.
4. **Not decided and not introduced:** a D1 table or migration, a new bucket, a wave engine, queue, Workflow, scheduler, a general backfill, a public batch API, any deletion or TTL. Retention: the artifacts are kept until the cohort is accepted and the restore window is closed; cleanup is a separately approved action.

## Alternatives considered

- **B: a new D1 append-only table.** Recorded by the [Coordinator review](https://trello.com/c/Og9XxXfy#comment-6b0a07131f26129b79a9b89f) and rejected by the owner as disproportionate for one operation on 16 candidates: it needs a migration, a separate owner-gated apply, a schema contract change and a related rollout, and by itself it would not make record, write and settle atomic under the current contract.
- **The historical 25 November wave/transition draft** (R2 or D1, `plan_wave`, `apply_wave`): explicitly deferred by the owner; not part of this decision.

## Consequences

- No schema change and no new infrastructure; the operation is small and removable.
- The R2 conditional-create pattern and the receipt/recover guarantees carry correctness; a checkpoint refusal, a conflict or an unreadable object stops the pass before any write.
- Intent objects contain catalogue localization values: private bucket only, never GitHub, Trello or a response.
- A guard that fails inside a batch rolls the batch back whole; the outcome is classified `unknown`, and `recover` then reports `not_applied` (no applied receipt, Film still at the planned revision), so the same recorded intent can resume under fresh pins.
- The artifacts persist after the operation until a separate approved cleanup.

## Recovery and migration boundary

- Reversible per Film by `restore`, only while the Film is still at exactly the recorded post-revision with the row equal to the post-image; otherwise a separately approved forward correction. A restore does not remove a legacy source row the reconciler preserved.
- Code rollback does not revert D1 rows, receipts or R2 artifacts.
- This ADR and its code authorize **no production write**. `apply` and `restore` need a separate operation-specific owner GO on the preflight pins (L3 plan or an L2 contract); delivery, merge or deploy of this code grants none.

## Evidence

- **Original decision:** [owner decision](https://trello.com/c/Og9XxXfy#comment-6b0a0e03f249388ec3491999) and [Coordinator review](https://trello.com/c/Og9XxXfy#comment-6b0a07131f26129b79a9b89f).
- **Cohort:** [AIR-683 evidence](../evidence/film-person/air-683-localization-cohort-diagnosis-2026-11-26.md).
- **Implementation:** `src/film-localization-repair.js`, the optional `extraGuards` of `resumeLocalizationReconcile`, `tests/film-localization-repair.mjs` (real SQLite fixtures plus an in-memory R2 bucket); delivery PR to be linked at merge.
- **Dated verification:** offline fixtures only; no production operation has run.
- **Uncertainty:** real R2 conditional-put behaviour under timeout is covered by the fixture's readback rule, not by a production observation; the live cohort may have changed since the census, which the preflight re-derives.

## Follow-ups

- [AIR-664](https://trello.com/c/Og9XxXfy): operation-specific owner GO, apply, scoped readback and sanitized evidence.
- Cleanup of the recovery artifacts after acceptance: a separate approval.
