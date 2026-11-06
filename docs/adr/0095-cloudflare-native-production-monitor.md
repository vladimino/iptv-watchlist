# ADR 0095: An inert Cloudflare-native monitor diagnoses the four production streams and alerts through an owner-approved webhook

**Status:** Proposed  
**Original decision date:** 2026-11-06 (implementation choice inside the AIR-349 card)  
**Recorded at:** 2026-11-06  
**Approval source:** not documented (Proposed; the owner decides when reviewing the AIR-349 pull request)  
**Related work:** [AIR-349](https://trello.com/c/VUyampoh); [ADR 0089](0089-shared-orchestration-reliability-contract.md); [ADR 0090](0090-ratings-cloudflare-workflow-executor.md); [AIR-344](https://trello.com/c/8TV5soDb)  
**Supersedes:** None  
**Superseded by:** None

## Context

Monitoring of the pipelines depends today on an external ChatGPT drift task that runs once a day and notifies the owner. The plan for autonomous orchestration asks for monitoring that does not depend on ChatGPT or Codex quota, judges the stored result and not the scheduler trigger, and reports actionable anomalies without noise. [ADR 0089](0089-shared-orchestration-reliability-contract.md) already names the health states that the domain executors derive; the monitor reads them and does not recover anything.

## Decision

1. **One more tick on the existing hourly cron.** `scheduled` calls `Monitor.run` next to the other inert ticks. No new trigger, Worker or Workflow is added, and `Monitor.run` never throws into the handler. Hourly is enough for the hour-scale thresholds below; a finer cadence would be a separate decision.
2. **Inert by default: `MONITOR` is `off`, `dry` or `on`.** `off` (absent or any other value) does nothing. `dry` evaluates and logs one line without writing or sending. `on` also keeps one state document and sends alerts when `MONITOR_WEBHOOK_URL` is set. Deployment sets none of them.
3. **Cheap, bounded, read-only facts.** Each stream is read through records the domain already keeps: EPG (`sync.json` and the published pointer), Discovery (continuation, lease and last-chunk records, `continuationHealth`, the Workflow readout when `DISCOVERY_EXECUTOR=workflow`), Ratings (`RatingsOrchestration.readModel`) and the prediction queue (one record). It never streams the Discovery ledger and never reads `programme.json`. A source that cannot be read is reported as an issue of its own and does not hide the others.
4. **Pure policy.** `src/domain/monitor-policy.js` maps facts to `healthy`, `waiting` (by design), `delayed`, `degraded` or `needs_owner`, with the Madrid 17:00 EPG expectation (DST by the IANA zone), the Discovery backoff, the Ratings health and the queue age. `waiting` and `delayed` are recorded and never alert.
5. **Alert policy.** One issue key per condition; `degraded` is confirmed by a second consecutive snapshot, `needs_owner` alerts at once; cooldown 6 hours (degraded) or 2 hours (needs owner); an upgrade escalates; at most eight messages per issue per day; one recovery message for an issue that had alerted. Delivery is claimed before it is sent: the planned messages are committed to `monitor/state.json` (alert state plus an outbox with stable ids) by compare-and-swap, and only the tick that wins that commit sends them. A message that is not delivered stays in the outbox until it is delivered and is retried on every tick with the same id; nothing is aged out or evicted. The outbox is bounded by construction: at most one pending alert-type message per issue key (a newer message for that key replaces the pending one) plus recoveries. Alert accounting (`lastSentAt`, `sendCount`, `sendsToday`) moves only when delivery succeeds, so a failed send never spends the cooldown or the daily quota. An alert that was never delivered raises no recovery: if its issue clears first, the alert is cancelled and counted in `cancelledUndelivered`, which the status shows together with the outbox size and its oldest entry. Delivery is at-least-once, not exactly-once: a crash after the claim or a failed commit of the delivered mark can repeat a message, and the stable `id` in the payload lets the receiver drop the repeat. Prediction activity is real model progress only (a productive completed run or a moved processed counter); a scheduled wake-up that found nothing to do is not progress, and work deferred by its own retry time is waiting.
6. **State.** One R2 document `monitor/state.json` (last snapshot per stream, open issues with send counters, the last published generation seen, `heartbeatAt`, `lastTestAt`). The monitor writes nothing else.
7. **Channel and privacy.** One HTTPS webhook (`MONITOR_WEBHOOK_URL`, a Worker secret chosen by the owner). The payload carries only fixed fields (source, kind, severity, stream, issue key, a short message, overall state): no titles, ratings, credentials or private records. `POST /api/monitor/test` sends one synthetic message through the real channel, changes no domain state and is deduplicated for ten minutes; `GET /api/monitor/status` returns the stored result as a pure read and never the channel URLs.
8. **Dead-man limitation, stated plainly.** A Worker cannot observe its own total outage or a Cloudflare-wide outage. `MONITOR_HEARTBEAT_URL`, when set, is pinged with an HTTPS GET after each saved snapshot, so an external service that alerts when pings stop provides the out-of-band check. Without it the monitor is not an availability check.
9. **Diagnose only.** The monitor does not call `ensure`, `reconcile`, a resolver, a step or a reset. Recovery stays with ADR 0089 and the domain Workflows.

Not decided: activation. Setting `MONITOR`, the webhook and heartbeat secrets, the choice of provider and the first real alert and recovery each need a separate action-specific owner approval.

## Alternatives considered

- **A separate monitor Worker with its own cron:** rejected for now; it adds a deployment and a trigger for a job that fits the existing hourly tick. Not documented as discussed with the owner.
- **Reading `discoveryPipelineStatus` and `predictionQueueOverview`:** rejected; they stream the Discovery ledger or read the large programme record, which is not bounded for a cron.

## Consequences

One more call on the hourly tick (a handful of small reads when `on`, none when `off`), one more R2 key and one new outbound destination when the owner configures a webhook. The thresholds are policy constants and can be tuned in code. The publication time of the EPG is taken from the completed run record or, failing that, from the first time the monitor saw the generation, so a generation that was already stale when the monitor started is flagged only after it has been seen.

## Recovery and migration boundary

Reversible: set `MONITOR` back to `off` (or remove it); code rollback is a revert. The state document and any sent alerts remain. This ADR authorizes no flag, secret, webhook, schedule change or production write.

## Evidence

- **Original decision:** [AIR-349](https://trello.com/c/VUyampoh)
- **Implementation:** the AIR-349 pull request
- **Dated verification:** [offline evidence 2026-11-06](../evidence/monitoring/monitor-air-349-2026-11-06.md); no production observation
- **Uncertainty:** real thresholds against production cadence, the webhook provider's behaviour and the delivery receipt are unobserved until an authorized activation.

## Follow-ups

Activation, the live synthetic alert and owner receipt, and the dead-man provider remain gated by separate owner approval on [AIR-349](https://trello.com/c/VUyampoh).
