# AIR-364: recovery latency of the Discovery Workflow, design options

**Captured:** 2026-11-07 (UTC). **Method:** reading `src/discovery-workflow.js`, `wrangler.jsonc` and the Cloudflare documentation (Workers limits, Workflows, Durable Objects, Queues). No production read or write, no code change. **Status: options for an owner decision.** Nothing here changes a trigger, a binding or a schedule.

## The gap

When an instance ends `errored`, `terminated` or `complete`, the hourly cron (`37 * * * *`, `reconcileDiscoveryWorkflow`) moves the executor record from `running` to `stopped` and persists `recovery.dueAt` (60 s, then 5 min, 15 min, 1 h; at most four recoveries, then quarantine). It then returns. A successor is created only by a later cron firing, because every later firing finds `stopped` and an elapsed `dueAt`.

Latency from the arithmetic of the code, not measured in production:

| Step | Time after detection |
| --- | --- |
| Detection and arm (first cron, tick `k`) | 0 |
| `dueAt` (first tier) | 60 s |
| Successor (cron tick `k+1`) | about 60 min |
| Wasted wait after `dueAt` | about 59 min; 55 min for the 5 min tier, 45 min for the 15 min tier |

The backoff itself is not the problem; the next cron is. A successor must never be created before `dueAt` (kept as a constraint).

## What the platform allows (documentation read on 2026-11-07)

- **Cron Trigger invocation:** 15 minutes of wall time; the runtime awaits the promise `scheduled()` returns. A sleep inside it holds no CPU but is not durable: a runtime update, an eviction or a crash ends it, and nothing resumes it.
- **`ctx.waitUntil`:** extends an HTTP invocation by up to 30 s only. Not a delay mechanism.
- **Workflows `step.sleep` / `step.sleepUntil`:** durable and not counted against the step limit, but only inside a live instance. A dead instance does not wake.
- **Catching a step error:** a `try/catch` around `step.do` keeps the instance running; an uncaught exception or an exhausted retry limit ends it `errored`. The instance can therefore handle a step failure itself.
- **`workflows[].schedules`:** exists, but ADR 0089 and ADR 0093 forbid it (a schedule creates instances).
- **Durable Object alarm:** a new class, binding and migration; handler wall time 15 minutes.
- **Queues `delaySeconds`:** up to 24 hours; a new queue, producer and consumer binding. Not allowed without a separate architectural decision.

## Options

| | Mechanism | Durable | Covers | New topology | Cost / blast radius |
| --- | --- | --- | --- | --- | --- |
| **A** | The instance catches a failed step after its retries, persists the recovery (existing `stopOwnedWorkflow` with a recoverable reason), `step.sleepUntil(dueAt)`, re-checks authority, generation, owner and recovery gate, and opens the successor itself through the existing rollover path. The cron stays the fallback | Yes (Workflow sleep) | Step failures the instance can catch: the 6 November failures (steps failing with `discovery_unavailable` until the retry limit) | None: same class, same binding, same cron | One more code path in the instance; the catch handler itself needs D1 to arm, and if it fails the instance ends as today and the cron recovers |
| **B** | After arming, the same cron invocation awaits until `dueAt` (at most the 60 s and 5 min tiers) and runs reconcile once more | No | Any death the cron sees, while the invocation survives | None | Holds a cron invocation for up to 5 min (wall, no CPU); lost on a deploy or eviction, which falls back to the next cron. The AIR-364 card warns against relying on in-process waiting |
| **C** | A separate waker instance of the same class created at arm time, with `sleepUntil(dueAt)`, then one reconcile | Yes | Also platform termination and any death the cron sees | Same binding, but a second instance role and a second instance created before `dueAt`; the card forbids creating the successor early, a waker needs an explicit decision | Instance and concurrency budget, a deterministic waker id, duplicate suppression |
| **D** | Cron every 5 minutes with the projector, ratings and monitor gated by `controller.cron` | Yes | Everything the cron sees | Cron edit: owner decision | Changes the cadence of the existing work or adds gating code; more D1 reads per hour |
| **E** | Durable Object alarm | Yes | Everything | New class, binding, migration | ADR, owner approval, security and operations review |
| **F** | Queue with `delaySeconds` | Yes | Everything | New queue and consumer | ADR, owner approval; excluded by the current plan |

