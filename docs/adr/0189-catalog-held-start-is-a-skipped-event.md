# ADR 0189: A Predictions `batch_start` refused with `prediction_catalog_held` leaves one neutral `batch_v2_skipped` Events Log item

**Status:** Accepted  
**Original decision date:** 2026-11-21 (Europe/Madrid)  
**Recorded at:** 2026-11-21  
**Approval source:** [Owner-approved scope of AIR-575](https://trello.com/c/4ncE69Ic) (21 November 2026, Europe/Madrid): every confirmed refusal of a real Predictions `batch_start` with `code=prediction_catalog_held` is recorded as one idempotent warning Event of a skipped attempt, without an invented run. No Task, flag, schedule, lease reset, backfill or production write is authorized by this ADR.  
**Related work:** [AIR-575](https://trello.com/c/4ncE69Ic); [AIR-548](https://trello.com/c/lv04pDu2); [AIR-557](https://trello.com/c/VzNQloU1); [AIR-491](https://trello.com/c/aEQ1KNVw); [AIR-574](https://trello.com/c/ZyUoLRki) (removes the false refusal; independent of this record); [ADR 0180](0180-skipped-predictions-start-is-a-neutral-event.md); [ADR 0146](0146-batch-v2-single-terminal-prediction-event.md); [ADR 0107](0107-get-head-read-side-effect-boundary.md)  
**Supersedes:** None. It **narrows decision 3a of [ADR 0180](0180-skipped-predictions-start-is-a-neutral-event.md) for `catalog_held` only**; `409` refusals, `manifest_too_large`, `queue_changed`, idle `noop`/`blocked`, `lease_expired` and a dry run still write no Event, and every other decision of ADR 0180 stands.  
**Superseded by:** None

## Context

A natural production start of the «IPTV Predictions v2 00» Task on 21 November 2026 (real time 17:04:45–17:05:09 Madrid) was refused with HTTP 503 `code=prediction_catalog_held`, `cause=discovery_incomplete`, with nothing processed. The Events Log showed nothing of the lost attempt: `observedPrediction` deliberately writes no stop Event for `prediction_catalog_held` (correct for run-stop semantics: no run exists and no lease is retained), and [ADR 0180](0180-skipped-predictions-start-is-a-neutral-event.md) recorded only `already_running`. A genuine, safe `catalog_held` can remain after [AIR-574](https://trello.com/c/ZyUoLRki) removes the false one (a real EPG seal, a real catalog replacement), so the attempt must stay visible.

A real start answers `prediction_catalog_held` on five code paths of `batchStartWork`: the preflight, the global `catalog_gate`, the queue refresh, the revalidation under the lease, and the persist step. All of them build the same body through `catalogHeldResponse`.

## Decision

1. **Reuse the skipped Event, add a reason.** One refused request records one `enrichment` Event with `presentation: "batch_v2_skipped"`, `protocol: "batch_v2"`, `stage: "skipped"`, `reason: "catalog_held"`, `cause` (`discovery_fence` or `discovery_incomplete`, only when it is one of those two codes), `at`, `requestId` and `trigger` (only when the request stated one). It has no holder fields, no `runId`, no `queueSchemaVersion`, no counts, no `details`, no film ids and no payload. Its result is `warning` through the existing classifier (AIR-557); it is neither `error`, `interrupted` nor `success`.
2. **One recording point.** The Event is recorded where the route returns, from the answer itself (HTTP 503, `code=prediction_catalog_held`, a known `cause`) and only for a real start (never for `dryRun`). No refusal path can be missed or counted twice, and no new stage has to remember to record.
3. **Identity and delivery are those of ADR 0180.** The Event id is `enrichment-skipped-<requestId>` (the validated `X-Request-Id`, or a Worker-generated UUID); a replayed request id is one journal item, a different request id is a different Event, nothing is merged by time. Delivery is the AIR-416 outbox, index entry first, the parked create-only record `enrichment/stop-events/skipped-<requestId>.json`, then the journal item. The recorder never throws and never changes the 503; a journal outage delays the card until the next successful start; the stated limitation of ADR 0180 (journal and index both down) applies. A request id is one attempt: a replay that is refused for a different reason reads back the first record.
3a. **The recorder's guarantee is narrow.** The recorder mutates only the Event and its outbox entry: it creates no run, run id, retry, film or diagnostics row and no stop Event, and it returns the original 503. It infers nothing beyond the final refusal body, so it does not assert that nothing else happened before the refusal: a keyed start may have acquired and released its own claim, and `batchRefreshQueue` may have made a guarded queue settlement (both as defined by [ADR 0188](0188-idempotent-keyed-batch-start-and-early-start-claim.md)); those effects stay as the runner defines them and the Event neither adds nor removes them. The 503 body, `scheduledRunFields`, the 503 body, `scheduledRunFields`, the `next`/`submit`/`complete` 503 of an owned run and the Discovery gate itself are untouched. No GET writes the Event ([ADR 0107](0107-get-head-read-side-effect-boundary.md)).
4. **Events screen.** The existing neutral card gets a second fixed sentence: «Запуск прогнозов пропущен: каталог временно недоступен», states only that the attempt was refused and that its films were not processed (never that the queue or the lease was untouched), gives a fixed cause sentence that does not name an EPG publication (a genuine catalog replacement hold, which [AIR-574](https://trello.com/c/ZyUoLRki) keeps, gives the same answer; the cause is read through a two-value list, never printed as stored), the request id and the code `prediction_catalog_held`. It appears in «Все события», «Прогнозы» and «Пропущенные», and under the result «Предупреждение». Filters for `already_running`, successful and partial runs are unchanged.
5. **Not in scope.** No backfill of the 21 November event or of any earlier refusal, no synthetic production Event, no change of Task prompts, cadence or S7, no alert (AIR-556/AIR-573), no migration, no new flag.

## Alternatives considered

- **A separate presentation (`batch_v2_catalog_held`).** Rejected: it needs a new filter, a new classifier branch and a new baseline exclusion for the same neutral idea; the owner asked for the existing «Пропущенные» surface.
- **Record inside each of the five refusal paths.** Rejected: five places to keep consistent and a double record when one path falls through to another.
- **A stop Event through `observedPrediction`.** Rejected: it would invent a run stop for a start that took no lease and created no run (ADR 0146, ADR 0180).
- **Write the Event from a read or status call.** Rejected ([ADR 0107](0107-get-head-read-side-effect-boundary.md)).

## Consequences

Each lost slot caused by a held catalog is visible with a short honest card, as a lease refusal already is. Cost: a few small R2 operations on an already refused request. A refusal storm adds one small journal item per refused request. After AIR-574 the card should be rare.

## Recovery and migration boundary

Code, UI and documentation only. No production write, Task edit, flag, lease reset, replay or backfill is authorized. Rollback is a reviewed Worker and UI revert; stored skipped Events stay in the journal and the previous UI renders them as the generic lease-refusal card or a generic prediction card (no data is lost).

## Evidence

- **Original decision:** [AIR-575](https://trello.com/c/4ncE69Ic) (21 November 2026, Europe/Madrid); production fact on the card (requestId `9db4b9eb-0567-4fd8-a378-3c17f24fc4ac`, read-only timing).
- **Offline acceptance:** `tests/prediction-catalog-held-event.mjs` (both causes, gate, preflight and lease paths, replay, distinct ids, dry run / rejected body / success / `already_running`, journal outage and outbox recovery), `tests/prediction-start-diagnostics.mjs`, `tests/activity-ui.mjs`, `tests/events-result-status.mjs`, `tests/events-type-filter.mjs`.
- **Not proven without a live refusal:** a natural `catalog_held` is not provoked; it is read-only observed when it occurs (`GET /api/events`, then `/events?type=skipped&result=warning`).
