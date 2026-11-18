# ADR 0167: Retire the one-film prediction runner v5; batch runner v2 is the only prediction protocol

**Status:** Proposed
**Original decision date:** 2026-11-17
**Recorded at:** 2026-11-17
**Approval source:** owner GO to implement [AIR-452](https://trello.com/c/bHuKy3eF) as a code and documentation PR (card description, 17 Nov 2026); owner answers during implementation on 17 Nov 2026: full removal of the v5 MCP tools, HTTP routes and implementation, removal of `prediction_validate`, and "D1 stays, no rollback to R2 is planned". No production operation is authorized by this ADR.
**Related work:** [AIR-452](https://trello.com/c/bHuKy3eF); prerequisite [AIR-451](https://trello.com/c/NN3N6kRp) (cutover of the hourly Scheduled Tasks to batch v2); [consumer inventory](../evidence/prediction/air-452-v5-consumer-inventory-2026-11-17.md)
**Supersedes:** [ADR 0122](0122-prediction-batch-runner-v2-dual-protocol.md) in part: the dual-protocol coexistence (v2 runs *beside* v5) and its rollback "re-enable the v5 Task". The shared queue, lease, epoch, submit gate, persistence and every v2 rule of ADR 0122 stay in force. [ADR 0035](0035-selective-fingerprint-transition-compatibility.md) section 7 in part: no runner restores a fingerprint pointer to a stored generation record any more (see Consequences).
**Superseded by:** None

## Context

ADR 0122 introduced the batch runner v2 (`prediction_batch_start`, `prediction_batch_manifest`, `prediction_batch_validate`, `prediction_batch_hold`, `prediction_batch_submit`) beside the one-film runner v5 (`prediction_start`, `prediction_next`, `prediction_submit`, with the standalone `prediction_validate` preflight), on one queue, one runner lease and one persistence path, so the hourly Scheduled Task could move from v5 to v2 and back by a registry change only.

AIR-451 moved production to v2: four hourly ChatGPT Scheduled Tasks run the batch v2 prompt, and the legacy v5 Task was disabled during the cutover. The consumer inventory on `main` of 17 Nov 2026 found that the v5 contract had no remaining live consumer: the only external entry was the MCP server, the Admin UI and the Worker never call `/api/enrichment/start`, `/next` or `/submit`, the batch v2 prompt forbids every v5 tool and `prediction_validate`, and the v2 start already performs the repairs a v5 start performed (it delivers pending run Events and settles an expired lease holder). The v5 routes remained the main harness of the test suite.

v5 was also the only runner able to write predictions while `prediction_domain_authority.mode` is `r2`: v2 refuses with `batch_runner_requires_d1` because its per-film commit is a guarded D1 batch (ADR 0122, decision 7).

## Decision

1. **Retire v5.** Remove the MCP tools `prediction_start`, `prediction_next`, `prediction_submit` and `prediction_validate`, the HTTP routes `POST /api/enrichment/start`, `POST /api/enrichment/next` and `POST /api/enrichment/submit`, and their implementation (the v5 start with its `legacy` mode, the one-film `next` with adaptive batch selection, the v5 submit, their step-timing wrapper and the helpers only they used). A removed tool is an unknown tool (`-32602`); a removed route falls through to the Worker's `404 Not found`. No `410` compatibility shim is kept, because no client remains.
2. **Batch runner v2 is the only prediction protocol.** `prediction_heartbeat` and `prediction_complete` stay shared runner tools. `GET /api/enrichment/runner` (MCP `enrichment_runner`) describes v2 only and lists `retiredProtocols: ["v5"]`.
3. **Stored v5 runs stay readable and safe.** Run records written by v5 (no `protocol`, or not `batch_v2`) are not migrated or deleted. Batch v2 still treats such a run as another protocol: its live lease turns a start away with `already_running`, an expired one is settled by the next v2 start, the v2 submit, hold and manifest tools answer `wrong_protocol`, and heartbeat, complete, diagnostics, history and Events keep reading it.
4. **Predictions require the D1 prediction authority.** With v5 gone no runner writes predictions while the marker is `r2`. The owner confirmed that D1 stays the prediction authority and that no rollback to R2 is planned. This is consistent with [ADR 0162](0162-d1-only-authority-retire-rollback-toolchain.md) (D1 is the only authority; the R2 rollback toolchain of ADR 0078 is retired): no prediction writer is kept for an `r2` marker.

Not decided here: any change to the Scheduled Task registry (the disabled legacy v5 Task, the four v2 Tasks, the drift monitor), the prediction authority marker, flags, D1 or R2 data, or a v2 implementation of fingerprint pointer restoration.

## Alternatives considered

- **Retire only the MCP exposure and keep the HTTP routes and implementation** as an Access-protected R2 fallback and test harness. Rejected by the owner: no client would drive the routes, and the R2 fallback is not planned.
- **Split the retirement into two cards** (MCP and documentation first, then routes, implementation and test migration). Rejected by the owner in favour of one PR.
- **Keep `prediction_validate` as a standalone preflight.** Rejected: no consumer, the v2 prompt forbids it, and `prediction_batch_validate` with one item runs the same validators.
- **Answer `410 Gone` on the removed routes and tools.** Rejected: the card forbids open-ended compatibility shims without a real consumer, and the Worker already answers an unknown route and an unknown tool deterministically.

## Consequences

- One protocol to document, test and operate. The v5 tests are removed or ported to batch v2 in D1 mode; the coverage of the shared machinery (lease, heartbeat, completion, Events, diagnostics, retries, queue fences, validators, versions) now runs through v2.
- **No fingerprint pointer restoration.** ADR 0035 section 7 restored, without a model run, a stored generation record current for the target when a schema or prompt rollback left a fingerprint `fingerprint_ahead`. Only the v5 `next` did this; batch v2 never did. After this ADR such a fingerprint is treated as stale and the film needs `fingerprint_and_prediction` in the next manifest. The pure selection rule `fingerprintRestoreCandidate` and its specification fixtures stay as the ADR 0035 specification; they have no runtime caller.
- The previous rollback of ADR 0122 ("disable the v2 Task and re-enable the v5 Task") no longer works: a registry change alone cannot bring v5 back.
- `pipelineVersion` of the runner contract stays `5`: it names the stored run format shared by both protocols, not the retired protocol.

## Recovery and migration boundary

The code change is reversible only by an ordinary code rollback to a Worker that still contains v5. Using v5 again then also needs a separate, operation-specific owner GO for every Scheduled Task action (disable the v2 Tasks, re-enable or edit the legacy Task). A code rollback does not revert D1, R2, the queue, stored predictions, flags, Access or Task schedules. No data migration is part of this ADR, so none is reversed. This ADR authorizes no production write.

## Evidence

- **Original decision:** [AIR-452](https://trello.com/c/bHuKy3eF) (owner GO and answers of 17 Nov 2026)
- **Implementation:** the AIR-452 pull request
- **Dated verification:** [consumer inventory, 17 Nov 2026](../evidence/prediction/air-452-v5-consumer-inventory-2026-11-17.md)
- **Uncertainty:** the live Scheduled Task registry was not read for this change; the inventory relies on the AIR-451 readback and the installed batch v2 prompt in the repository.

## Follow-ups

- A natural batch v2 Scheduled Task run after deploy confirms no regression (AIR-452 acceptance).
- Whether batch v2 should restore a fingerprint pointer after a schema or prompt rollback, or the restore rule should be retired from ADR 0035, is a separate decision.
- Removing the disabled legacy v5 Task from the registry needs its own owner GO.
