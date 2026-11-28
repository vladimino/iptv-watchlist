# ADR 0225: The one-off repair of 16 stale Film localization rows keeps its recovery checkpoint in the existing private R2 bucket

**Status:** Accepted
**Original decision date:** 2026-11-27 (storage direction, option A)
**Final decision date:** 2026-11-28 (option A)
**Recorded at:** 2026-11-28
**Approval source:** [Product Owner final decision, 2026-11-28](https://github.com/vladimino/iptv-watchlist/pull/1058#issuecomment-7231682588): «Утверждаю ADR 0225. Переводи в Accepted и доводи до деплоя. Production GO отдельно.» Option A (existing private R2) is accepted; the dormant implementation may be delivered. Production apply, restore and cleanup require separate authorization.
**Related work:** [AIR-664](https://trello.com/c/Og9XxXfy), [AIR-663](https://trello.com/c/UP10l6Js) (reconciler), [AIR-683](https://trello.com/c/VJYgJuOW) ([cohort evidence](../evidence/film-person/air-683-localization-cohort-diagnosis-2026-11-26.md)); [Coordinator review](https://trello.com/c/Og9XxXfy#comment-6b0a07131f26129b79a9b89f)
**Supersedes:** None. Applies [ADR 0218](0218-film-lifecycle-dimensions-revision.md) decision 3 stage 4 (unchanged).
**Superseded by:** None

## Context

The AIR-663 reconciler fixes a stale effective Film `localization` row by writing the output of the existing resolver. Its contract requires a durable per-Film **intent** (the full pre-image, post-image, digest, planned and post revision) to be recorded **before** the write, because a receipt stores no payload and a dry-run report is not a pre-image. The read-only AIR-683 census (27 November 2026) measured 16 stale Films of 13,867 and no held, absent or unavailable Film. The owner approved a one-off, narrow operation for exactly those 16 candidates, with revalidation immediately before the write, instead of a general mass-reconciliation mechanism.

Confirmed facts: no route, MCP tool, Workflow or script reached the reconciler's mutation entries; the module had no durable checkpoint implementation; canonical D1 holds Film/Person authority. The existing private R2 bucket already hosts immutable and conditionally created operational objects (`onlyIf: {etagDoesNotMatch: '*'}` in Discovery, Letterboxd sync and the published EPG).

## Decision

1. **Option A: the checkpoint lives in the existing private R2 bucket**, under the isolated prefix `film-localization-repair/air-664/`. An intent is an immutable object created with a conditional put (`etagDoesNotMatch: '*'`) **before** its D1 write. Outcomes are immutable, sequence-numbered event objects (one key per sequence), created the same way; an intent object is never rewritten. After a precondition failure, a timeout or an error the object is read back and compared **in full**: equal is an idempotent success, different is `checkpoint_conflict`, unreadable or absent counts as not recorded and nothing is written. A truncated listing fails closed.
2. **R2 holds recovery artifacts only.** Canonical D1 remains the Film/Person authority; the artifacts never become a source of Film values. R2 and D1 are not atomic: the gap is closed by the existing receipt, `recoverLocalizationReconcile` and the exact-revision restore, not by a new mechanism.
3. **One owner-only MCP entry, `film_localization_repair`,** with a **fixed 16-id cohort constant** and a fixed run id. A `preflight` reads the server clock once (`planAt`), derives every intent at that time and returns it among the pins; `apply` must present it and re-derives at exactly that time, so the digest is reproducible and **no revision timestamp is backdated** (a plan time earlier than any cohort revision is refused; a Film revised after the preflight changes its planned revision and so the digest). Modes: `preflight` and `recover` read only; `apply` and `restore` need `confirmGo`. The operation uses the delivered exact-intent path (`readReconcileIntent`, `resumeLocalizationReconcile`, `recoverLocalizationReconcile`, `restoreLocalizationReconcile`) and never the replanning `applyLocalizationReconcile` pass. **Every approved pin** (Film/Person generation, schema contract version, owner-review generation **and writes**, plus the plan time and the digest) is compared at the approval and before every Film and **asserted inside the same fenced batch as the receipt reservation and as the domain write** (`approvedPins` of the existing fenced path: fixed statements over validated values, never caller SQL); a moved pin refuses the reservation and the domain batch, so no D1 reservation or write lands under an unapproved pin. A recorded R2 intent is a harmless recovery artifact, not an effect, and the failure bookkeeping of an already reserved receipt (marking it failed) stays on the plain marker gate: it records a refusal and creates no effect. **Real runtime budget:** D1 allows 1,000 queries per Worker invocation on Paid, a batch counting once ([AIR-683 evidence](../evidence/film-person/air-683-localization-cohort-diagnosis-2026-11-26.md)). Every call runs behind the existing counting meter (`countedEnv`) with that limit enforced locally, reuses the writer gate through the existing operation-scoped `gateReuse`, checks the pins between Films in one query and proves each Film from one snapshot. Measured on the synthetic fixtures the straightforward all-16 `apply`, closing acceptance proofs included, costs about 750 executions (the first, unoptimized path measured 1,062). `apply` also stops BEFORE a Film whose measured write cost plus the closing proofs could pass the limit (`stopped: d1_query_budget`): not a quota, a continuation through a fresh preflight over the recorded intents, never a lost effect or a false completion.

**Acceptance is current and scoped to the 16 Films:** a Film counts as repaired only while its apply receipt is applied at the recorded post-revision, the stored row equals the post-image and the resolver reports it current; a later legitimate change is reported (`applied_moved`), never overwritten and never complete, and an R2 applied event without a D1 proof is `applied_unproved`. **A restored Film is a deliberate rollback** (`restored`, proved by its own receipt, the post-restore revision and the pre-image row): not eligible for automatic reapply, not a repair, and the cohort is never complete while one remains; a later change to it is `restored_moved`.

**Attribution and in-flight attempts:** only a commit this call ran is its write. An effect the receipt layer replayed (`alreadyApplied`), found committed by an earlier run, or proved after a lost reply (`recoveredUnattributed`: this or an overlapping call committed it) is reported as such and `writes` is then `null`. A receipt that is nonterminal and not yet due is an attempt that may still land (`in_flight`), never a definite no effect: no terminal-looking `not_applied` event is appended and no fresh intent is derived over it until the receipt is reconciled or terminal. The stored outcome history is validated against its intent (request id, digest, version, shape, transition table). **Restore** is approved against a fresh, intent-specific proof and pins returned by the read-only `recover` mode, asserts them at the restore receipt's reservation and in its batch, and is recovered by its **own** receipt: a lost reply or lost settlement is classified, never retried blind. `writes` is a number only when proved (`null` while an effect is unproved). Responses carry counts, ids, request ids, digests and pins, never an intent body, a value or an R2 key.
4. **Not decided and not introduced:** a D1 table or migration, a new bucket, a wave engine, queue, Workflow, scheduler, a general backfill, a public batch API, any deletion or TTL. Retention: the artifacts are kept until the cohort is accepted and the restore window is closed; cleanup is a separately approved action.

## Alternatives considered

- **B: a new D1 append-only table.** Recorded by the [Coordinator review](https://trello.com/c/Og9XxXfy#comment-6b0a07131f26129b79a9b89f) and rejected by the owner as disproportionate for one operation on 16 candidates: it needs a migration, a separate owner-gated apply, a schema contract change and a related rollout, and by itself it would not make record, write and settle atomic under the current contract.
- **The historical 25 November wave/transition draft** (R2 or D1, `plan_wave`, `apply_wave`): explicitly deferred by the owner; not part of this decision.

## Consequences

- No schema change and no new infrastructure; the operation is small and removable.
- The R2 conditional-create pattern and the receipt/recover guarantees carry correctness; a checkpoint refusal, a conflict or an unreadable object stops the pass before any write.
- Intent objects contain catalogue localization values: private bucket only, never GitHub, Trello or a response.
- A guard that fails in a batch rolls the batch back whole. The outcome is classified from durable evidence (receipt, revision, row), not from the error text: `not_applied` when no applied receipt exists and the Film is unchanged, `applied` when the receipt proves the effect after a lost reply. The schema contract only moves forward, so after such a move the owner approves anew from a fresh preflight at a later plan time. A continuation after a budget stop is the same: a fresh preflight and the owner's GO cover it (an applied Film is proved again, not trusted).
- The artifacts persist after the operation until a separate approved cleanup.

## Recovery and migration boundary

- Reversible per Film by `restore`, only while the Film is still at exactly the recorded post-revision with the row equal to the post-image; otherwise a separately approved forward correction. A restore does not remove a legacy source row the reconciler preserved.
- Code rollback does not revert D1 rows, receipts or R2 artifacts.
- This ADR and its code authorize **no production write**. `apply` and `restore` need a separate operation-specific owner GO on the preflight pins (L3 plan or an L2 contract); delivery, merge or deploy of this code grants none.

## Evidence

- **Original decision:** [owner decision](https://trello.com/c/Og9XxXfy#comment-6b0a0e03f249388ec3491999) and [Coordinator review](https://trello.com/c/Og9XxXfy#comment-6b0a07131f26129b79a9b89f).
- **Cohort:** [AIR-683 evidence](../evidence/film-person/air-683-localization-cohort-diagnosis-2026-11-26.md).
- **Implementation:** `src/film-localization-repair.js`, the optional `approvedPins` of `resumeLocalizationReconcile`, `tests/film-localization-repair.mjs` (real SQLite fixtures plus an in-memory R2 bucket); [delivery PR #1058](https://github.com/vladimino/iptv-watchlist/pull/1058).
- **Dated verification:** offline fixtures only; no production operation has run.
- **Uncertainty:** real R2 conditional-put behaviour under timeout is covered by the fixture's readback rule, not by a production observation; the live cohort may have changed since the census, which the preflight re-derives.

## Follow-ups

- [AIR-664](https://trello.com/c/Og9XxXfy): operation-specific owner GO, apply, scoped readback and sanitized evidence.
- Cleanup of the recovery artifacts after acceptance: a separate approval.
