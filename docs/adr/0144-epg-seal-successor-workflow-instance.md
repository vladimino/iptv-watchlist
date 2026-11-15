# ADR 0144: EPG seal execution in a successor Workflow instance after durable epg_commit

**Status:** **Accepted as DESIGN** (2026-11-14, owner decision; scoped implementation via [AIR-484](https://trello.com/c/CDvqIdUn); no production operation authorized)
**Original decision date:** 2026-11-14
**Recorded at:** 2026-11-14
**Approval source:** Owner decision of 14 November 2026 (Europe/Madrid) on [PR #631](https://github.com/vladimino/iptv-watchlist/pull/631), [comment](https://github.com/vladimino/iptv-watchlist/pull/631#issuecomment-6883961904): the earlier two-part proposal is narrowed to this execution boundary only, accepted as design, with a separate implementation PR. The decision authorizes scoped implementation through AIR-484. It does **not** authorize a manual Workflow run, production sync, Discovery or TMDB, changes to Tasks, flags or Access, migrations, or R2 or D1 interventions.
**Related work:** [AIR-460](https://trello.com/c/ZXySuCJk) (source RCA); [AIR-484](https://trello.com/c/CDvqIdUn) (implementation); [AIR-485](https://trello.com/c/qulgP9a8) (staged payload optimization, not decided here); [AIR-420](https://trello.com/c/J0dit94i); [ADR 0092](0092-resumable-bounded-ledger-seal.md); [ADR 0096](0096-bounded-seal-publication-steps.md); [ADR 0100](0100-epg-cloudflare-workflow-executor.md); [ADR 0140](0140-producer-workflow-adaptive-successor-chain.md)
**Supersedes:** None. It qualifies [ADR 0100](0100-epg-cloudflare-workflow-executor.md) decision 1 (one Workflow instance per run key and series) only for the seal stage: the hand-off is a series bump that records no failure. It changes nothing in ADR 0092 or 0096.
**Superseded by:** None

## Context

Two natural EPG runs lost two Workflow attempts each to `Worker exceeded memory limit` (13 and 14 November 2026), in `seal_ledger` and in `seal_publish`. Recovery worked each time, but publication slipped (13 Nov: 17:44:34 Madrid for a 17:00 due time). Evidence: [AIR-462 natural-run correlation](../evidence/orchestration/air-462-epg-oom-natural-run-2026-11-14.md) (last confirmed phase per killed attempt, not the failing allocation), [seal memory RCA](../evidence/epg-seal-memory-rca-air-460-2026-11-13.md), [stream measurements](../evidence/orchestration/air-460-seal-stream-workerd-2026-11-14.md) and [parser churn](../evidence/orchestration/air-460-parser-churn-2026-11-14.md): each failing step is far below 128 MiB in isolation.

At `main`, one Workflow instance (`epg_<YYYYMMDD>_<series>`) runs `epg_commit` (scan, archive, emit in `stageSealedGeneration`) and then every seal step as consecutive `step.do` actions. The staged publication is the single R2 object `epg/seal/<runId>/payload.json`.

**Unproven.** What is resident in the isolate at the kill. Whether Workflow steps of one instance share an isolate or heap is not documented to the level this decision needs. Whether a new instance gives a fresh isolate is **not known and not assumed**.

## Decision

1. **Boundary.** After `stageSealedGeneration` has durably stored every staged object and `sync.json` names `stage: seal` with `seal.phase: ledger` (the durable checkpoint), the producing instance ends normally. The seal runs in a **successor instance** of the same Workflow class. Staged storage is unchanged: the current `epg/seal/<runId>/payload.json` and every reader of it stay as they are.
2. **Identity: the successor is the next series of the existing scheme.** A Workflow instance id is unique for its retention period, terminal instances included, so `create({id})` on an existing id answers `already_exists` and can never re-run anything ([Workflows rules](https://developers.cloudflare.com/workflows/build/rules-of-workflows/), [triggering](https://developers.cloudflare.com/workflows/build/trigger-workflows/)). The successor has its own deterministic id `epg_<YYYYMMDD>_<series+1>` (the id family of ADR 0100), where `<YYYYMMDD>` is the `runKey` of the control record that owns the seal. A terminal id is never resurrected.
3. **Claim before `create()`.** After the checkpoint, the producing instance ends with a `control` compare-and-set that records `handoff: {sealRunId, fromSeries, toSeries, at}`, `series: toSeries`, the successor `instanceId` and `phase: starting`, under the epoch and mode revision of admission. No failure is recorded and no budget is spent: a normal hand-off is progress. Only then is `create()` called. The successor admits itself against that record and the mode revision, takes the existing durable step lease, and stops with `not_owner` if the claim names another id. The producing instance takes no more step leases once the claim is written. The pointer-switch epoch fence and the generation fence are unchanged.
4. **Recovery by observed state, bounded.** The hourly `EpgOrchestration.ensure` reads `control` and `sync.json`. For a claim whose `sealRunId` is still `stage: seal` it reads the successor status and acts:
   - **absent, or the `create()` outcome unknown:** read the status again, then idempotent `create()` of the same id or attach (`already_exists` is an attach, as today). Bounded by the existing budget: `create_uncertain`.
   - **alive** (`queued`, `running`, `waiting`, `paused`): attach and wait; nothing is created.
   - **terminal, `errored` or `terminated`:** record `instance_errored` or `instance_terminated` against the existing budget and cooldown, then a compare-and-set to a **new recovery series** (`series + 1`, a new id). The new instance resumes the seal from the durable ledger, `seal.units` and the step lease; units are idempotent. `restart()` of the dead instance is not used. Repeated failure ends in the existing quarantine.
   - **`complete` while `sync.json` still says `stage: seal`:** fail closed with `evidence_contradictory` and alert; nothing is re-created and no step runs until reconciled by an owner-approved action.
   No new Cron Trigger, Task or feature flag.
5. **Day-roll.** A run's age is not an invariant: `drive()` adopts and finishes a sealed `sync.json` run of another Madrid day (`foreign_run_sealed`, ADR 0092 resume) while `ensure` computes the due key for today. The owner of an unfinished seal is the control record holding its claim, keyed by that run's own `runKey`, which may be yesterday's. Two rules follow:
   - `ensure` checks the claim **before** it computes today's start: while a claim's `sealRunId` is still `stage: seal`, today's run is not started and today's compare-and-set does not replace the claim; the answer is a wait (`seal_pending`) and decision 4 applies to the claim's key.
   - The executor's `act()` today returns `day_rolled` unconditionally when `dayOf(now) !== runKey`, before `drive()` can resume a seal. The implementation must change that guard explicitly: an admitted successor whose control record carries `handoff.sealRunId` equal to the `sealRunId` of the unfinished `sync.json` seal may pass it, and only then. Any other instance with a rolled day still stops. The completion of such a seal publishes the claim's own day and never marks today's run complete (the `foreign_run_sealed` rule). The test runs the successor's actual `act()` after midnight, not only `ensure` retaining the claim.
6. **Mixed versions and rollback.** Code from before this decision does not recognize `handoff`: `readControl()` accepts extra fields under `schemaVersion: 1` and `admit()` checks only id, series and `runKey`, so older code may admit a claimed successor and execute the seal while ignoring the claim. Therefore no backward-compatible fence is assumed. The rule is a **drain holdpoint**: a deploy of the implementation, and any rollback of it, happens only while no claim is unfinished (no control record with `handoff.sealRunId` whose `sync.json` run is still `stage: seal`, read from state) and no successor instance is alive. A seal started without a claim is finished by the existing path unchanged. The implementation may instead ship a control schema version that older readers refuse, but that is a separate, earlier release and is not assumed here. A mixed-version restart is tested with the actual pre-change executor.
7. **Not claimed.** A new instance does not guarantee a new V8 isolate or a lower peak. The boundary is justified as a smaller, separately observable and separately retried unit; it is kept only if natural EPG runs show the effect and is reverted otherwise.

### Invariants kept (ADR 0092, 0096, 0100)

The D1 ledger and catalog are complete **before** the atomic published pointer. The pointer moves exactly once per run. Generation, lease and compare-and-set fences are unchanged. Publish, finalize and queue stay idempotent units. There is one EPG generation. The Producer Workflow of ADR 0140 starts after the publication and is not merged with this boundary; the two chains use different control records and id families.

### Not decided

The staged payload format. Splitting, selective reads, reuse of D1 staging, a manifest, retention and garbage collection of staged objects belong exclusively to [AIR-485](https://trello.com/c/qulgP9a8) and are neither approved nor implied by this ADR. Also not decided: a numeric budget for the successor, whether the successor may itself chain further, and any activation step beyond the scoped implementation.

## Alternatives considered

- **Reduce churn only** (done in [PR #630](https://github.com/vladimino/iptv-watchlist/pull/630)): removes measured garbage and CPU; did not establish the carried-over mechanism.
- **Drop the unused catalog from the parsed payload** (done in [PR #595](https://github.com/vladimino/iptv-watchlist/pull/595)): lowers post-GC retained memory by 12.6 MB offline; the 14 Nov OOMs followed it.
- **Change the staged payload** (split objects, selective reads, D1 staging): deferred to AIR-485 for measured comparison.
- **Re-`create` the same id, or `restart()` the dead instance:** rejected; a terminal id cannot be created again, and `restart()` was not evaluated with this claim protocol.
- **A second Worker or a Durable Object for the seal:** a new trust and deployment boundary; not documented as evaluated.
- **Raising limits or lease duration:** masks the failure; excluded by the card.

## Consequences

One more control-record claim and one more branch in the hourly `ensure` (a pending claim takes priority over today's start); more Workflow instances per day; a clean per-instance boundary for the AIR-462 markers and `epg_act` traces. Risk: the hypothesis behind the boundary may be wrong, in which case the cost is more moving parts with no memory benefit and the remedy is a revert.

**Scope-specific tests for the implementation:** crash at every hand-off point (before the claim, between claim and `create()`, after `create()`); duplicate and uncertain `create()`; every status case of decision 4, including terminal and unexpectedly complete; replay after kill with no duplicate publish or event; a foreign-day sealed run across midnight with today's `ensure` running; a mixed-version restart with the actual pre-change executor (claim present or absent) and the drain holdpoint of decision 6; the normal hand-off consuming no failure budget; quarantine after repeated terminal failure.

## Recovery and migration boundary

Code is reversible by revert. A revert does **not** remove the control claim, a running successor or the published generation, and is safe only under the drain holdpoint of decision 6. No migration is required: the claim is a field of the existing `control` document. Runs in flight across a midnight follow decision 5; deploy and rollback follow the drain holdpoint of decision 6. This ADR authorizes no manual Workflow run, flag, Task, schedule, Access change, migration or data write.

## Evidence

- **Original decision:** [owner decision on PR #631](https://github.com/vladimino/iptv-watchlist/pull/631#issuecomment-6883961904), 14 November 2026.
- **Implementation:** none yet; tracked in [AIR-484](https://trello.com/c/CDvqIdUn).
- **Dated verification:** [AIR-462 natural run](../evidence/orchestration/air-462-epg-oom-natural-run-2026-11-14.md), [stream measurements](../evidence/orchestration/air-460-seal-stream-workerd-2026-11-14.md), [parser churn](../evidence/orchestration/air-460-parser-churn-2026-11-14.md).
- **Uncertainty:** isolate reuse across steps and instances; peak heap in production; the effect of the boundary on `exceededMemory`; Workflow create and wake behaviour under the claim protocol.

## Follow-ups

Implementation in AIR-484 with its own independent review and a natural-run acceptance in `Verifikatsiya`. Payload optimization in [AIR-485](https://trello.com/c/qulgP9a8). Related: [ADR 0141 proposal](https://github.com/vladimino/iptv-watchlist/pull/618) for the Producer chain protocol.
