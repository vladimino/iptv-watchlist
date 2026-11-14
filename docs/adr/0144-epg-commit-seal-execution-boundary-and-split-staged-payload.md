# ADR 0144: The EPG seal runs in a successor Workflow instance after a durable commit checkpoint, over separately stored immutable staged payload objects

**Status:** Proposed
**Original decision date:** not decided (proposal; owner approval of the architecture is required before any code)
**Recorded at:** 2026-11-14
**Approval source:** direction of the owner on the [AIR-460 card](https://trello.com/c/ZXySuCJk), comment of 14 November 2026 (Europe/Madrid) "Poruchenie ispolnitelyu po itogam PR #626", item 2: write an ADR-only PR. That comment authorizes this document, **not** implementation, provisioning, activation or any production operation.
**Related work:** [AIR-460](https://trello.com/c/ZXySuCJk); [AIR-420](https://trello.com/c/J0dit94i); [AIR-462](https://trello.com/c/w73gROBl); [PR #595](https://github.com/vladimino/iptv-watchlist/pull/595), [PR #626](https://github.com/vladimino/iptv-watchlist/pull/626), [PR #630](https://github.com/vladimino/iptv-watchlist/pull/630); [ADR 0092](0092-resumable-bounded-ledger-seal.md); [ADR 0096](0096-bounded-seal-publication-steps.md); [ADR 0100](0100-epg-cloudflare-workflow-executor.md); [ADR 0140](0140-producer-workflow-adaptive-successor-chain.md)
**Supersedes:** None. It qualifies [ADR 0100](0100-epg-cloudflare-workflow-executor.md) decision 1 (one Workflow instance per run key and series) only for the seal stage (the hand-off is a series bump that records no failure), and changes nothing in ADR 0092 or 0096.
**Superseded by:** None

## Context

Two natural EPG runs lost two Workflow attempts each to `Worker exceeded memory limit` (13 and 14 November 2026): in `seal_ledger` and in `seal_publish`. Recovery worked each time, but the publication slipped (13 Nov: 17:44:34 Madrid for a 17:00 due time, about 9.6 minutes of it lease waiting). Evidence:

- [AIR-462 natural-run correlation](../evidence/orchestration/air-462-epg-oom-natural-run-2026-11-14.md): last confirmed phase per killed attempt (`seal_ledger_batches` at 21,434 items; `seal_publish_copy:enter`); not the allocation that failed.
- [Seal memory RCA](../evidence/epg-seal-memory-rca-air-460-2026-11-13.md), [stream measurements](../evidence/orchestration/air-460-seal-stream-workerd-2026-11-14.md), [parser churn](../evidence/orchestration/air-460-parser-churn-2026-11-14.md): each failing step is far below 128 MiB in isolation; the copy and the body stream are cheap; the ledger parser churned about 17.5 GiB of garbage (removed by PR #630, retained nothing); `sealPayload` parses a 14.9 MiB payload with a +58 MiB host-RSS rise.

Facts of the code at `main`: one Workflow instance (`epg_<YYYYMMDD>_<series>`) runs `epg_commit` (scan, archive, emit in `stageSealedGeneration`) and then every seal step (`ledger`, `catalog`, `publish`, `finalize`, `queue`) as consecutive `step.do` actions. The staged publication is one R2 object, `epg/seal/<runId>/payload.json`, holding report, catalog, watchlist, uncertain, fence and expected programme run; `sealPayload` parses all of it for the publish, finalize and queue steps, and `seal_catalog` parses it for the catalog.

**Unproven.** What is resident in the isolate when the kill happens. Whether Workflow steps of one instance share an isolate or its heap is not documented to the level this decision needs. Whether a new Workflow instance gives a fresh isolate is **not known and not assumed**.

## Decision

Proposed, in two parts that can be accepted or rejected separately. Nothing here selects a numeric limit or authorizes implementation.

### Part A. Execution boundary between `epg_commit` and the seal

1. After `stageSealedGeneration` has durably stored every staged object and `sync.json` names `stage: seal` with `seal.phase: ledger`, the producing instance ends normally. The seal runs in a **successor instance** of the same Workflow class.
2. **Identity: the successor is the next series of the existing scheme.** A Workflow instance id is unique for its retention period, terminal instances included, so `create({id})` on an existing id answers `already_exists` and can never re-run anything ([Workflows rules](https://developers.cloudflare.com/workflows/build/rules-of-workflows/), [triggering](https://developers.cloudflare.com/workflows/build/trigger-workflows/)). The successor therefore has its own deterministic id `epg_<YYYYMMDD>_<series+1>` (the id family of [ADR 0100](0100-epg-cloudflare-workflow-executor.md)), where `<YYYYMMDD>` is the `runKey` of the control record that owns the seal. That is the series bump the executor already performs; the new part is that the hand-off performs it **without** counting a failure.
3. **Claim before `create()`.** The producing instance ends with a `control` compare-and-set that records `handoff: {sealRunId, fromSeries, toSeries, at}`, `series: toSeries`, `instanceId` of the successor and `phase: starting`, the epoch and mode revision being those of admission. No failure is recorded and no budget is spent: a normal hand-off is progress, not an error. Only then is `create()` called. The successor admits itself against that record and the mode revision, takes the existing durable step lease, and stops with `not_owner` if the claim names another id. The producing instance takes no more step leases once the claim is written. The pointer-switch epoch fence and the generation fence are unchanged.
4. **Recovery is by observed state, bounded, and never a re-`create` of a terminal id.** The hourly `EpgOrchestration.ensure` already reads `control` and `sync.json`. For a claim whose `sealRunId` is still `stage: seal` in `sync.json` it reads the successor status and acts per case:
   - **absent or the `create()` outcome unknown:** read the status again, then `create()` the same id (idempotent) or attach; an `already_exists` answer is an attach, as today. Bounded by the existing budget: `create_uncertain`.
   - **alive** (`queued`, `running`, `waiting`, `paused`): attach and wait; nothing is created.
   - **terminal, `errored` or `terminated`:** record `instance_errored` or `instance_terminated` against the existing budget and cooldown, then a compare-and-set to a **new deterministic recovery series** (`series + 1`, a new id). The new instance resumes the seal from the durable ledger, `seal.units` and the step lease; the units are idempotent. `restart()` of the dead instance is not used by this design. Repeated failure ends in the existing quarantine.
   - **`complete` while `sync.json` still says `stage: seal`:** fail closed with `evidence_contradictory` and alert; nothing is re-created and no step runs until reconciled by an owner-approved action.
   No new Cron Trigger, Task or feature flag.
5. **Not claimed.** A new instance does not guarantee a new V8 isolate or a lower peak. The boundary is justified as a smaller, separately observable and separately retried unit: the memory carried from scan, archive and emit has no path into the seal unless the platform reuses the isolate. It is accepted only if natural runs show the effect; it is rejected otherwise and the cost is a revert.

### Part B. Split the staged payload

6. The single `payload.json` is replaced by immutable objects under `epg/seal/<runId>/`: `report.json`, `catalog.json`, `watchlist.json`, `uncertain.json` and a small `manifest.json` carrying the run id, the fence, `expectedProgrammeRunId` and, for each object, its byte length and SHA-256.
7. **Layout marker and commit boundary.** `manifest.json` is written last. Only after it is stored does the staging step save `sync.json` with `seal.layout: 'split'` in the same save that moves the run to `stage: seal`; that save is the commit point. The reader decides by `sync.json`, never by probing keys: `seal.layout` absent means a legacy run and `payload.json` is required (missing it fails closed); `'split'` means the manifest is required and a missing or mismatching manifest fails closed with `evidence_contradictory`, with **no fallback** to `payload.json`. Objects are write-once per run id; a replay of the staging step may rewrite identical bytes, and the manifest hashes detect any difference.
8. **Readers per phase and unit** (checked against `sealPublishStep`, `sealFinalizeStep` and `sealQueueStep` at `main`). `seal_catalog` reads only `catalog.json`. `publish` reads the manifest first (fence, `expectedProgrammeRunId`), then per unit: `pointer` reads `report.json` and `watchlist.json`; `mirrors` reads `report.json` and `watchlist.json`; `copy` reads no payload object; `intent` reads `watchlist.json` (the fallback `films`) and **`uncertain.json`**, which it writes to the stored `uncertain.json`. A publish step that loads only report and watchlist would silently drop the uncertain records, so the unit-to-object matrix is part of the contract and a unit loads exactly the objects it lists, lazily and only when that unit runs (a replayed step that skips finished units reads nothing for them). `finalize` and `queue` use only `report` and read the manifest and `report.json`; they do not read the watchlist or uncertain objects. Each read checks the manifest length and hash. Exactly-once intent and replay semantics of the units are unchanged.
9. **Legacy and day-roll compatibility.** A run's age is not an invariant: `drive()` adopts and finishes a sealed `sync.json` run of **another** Madrid day (`foreign_run_sealed`, [ADR 0092](0092-resumable-bounded-ledger-seal.md) resume) while `ensure` computes the due key for today. Therefore:
   - the owner of an unfinished seal is the control record that holds its claim, keyed by that run's own `runKey`, which may be yesterday's;
   - `ensure` checks the claim **before** it computes today's start: while a claim's `sealRunId` is still `stage: seal`, today's run is not started and today's CAS does not replace the claim; the answer is a wait (`seal_pending`) and the recovery of decision 4 applies to the claim's key;
   - a legacy run adopted across a deploy keeps its legacy reader; a run with a claim and `layout: 'split'` is finished only by code that reads the split layout. After a code rollback such a run is not finishable until the new code is back; the rollback note says so;
   - the legacy `payload.json` reader may be removed only when no unfinished run with `seal.layout` absent exists (read from `sync.json` and the control record, not inferred from elapsed days) and the split code has been deployed for at least one full natural run.
10. **Retention and orphan objects, an unresolved obligation.** Today the only deletion of the staged prefix is the `sealPayloadKey` delete in `sealQueueStep` after a successful completion; there is no cleanup of an abandoned or torn staging, and this ADR does **not** rely on one. Part B would add four objects and a manifest that the completion step must delete by the manifest's list. Garbage collection of objects of runs that never completed is **not decided and is not implemented by this ADR**; Part B must not be accepted for implementation without an owner-approved contract for it. Minimum properties that contract must have: a named writer fenced by the step lease; it deletes only keys under `epg/seal/<runId>/` where `runId` is neither `sync.json.runId`, nor a control `handoff.sealRunId`, nor the published pointer's run; only after a retention window the owner sets; never while a claim names the run. Until then orphans of failed stagings (about 30 MB each at the 13 Nov scale) remain in R2.
### Invariants kept (ADR 0092, 0096, 0100)

The D1 ledger and catalog are complete **before** the atomic published pointer. The pointer moves exactly once per run. Generation, lease and compare-and-set fences are unchanged. Publish, finalize and queue stay idempotent units. There is one EPG generation. This ADR adds no pipeline: the Producer Workflow of [ADR 0140](0140-producer-workflow-adaptive-successor-chain.md) starts after the publication and is not merged with this boundary; the two chains use different instance-id families and different control records.

### Not decided

Activation, a numeric byte budget per object, whether the seal successor may itself chain further, the retention window and garbage collection of orphaned staged objects (decision 10), any migration, flag, Task, schedule, Workflow instance, manual run or data write. Each needs its own owner approval. Diagrams and the reference below record the **proposed** shape and are marked as such.

## Alternatives considered

- **Reduce churn only** (done in [PR #630](https://github.com/vladimino/iptv-watchlist/pull/630)): removes measured garbage and CPU, did not change `sealPayload` or establish the carried-over mechanism.
- **Delete unused objects from the parsed payload** (done in PR #595): lowers post-GC retained memory by 12.6 MB offline; the 14 Nov OOMs followed it.
- **Split payload only, no instance boundary:** smaller parse in each step, no change of what the isolate carries from `epg_commit`. Cheaper, no topology change; it is Part B alone and is valid as an independent first step.
- **Instance boundary only:** tests the carried-memory hypothesis; leaves `sealPayload` parsing everything.
- **A second Cloudflare Worker or Durable Object for the seal:** new trust and deployment boundary; not documented as evaluated.
- **Raising limits or lease duration:** masks the failure and is excluded by the card.

## Consequences

One more Workflow instance family; one more control-record claim and one more branch in the hourly `ensure` (a pending claim now takes priority over today's start); five R2 objects instead of one per run; a manifest to maintain. Observability gains a clean per-instance boundary: the AIR-462 markers and `epg_act` traces keep working, and a seal attempt is attributable to its own instance. Risk: the hypothesis behind Part A may be wrong, in which case the cost is more moving parts with no memory benefit. Part B is independent of that hypothesis.

## Recovery and migration boundary

Code is reversible by revert. A revert does **not** remove the control claim, staged objects, a running successor or the published generation. Runs in flight across a deploy or a midnight must finish with code that reads their layout (decision 9). No migration is required by this proposal: the claim is a field of the existing `control` document and staged objects are R2 keys. This ADR authorizes no operation.

## Evidence

- **Original decision:** owner direction on [AIR-460](https://trello.com/c/ZXySuCJk), 14 November 2026.
- **Implementation:** none.
- **Dated verification:** [AIR-462 natural run](../evidence/orchestration/air-462-epg-oom-natural-run-2026-11-14.md), [stream measurements](../evidence/orchestration/air-460-seal-stream-workerd-2026-11-14.md), [parser churn](../evidence/orchestration/air-460-parser-churn-2026-11-14.md).
- **Uncertainty:** isolate reuse across steps and instances; peak heap in production; the effect of either part on `exceededMemory`; Workflow create and wake behaviour under the claim protocol.

## Follow-ups

Owner decision on Parts A and B; then a separate implementation card per part with its own tests (crash at every hand-off point, duplicate and uncertain `create()`, every status case of decision 4 including terminal and unexpectedly complete, replay after kill, no duplicate publish or event, a nonempty `uncertain` list through an interrupted and resumed `publish_intent` unit (stored `uncertain.json` equals the staged object, no loss, no duplicate), `finalize` and `queue` reading only the manifest and `report.json`, a legacy `payload.json` run across a deploy, a mixed-version restart, a foreign-day sealed run across midnight with today's `ensure` running, torn staged objects with and without `seal.layout`) and a natural-run acceptance in `Verifikatsiya`. Related: [ADR 0141 proposal](https://github.com/vladimino/iptv-watchlist/pull/618) for the Producer chain protocol.
