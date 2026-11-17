# ADR 0162: Controlled Discovery Workflow rollover onto the deployed Worker version

**Status:** Proposed  
**Original decision date:** 2026-11-17  
**Recorded at:** 2026-11-17  
**Approval source:** owner decision recorded on [AIR-524](https://trello.com/c/G32xYzLC) (17 Nov 2026): build a standard, owner-only controlled rollover; the earlier "do not build a mechanism" recommendation is withdrawn  
**Related work:** [AIR-524](https://trello.com/c/G32xYzLC); context [AIR-523](https://trello.com/c/M4oYCT1B), [PR #724](https://github.com/vladimino/iptv-watchlist/pull/724), [PR #727](https://github.com/vladimino/iptv-watchlist/pull/727)  
**Supersedes:** None  
**Superseded by:** None

## Context

A Discovery Workflow instance keeps running the Worker version it was created on. A deploy therefore reaches Discovery only when the running instance hands over by itself: at 20 chunks or at the 6,000-statement invocation budget ([ADR 0094](0094-discovery-workflow-invocation-budget.md)), through `rolloverDiscoveryWorkflow`, which only the owning instance calls. After the AIR-523 fixes were deployed, the running instance kept the old code until that natural handover. `ensureDiscoveryWorkflow` and `reconcileDiscoveryWorkflow` never move an active instance to a new version.

Ownership lives in exactly one place: the executor record (`discovery_workflow` in D1 while the Discovery marker is `d1`/`open`), written only by compare-and-swap on its revision. Every loop of an instance starts with the owner gate (`instanceId` and `series` must match the record); every record write of an instance is `settleWorkflowIfOwner` (refused once another instance is named); Discovery data writes are fenced by the Discovery lease and the continuation compare-and-swap ([ADR 0083](0083-inert-discovery-workflow.md), [ADR 0093](0093-discovery-workflow-cron-reconcile.md)). A platform `terminate`/`restart` or a second `create` beside a live owner bypasses that record and can leave two writers or keep the old version.

## Decision

Add one owner-only, explicitly invoked operator: the MCP tool `discovery_workflow_rollover` on `/mcp` (Cloudflare Access Managed OAuth plus the Worker's signed JWT checks). It hands the executor record to the deterministic successor (`series + 1`, `discovery_<generation>_<series>`) of the **same** published generation, using the record's own compare-and-swap.

1. **Preflight (`mode: dry_run`) writes nothing.** It reads the published EPG generation, Discovery authority and its published-generation pin, the executor record (owner instance, series, phase, durable sleep, recorded Worker version), the platform status of the owner instance, the deployed version (`CF_VERSION_METADATA`), the continuation (stage, hop, budget, revision; `replayAfter` from the status), the lease, the projector window and the EPG-priority pause (`readDiscoveryGates`, read only). It answers `eligible`, `already_current`, `unsafe` (with `blockers`) or `unknown` (with `unknowns`) and the `expect` pins.
2. **Admission is a provably sleeping owner.** `eligible` requires: open authority with the pin equal to the published generation; record phase `waiting` whose durable sleep ends more than 120 s from now; the platform reports the owner `running` or `waiting`; no live lease; a continuation of the same generation that is not `running` (its checkpoint is saved); no active projector window; no EPG-priority pause; no exhausted recovery; and the owner did not record the deployed version (`already_current` is answered only for a `waiting`, `running` or `starting` owner). Any unreadable fact is `unknown`. Only `eligible` admits an apply.
3. **Apply (`mode: apply`)** requires `confirmGo: true`, a `requestId` and the exact `expectedProgrammeRunId`, `expectedInstanceId` and `expectedSeries` of a preflight. It re-runs the preflight, refuses if the reads took long enough to leave less than half the wake margin, then performs **one** compare-and-swap of the executor record against the revision the decision was made on: the successor is named with phase `starting`, the period report and outbox are carried, and a `rollover` receipt (request id, from/to instance and series, deployed version, continuation revision and hop) is stored. The window and EPG-priority guards of the record write refuse inside their own statement. Then it creates the successor and settles the record to `running` only while it is still `starting` for that id.
4. **The old instance cannot write after the swap.** It is asleep at the swap (no lease, no step in flight). When it wakes, its owner gate finds another instance and it stops; `settleWorkflowIfOwner` refuses it; its natural rollover attaches to the named successor instead of creating one.
5. **Recovery is the existing one.** A create that fails or cannot be confirmed settles the record `uncertain` with the start recovery due time; the hourly reconcile recreates the same deterministic id. A crash between the swap and the create leaves `starting`: the reconcile, or a repeat of the same request, creates that id. A duplicate id is the same successor (attach). There is never a second successor id.
6. **Idempotent and fail-closed.** A repeat with the same `requestId` never swaps again: it resumes a `starting` create (only while that generation is still the published one; otherwise `replay_stale` and the reconcile decides) or reads back (`superseded` when a later natural successor already replaced it). A stale pin, a reused request id with other pins, any `unsafe`/`unknown` decision, a lost swap or a refused swap answers a refusal with zero writes.
7. **Readback, not HTTP, is acceptance.** `accepted` requires that the record names the successor and only it, the platform reports it alive, and the continuation of the same generation is still present (its revision never decreases, so this mainly proves the record and generation). The successor records its own `versionId` as its first step; `versionConfirmed` (outcome `handed_over`) needs that, otherwise `handed_over_version_pending` until the preflight reads `already_current`.
8. **Version metadata.** The Worker gets a `version_metadata` binding `CF_VERSION_METADATA`. Every instance writes the version it runs on into the executor record: in a first step with a fixed name outside the numbered step sequence (so no later step name moves), and in every waiting, busy and progress checkpoint, and a newly created instance starts with `versionId: null` and the creator's `createdVersionId`.

Not decided here: no automatic rollover on deploy, no cron, schedule, feature flag, Scheduled Task, storage migration or general orchestrator; no termination of the old platform instance (it ends itself on its next wake); no change to the natural handover, the recovery budget or the reconcile. A merge or deploy is not a production GO: the first live `apply` needs a separate owner approval with the exact target and preconditions.

## Alternatives considered

- **Wait for the natural handover** (the status before this decision): no new code, but a deploy reaches Discovery only after 20 chunks or the invocation budget. The owner rejected it on AIR-524.
- **Platform `terminate`/`restart` of the old instance, or a second `create`**: rejected on AIR-524; it bypasses the executor record, can leave two writers, and a restart does not change the version.
- **Automatic rollover on every deploy or from the cron reconcile**: rejected by the card's scope (an explicitly invoked operator, not a reaction to every deploy); it would add a writer path to the hourly tick.
- **Admit a running owner (fence by the lease alone)**: rejected. The owner gate and the chunk start are separate reads; a running owner could take one more chunk under the lease after the swap, which the lease and the continuation CAS make safe for the data but which the period report would not count. Requiring a durable sleep removes that window.

## Consequences

- A deploy can reach Discovery within minutes of an owner GO instead of waiting for the natural handover, without a second writer.
- The operator is refused while the owner runs chunks back to back; the operator waits for a durable sleep (the preflight shows `waitingUntil`).
- One more MCP write tool and one more instance step (the version record). The version binding adds no data and no cost.
- The receipt is carried by later successors, so a retried request is recognised after another handover.
- A generation published between the swap and the successor's first step makes the successor stop with `stale_generation`, as for any instance; the reconcile then starts the new generation.

## Recovery and migration boundary

No schema change, no data migration, no new D1 table, no R2 key. Reverting the code removes the tool and the version step; executor records that carry `versionId`, `createdVersionId` or `rollover` stay readable by the older code, which ignores those fields. A swap already applied in production is not undone by a code revert; the successor simply continues. Each production `apply` needs its own owner approval.

## Evidence

- **Original decision:** [AIR-524](https://trello.com/c/G32xYzLC)
- **Implementation:** `src/discovery-workflow.js` (`discoveryRolloverFacts`, `discoveryRolloverDecision`, `discoveryWorkflowRollover`, `handleDiscoveryRolloverTool`, the instance version step), `src/discovery-authority.js` (`readDiscoveryGates`), `src/mcp.js`, `wrangler.jsonc`; tests `tests/discovery-workflow-rollover.mjs`, `tests/epg-priority-gate.mjs`, `tests/mcp.mjs`
- **Dated verification:** [offline test evidence, 17 Nov 2026](../evidence/discovery/discovery-workflow-rollover-tests-2026-11-17.md)
- **Uncertainty:** no live apply has run. That Cloudflare runs a new instance on the version deployed at its creation, and that `CF_VERSION_METADATA` inside a Workflow step reports the instance's own version, are platform behaviours the readback checks on the first live run rather than assumes.

## Follow-ups

The first production apply under a separate owner GO, with its own evidence.
