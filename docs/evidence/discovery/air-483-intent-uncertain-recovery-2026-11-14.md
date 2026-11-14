# AIR-483: hourly `intent_uncertain` without Discovery recovery (13-14 November 2026)

Method: code reading and offline tests only, 14 November 2026 UTC. No production read, write or run.

## Observed (from the card's L0 record, not re-measured here)

- The Discovery Workflow of the published generation stored a `programme_changed` chunk on 13 Nov at 19:00 UTC and stopped.
- From 20:00 UTC on 13 Nov to 16:00 UTC on 14 Nov every hourly reconcile answered `intent_uncertain` and created no Workflow instance.

## Inferred

- `ensurePublishedDiscoveryIntent` collapsed every `queueDiscovery` error into `intent_uncertain`. The scheduled reconcile retries in the same tick only `projector_window`, so a `discovery_window` refusal of the continuation write (the hourly :00 tick coincides with the projector window) was never retried. Offline, a held window now reproduces this on the old code and recovers after expiry on the fixed code.

## Unknown

- Which branch produced the 13 Nov `programme_changed` (`currentProgrammeRunId` is lost from `chunkSummary`), and whether the projector window was actually held at each of the 21 ticks. The window-contention cause is a hypothesis, not a proven root cause.

## Fix and limits

Typed refusals map to `projector_window` (bounded same-tick retry), `epg_priority` (wait, no loop) and `authority_held` (fail closed); unknown errors stay `intent_uncertain`. Production recovery is not proven; it needs read-only natural acceptance on later hourly ticks. This is unrelated to the AIR-482 Cron memory incident.
