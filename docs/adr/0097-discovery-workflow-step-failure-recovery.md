# ADR 0097: A Discovery Workflow instance recovers from a transient step failure itself

**Status:** Proposed  
**Original decision date:** 2026-11-07  
**Recorded at:** 2026-11-07  
**Approval source:** Option A approved for implementation by the owner/coordinator account in the [PR #399 decision comment](https://github.com/vladimino/iptv-watchlist/pull/399#issuecomment-6708109263) on 2026-11-07; the ADR becomes Accepted on the owner's acceptance of the implementing PR.  
**Related work:** [AIR-364](https://trello.com/c/QSu1SDvS), [AIR-324](https://trello.com/c/kNtaEbm8), [AIR-360](https://trello.com/c/AKiiAU3V), [ADR 0083](0083-inert-discovery-workflow.md), [ADR 0089](0089-shared-orchestration-reliability-contract.md), [ADR 0093](0093-discovery-workflow-cron-reconcile.md), [ADR 0094](0094-discovery-workflow-invocation-budget.md), [options record](../evidence/orchestration/discovery-workflow-recovery-latency-air-364-2026-11-07.md)  
**Supersedes:** None. It adds to [ADR 0093](0093-discovery-workflow-cron-reconcile.md) decision 3 (who may open a successor).  
**Superseded by:** None

## Context

When a Discovery Workflow instance ends `errored`, the hourly cron arms `recovery.dueAt` (60 s, 5 min, 15 min, 1 h; four recoveries, then quarantine) and returns; the successor is created by a later cron firing, about an hour later. The cause on 6 November was a step that failed with `discovery_unavailable` until its retries ran out. Cloudflare Workflows allow a `try/catch` around `step.do` and a durable `step.sleepUntil` inside a live instance; a dead instance does not wake, and a new trigger (cron change, Durable Object alarm, Queue, a second instance role, `workflows[].schedules`) is a topology change that this decision does not take.

## Decision

1. **The instance catches a step failure after the platform's retries, but only a recognised transient one.** Recoverable: the `discovery_unavailable` code, or a transient class (lost connection, timeout, limit exceeded, overload, D1 reset) on the error or its cause. Never recovered here: the hard codes (`discovery_fence`, `discovery_incomplete`, `discovery_not_authoritative`, `discovery_conflict`, `discovery_lease`, `discovery_bounded`), an unclassified or empty error, a non-error, or an error whose classification cannot be read. They end the instance as before.
2. **The recovery is armed once with the existing machinery.** `stopOwnedWorkflow` with the recoverable reason `step_failure` runs `workflowFailure` under the owner CAS: attempts +1, backoff 60 s / 5 min / 15 min / 1 h, quarantine after four. The record is `stopped` with `recovery.dueAt`; a quarantined record sleeps and creates nothing. The arm is a durable step, so a replay does not count it twice, and the cron that later sees `stopped` with a due time does not arm again.
3. **A durable `step.sleepUntil(dueAt)`, never earlier.** After waking, one step reads the owner (a superseding instance or a lost CAS stops quietly), re-runs the Discovery admission (D1 authority ready and open, published pointer equal to the discovery pin, mode `workflow`), refuses a generation other than the pinned one, and then calls the existing `ensureDiscoveryWorkflow`, which applies the recovery gate and opens the deterministic successor `discovery_<run>_<series+1>`. A due time that has not elapsed by the platform's clock sleeps again (at most three times).
4. **Replay-safe and duplicate-safe.** The state write precedes `create()` inside the existing create path; a crash between them is repaired by the step retry or the cron through the same id; an unknown create result keeps the id and counts one recovery; an instance wake and a cron firing that race open one instance (the second `create()` attaches).
5. **The hourly cron stays the fallback and nothing else changes.** No new binding, trigger, schedule or cron edit; the single-writer fence, the generation pin, the owner CAS, the backoff, the quarantine limit and the inertness of `external` are as before.

## Consequences

- A transient step failure that exhausts its retries is recovered at `dueAt` (60 s for the first failure) without waiting for the next cron.
- **Not covered, and still an hour:** an instance killed by the platform as a whole, a failure of the arming step itself (for example D1 down at that moment: the step error ends the instance as before), and a `stopped` record whose instance is gone. The cron recovers them. This is not universal automatic recovery and no production latency has been measured.
- One more path to a successor; a bug in the classification could recover a failure that should stop, which the post-wake admission and owner checks bound.
- Option C (a separate waker instance) is deferred as a documented residual-risk trade-off; options B, D, E and F are out of scope.

## Rollback

Revert the code. The cron path and the records are unchanged by this decision.

## Unsupported assumptions

- That the platform replays a step that failed after its retries with the same recorded failure. If it re-runs the step on replay and the step now succeeds, the instance continues normally and the cron or a later wake finds a `stopped` record whose owner check fails, so no second writer runs; this was not observed.
