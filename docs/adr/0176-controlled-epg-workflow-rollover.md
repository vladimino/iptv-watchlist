# ADR 0176: Controlled EPG Workflow rollover onto the deployed Worker version

**Status:** Accepted  
**Original decision date:** 2026-11-19  
**Recorded at:** 2026-11-19  
**Accepted at:** 2026-11-19  
**Approval source:** Explicit Product Owner approval of ADR 0176 in [AIR-540](https://trello.com/c/YAVfVHrs) on 2026-11-19, after the [independent code review](https://github.com/vladimino/iptv-watchlist/pull/790#pullrequestreview-5981745152) and the [Mermaid visual QA evidence](../evidence/orchestration/air-540-epg-rollover-offline-2026-11-19.md). This approves the EPG rollover mechanism and its delivery only. **Every production `epg_workflow_rollover.apply` requires a separate, explicit owner GO with exact pins; no apply is authorized by this ADR.**  
**Related work:** [AIR-540](https://trello.com/c/YAVfVHrs); precedents [AIR-524](https://trello.com/c/G32xYzLC), [AIR-484](https://trello.com/c/CDvqIdUn), [AIR-520](https://trello.com/c/AJEULl3k); incident context [AIR-532](https://trello.com/c/mGPwomMX), [PR #786](https://github.com/vladimino/iptv-watchlist/pull/786)  
**Supersedes:** None  
**Superseded by:** None

## Context

An EPG Workflow instance keeps the Worker version it was created on. A deploy reaches it only when the instance hands over by itself (the seal hand-off of [ADR 0144](0144-epg-seal-successor-workflow-instance.md), through `createSuccessor`) or when the hourly `ensure` creates the next series after the instance ended. After the AIR-532 hotfix the running `epg_20261119_1` kept the old code until it recovered by itself. There is no operator that moves a live EPG instance onto the deployed version safely.

Ownership of the EPG run lives in one place: the `control` document of `epg_orchestration_document` (run key, series, instance id, epoch, phase, run id, checkpoint, failure budget, cooldown, quarantine, `handoff`), written only by compare-and-set and only under the mode revision it was admitted with ([ADR 0100](0100-epg-cloudflare-workflow-executor.md)). Every `act` of an instance starts by `admit`, which refuses an instance that is not the record's `instanceId` and `series` (`not_owner`). Every step takes the durable step lease and renews it at each mutation boundary. A platform `terminate` or `restart`, or a second `create` beside a live owner, bypasses this record: it can leave two writers, spend the failure budget or keep the old version.

This differs from Discovery: there is no executor record with a recorded sleep, no continuation or Discovery lease, and the published pointer is moved by the instance itself inside a lease-holding step. The EPG protocol therefore needs its own proof of "asleep outside a step".

## Decision

Add one owner-only, explicitly invoked operator: the MCP tool `epg_workflow_rollover` on `/mcp` (Cloudflare Access Managed OAuth plus the Worker's signed JWT checks). It hands the `control` record to the deterministic successor `epg_<runKey>_<series+1>` of the **same** run key, epoch and run id, using the record's own compare-and-set.

1. **Preflight (`mode: dry_run`) writes nothing.** It reads the mode document, the control record, the step lease row, `sync.json`, the published-EPG authority, the platform status of the owner instance and the deployed version (`CF_VERSION_METADATA.id`). It answers `eligible`, `already_current`, `unsafe` (with `blockers`) or `unknown` (with `unknowns`), the instance's recorded version, the sleep end, the budget and the `expect` pins `{runKey, epoch, series, instanceId, runId, controlRevision}`.
2. **Admission is a provably sleeping owner.** `eligible` requires all of: mode `cloudflare` at the record's epoch; published authority ready; a stored control record naming an instance, with no `doneAt` and no quarantine; phase not `starting`; the platform reports the owner `running` or `waiting`; **a durable sleep** (`nextWakeAt` for `waiting`, `cooldownUntil` for a cooldown, whichever is later) more than 120 s from now, while a `running` record without either is an owner that continues at once; no live step lease; the run key is today's Madrid day or a seal claim of that run is still pending (the executor's own `day_rolled` rule); `sync.json` at `stage: seal` is covered by `handoff.sealRunId`; `sync.json` belongs to the record's run unless complete. The failure budget and cooldown are **not** a blocker and are carried unchanged. Any unreadable or malformed fact, an unreadable platform status or a missing deployed version is `unknown`. Only `eligible` admits an apply. `already_current` is answered only for an alive owner whose recorded `versionId` equals the deployed version.
3. **Apply (`mode: apply`)** requires `confirmGo: true`, a `requestId` and the exact pins of a preflight (`expectedRunKey`, `expectedEpoch`, `expectedSeries`, `expectedInstanceId`, `expectedRunId`, `expectedControlRevision`). It re-runs the preflight, refuses when the reads left less than half of the wake margin, then performs **one** compare-and-set of the control document: revision equal to the pinned one, mode revision unchanged, **and the lease row still at the revision read** (a step that took or released the lease in between moves it, so the swap is refused whole). The successor is named (`series+1`, `phase: starting`, `nextWakeAt: null`, `versionId: null`, `createdVersionId`), a `rollover` receipt is stored, and every other field (run id, checkpoint, budget, failure, cooldown, `handoff`, `lastDurableProgressAt`, `publishedRunId`) is carried as it was. Then it creates the successor with `{runKey, series, epoch}` through the existing `createSuccessor` and reads back.
4. **The old instance cannot write after the swap.** It is asleep at the swap (no lease, no step in flight). When it wakes, `admit` finds another `instanceId` and `series` (`not_owner`); its orphan-claim recovery ([AIR-520](https://trello.com/c/AJEULl3k)) needs a `handoff` with `fromSeries` equal to its own series and a pending claim, which a rollover never writes and a carried earlier claim never satisfies. It stops without a write. No platform `terminate`.
5. **Recovery is the existing one, plus one branch.** A crash between the swap and the create, or a create whose outcome stays unknown, leaves `phase: starting` with the receipt naming that id. The hourly `ensure` creates the **same id** (an existing id attaches) and spends no budget; it never mints a new candidate id. A repeat of the same `requestId` does the same on demand.
6. **Idempotent and fail-closed.** A repeat of the same `requestId` never swaps again. The receipt stores all six pins and the proof baseline; a repeat whose six pins do not all equal them is `request_id_reused` before anything else. A readback is always allowed (`superseded` when a later natural successor already replaced it). An owed create is performed only when the **current** facts pass: every fact readable, no blocker except the two a swapped record shows by itself (`successor_not_started`, `owner_not_alive`), authority ready, the mode epoch equal to the control epoch, the platform reporting the successor absent; otherwise the answer is `create_blocked` (202) and nothing is created. The same-id recovery of the hourly `ensure` additionally requires the control epoch to equal the mode epoch. A reused `requestId` with other pins, a stale pin, any `unsafe`/`unknown` decision, a lost swap or a thrown swap answers a refusal or `swap_unknown` and changes nothing; the same request is then repeated.
7. **Readback, not HTTP, is acceptance.** `accepted` requires that the record names the successor and only it with the receipt, the platform reports it alive, `sync.json` is readable and is the very run pinned before the swap (absent exactly when it was absent), its checkpoint within that run is not behind, the record's run id is unchanged and the failure budget is not lower. An unreadable, missing or different run document is `readback_unproven` (202), never a success. The successor records its own `versionId` in every `act` commit (`CF_VERSION_METADATA.id`); `versionConfirmed` (outcome `handed_over`) needs that, otherwise `handed_over_version_pending` until a preflight reads `already_current`.
8. **Version provenance.** The deployed version is the binding of the Worker answering the tool. The instance version is **recorded by the instance itself**, never inferred from "Deploy succeeded". An instance created before this decision has no recorded version: the preflight treats it as "has not recorded the deployed version" (so `eligible` when everything else holds), not as `already_current`.

Not decided here: no automatic rollover on deploy, no cron, schedule, feature flag, Scheduled Task, storage migration or general orchestrator; no termination of the old instance; no quarantine-recovery path (a quarantined run is `unsafe` and stays for its own owner-approved procedure); no change to the natural seal hand-off, the failure budget or the cross-day adoption rules ([ADR 0092](0092-resumable-bounded-ledger-seal.md), [0144](0144-epg-seal-successor-workflow-instance.md), [0145](0145-epg-seal-publication-only-staging.md)). A merge or deploy is not a production GO: **each** production `apply` needs a separate owner approval naming the exact pins.

## Safety matrix

| Situation | Decision | Writes |
| --- | --- | --- |
| Owner sleeping ≥ 120 s ahead, lease free, no quarantine | `eligible` | dry_run 0 |
| Owner in a step (live lease) or `running` without a durable sleep | `unsafe` (`lease_live`, `owner_not_sleeping`) | 0 |
| Wake within 120 s, or past | `unsafe` (`wake_too_soon`, `owner_not_sleeping`) | 0 |
| Quarantined, complete, `starting`, epoch moved, authority held, switching/external | `unsafe` | 0 |
| `sync.json` at seal not covered by the claim, or another run | `unsafe` (`seal_unclaimed`, `run_mismatch`) | 0 |
| Platform status, `sync.json`, mode, control or version unreadable | `unknown` | 0 |
| Recorded version equals deployed | `already_current` | 0 |
| Stale pin, no `confirmGo`, reused `requestId` | refusal | 0 |
| A step takes the lease, or the control moves, between preflight and swap | `cas_lost` / `stale_pin` | 0 |
| Create outcome unknown | `successor_uncertain`; same id by repeat or `ensure` | swap 1 |
| Day rolled, no pending claim | `unsafe` (`day_rolled`) | 0 |

## Alternatives considered

- **Wait for the natural hand-off or the next series** (the status before this decision): no new code, but a deploy reaches a live EPG instance only when it hands over by itself, which AIR-532 showed can take hours. Rejected by the card.
- **Platform `terminate`/`restart`, or a blind second `create` of a candidate id**: bypasses the control record, can leave two writers or lose the in-memory step state, and a restart does not change the version. Rejected.
- **Automatic rollover on every deploy or from the hourly `ensure`**: adds a writer path to a tick that must stay read-mostly and removes the owner's gate. Rejected.
- **Admit a running owner (fence by the lease alone)**: the lease and the control commit are separate; a running owner could publish one more step after the swap. Requiring a durable sleep and pinning the lease revision removes that window.
- **Copy the Discovery protocol**: Discovery has an executor record with a recorded sleep, a continuation and its own lease; EPG has neither, so the proof of sleep, the pin set and the successor carry differ. Not copied.

## Consequences

- A deploy can reach the EPG Workflow within minutes of an owner GO without a second writer and without losing the checkpoint or the failure budget.
- The operator is refused while the owner is in a step or about to wake; the preflight shows `sleepsUntil`.
- One more MCP write tool, one `versionId` field per `act` commit, one `rollover` receipt and one branch in `ensure`.
- Platform behaviour is assumed, not proven: that a new instance runs the version deployed at its creation, and that `CF_VERSION_METADATA` inside a step reports the instance's own version. The readback checks both on the first live run.

## Recovery and migration boundary

No schema change, no data migration, no new table, no R2 key, no change to the published pointer, `sync.json`, Discovery or any schedule. The control document gains optional fields (`versionId`, `createdVersionId`, `rollover`) that older code ignores. Reverting the code removes the tool and the version write; a swap already applied is not undone, the successor simply continues, and a code rollback does not revert D1 or R2.

## Evidence

- **Implementation:** `src/epg-orchestration.js` (`rolloverPreflight`, `epgWorkflowRollover`, `handleRolloverTool`, the `leaseRevision` condition of `casDoc`, the `versionId` record in `act`, the rollover branch of `ensureWorkflow`), `src/mcp.js`; tests `tests/epg-workflow-rollover.mjs`, `tests/mcp.mjs`
- **Dated verification:** [offline test evidence, 19 Nov 2026](../evidence/orchestration/air-540-epg-rollover-offline-2026-11-19.md)
- **Uncertainty:** no live apply has run.

## Follow-ups

The first production apply under a separate owner GO naming the exact pins, with its own evidence.