## Recommendation

Take **A** first. It needs no new binding, schedule or cron change, uses the only durable delay the runtime offers inside a live instance, and covers the failure that actually happened (step failures that exhaust their retries). Keep the hourly cron as the documented fallback for what A cannot see: an instance killed by the platform, a failure of the catch handler's own D1 write, and a stopped record whose owner is gone. **B is not recommended** (not durable). **C** is the next step if the owner wants platform terminations covered too; it needs an explicit decision because it creates an instance before `dueAt`. **D, E and F** are topology changes and need an ADR and owner approval before any code.

A needs a short ADR (Proposed) because it changes who may open a successor (today: rollover and cron only). It does not change the single-writer fence, the generation pin, the owner CAS, the 60 s / 5 m / 15 m / 1 h backoff, the quarantine limit or the external-mode inertness.

## What A would do, and its tests

1. Wrap the loop in the instance so a step error after the retries goes to one handler instead of ending the instance.
2. The handler arms the recovery with the existing `workflowFailure` and CAS (`settleWorkflowIfOwner`), never shortening `dueAt`; at quarantine it stops and creates nothing.
3. `step.sleepUntil(dueAt)`, then a fresh gate: `DiscoveryAuthority` ready and `d1/open`, published pointer equal to the discovery pin, the executor record still owned by this series, `workflowRecoveryGate` due. Then the existing rollover create with the deterministic successor id; a lost CAS or `not_owner` ends the instance quietly.
4. Offline tests that fail without the change: a step failing past its retries arms and does not create early; the successor appears at or after `dueAt` without a second cron; a duplicate wakeup (instance and cron together) creates one instance; a crash between the state write and the create is repaired by the cron through the same deterministic id; an unknown create result keeps the id; the 5 m, 15 m and 1 h tiers and quarantine; a new generation published during the sleep stops it; external mode creates nothing; D1 down at the catch handler leaves today's behaviour.
5. Documentation: the deployment runbook, the scheduling architecture page (the instance gains a recovery branch; a Mermaid change needs the rendered visual check), the orchestration reliability reference, a dated evidence record with measured detection to eligible to successor times, and the ADR.

## Decision and offline result (2026-11-07)

The owner/coordinator approved Option A for implementation ([PR #399 comment](https://github.com/vladimino/iptv-watchlist/pull/399#issuecomment-6708109263)); C is deferred, B, D, E and F are out of scope. It is recorded in [ADR 0098](../../adr/0098-discovery-workflow-step-failure-recovery.md) (Proposed). Offline tests (`tests/discovery-workflow.mjs`, block 15, with a controlled clock): armed once at 60 s with no early create; one successor with no second cron, created at or after `dueAt`; the cron fallback opens it after `dueAt`; an instance wake racing a cron firing opens one deterministic id and counts one failure; a superseded instance, a newer generation and `external` stop quietly; an unknown create result keeps the identity; 5 min, 15 min and 1 h backoff and quarantine (no sleep, no create); D1 failure while arming ends the instance as before; a lost arming CAS while the record keeps the same instance, series and an old recovery re-reads and counts the failure once with the new due time, three lost CAS in a row sleep and create nothing (`recovery_write_conflict`), and a platform retry of the arming step after its write landed counts once; hard codes, unclassified errors and hostile error objects are not recovered. Removing the catch, the recoverable reason, the sleep, the pinned-generation check or the hard-code check fails the tests. Not measured: production latency; nothing was provoked.

## Rollback and gates

Rollback is a code revert; the cron path stays as it is. Nothing here authorizes a cron edit, a new binding, a flag, a Task change, a manual ensure, an instance terminate or create, or any R2 or D1 write. A real latency measurement needs a natural failure; none may be provoked without a separate GO. This document is research only: A needs the coordinator's and the owner's decision before code.
