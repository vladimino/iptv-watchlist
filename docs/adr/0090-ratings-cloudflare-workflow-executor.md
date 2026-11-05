# ADR 0090: The daily Ratings run may be executed by an inert Cloudflare Workflow with D1-document control and mode records

**Status:** Proposed  
**Original decision date:** 2026-11-05 (implementation choice inside the AIR-347 card)  
**Recorded at:** 2026-11-05  
**Approval source:** not documented (Proposed; the owner decides when reviewing the AIR-347 PR)  
**Related work:** [AIR-347](https://trello.com/c/j2Ua76yv); [ADR 0089](0089-shared-orchestration-reliability-contract.md); [ADR 0060](0060-independent-letterboxd-ratings-pipeline.md); [ADR 0084](0084-d1-authoritative-ratings.md)  
**Supersedes:** None  
**Superseded by:** None

## Context

[ADR 0089](0089-shared-orchestration-reliability-contract.md) fixed the contract (Madrid day key, failure classes, bounded retries, three-step mode switch with an epoch fence) and left each executor's mechanism to its delivery card. [AIR-347](https://trello.com/c/j2Ua76yv) asks for the Ratings executor, with Cron versus Workflow chosen inside the task. The Ratings run is one leased, checkpointed record; its removal phase takes an unbounded number of bounded steps (at most 5 lookups per step), so one cron invocation cannot finish it.

## Decision

1. **Workflow, not Cron-only.** A new Workflow binding `RATINGS_WORKFLOW` (`RatingsWorkflow`) runs the existing `LetterboxdRatings.start` and `step` in a loop of `step.do` actions separated by `step.sleepUntil`. The existing hourly cron only calls `RatingsOrchestration.ensure`, which creates at most one deterministic instance `ratings_<YYYYMMDD>_<series>` per Madrid date and 17:30 Europe/Madrid (DST by IANA zone). No new cron trigger is added.
2. **Inert by default.** `ensure` does nothing unless the owner-written mode document says `cloudflare`. An absent document means `external`, epoch 0. Deployment creates the Workflow resource but no instance, flag, Task change or run.
3. **Control and mode records are D1-owned ratings documents** (`letterboxd/ratings/executor.json`, `letterboxd/ratings/orchestration.json`), so no migration is needed. `executor.json` is written only by the owner-approved switch (`POST /api/letterboxd/ratings/executor`: `close_admission`, `complete`, `clear_quarantine`).
4. **Epoch fence.** Every executor commit into D1 runs in the same transactional batch as an assertion that the mode document's etag is unchanged (`ratingsFence`). A stale instance whose mode or epoch moved has its whole batch refused with its data. R2 event writes stay idempotent by event key (ADR 0089 decision 2a).
5. **External writer gate.** `LetterboxdRatings.handle` answers `start` and `step` with `switch_in_progress` or `external_writer_fenced` (`nextAction: stop`) while the mode is `switching` or `cloudflare`. Reads, status and `migrate` stay open.
6. **Read model.** `ratings_sync_status` gains the read-only `orchestration` object (mode, epoch, run key, health, failure, budget, cooldown, quarantine, `nextWakeAt`, `oldestPendingAt`).
7. **New failure codes** `d1_unavailable` and `step_failed` are transient and are added to the [reference table](../reference/orchestration-reliability.md). Durable progress is a checkpoint counter that advanced in the same run; starting or restarting a run is not progress.

Not decided: activation. The mode switch, any Workflow instance, disabling the external Ratings Task and the first production run each need a separate action-specific owner approval.

## Alternatives considered

- **Cron-only stepping:** rejected; an hourly cron cannot drive the unbounded removal phase to completion within the same date and cannot sleep for a 6-hour 429 pause.
- **New D1 tables for control state:** rejected for now; existing D1-owned documents with CAS avoid a migration and keep the fence in one batch.

## Consequences

One more Workflow resource is created on deploy. The cron handler now also calls an inert `ensure`. The external Ratings Task keeps working until the owner closes admission. Rolling back code does not revert D1 documents.

## Recovery and migration boundary

Reversible: code. Not reverted by code rollback: mode and control documents, epoch, an existing Workflow instance. The switch back uses the same three steps with a verified drain. This ADR authorizes no flag, Task, cron, Workflow instance, D1/R2 write or cutover.

## Evidence

- **Original decision:** [AIR-347](https://trello.com/c/j2Ua76yv)
- **Implementation:** the AIR-347 pull request
- **Dated verification:** [offline evidence 2026-11-05](../evidence/orchestration/ratings-executor-air-347-2026-11-05.md); no production observation
- **Uncertainty:** real Workflow instance behaviour, memory/CPU of a live step and Cloudflare's wakeup timing are unobserved until an authorized acceptance run.

## Follow-ups

Activation and production acceptance remain gated by separate owner approval on [AIR-347](https://trello.com/c/j2Ua76yv).
