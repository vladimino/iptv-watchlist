# D1 discovery chunk: lease renewal, wall budget and timings, 5 November 2026

**Card:** [AIR-352](https://trello.com/c/IJsGZJNN), follow-up of the read-only RCA [AIR-351](https://trello.com/c/umaIPZgC).
**Captured:** 2026-11-05 04:30–06:00 UTC. **Offline:** Node 22.23 in the agent container, `main` `e7a2a47`, local sqlite stand-ins (`tests/d1-standin.mjs`). **Read-only production reads** (RCA, 04:30 UTC): `epg_status`, `epg_pipeline_status`, Workers telemetry and deployments of Worker `iptv`, `SELECT` statements on D1 `iptv`.
**Not done:** no `epg_sync_step`, resolve, TMDB call, lease change, flag, Task, migration or R2/D1 write. No real chunk was run.
**Verdict:** the paged chunk had two wall-clock limits it did not respect (a client timeout of about 60 s and a 90 s lease that D1 cannot renew once expired). The change renews the lease on every long phase, reads the ledger concurrently, stops at a 40 s budget and records its own timings. Whether a production chunk now reaches its checkpoint is **not established**; that needs its own owner GO. The paged chunk also persists no decisions yet; that is the second delivery of this card.

Aggregates only: no titles, film ids or payloads.

## 1. Production facts behind the change (RCA)

| Time (UTC, 5 Nov) | Fact | Source |
| --- | --- | --- |
| 00:14:05–00:15:04 | An MCP step from a client with a ~60 s timeout ended as `canceled` at 59.5 s wall, 1.4 s CPU, no HTTP status. Its chunk held a lease for 47 s and never renewed it. | Workers telemetry, diagnostics ring |
| 00:27:38–00:29:34 | A second MCP step (a client that waits longer) ran a chunk for ≈108 s; its first lease renewal came after the 90 s TTL and failed: `resolver lease lost`, HTTP 200, no decision, status or admission written. | telemetry, `discovery_continuation`, `discovery_decision_history` |
| 04:32 | A side-effect-free `epg_pipeline_status` took 47.6 s wall (1.9 s CPU); other callers 35–61 s. A full ledger walk is latency-bound. | telemetry |

The previous successful chunk (190 s, 4 Nov 20:36 UTC) ran while discovery was still R2-authoritative; the R2 lease renewal compares only the lease id and does not check expiry, which the D1 renewal does (`expires_at > now`).

`discovery_authority.generation` was 4 against 1 at activation. Every fenced write and every continuation write (`writeContinuation`) adds one. Three continuation writes (two `running`, one `error`) after the activation account for 1 → 4, and the continuation `revision` moved 1 → 4 with them. All decision, admission, score and status rows still carry generation 1. So the counter is expected, not an anomaly.

## 2. What the paged chunk did before the change

`resolvePagedDiscoveryChunk` read every page of the ledger one after another (two queries per page, 74 pages at production size), renewed the lease only once, immediately before its final status write, had no wall budget and no TMDB call cap, and searched up to `limit` candidates. A lease older than 90 s at that final renewal was lost.

## 3. The change

- **Concurrent walk** (`DiscoveryAuthority.walkObservationPages`): one query returns the page starts, pages load four at a time, results reach the selection in key order, and the walk fails closed when the marker, the programme or the generation moved.
- **Lease heartbeat:** a renewal whenever less than 45 s remain, before each batch of loads and before each TMDB candidate. The D1 renewal condition, the TTL and the generation fence are unchanged.
- **Wall budget:** no new candidate after 40 s or 16 TMDB requests, but the first candidate is always taken.
- **Timings** in the chunk summary and the step diagnostic (`walkMs`, `pages`, `concurrency`, `renewals`, `firstRenewMs`, `tmdbMs`, `totalMs`; `sinceStartMs` and `failedAt` for a lost lease).

## 4. Offline measurement

`tests/discovery-chunk-budget.mjs`, 20,001 observations (41 pages of 500), a stand-in that adds a fixed delay to every D1 query:

| Read | 20 ms per query | Result |
| --- | --- | --- |
| Sequential pages (`readObservationPage`, the previous order) | 6.1 s | same 20,001 keys and shows |
| `walkObservationPages`, 4 at a time | 1.0 s | same keys, same order |

Three runs gave 6,092 / 6,193 / 6,093 ms and 989 / 972 / 986 ms. The stand-in also pays a local sqlite process per query, so the figures rank the two orders; they are not D1 latencies and do not prove a production wall time.

The same test checks: eligibility and priority (verified, terminal and backed-off decisions are not searched; order is hot, has a year, latest airing, key), a lease renewed on the first batch with its expiry moved forward, the 16-call cap, the first-candidate rule, a lease that expires during the walk, a lease taken by another hop, and a lease that ends during the TMDB phase. Each lost-lease case stops with `LeaseLostError` and the status, decisions and lease row unchanged.

## 5. Limits

- No production chunk was run, so the production wall time and the real D1 page latency are unmeasured. The 40 s target is a budget the code enforces on its TMDB phase; the read phase is bounded only by concurrency.
- A client that disconnects is not visible to the Worker; Workers telemetry (`canceled`) is the evidence.
- The paged chunk searches TMDB but stores no decision, admission, cheap-pass result or score preview. Persisting them is the second delivery of the card; until then a successful chunk makes no durable progress and no production GO is prepared.
- R2 side effects and TMDB request counts of the two failed hops are not established.
