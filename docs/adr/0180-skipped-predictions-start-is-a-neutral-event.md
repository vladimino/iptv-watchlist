# ADR 0180: A Predictions `batch_start` turned away by a live runner lease leaves one neutral `batch_v2_skipped` Events Log item

**Status:** Accepted  
**Original decision date:** 2026-11-20 (Europe/Madrid)  
**Recorded at:** 2026-11-19 (UTC)  
**Approval source:** [Owner product decision recorded on AIR-548](https://trello.com/c/lv04pDu2) (20 November 2026, Europe/Madrid): make skipped Predictions starts visible in Events with their own filter. No Task, flag, schedule, TTL, lease reset or production write is authorized by this ADR.  
**Related work:** [AIR-548](https://trello.com/c/lv04pDu2); [AIR-491](https://trello.com/c/aEQ1KNVw); [AIR-544](https://trello.com/c/w6lw3KYy); [AIR-416](https://trello.com/c/f7FX4Elk); [AIR-381](https://trello.com/c/OGaEiHDS); [AIR-530](https://trello.com/c/iTstlCo7); [ADR 0146](0146-batch-v2-single-terminal-prediction-event.md); [ADR 0107](0107-get-head-read-side-effect-boundary.md)  
**Supersedes:** None. It **narrows decision 4 of [ADR 0146](0146-batch-v2-single-terminal-prediction-event.md) for `already_running` only**; the other cases of that decision (`catalog_held`, `manifest_too_large`, idle `noop`/`blocked`) still write no Event, and decisions 1–3 and 5 stand.  
**Superseded by:** None (decision 3a is narrowed for `catalog_held` by [ADR 0190](0190-catalog-held-start-is-a-skipped-event.md))

## Context

After [ADR 0146](0146-batch-v2-single-terminal-prediction-event.md) the Events Log shows one terminal card per batch v2 run that actually ran. A `batch_start` that a live runner lease turns away creates no run, so it is invisible there: the Worker answers `already_running` (HTTP 200) and keeps only a diagnostics row. Read-only Workers telemetry for 18–19 November 2026 ([AIR-544](https://trello.com/c/w6lw3KYy)) showed 107 `batch_start` requests with 16 request-level lease refusals. The owner asked for those skipped starts to be visible and filterable. This is independent of any later change of schedule or lease TTL.

There are two places where a real start is refused for a live lease: the early check (`batchTurnedAway`) and the lease acquire after the preflight, where a competing start won the race.

## Decision

1. **One Event per refused request.** On either path, when the answer is `already_running`, the Worker records one `enrichment` Event: `presentation: "batch_v2_skipped"`, `protocol: "batch_v2"`, `stage: "skipped"`, `reason: "already_running"`, `at` (the refusal), `requestId`, `trigger` (`scheduled` or `manual`, only when the request stated one), and, when known, `holderRunId` and `holderAgeMs`. It has **no `runId` of its own, no `queueSchemaVersion`, no counts and no `details`**: it never claims that films were processed and gives no new batch id.
2. **Identity is the request.** The Event id is `enrichment-skipped-<requestId>` (the validated `X-Request-Id`, or a Worker-generated UUID when the caller sent none). A replayed request id is one journal item; a different request id is a different Event. Requests are never merged by minute or heuristic, and the card says "attempt", not "Scheduled Task tick", because no verifiable invocation identity exists.
3. **Durable delivery reuses the AIR-416 outbox, index first.** The outbox index entry (`enrichment/event-outbox.json`) is written **before** the Event is parked create-only in `enrichment/stop-events/skipped-<requestId>.json`, so a parked record never exists without an entry that finds it and cannot be orphaned (review of PR #805). The journal write then goes through the existing `flushStopEvent`; on success the entry is removed at once (otherwise the next sweep finds the record delivered and removes it), on failure the entry stays and `deliverPendingEvents` of the next authorized start delivers it with the same bounded retries and quarantine, whatever its request id. A repeated write reads the first record back (same `at`, same journal key). The parked record is also the request's idempotency identity (it holds `at`, part of the journal key): **no journal item is ever written for a request whose record is not parked, and a record whose journal outcome is not known to be absent is never deleted**, so replaying one request id always reuses the same `at` and can never create a second item. The journal write and the `delivered` marker are separate steps: an item that exists counts as delivered even when the marker cannot be written (the next sweep or a replay rewrites the same item and marks it). If the index cannot be written the record is still parked and delivered once; it is deleted again only when a `head` of the journal key proves the item absent. An unknown outcome (the `head` fails too) keeps the record, which is replay-safe. If the park fails after the index entry, nothing is journaled and the entry, whose record is `absent`, leaves the index at the next sweep. The recorder never throws and never changes the `already_running` answer, the diagnostics row, the lease, the queue, the run or any film. No GET writes it ([ADR 0107](0107-get-head-read-side-effect-boundary.md)).
3b. **Stated limitation.** If the journal **and** the outbox index are both unwritable at the moment of one refusal, or the park fails, or the process ends between the index entry and the park, that one skipped Event is not recorded (a later replay of the same request id records it once). The answer is unaffected and nothing is left orphaned. This is the price of no listing and no second index; it is flagged for owner acceptance on AIR-548.
3a. **Only `already_running`** (narrowed by [ADR 0190](0190-catalog-held-start-is-a-skipped-event.md): `catalog_held` is now recorded too, with `reason: "catalog_held"`). A `409` refusal, `catalog_held` (before ADR 0190), `manifest_too_large`, `queue_changed`, idle `noop`/`blocked`, `lease_expired`, a dry run and any lease status other than `already_running` are not reclassified and write no skipped Event.
4. **Events screen.** A neutral card «Запуск прогнозов пропущен: предыдущий ещё выполняется» with the time, the trigger when stored, the holder (short run id and age when stored), the request id and the code. No error styling, no packet title, no counts, no Telegram alert. The filter «Тип событий» gains «Пропущенные» (`presentation=batch_v2_skipped`); «Прогнозы» and «Все события» show it too. A skipped Event is never the queue-comparison baseline of a later prediction card.
5. **Unchanged.** One terminal Event per run that ran, historical `batch_v2_terminal` and v5 objects, the outbox budget and quarantine, lease, queue and prediction semantics, schema, Scheduled Tasks, schedule and TTL. No migration, no flag, no backfill of earlier refusals.

## Alternatives considered

- **A diagnostics-only counter** — rejected by the owner: the skipped starts must be visible in the Events feed with a filter.
- **A start/progress card for every start** — rejected: it would reopen [ADR 0146](0146-batch-v2-single-terminal-prediction-event.md), which removed two cards per run.
- **Deduplicate by minute** — rejected: no verifiable Task invocation identity; two independent refusals could disappear.
- **Write the Event from a read or a status call** — rejected ([ADR 0107](0107-get-head-read-side-effect-boundary.md)).

## Consequences

Each lost slot is visible, with a short, honest card. Cost: a handful of small R2 operations on an already-refused request (index entry, record, journal item, index removal; two index writes are compare-and-swap). Under heavy refusal traffic the journal grows by one small item per refused request. A journal outage delays the card until the next successful start; it never fails the refused request.

## Recovery and migration boundary

Code and UI only. No production write, Task edit, flag, lease reset, replay or cleanup is authorized. Rollback is a reviewed Worker and UI revert; already stored skipped Events stay in the journal and remain renderable by the old UI as a generic prediction card.

## Evidence

- **Original decision:** [AIR-548](https://trello.com/c/lv04pDu2) (20 November 2026, Europe/Madrid).
- **Offline acceptance:** `tests/prediction-skipped-event.mjs` (both refusal paths, replay, distinct ids, no-event cases, journal outage and outbox recovery, unchanged runner), `tests/activity-ui.mjs` and `tests/events-type-filter.mjs` (card, filter, baseline).
- **Not proven without a live collision:** a real `already_running` of a natural hourly Task is not provoked; it is read-only observed when it occurs.
