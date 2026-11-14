# ADR 0144: The EPG seal runs in a successor Workflow instance after a durable commit checkpoint, over separately stored immutable staged payload objects

**Status:** Proposed
**Original decision date:** not decided (proposal; owner approval of the architecture is required before any code)
**Recorded at:** 2026-11-14
**Approval source:** direction of the owner on the [AIR-460 card](https://trello.com/c/ZXySuCJk), comment of 14 November 2026 (Europe/Madrid) "Poruchenie ispolnitelyu po itogam PR #626", item 2: write an ADR-only PR. That comment authorizes this document, **not** implementation, provisioning, activation or any production operation.
**Related work:** [AIR-460](https://trello.com/c/ZXySuCJk); [AIR-420](https://trello.com/c/J0dit94i); [AIR-462](https://trello.com/c/w73gROBl); [PR #595](https://github.com/vladimino/iptv-watchlist/pull/595), [PR #626](https://github.com/vladimino/iptv-watchlist/pull/626), [PR #630](https://github.com/vladimino/iptv-watchlist/pull/630); [ADR 0092](0092-resumable-bounded-ledger-seal.md); [ADR 0096](0096-bounded-seal-publication-steps.md); [ADR 0100](0100-epg-cloudflare-workflow-executor.md); [ADR 0140](0140-producer-workflow-adaptive-successor-chain.md)
**Supersedes:** None. It qualifies [ADR 0100](0100-epg-cloudflare-workflow-executor.md) decision 1 (one Workflow instance per run key and series) only for the seal stage, and changes nothing in ADR 0092 or 0096.
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
2. **Identity.** The successor id is deterministic from the run key, the series and the sealed run: `epg_<YYYYMMDD>_<series>_seal`. A repeated `create()` names the same instance, so a duplicate is harmless. An ambiguous or failed `create()` never proves that the instance is absent; the status is read before anything is concluded ([ADR 0100](0100-epg-cloudflare-workflow-executor.md), `create_uncertain`).
3. **Single owner and fence.** The `control` document records the hand-off as a compare-and-set that names the successor id, the sealed `runId` and the epoch **before** `create()` is called, in the order [ADR 0140](0140-producer-workflow-adaptive-successor-chain.md) already uses for its chain. The successor admits itself against that record and the mode revision, takes the existing durable step lease, and stops with `not_owner` if the claim names another id. The producing instance stops taking the step lease once the claim is written. The existing epoch fence in the publication batch and the generation fence of the pointer switch are unchanged.
4. **Recovery without a new schedule.** The existing hourly `EpgOrchestration.ensure` already reads `control` and `sync.json`. It additionally re-creates the deterministic successor when it finds `stage: seal`, a claim whose instance is not alive and no live step lease. This adds no Cron Trigger, Task or feature flag.
5. **Not claimed.** A new instance does not guarantee a new V8 isolate or a lower peak. The boundary is justified as a smaller, separately observable and separately retried unit: the memory carried from scan, archive and emit has no path into the seal unless the platform reuses the isolate. It is accepted only if natural runs show the effect; it is rejected otherwise and the cost is a revert.

### Part B. Split the staged payload

6. The single `payload.json` is replaced by immutable objects under `epg/seal/<runId>/`: `report.json`, `catalog.json`, `watchlist.json`, `uncertain.json` and a small `manifest.json` carrying the run id, the fence, `expectedProgrammeRunId` and, for each object, its byte length and SHA-256.
7. **Commit boundary.** `manifest.json` is written last and is the commit marker. A reader that finds no manifest sees no staged payload and fails closed (`evidence_contradictory`), never a partial one. Partial writes and crashes before the manifest leave unreferenced objects of an unpublished run, removed by the existing cleanup of an abandoned seal; they are never read. Objects are write-once per run id, so a replay of the staging step may rewrite identical bytes and the manifest check detects any difference.
8. **Readers per phase.** `seal_catalog` reads only `catalog.json`. `publish` reads the manifest, `report.json` and `watchlist.json`. `finalize` and `queue` read the manifest and `report.json`; `finalize` also reads `uncertain.json` and `watchlist.json` where it uses them today. No step parses an object it does not use. Each read checks the manifest length and hash.
9. **Compatibility.** A run that was staged with `payload.json` before the change is finished by code that still reads it: the reader selects by the presence of the manifest, and the legacy path is kept until no in-flight run can carry it (a run is bounded by its Madrid day). A rollback to code that only reads `payload.json` is safe only for runs staged before the change; a run staged with the split layout would need the new code to finish, which the rollback note below states.

### Invariants kept (ADR 0092, 0096, 0100)

The D1 ledger and catalog are complete **before** the atomic published pointer. The pointer moves exactly once per run. Generation, lease and compare-and-set fences are unchanged. Publish, finalize and queue stay idempotent units. There is one EPG generation. This ADR adds no pipeline: the Producer Workflow of [ADR 0140](0140-producer-workflow-adaptive-successor-chain.md) starts after the publication and is not merged with this boundary; the two chains use different instance-id families and different control records.

### Not decided

Activation, a numeric byte budget per object, whether the seal successor may itself chain further, the retention of staged objects after publication, any migration, flag, Task, schedule, Workflow instance, manual run or data write. Each needs its own owner approval. Diagrams and the reference below record the **proposed** shape and are marked as such.

## Alternatives considered

- **Reduce churn only** (done in [PR #630](https://github.com/vladimino/iptv-watchlist/pull/630)): removes measured garbage and CPU, did not change `sealPayload` or establish the carried-over mechanism.
- **Delete unused objects from the parsed payload** (done in PR #595): lowers post-GC retained memory by 12.6 MB offline; the 14 Nov OOMs followed it.
- **Split payload only, no instance boundary:** smaller parse in each step, no change of what the isolate carries from `epg_commit`. Cheaper, no topology change; it is Part B alone and is valid as an independent first step.
- **Instance boundary only:** tests the carried-memory hypothesis; leaves `sealPayload` parsing everything.
- **A second Cloudflare Worker or Durable Object for the seal:** new trust and deployment boundary; not documented as evaluated.
- **Raising limits or lease duration:** masks the failure and is excluded by the card.

## Consequences

One more Workflow instance family; one more control-record claim and one more branch in the hourly `ensure`; five R2 objects instead of one per run; a manifest to maintain. Observability gains a clean per-instance boundary: the AIR-462 markers and `epg_act` traces keep working, and a seal attempt is attributable to its own instance. Risk: the hypothesis behind Part A may be wrong, in which case the cost is more moving parts with no memory benefit. Part B is independent of that hypothesis.

## Recovery and migration boundary

Code is reversible by revert. A revert does **not** remove the control claim, staged objects, a running successor or the published generation. Runs in flight across a deploy must finish with code that reads their layout (decision 9). No migration is required by this proposal: the claim is a field of the existing `control` document and staged objects are R2 keys. This ADR authorizes no operation.

## Evidence

- **Original decision:** owner direction on [AIR-460](https://trello.com/c/ZXySuCJk), 14 November 2026.
- **Implementation:** none.
- **Dated verification:** [AIR-462 natural run](../evidence/orchestration/air-462-epg-oom-natural-run-2026-11-14.md), [stream measurements](../evidence/orchestration/air-460-seal-stream-workerd-2026-11-14.md), [parser churn](../evidence/orchestration/air-460-parser-churn-2026-11-14.md).
- **Uncertainty:** isolate reuse across steps and instances; peak heap in production; the effect of either part on `exceededMemory`; Workflow create and wake behaviour under the claim protocol.

## Follow-ups

Owner decision on Parts A and B; then a separate implementation card per part with its own tests (crash at every hand-off point, duplicate and uncertain `create()`, replay after kill, no duplicate publish or event, legacy `payload.json` run across a deploy, torn staged objects) and a natural-run acceptance in `Verifikatsiya`. Related: [ADR 0141 proposal](https://github.com/vladimino/iptv-watchlist/pull/618) for the Producer chain protocol.
