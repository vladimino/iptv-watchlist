# ADR 0174: A second, Discovery-only Worker cron every two minutes recovers a stopped Discovery Workflow

**Status:** Accepted  
**Original decision date:** 2026-11-18  
**Recorded at:** 2026-11-18  
**Approval source:** [Product Owner handoff on the AIR-534 Trello card, 18 November 2026, after the coordinator's decision brief](https://trello.com/c/90dyx0Ai). The card handoff names this architecture, the boundaries and the required documentation. It approves the architecture and a code/config pull request, not any production operation.  
**Related work:** [AIR-534](https://trello.com/c/90dyx0Ai); [PR 768](https://github.com/vladimino/iptv-watchlist/pull/768) (scopes 1, 2 and 4); [ADR 0093](0093-discovery-workflow-cron-reconcile.md); [ADR 0098](0098-discovery-workflow-step-failure-recovery.md); [ADR 0083](0083-inert-discovery-workflow.md)  
**Supersedes:** None. It **refines** decision 1 of [ADR 0093](0093-discovery-workflow-cron-reconcile.md) ("same cron, no new trigger"): the hourly cron and its Discovery reconcile are unchanged, a second trigger is added for Discovery alone. ADR 0098 and its `step.sleepUntil` recovery inside a live instance are unchanged.  
**Superseded by:** None

## Context

On 18 November 2026 a Discovery Workflow stopped at 20:00 Madrid with a recoverable stop and a recovery due at 20:01:49. The only thing that could start its successor was the hourly cron, so the successor started at 21:00, almost two hours after the stop, while a backlog waited. The cron was working; the recovery was simply bound to the cron period. [ADR 0098](0098-discovery-workflow-step-failure-recovery.md) already makes a **live** instance sleep until `recovery.dueAt`, but an instance that was killed, completed or errored, a lost or uncertain wake and a stop recorded by the reconcile have no live instance to wake. The EPG-publication fast start (`queueDiscovery`, `presentQueuedDiscovery`, `ensureDiscoveryWorkflow`) starts a new generation and is not a recovery clock.

## Decision

1. **A second cron trigger, Discovery only.** `wrangler.jsonc` lists `["0 * * * *", "1-59/2 * * * *"]`. The second expression fires every two minutes on odd minutes, so it never coincides with the hourly minute 0. `src/worker.js` dispatches on `controller.cron`: the fast expression calls only `reconcileDiscoveryRecovery`; every other firing keeps the hourly path unchanged (EPG ensure, Ratings ensure, Monitor, the Discovery reconcile with `scheduled:true`, and the single hourly Discovery report).
2. **The fast tick is a fallback, not a second executor.** It runs no chunk, calls no TMDB, EPG, Ratings or Monitor code and closes no hourly report (`scheduled:false`). The EPG-publication fast start and the durable `step.sleepUntil` of a live instance stay the primary paths.
3. **Cheap when nothing is due.** The tick reads the Workflow record once, reads the published generation pointer once and, only for a record that says an instance is alive, makes one platform status call. A healthy live instance of the published generation, a stopped record whose recovery is not due, a terminal stop and a quarantine end there: no `create()`, no write, no authority read, no ledger scan. The tick hands the case to the existing `reconcileDiscoveryWorkflowAttempt` only for: a dead instance behind a live-looking record, an unarmed stop, a due recovery, **a missing Workflow record, and a record of an older generation than the published one (also while that old instance is still alive)**. The last two are the missed-EPG-handoff cases (the EPG commit queued Discovery but the publication start was lost, or the old instance outlived the publication), so the fast tick covers what the hourly reconcile covers. The reconcile reconstructs the intent and creates the new generation's series 0 under the same admission, CAS and deterministic id. An unreadable published pointer fails closed and is logged as a typed failure.
4. **Safety is the existing safety.** A successor is created only when the recorded `recovery.dueAt` has passed and the existing admission accepts: authority ready and open, no transfer, published generation equal to the record, no EPG priority pause, no projector window, no live lease or other owner. Backoff tiers and quarantine are unchanged. Exactly one owner, series and successor come from the existing expected-etag CAS and the deterministic instance id (`discovery_<generation>_<series>`), also when the fast tick, the hourly tick and a durable wake overlap or a cron repeats. Fencing, priority and the generation pin are not weakened. An unreadable platform status, a held authority and any other ambiguity fail closed.
5. **Observability.** The fast tick distinguishes waiting, started, overdue and refused (with the refusal reason) in the `discovery_recovery_tick` log line and in the outcome, with `kind` `recovery` or `handoff`, and records `recoveryDelayMs`, the time from `dueAt` to the successor start. `incident` is true on **every** outcome whose lateness exceeds five minutes, a late success included (`started` with `recoveryDelayMs` above five minutes), so a recovery that succeeded late still leaves incident evidence after the readout is no longer overdue. A tick that could not decide (`fast_tick_error`, `instance_status_unknown`, `published_unreadable`, `workflow_unavailable`) is logged as `state=failed` with the typed reason, never as success. The executor readout adds `recoveryState` (`none`, `waiting`, `overdue`), `recoveryOverdueMs` and `recoveryIncident`; a recovery more than five minutes overdue is an operational incident and the readout is `degraded`. The expected latency after a due time is the next two-minute tick plus the platform's scheduling delay; this is a target, not an SLA.

Not decided: any production run of Discovery, EPG or TMDB, lease reset or retry, rollover apply, flag, Scheduled Task or Access change, direct D1 or R2 write, migration.

## Alternatives considered

- **A durable wake inside the Workflow only.** Already exists for a live instance (ADR 0098). It cannot see a dead or completed instance, and a second waker would add an instance role and an owner risk without a detector. Rejected as the only mechanism.
- **An event-driven early ensure after a stop.** The EPG fast start already exists and stays; a stop of a running generation has no event of its own to hang an ensure on. Not sufficient alone.
- **Moving the whole cron to two minutes.** Would run the EPG, Ratings and Monitor paths and the hourly report thirty times as often and put the report on the wrong period. Rejected.

## Consequences

- A recoverable stop is taken over about one tick after its due time instead of at the next hour; a killed instance is detected and armed within a tick, then recovered after its backoff.
- Idle cost is one record read and one published-pointer read per tick (1,440 reads a day) and a platform status call while an instance is alive; no writes. Recovery cost is the cost of the existing reconcile, at most once per due time.
- A second schedule entry exists in the live configuration; each deploy replaces the live schedule with `wrangler.jsonc`, so it changes only by pull request.
- Operations must read the two schedule entries as expected (see the [runbook](../runbooks/discovery-workflow-rollover.md#fast-recovery-tick-read-only-checks)).

## Recovery and migration boundary

Code and cron configuration roll back by reverting the pull request; the hourly path is untouched and keeps working. A rollback restores no lost time and no data. This ADR authorizes no production operation; the natural-recovery proof is read-only.

## Evidence

- **Original decision:** the AIR-534 card handoff above.
- **Implementation:** the pull request that adds this file.
- **Dated verification:** [AIR-534 evidence](../evidence/discovery/air-534-false-programme-changed-2026-11-18.md) (offline only).
- **Uncertainty:** that the 18 November `:00` episode was a generation CAS collision is a hypothesis; no production run of the fast tick has been observed.

## Follow-ups

Natural-recovery verification and the owner's visual acceptance stay on [AIR-534](https://trello.com/c/90dyx0Ai).
