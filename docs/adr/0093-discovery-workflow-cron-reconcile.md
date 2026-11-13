# ADR 0093: The existing Worker cron may reconcile an inert Discovery Workflow

**Status:** Accepted  
**Original decision date:** 2026-11-05  
**Recorded at:** 2026-11-05  
**Approval source:** explicit owner acceptance in AIR-324 PR #380 conversation on 2026-11-06, after independent review and Mermaid visual acceptance. This approves architecture, not production activation.  
**Related work:** [AIR-324](https://trello.com/c/kNtaEbm8); [ADR 0083](0083-inert-discovery-workflow.md); [ADR 0085](0085-d1-authoritative-discovery.md); [ADR 0089](0089-shared-orchestration-reliability-contract.md)  
**Supersedes:** [ADR 0083](0083-inert-discovery-workflow.md) decisions 7 and 8 in part (the reconciler is no longer unscheduled; the cron may call it)  
**Superseded by:** None

## Context

[ADR 0083](0083-inert-discovery-workflow.md) delivered `ensureDiscoveryWorkflow` and `reconcileDiscoveryWorkflow` and forbade calling them from cron, from a request, or from a Workflow `schedules` entry. The EPG commit already notes the Workflow after it queues intent. A lost wakeup, an uncertain `create()`, or a crash between the queued intent and `create()` then waited for a reconciler that nothing invoked. [AIR-324](https://trello.com/c/kNtaEbm8) is the offline wiring for self-start and durable recover after the accepted D1 discovery cutover. Production `DISCOVERY_EXECUTOR=workflow`, a Task prompt edit and a Workflow schedule remain unauthorized.

[ADR 0089](0089-shared-orchestration-reliability-contract.md) already chose the existing hourly cron as the shared `ensure` clock and forbade adding `workflows[].schedules` because a schedule creates instances on deploy. Ratings already calls `RatingsOrchestration.ensure` from that same firing ([ADR 0090](0090-ratings-cloudflare-workflow-executor.md)).

## Decision

1. **Same cron, no new trigger.** The existing `37 * * * *` Worker cron continues to run the D1 enrichment projector and the ratings `ensure`. It now also calls `reconcileDiscoveryWorkflow`. That call reads a few records and creates at most one Workflow instance. It does not run a discovery chunk, call TMDB, or change the projector or ratings `ensure` semantics. No `workflows[].schedules` entry is added.

2. **Inert unless the flag is exactly `workflow`.** Absent, empty or `external` `DISCOVERY_EXECUTOR` returns immediately without `create()`. `invalid` creates nothing. A deploy does not set the variable (`keep_vars: true`). Code rollback with the variable absent returns to the external ChatGPT path; Workflow instances and D1/R2 objects already written are not deleted.

3. **Published generation is the source of intent.** After a confirmed published `programmeRunId`, `ensure` and `reconcile` compare the discovery continuation with that pointer. When the continuation is missing, names another generation, or is a same-generation `programme_changed` artefact, and the published generation has no true terminal `stop`, they reconstruct the intent with the existing `queueDiscovery` compare-and-swap (`epg_committed`) and require a read-back that names the published run. The EPG commit's own queue write stays a fast path and is not in one transaction with the pointer switch. Admission always reads `DiscoveryAuthority` and `PublishedEpg.currentGeneration()`. It requires `ready === true` (`mode` `d1`, `cutover` `open`), transfer `idle` or `committed`, a non-null current D1 EPG pointer, and a Discovery `published_programme_run_id` that equals that pointer. The admitted `programmeRunId` is that verified published run only. A missing module, a held or `loading` marker, a `closed()` readout (missing DB or schema below v11), an `r2` marker, or an unreadable D1 authority writes nothing (`authority_not_ready`, `authority_held`, `authority_loading`, `d1_unavailable`). A missing EPG pointer is `generation_unpublished`. A null or mismatched Discovery published pin, including an A→B EPG pointer while Discovery still names A, is `generation_handoff` and does not reconstruct intent. There is no fallback to `programme_run_id`, an old marker, or an R2 generation object.

4. **Single writer stays the ADR 0083 fence.** While the mode is `workflow`, `epg_sync_step` on a completed run and `POST /api/enrichment/discovery/resolve` do not call `advanceDiscovery`. They answer `delegated` / `wait` (or the stored `stop`). Old Scheduled Task prompts cannot drive a chunk. The Workflow still runs one chunk per durable step, renews a spent series without the hour wait, rolls over at 20 chunks, and keeps the existing recovery backoff and quarantine.

5. **Prompt drafts are documentation only.** The Daily EPG and Hourly Stage B texts in `docs/reference/scheduled-task-prompts/` are drafts for a later owner-approved registry edit. This record does not change a live Scheduled Task.

Not decided: setting production `DISCOVERY_EXECUTOR=workflow`, enabling a Workflow schedule, editing or enabling ChatGPT Tasks, a manual discovery or EPG run, or the later removal of the flag ([AIR-325](https://trello.com/c/Q416Mx7v)). The full ADR 0089 three-step mode document (`switching` / epoch) is not introduced for Discovery; the existing `DISCOVERY_EXECUTOR` token remains the switch.

## Alternatives considered

- **`workflows[].schedules`:** rejected again; Cloudflare creates an instance on each schedule match, including deploy.
- **A second cron expression:** rejected; one firing already exists and Ratings already uses it.
- **Leaving the reconciler unscheduled until a later card:** rejected by the AIR-324 owner GO for offline wiring. Without a caller, lost wakeups stay stuck.

## Consequences

Cron CPU grows by a bounded read-and-maybe-create path that is a no-op in production while the flag is absent. When the owner later sets `workflow`, a missed EPG queue write is repaired on the next cron tick or the next `ensure`. External rollback uses the D1-authoritative ledger; it does not reopen an R2 decision writer.

## Recovery and migration boundary

Reversible: code. Not reverted by code rollback: a Workflow instance, the executor record, a reconstructed continuation, D1 decisions. Setting or clearing `DISCOVERY_EXECUTOR`, editing Tasks, and any production discovery write each need a separate owner approval. This ADR authorizes none of those.

## Evidence

- **Original decision:** [AIR-324](https://trello.com/c/kNtaEbm8)
- **Implementation:** the AIR-324 pull request
- **Dated verification:** [offline evidence 2026-11-05](../evidence/orchestration/discovery-workflow-handover-air-324-2026-11-05.md); no production read or write
- **Uncertainty:** live Workflow wakeup timing, cron delivery delay and isolate CPU of a production reconcile are unobserved until an authorized activation

## Follow-ups

Production activation and prompt cutover remain gated on [AIR-324](https://trello.com/c/kNtaEbm8). Flag removal is [AIR-325](https://trello.com/c/Q416Mx7v). Accepted [ADR 0135](0135-epg-priority-discovery-pause.md) adds a refusal: while the EPG-priority pause is open, reconcile does not create an instance. That record is Accepted, not implemented and not activated, and changes no runtime behaviour.
