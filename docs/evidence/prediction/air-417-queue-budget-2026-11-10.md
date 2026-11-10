# Prediction queue budget refusal, 10 November 2026

[AIR-417](https://trello.com/c/CGkINDmh) · capture 10 November 2026, about 15:30–17:00 Madrid (14:30–16:00 UTC). Read-only observation, offline reconstruction and local tests. No production write, no Task, no model run, no start retry.

## Observation (read-only MCP)

- `epg_status`: published generation `e38e3f5c…` (9 Nov), `stage: complete`, `enrichmentQueueError: prediction_domain_budget`.
- `prediction_queue_overview` and `enrichment_queue`: the queue is still on `29146e6a…` (refreshed 8 Nov 18:17 UTC), `consistent: false`, `queue_programme_differs`; 3109 outstanding (2642 hot, 467 cold), 0 deferred by retry; 3255 of 8704 films current.
- Cloudflare telemetry (events view, 26 h, service `iptv`): zero events for `prediction_domain_budget`, `storage_error` or `prediction_domain`. The Worker did not log the code, so **the logs cannot name the refusing limit**.

## Reconstruction

The queue document holds each outstanding film in `pending`, one of `hotPending` or `coldPending`, `priority` and (for pending films) `work`, about 300 characters per hot film. With the real shapes and synthetic ids:

| Case | Plain JSON characters | Against the 900000 cap |
| --- | --- | --- |
| 8 Nov generation, 2642 hot and 467 cold | 826–839 thousand | 92–93% |
| about 3500 outstanding | about 947 thousand | 105% |
| 5449 outstanding (8704 films, 3255 current) | 1.44–1.47 million | 160–163% |

The 8 Nov queue already sat near the cap, so a rebuild on the larger 9 Nov generation exceeds `PREDICTION_QUEUE_CHARS` as plain text. **This is a reconstruction, not a production measurement.** The 5000-key `PREDICTION_INDEX_LIMIT` in `overlayIndex` and the statement limits were not excluded: the number of view-index keys is not readable from a read-only tool. The change below makes the next refusal name its limit.

## Change and measurement

The queue text is stored plain while it fits and in the `dict1` encoding above the cap; `loadQueue` expands it to the identical document. Local test `tests/prediction-queue-budget.mjs` on the SQLite D1 stand-in, old to new generation:

- plain 1,465,331 characters, encoded 261,267 (ratio 0.18), 7 chunks, each statement under 100 KB; write about 80 ms.
- the 8 Nov size stays byte-identical plain; a rebuild back under the cap returns to plain text.
- read-back equals the plain document for hot and cold lists, priority, work, retries and order, including integer-like ids; the R2 mirror stays plain.
- a stale head never lands, encoded or plain; three concurrent writers per round produce exactly one winner; an unknown D1 batch failure leaves the previous queue; damaged or unknown encodings fail closed; a document over the cap even encoded is refused with `guard: queue_chars` and changes nothing; a failed refresh followed by a rebuild lands consistently.

## Limits and rollback

- The refusing limit in production is unproven until the next rebuild runs on the new Worker and either lands or reports `prediction_domain_budget:<guard>`.
- Not measured: D1 wall time and query count on production; the stand-in has no network latency.
- A Worker without `dict1` support fails closed on an encoded queue (the stored text starts with `dict1:` and is not valid JSON) and cannot rebuild it; the independent review found that a plain-rewrite needs a compatible build. The first build with `dict1` wrote the encoded text without the prefix; reads accept both forms and every new write carries the prefix. Code rollback does not rewrite D1 rows ([runbook](../../runbooks/prediction-operations.md#prediction-queue-conflicts)).
- This delivery does not show that the persisted queue is repaired. That needs a successful writer after deploy, which needs the owner's operation-specific approval.

## Production acceptance after the first deploy, 10 November 2026

Capture: Cloudflare telemetry (events view, service `iptv`, 15:34:00–15:36:30 UTC, 63 events), the Trello handoff and read-only MCP. The owner resumed the hourly Task and started it twice after the deploy of `036e9ed`; both starts answered 502 `storage_error` (runs started 15:34:24 and 15:34:40 UTC, no `next`, queue unchanged on the 8 Nov generation).

- The only non-`info` events in the window are two lines `{"event":"prediction_domain_budget","guard":"index_limit"}` at 15:34:42.679 and 15:35:28.336 UTC, both on `POST /mcp`. No other warning, error or D1 exception is in the window. The two lines are correlated with the two starts **by time only**: the log carries no run id, and the 502 answer discarded the error, so the stage that raised it was not recorded.
- `index_limit` is raised in one place: `overlayIndex` refuses a view index with more than 5000 keys. The first change (`dict1`) addressed the queue-size limit, which was an unproven candidate; it did not reach this guard. The earlier statement that the refusing limit was unproven stands for that change; for this one the guard is named by production telemetry.
- The index overlay (a caller of the queue rebuild, the view and the admin health read) asked D1 for every key of the view index, 80 keys per query, two queries per chunk: 218 queries for 8704 keys.

Change: the overlay reads the prediction rows in keyset pages of 300 and applies those of indexed films. Local result on the SQLite stand-in with 8704 index keys, 3254 fingerprint rows and 3255 pointer rows: 25 queries against about 221 (including the authority marker reads), 58 ms; parity with a per-film reading on 900 keys, page boundaries 0/299/300/301/600, a table at and above 20000 rows (refused with `guard: overlay_rows`), a damaged row of an indexed film (fails closed), rows of films outside the index (ignored). A failed start now writes one sanitized line with the stage, code and guard; each pre-`next` stage was fault-injected in a test and the lease semantics checked.

Limits: the overlay is the guard that production telemetry named, but it is not proven to be the last blocker on the start path. CPU and wall time of the rebuild with the full 8704-film catalogue in the Worker were not measured (the test harness has no D1-backed Worker). The queue rebuild, the dict1 write and the first `next` on production are verified only by a start the owner approves; until then the persisted queue is unchanged.
