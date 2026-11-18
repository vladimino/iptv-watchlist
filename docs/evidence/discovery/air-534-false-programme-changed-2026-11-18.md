# AIR-534: false `programme_changed` from a generation CAS collision

Date: 18 November 2026 (UTC). Evidence: source reading plus an offline sqlite stand-in test. No production access, no production write.

## Observed (from the card, read-only production facts)

- Workflow `_32` (old EPG generation) and Workflow `_0` (generation `cc26a2e7…`) ended with `stage=programme_changed` although the published run had not changed (`checked=0`, `error=null`).
- Recovery then waited for the next hourly tick (stopped 20:00, successor 21:00 Madrid).

## Causal chain established in code (offline)

1. Every D1 Discovery write is a batch whose first statement is `UPDATE discovery_authority SET generation=generation+1 … WHERE generation=?` with the generation read just before (`src/discovery-authority.js`, e.g. `writeDecisionDelta`, `upsertAdmissions`, `assignObservationSlots`). A lost CAS rolls the whole batch back and throws `discovery_fence`.
2. The hourly reporting path (`writeWorkflow()`, same table, same counter) also bumps `generation`. A chunk write that read the gate before that bump loses its CAS with the published run unchanged.
3. `guarded()` in `resolveDiscoveryChunk` (`src/discovery.js`) turned every `discovery_fence` into `null` after a lease renewal, and each caller returned `programmeChanged()`, a terminal outcome with `currentProgrammeRunId: null`.

Status: chain (1)-(3) is established by reading and reproduced offline. That the production `:00` boundary was exactly this interleaving is **not** proven; it stays a hypothesis for the live incidents until a natural occurrence is observed (diagnostic `timings.fenceRetries` / `generationCollision` now records it).

## Fix in this change

- `guarded()` re-checks after a fence refusal: lease renewal (lost lease still aborts), the published pointer and the authority gate (`ready`, not `loading`, `programmeRunId` equal to the chunk's run).
- Same run: the rolled-back write is retried, at most 2 retries (`DISCOVERY_FENCE_COLLISION_RETRIES`).
- Retries exhausted: a bounded deferral (`stage=partial`, `generationCollision=true`, `retryAt` +30 s, `error=null`), mapped by `continuationAfterChunk` to the existing `backoff` pause, never `programme_changed`.
- Different run or gate not ready: unchanged fail-closed `programme_changed`; a lease lost with the generation aborts the chunk.

## Tests

`tests/discovery-fence-collision.mjs` (core): one collision is retried and the chunk completes; collisions that never clear defer with a bounded attempt count; a real run switch is not retried and aborts on the lost lease.

## Scope 4 (health and events), offline

- `discoveryExecutorReadout` exposes `recoveryOverdue` and counts it in `degraded`.
- The hourly report maps a non-terminal stopped series with backlog to `stalled` (`recovery_overdue`) or `waiting` (`recovery_waiting`) instead of `idle`; terminal stops stay `idle`. The Events card says the recovery is overdue, and a `running` hour with no progress no longer reads «работает».
- Tests: `tests/discovery-events.mjs` block 16, `tests/discovery-workflow.mjs`, `tests/activity-ui.mjs`.

## Not done here (open on AIR-534)

- Scope 3: bounded automatic successor after a recoverable stopped series (today waits for the hourly Cron). This changes orchestration; it needs an owner decision and an ADR before implementation.
- Live proof: natural race, successor and no duplicate owners go to `Верификация`; offline tests do not replace it.
