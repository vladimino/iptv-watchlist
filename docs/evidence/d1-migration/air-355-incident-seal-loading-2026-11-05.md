# Stalled D1 ledger seal blocks EPG and predictions, 5 November 2026

**Card:** [AIR-355](https://trello.com/c/HbhJNQ7V). **Captured:** 2026-11-05 17:39–17:50 UTC. **Sources:** read-only `SELECT` statements on production D1 `iptv`, `epg_status`, Workers telemetry of Worker `iptv` (read-only queries), and offline sqlite stand-ins. **Not done:** no write, EPG commit, discovery chunk, TMDB call, lease or transfer change, flag, Task or R2 access.
**Verdict:** an EPG commit streamed the whole active ledger into D1 inside one request, which needs tens of minutes; the client cancelled it, the transfer stayed `loading`, and the fail-closed read rule blocked consumers that do not need the ledger. No data was lost. This change opens three independent reads only; it does not finish the seal.

Aggregates only: no titles, film ids or payloads.

## 1. Timeline (UTC, 5 November)

| Time | Event | Source |
| --- | --- | --- |
| 15:37 | last discovery chunk of the day; continuation `paused` / `chunk_budget` | D1 |
| 16:03:12–16:05:10 | EPG commit step `193b9989`: `generation_publish` from 16:04:12, outcome `canceled`, wall 119 s, CPU 52 s; no D1 effect (the transfer's `batches` grew by one in total) | telemetry |
| 16:06:32–16:08:28 | step `66ccf1cc`: ledger input scan (20,067 active observations to publish), the seal opened and wrote 328 observations, outcome `canceled`, wall 117.6 s, CPU 42.5 s; last lease renewal 16:07:54 | telemetry, D1 |
| 16:08:43–16:08:58 | step `cb6e15be`: HTTP 502 after 14.5 s, failed in the input scan reading the catalog | telemetry |
| 16:09:23 | the lease expired | D1 |

The write rate of the seal was about 7 observations per second, so publishing 20,064 observations takes roughly 50 minutes against a client that cancels at about 120 seconds.

## 2. D1 state (17:39:57 UTC)

`discovery_authority` `d1` / `open`, programme and published programme `7c1eaadb…`, generation 452. `discovery_transfer` `loading`, programme `5744aef7…`, `batches` 37,000. `discovery_lease` expired at 16:09:23. `published_epg_authority` unchanged (generation 3). Observations: 36,671 `retiring` (previous run) and 328 `active` (new run), 36,999 in all, no duplicates; shows 37,244 (36,456 and 788). Decisions 10,959, admissions 2,714, history 10,977, unchanged since 15:37. Time Travel bookmark at 17:43 UTC: `000001e7-00000000-0000511a-3e8da731dd3536b553ae7ca57c6d9f15` (a reference point; no restore is planned).

## 3. Why it blocks

The ledger handoff writes only the active ledger, the transfer row, the lease and the generation. While the transfer is `loading`, every owned key fails closed (`discovery_incomplete`), including the catalog that the EPG input scan and the prediction queue read first. A retry takes the expired lease and replays the seal from the first observation, so no attempt accumulates progress.

## 4. Offline reproduction and the change

`tests/discovery-seal-interrupted.mjs` reproduces the interrupted handoff on sqlite stand-ins: ledger reads fail closed, a killed attempt holds its lease for the TTL, a replay writes less than the attempt before it, a seal killed in its last batch leaves every row written with the transfer still `loading`. `tests/discovery-seal-reads.mjs` covers the change ([ADR 0091](../../adr/0091-selective-reads-during-a-loading-ledger-seal.md), Proposed): with a production-like partial seal (more `retiring` than `active` rows) the catalog, the status and the continuation are readable, identical to before the seal and marked `transfer: loading`; the ledger, observation reads, the index, decisions, the score preview, the workflow record and every write stay closed; a half-replaced catalog (pending admissions) keeps all three closed; the marker disappears when a seal finishes.

## 5. Limits

- The change does not finish the seal and does not unblock the EPG commit: a retry would replay the seal and be cancelled again. A resumable, bounded seal is a separate delivery.
- Whether the new generation ledger object exists in R2, and whether an EPG Scheduled Task is enabled, were not read.
- The 7 observations per second figure is derived from 328 rows over about 45 seconds of the seal phase; it is an estimate.
