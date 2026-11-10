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

## Owner-approved start after the overlay change, 10 November 2026

Capture: the Trello handoff, read-only MCP, Cloudflare telemetry (events view, service `iptv`, 16:41:30–16:45:00 UTC, 44 events) and an R2 object-size listing. The owner ran the paused Task once (16:41:56–16:44:23 UTC) on `e49d7ef`.

- The queue was rebuilt on the published generation `e38e3f5c…` (`refreshedAt` 16:43:13 UTC, `consistent: true`, 5450 outstanding: 3974 hot, 1476 cold) and run `0a55802d…` was saved at 16:43:23 UTC. The overlay and the `dict1` write therefore work at production volume.
- The Task reported that it could not serialize the `prediction_start` answer. Telemetry shows why: exactly one `POST /mcp` invocation in the window ended with `outcome: exceededMemory`, HTTP 503, wall 48.9 s, CPU 12.7 s, logged at 16:43:42 UTC. Every other `/mcp` invocation is `ok`. There is no `prediction_boundary_failed` and no `prediction_domain_budget` event in the window. The caller received a platform 503, not a start answer; the answer itself is about 3.3 thousand characters and plain JSON. The invocation is tied to the start by time and by being the only failed request; the log carries no run id.
- The start read its large inputs repeatedly in one request: the catalog three times (batch selection, queue rebuild, start event), the view index twice (each with its D1 overlay) and the programme up to three times. The isolate ended after the run was saved, in the steps that read them again for the start event.
- Sizes at capture: `view-index.json` 8.59 MB, generation `programme.json` 2.36 MB, shared `epg/discovered-films.json` 7.67 MB (last modified 4 Nov; whether the start's catalog is this object or a larger D1-assembled one was not established).

Change: the queue rebuild hands the inputs it read to the start, which reuses them for the batch selection and the start event. `scripts/prediction-start-heap-profile.mjs` (synthetic data: catalog 23.1 MB for 8704 films, index 10.3 MB, programme 1.9 MB; live V8 heap after a forced collection at every storage call) gives:

| Version | Catalog / index / programme reads | Peak live heap above the idle Worker |
| --- | --- | --- |
| before (`e49d7ef`) | 3 / 2 / 3 | 96.3 MB |
| after | 1 / 1 / 2 | 66.6 MB |

Limits: Node's heap ranks the versions; it is not workerd's 128 MB isolate limit, and the synthetic catalog size is an assumption. The profile has no D1, so the overlay's own allocations and the D1-assembled programme are not in it. Whether the reduced start fits the production isolate is shown only by the next owner-approved start. The run `0a55802d…` was left to the ordinary lease recovery.

## Start during an EPG seal, 10 November 2026

Capture: the Trello handoff, Cloudflare telemetry (events view, service `iptv`, 13:37–17:37 UTC) and read-only MCP. The owner ran the paused Task once on `1898fec` (17:30:11–17:32:35 UTC); `prediction_start` answered 502 `storage_error`, request `afb03a95…`, run `c9544245…`.

- The log line added earlier names the failure exactly, with the same request and run ids: `{"event":"prediction_boundary_failed","boundary":"start","stage":"queue_refresh","code":"discovery_fence","kind":"error"}` at 17:31:42.932 UTC. No `prediction_domain_budget` event after 15:35 UTC and no `exceededMemory` on a `/mcp` invocation in that minute: this failure is neither the budget nor the memory limit.
- The natural EPG Workflow of 10 November was sealing at the time (`seal/catalog` at 17:19 UTC, then `finalize`; the published generation moved from `e38e3f5c…` to `6d9e3c36…`). While a publication holds the Discovery authority a catalog read is refused with `discovery_fence`, so the queue rebuild of the start could not read its catalog. The start treated that wait as a storage failure, after taking the runner lease.
- At 17:35:43 UTC the queue was rebuilt on `6d9e3c36…` (`consistent: true`, 5450 outstanding: 4047 hot, 1403 cold). The EPG Workflow instance `epg_20261110_0` then ended with `exceededMemory` at 17:36:04 UTC (wall 1137 s); that is an EPG observation outside this change and was not investigated here.
- Whether the reduced-memory start of the previous section fits the production isolate is still untested: this start failed before it could show it.

Change: `start` reads the Discovery authority before the runner lease and answers `503 blocked` `prediction_catalog_held` when it is held or loading; a rebuild refused with `discovery_fence` or `discovery_incomplete` after the lease releases it and gives the same answer. No stop Event, no change to the queue or retries. `tests/prediction-start-diagnostics.mjs` covers both causes on both paths, an unrelated rebuild failure staying 502, and the start after the publication rebuilding the queue on the new generation with its retry record kept and a working first `next`.

Limits: `next`, `submit` and `complete` of a running run also rebuild the queue and are not changed; a seal that begins during a run can still stop it with `storage_error`, which the next start recovers. The external Task prompt was not changed; how it words a `blocked` start is its own behaviour.
