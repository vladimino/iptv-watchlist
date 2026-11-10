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
- A Worker without `dict1` support cannot read an encoded queue and fails closed; code rollback does not rewrite D1 rows ([runbook](../../runbooks/prediction-operations.md#prediction-queue-conflicts)).
- This delivery does not show that the persisted queue is repaired. That needs a successful writer after deploy, which needs the owner's operation-specific approval.
