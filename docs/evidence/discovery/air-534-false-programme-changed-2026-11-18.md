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

## Review fix (P1): every `guarded()` caller propagates an exhausted collision

The first version let the batched replay and the per-slot assignment swallow an exhausted collision as an ordinary refusal. Now the chunk returns the bounded deferral (`generationCollision`, `retryAt` +30 s) right after the replay and after each of the three `assignSlots` call sites (replay, candidate, revalidation), keeping the counters of work already committed. `tests/discovery-fence-collision.mjs` blocks D and E cover persistent collisions in bulk replay and slot assignment, and a real run switch on the same paths (lost lease, no deferral); block D fails on the previous code.

## Visual QA (P2), 18 November 2026

Local Chromium through Playwright, the real `public/styles.css` and the real `eventHTML` output on the `events-screen` layout; no screenshots were created or saved. The full app and production data were not loaded; the owner's visual acceptance on production data stays open. Cards checked: `stalled`, `waiting`, running with no progress, and a normal found-films hour.
- Desktop 1280 px: no horizontal overflow of the page, list or any card; the longer `stalled` title fits on one line; all four cards 191 px high, hierarchy (title, three counters, note) unchanged.
- Mobile 390 px: no horizontal overflow; the `stalled` and no-progress titles wrap to two lines (card 215 px instead of 191 px); counters and notes stay readable; the list scrolls inside its container.
- No problem found, nothing changed in the stylesheet.

## Scope 3 (fast recovery cron), offline

Owner decision of 18 November 2026 on the AIR-534 card, recorded as [ADR 0174](../../adr/0174-discovery-only-fast-recovery-cron.md). Second cron `1-59/2 * * * *`, dispatched on `controller.cron` to `reconcileDiscoveryRecovery`; the hourly path is unchanged.
- Idle cost measured in the test harness: a healthy live instance is one read of the Workflow record, one platform status call, zero writes, zero creates, zero authority reads and no report. A stopped record not yet due is one read and nothing else.
- `tests/discovery-fast-recovery.mjs` (core) covers: healthy live and unreadable status (fail closed); stopped undue; stopped due with the deterministic successor id and `recoveryDelayMs`; wait then due then success; killed, completed and errored instances armed with a backoff first; terminal stop and quarantine; refusals (authority held, authority loading, D1 unavailable, EPG priority, projector window, published run mismatch) with the incident flag past five minutes; two fast ticks plus the hourly reconcile giving one successor id and one series bump; an uncertain start; isolation (the fast entry calls none of EPG, Ratings, Monitor and writes no Event, the hourly entry still calls all three); readout `recoveryState` and `recoveryIncident`. The fast-path and the wait gates fail when mutated.
- The three tests that pinned a single cron now pin the two entries.
- Not proven: any production behaviour of the fast tick, the real platform scheduling delay and the 18 November `:00` interleaving. Natural recovery proof (a `discovery_recovery_tick` `state=started` with `recoveryDelayMs`, no manual writer) stays for «Верификация».

## Scope 3 review fixes (offline)

- **Missed EPG handoff:** the tick now also reads the published generation pointer and hands a missing record, or a record of an older generation (also with the old instance still alive, a terminal stop or an undue recovery), to the existing reconcile, which creates series 0 of the published generation. Healthy idle cost is now one record read, one published-pointer read and one platform status call, no write, no authority read, no create (asserted). Tests: no record; refused admission on no record; old generation with a live old instance; old generation with a terminal stop and with an undue recovery; two fast ticks plus the hourly reconcile on the missed handoff (one id, one creation, no report); unreadable pointer (typed failure, nothing written).
- **Late success is an incident:** `incident` is set on every outcome whose lateness exceeds five minutes, a successful start included; tests at 400 s (true) and 240 s (false).
- **Typed failures are logged:** `fast_tick_error`, `instance_status_unknown`, `published_unreadable` and `workflow_unavailable` log `state=failed`; none claims success.
- Mutating the published-generation comparison, the no-record handover and the incident on `started` each fails the test.
- Docs: rollback now removes only `1-59/2 * * * *` and never replaces the hourly trigger; the stale single-cron statements in the deployment runbook and the scheduling page were corrected; the Mermaid sequence now puts the admission/CAS write inside the "needs a decision" branch.
- ADR number: main took 0173 for the AIR-532 retention ADR first, so this decision is ADR 0174.
- Mermaid, actual GitHub rendering (19 November 2026, headless Chromium on the GitHub file view of the branch, no screenshots; measured in the GitHub mermaid frame at a 1280 px viewport, then at 390 px):
  - `scheduling-and-orchestration.md`, fast-tick sequence diagram: renders without a syntax error; the first version was 1,821 units wide and shrank to a scale of 0.47 (about 5.7 px text), so the labels were shortened; the pushed version is 1,182 units wide, scale 0.73, smallest text about 9 px at 1280 px and scale 0.27 (about 3 px) at 390 px, where the page offers the diagram's own zoom. Meaning checked from the rendered positions: `No-op, no write` sits above the `Needs a decision` branch; `Admission reads, one CAS write`, `Refused` and `Accepted` all sit below it, so no admission or write is drawn after a no-op.
  - `runtime-topology.md`: renders without error; the new node `Cloudflare cron trigger: 1-59/2 * * * * (Discovery only)` and its dashed edge `reconcileDiscoveryRecovery: recovery of a stopped Workflow only` to the Workflow are present beside the hourly node and its edge; scale 0.65, smallest text about 10 px at 1280 px.
  - Limit: a headless browser, not a human reading; the mobile text of the sequence diagram is small by the nature of a five-participant diagram.

## Not done here (open on AIR-534)

- Live proof: natural race, successor and no duplicate owners go to `Верификация`; offline tests do not replace it.
