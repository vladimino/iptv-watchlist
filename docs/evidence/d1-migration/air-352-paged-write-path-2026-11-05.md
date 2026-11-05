# D1 discovery paged chunk: resolution and keyed writes, 5 November 2026

**Card:** [AIR-352](https://trello.com/c/IJsGZJNN), second delivery after the lease, budget and timings change ([evidence](air-352-chunk-budget-2026-11-05.md)).
**Captured:** 2026-11-05, offline, Node 22.23 in the agent container, `main` `33ba94d`, local sqlite stand-ins (`tests/d1-standin.mjs`).
**Not done:** no production read or write, no `epg_sync_step`, resolve, TMDB call, lease change, flag, Task or migration. No real chunk was run.
**Verdict:** offline, the paged chunk now resolves its candidates and stores Films and decisions with keyed, fenced writes, and a second chunk makes progress instead of repeating the first. Whether a production chunk fits its budget and reaches its checkpoint is **not established**.

Aggregates only: no titles, film ids or payloads from production.

## 1. What was missing

The paged chunk (ledger above 20,000 observations) walked the ledger and searched TMDB for its selected candidates but discarded the result. It stored no decision, admission, cheap-pass result or score preview, only its status. A successful chunk therefore left `remaining` unchanged and the next chunk repeated the same searches. The only test of that path checked a 429 and a 403.

## 2. The change

- `DiscoveryAuthority.writeDecisionDelta`: one atomic batch per key behind the lease and generation fence, compare-and-set on the decision hash (a decision stored meanwhile wins and the key is skipped), a history row, and a diagnosis from the stored rows after a failed batch so a write that landed and lost its answer counts as written.
- `DiscoveryAuthority.upsertAdmissions`: batches of 19 films behind the fence; a film whose media kind and TMDB id belong to another film id is refused and the rest of its batch lands.
- The paged chunk resolves its selected candidates as the document path does, stores the Film and then the decision of each, folds the cheap pass into its single walk with at most 40 decisions and 38 Films written per chunk (`cheapRemaining` counts the rest), writes the `cheap_pass` status, replaces the score preview after a complete walk, and leaves the prediction queue to the prediction runner, which refreshes it from the catalog on every step (the call has no time bound of its own). No schema change and no migration: the tables, the history and the fence statements are those of the existing writers.

## 3. Offline results

`tests/discovery-paged-write.mjs` (authority writers) and `tests/discovery-chunk-budget.mjs` (the chunk), sqlite stand-ins:

| Case | Result |
| --- | --- |
| New decision, then update with the right previous | written; history 1 then 2; generation +1 per key |
| Previous decision stale (owner changed it) | skipped as `conflict`; owner's hash, history and generation unchanged |
| Unchanged, observation gone, evidence changed | skipped with their own reason |
| Retry of a write that already landed | counted as written; no second history row |
| Lease expired, taken by another hop, authority held, no lease | refused with `discovery_fence` / `discovery_lease`; nothing written |
| 45 films | three batches of at most 19; catalog read back whole; one film updated, others kept |
| Same TMDB id under another film id | `identity_conflict` refusal; the rest of the batch lands; movie and tv ids are separate identities |
| Chunk, 3 candidates plus the fixture's 5 hot ones | one Film added (admission row, `tmdb:1000`), 8 decisions with history, score preview of 8 rows, one queue refresh; second chunk: zero searches, zero writes |
| Cheap pass, 45 screened titles, 1 alias, 1 hot verified Film | 39 screened + 1 alias written in the first chunk (`cheapRemaining` 6), the Film's admission took the airings; second chunk writes the other 6 and rewrites nothing |
| Owner decision stored while the chunk resolves | stands; chunk skips the key, no history row |
| Film identity owned by another film id | `admission_identity_conflict`, one-hour back-off, no decision without its Film |
| 15 catalog-known candidates (1 request each) and an unknown one | exactly 16 requests; 15 decisions; no error, no retry time |

## 3a. Review follow-up: continuation and slow writes

| Case | Result |
| --- | --- |
| `advanceDiscovery` with 45 screened titles and no candidate left | the chunk reports `remaining` 0 and `cheapRemaining` > 0; the stored continuation stays `paused` with chunks to run and `nextAction` is `continue`; the next step finishes the cheap work and the record becomes `complete`; the step diagnostic carries `cheapRemaining` |
| 3 virtual seconds per D1 write batch, cheap pass of 45 titles | some decisions written, not all; the counters equal the stored rows; `cheapRemaining` equals the rest; no candidate started; checkpoint written; `totalMs` ≤ 40 s; `writeMaxMs` ≥ 3 s |
| 2 virtual seconds per batch, 6 candidates | only the candidates whose request and two writes fit are started; each counted candidate has its decision and each added Film its admission; inside the budget |
| 5 virtual seconds per batch | no candidate started, `wall_budget` with a back-off, no decision written, checkpoint inside the budget |

A first version of the slow-write case failed: with a fixed 5 s reserve a D1 at 5 s per batch needed 46 s because the final writes alone (preview, renewals, status, checkpoint) cost six batches. The reserve now scales with the slowest write measured.

## 3b. Walk at production row count (model)

`CHUNK_BUDGET_ROWS=36999 CHUNK_BUDGET_LATENCY=300 CHUNK_BUDGET_REPORT=1 CHUNK_BUDGET_ONLY_WALK=1 node tests/discovery-chunk-budget.mjs`: 36,999 observations (74 pages), a stand-in that adds 300 ms to every query.

| Read | Time |
| --- | --- |
| Sequential pages (the previous order) | 136 s |
| `walkObservationPages`, 4 at a time | 14.8 s |

300 ms per query is a deliberately pessimistic model (the observed sequential status read of the same ledger was 45–60 s), and the stand-in also pays a local sqlite process per query, which partly serialises the concurrent reads. It shows the walk fits the 30 s walk limit with margin under that model. It is **not** a production measurement: the real latency is unmeasured, and a query-side selection is not part of this change.

## 4. Limits

- No production chunk was run. The production wall time of the walk, the cheap pass and the keyed writes at real D1 latency is unmeasured; the step diagnostic's `timings` (`walkMs`, `cheapMs`, `tmdbMs`, `statusMs`, `checkpointMs`) will show it. If the walk cannot finish inside the budget, the chunk backs off (`wall_budget`) and a query-side selection is the next change.
- The cheap pass touches at most 38 Films per chunk, so the first chunks of a new generation rewrite the hot Films gradually; Finds airings catch up over those chunks.
- The paged chunk does not refresh the prediction queue. A Film it admits joins the queue on the prediction runner's next step; that delay is not measured here.
- A decision conflict is skipped without a retry in the same chunk; the candidate counts as handled.
