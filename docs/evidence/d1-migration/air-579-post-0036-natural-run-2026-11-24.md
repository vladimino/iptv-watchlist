# AIR-579: the first natural EPG/Discovery run after migration 0036, and the owner's acceptance (24 Nov 2026)

**Card:** [AIR-579](https://trello.com/c/OlcWhyM7). **What this page is:** the dated record of the read-only (L0) verification of 24 Nov 2026 on the first natural EPG run and Discovery catch-up after production D1 `iptv` reached schema 36, compared with the window of the [RCA of 22 Nov 2026](air-579-d1-overload-rca-2026-11-22.md), and the owner's final acceptance of the card. It closes the open point of the [0036 apply evidence](air-579-0036-apply-2026-11-23.md) (published by [PR #953](https://github.com/vladimino/iptv-watchlist/pull/953)), which claimed no performance effect until a natural run. The RCA, the 0036 apply page and the earlier AIR-579 pages are history and are not rewritten.

## Sources and provenance

- **The verification:** the independent L0 verification recorded on the card at 24 Nov 2026 18:23 UTC (19:22 Madrid), [comment `6b05d615`](https://trello.com/c/OlcWhyM7#comment-6b05d615503b76480d8277e7). Every figure on this page is transcribed from it. The executor who wrote this page did **not** repeat the reads and made no production call for it.
- **The owner decision:** the card at 24 Nov 2026 18:24:55 UTC (19:24 Madrid), [comment `6b05d677`](https://trello.com/c/OlcWhyM7#comment-6b05d677896aaf36d4a01a9d).
- **What was read (as recorded):** D1 analytics SQL over `events.d1Queries` for database `iptv`; a Workers Observability aggregation; the aggregate of the `discovery_catalog_read` log lines; the EPG and Discovery status. Reads only: no D1 SQL was executed against the database (analytics only), nothing was triggered and nothing was written. No EPG, Discovery, Predictions, Task, flag, Workflow, cron, R2 or authority operation was run to produce this observation, and none was run for this page.

## What lies between the two windows

The AIR-579 changes merged to `main` between the RCA window (22 Nov) and this one (24 Nov): the per-observation slot read by coordinates ([PR #917](https://github.com/vladimino/iptv-watchlist/pull/917), [offline evidence](air-579-held-slot-read-offline-2026-11-22.md)), `prediction_pending` without the whole-catalog read ([PR #920](https://github.com/vladimino/iptv-watchlist/pull/920)), the MCP tool-call log line ([PR #925](https://github.com/vladimino/iptv-watchlist/pull/925)), the `discovery_catalog_read` log line ([PR #941](https://github.com/vladimino/iptv-watchlist/pull/941), [L0 observation](air-579-post-925-l0-observation-2026-11-23.md)), and migration `0036` ([PR #937](https://github.com/vladimino/iptv-watchlist/pull/937), operator [PR #945](https://github.com/vladimino/iptv-watchlist/pull/945)), applied on 23 Nov 2026 19:32 UTC: the partial index `published_epg_show_discovery_by_match` and the index `film_external_id_by_scheme_value` ([apply evidence](air-579-0036-apply-2026-11-23.md)). The projected user reads of the whole catalog came from AIR-586 ([PR #957](https://github.com/vladimino/iptv-watchlist/pull/957), [evidence](../user-read-oom-rca-2026-11-23.md)). Each merge deploys through the normal pipeline; the Worker version live on 24 Nov 16:00 UTC was not read for this page. Other deployments and data changes between the two windows were **not inventoried** (see the comparability limits).

## EPG and Discovery at the time of the observation (point in time, UTC)

- **EPG:** run `234e3cbd-3906-4006-8575-8673cab91bf9`, published 16:05:57, complete 16:06:17, `healthy`, failures 0.
- **Discovery, read at 18:22:11:** the same programme run; authority `d1` / `open`; transfer `committed`; Workflow series 11 `running` with a live lease; remaining ledger 2,345; `cheapRemaining` 0; interruptions 0; `generationConflict` false; `stalled` false.
- The catch-up was **still running** when it was read. Its completion was not observed and is not claimed here.

## D1 analytics: the same window on both days

**Windows:** 22 Nov 2026 16:00-18:20 UTC (the RCA day) and 24 Nov 2026 16:00-18:20 UTC, D1 `iptv`, `events.d1Queries`. Means are weighted by the sampling interval: rows read = `sum(rowsRead * sampleInterval) / sum(sampleInterval)`, and the same weighting for duration. **Samples** are the number of sampled records of the signature in the window, not executions.

| Signature (shape) | Mean rows read per execution, 22 Nov → 24 Nov | Mean duration, 22 Nov → 24 Nov | Samples, 22 Nov → 24 Nov |
| --- | --- | --- | --- |
| `DELETE` from `published_epg_show` by `match_reason` (`ASSIGNED_ROWS_DELETE`) | 19,754.01 → **1** | 33.20 ms → **0.23 ms** | 1,039 → 194 |
| `film_external_id`, single lookup `scheme = 'tmdb' AND value = ?` | 13,740.76 → **1.69** | 2.12 ms → **0.80 ms** | 685 → 155 |
| `film_external_id`, batch `scheme IN (...) AND value IN (SELECT value FROM json_each(?))` | 15,260.20 → **4,942.11** | 3.59 ms → **2.30 ms** | 1,161 → 722 |
| `film_external_id`, dual `(scheme = 'tmdb' AND value = ?) OR (scheme = 'letterboxd' AND value = ?)` | (22 Nov only) | (22 Nov only) | 505 → **0** |
| Whole-catalog `discovery_admission` read | 12,164.12 → 12,429.91 | 380.61 ms → 409.30 ms | 358 → 164 |

For the whole-catalog read the weighted execution estimate (`sum(sampleInterval)`) was **20,292 → 6,782**. It compares the two days under the same method only. It is not reconciled with the execution counts of the RCA tables (another aggregation, `d1QueriesAdaptiveGroups`, over 16:00-19:00), and no figure on this page should be read against those counts.

## Observed, inferred and not established

**Observed** (the analytics above):

- The assigned-rows delete reads about one row per execution instead of about 19.8 k, and takes 0.23 ms instead of 33.2 ms.
- The single `(scheme, value)` lookup reads 1.69 rows per execution instead of about 13.7 k.
- The batch `(scheme, value)` lookup reads about two thirds fewer rows (15.3 k → 4.9 k) and is about a third faster.
- The whole-catalog read costs about the same per execution, slightly more (12.2 k → 12.4 k rows, 381 → 409 ms). The rise is consistent with a slightly larger catalog, which was not measured. Fewer samples and a lower weighted execution estimate were seen on 24 Nov.
- The dual lookup has **no sample** on 24 Nov.

**Inferred** (from the plans read back after the 0036 apply, not from a production plan of 24 Nov):

- The delete and the single lookup now use the new indexes: their row counts fall to the per-key level that the read-back `EXPLAIN QUERY PLAN` predicts (`SEARCH ... published_epg_show_discovery_by_match`, `SEARCH ... film_external_id_by_scheme_value`).

**Not established:**

- Why the batch lookup still reads about 4.9 k rows per execution (the size of the lists per call, a plan chosen per execution, or another statement grouped under the same signature).
- The effect of the index on the dual lookup in production. No matching sampled record was returned for 24 Nov, so its live performance effect cannot be established; the lookup may have executed without being sampled. The offline evidence for it is in the [0036 offline page](air-579-0036-lookup-indexes-offline-2026-11-23.md).
- Any causal statement about throughput or the number of executions. The workload of the two days differs (see below), so fewer samples of the whole-catalog read do not prove that a change removed reads.
- The `ledgerArchive` count and the `sqlite_master` introspection (RCA hotspots 3 and 6) were not part of this observation.

## Errors in the 24 Nov window

- **Workers Observability aggregation** (24 Nov, the same window): 238 outcomes `ok` and 18 `canceled`. No CPU-limit or out-of-memory outcome in the returned aggregates. The 18 `canceled` outcomes are not classified in the record.
- **D1 error aggregate** for the window: empty.
- This covers the returned aggregates of this window only. It is **not** a claim that no error happened outside the window, or that no error happened that these aggregates do not show.

## Whole-catalog read attribution (`discovery_catalog_read`)

- **Discovery:** the top groups of the log aggregate include the current Discovery instances, series 5 to 10, with `projected` false (12 to 18 lines per group).
- **User reads:** the user `GET` routes for programme, view, catalog and footer have `projected` true (14 to 16 lines each).
- **Limits:**
  - The record states no separate window for this aggregate.
  - The line count is a lower bound of executions ([log line limits](air-579-post-925-l0-observation-2026-11-23.md#limits-of-the-signal)).
  - A projected read still executes the full catalog SQL. Projection lowers what the Worker keeps in memory. It does not remove the D1 read.
- **Result:** the expensive whole-catalog SQL remains, and it is the known residual of this card. The comparison neither establishes nor rules out a regression of it: the workloads differ, and the per-execution means rose slightly.

## Comparability limits

- **Same window, different workload.** The two windows have the same clock time but not the same work. 22 Nov held the RCA burst (an EPG run plus a long Discovery catch-up, 24 Discovery instances in 16:00-19:00). On 24 Nov the catch-up was still running at series 11 at 18:22. The ledger size, the number of Discovery series, user traffic and Predictions activity of the two days were not equalised.
- **Sampled analytics.** Samples and weighted means come from sampled analytics. The 24 Nov window is one observation, not a series.
- **Not proven:**
  - full catch-up completion;
  - a live observation of the dual lookup signature;
  - a production `EXPLAIN QUERY PLAN` on 24 Nov;
  - an inventory of the other deployments between the windows.

## Owner acceptance

On 24 Nov 2026 at 18:24:55 UTC (19:24 Madrid) the owner accepted AIR-579 after the independent verification ([comment `6b05d677`](https://trello.com/c/OlcWhyM7#comment-6b05d677896aaf36d4a01a9d)). Translated from Russian: "we're closing it. This doesn't get in the way; on the contrary, the final result of all the optimizations has been impressive two days in a row."

What the decision records:

- **Accepted:** the measured substantial improvements, together with the known limits: the cost of the whole-catalog read, no sample of the dual lookup, and the catch-up not complete at the moment of observation.
- **No further checks:** no further performance or production check is required for acceptance.
- **Residual optimization:** it does not block the closure, and it does not authorize any new implementation scope.

The owner's "two days in a row" is the owner's own observation. It is not separately measured on this page.

## Not done and not claimed

- No D1 SQL against the database, no production `EXPLAIN`, no write, no run started, no flag, Task, Workflow, cron, R2 or authority change.
- No change to the AIR-554 D1 gate proposed in the RCA. AIR-554 stays under its own procedure.
- No claim that Discovery finished, that the full-catalog read is fixed, or that the 22 Nov burst cannot recur under a comparable catch-up.
