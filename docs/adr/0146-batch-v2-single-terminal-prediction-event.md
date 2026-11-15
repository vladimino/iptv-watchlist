# ADR 0146: A batch v2 prediction run writes one terminal Events Log item

**Status:** Accepted  
**Original decision date:** 2026-11-15  
**Recorded at:** 2026-11-15  
**Approval source:** Owner product decision on [AIR-491](https://trello.com/c/aEQ1KNVw)  
**Related work:** [AIR-491](https://trello.com/c/aEQ1KNVw); contracts [ADR 0136](0136-prediction-batch-manifest-size-and-spent-complete.md), [ADR 0107](0107-get-head-read-side-effect-boundary.md), durable outbox [AIR-416](https://trello.com/c/f7FX4Elk)  
**Supersedes:** None (narrows product-facing event *emission* for `protocol=batch_v2` only; does not rewrite ADR 0136 complete semantics or the outbox owner)  
**Superseded by:** None

## Context

Hourly batch v2 runs finish in a few minutes with a handful of films. The Events Log showed two near-duplicate cards per run («Прогнозы запущены» then «Прогнозы обновлены») and printed the internal complete reason `manifest_spent` as «Причина», which ADR 0136 defines as a **normal** short-packet complete, not a failure. Start and mid-run progress Events remain useful for the long v5/continuous runner until that protocol is retired.

## Decision

1. **One user-facing Event per finished `batch_v2` run.** A new `protocol=batch_v2` run does not write `prediction-start-<runId>` or `enrichment-<runId>-progress-…`. After the terminal commit it writes one `enrichment-<runId>` (stable identity), parked in `enrichment/stop-events/<runId>.json` and delivered through the existing Predictions-writer outbox. Replay and concurrent delivery keep one journal key.
2. **Explicit presentation marker.** New terminal objects carry `presentation: "batch_v2_terminal"` (and `protocol: "batch_v2"`). The Events UI uses that field, not the date or title, to choose the packet copy. Historical start/progress/complete objects without the marker keep their previous rendering, including «Причина: manifest_spent».
3. **Copy for marked Events.** `status=complete` and `failed=0`: «Пакет прогнозов обработан», with selected/created/recalculated/failed and stored queue slices; the raw code `manifest_spent` is not shown. `status=complete` and `failed>0`: «Пакет прогнозов обработан с ошибками», not «прерван»; films stay on retry. Systemic `partial` / interruption: «Пакет прогнозов прерван» plus a fixed human sentence; `stopReason` remains on the API object. Ambiguous or zero-change slices must not claim the global queue is drained; `manifest_spent` is not `queue_empty`.
4. **No Event without a run.** `already_running`, `catalog_held`, `manifest_too_large`, idle `noop`/`blocked` before a lease and run exist write no user Event. Per-film failures are not a systemic stop.
5. **Unchanged.** v5 start/progress/stop; outbox budget, quarantine, late recovery; `GET /api/events` remains query-only; prediction_batch_start/submit/complete protocol, leases, manifest size, D1 authority, Scheduled Tasks. Already stored Events are not rewritten, deleted or backfilled.

## Alternatives considered

- **Hide start Events only in the UI** — rejected: the journal would still grow two cards per five-minute run and the raw `manifest_spent` reason would remain.
- **Rewrite or backfill historical cards** — rejected: immutable journal; the marker distinguishes new objects.
- **Change the outbox owner or deliver from GET /api/events** — rejected: that would reopen ADR 0107.

## Consequences

Short batch v2 hours produce one truthful card. Operators still recover an undelivered terminal Event on the next authorized `prediction_start` / `prediction_batch_start` under the writer lease. A Worker rollback does not remove journal items already written with the new marker.

## Recovery and migration boundary

Code and UI only. No production write, Task edit, flag, replay or cleanup is authorized. Rollback is a Worker+UI revert; it does not delete Events or the outbox.

## Evidence

- **Original decision:** [AIR-491](https://trello.com/c/aEQ1KNVw) (15 November 2026, Europe/Madrid)
- **Implementation:** this delivery PR
- **Dated verification:** offline tests `tests/activity-ui.mjs`, `tests/prediction-manifest-size.mjs`, `tests/event-outbox.mjs`
- **Uncertainty:** product acceptance of a live hourly Task A run after deploy (read-only)

## Follow-ups

Owner visual/product acceptance of a natural new batch v2 terminal card after deploy; v5 start/progress Events remain until that runner is retired.
