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
- The paged chunk resolves its selected candidates as the document path does, stores the Film and then the decision of each, folds the cheap pass into its single walk with at most 40 decisions and 38 Films written per chunk (`cheapRemaining` counts the rest), writes the `cheap_pass` status, replaces the score preview after a complete walk, and refreshes the prediction queue when it admitted a new Film. No schema change and no migration: the tables, the history and the fence statements are those of the existing writers.

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

## 4. Limits

- No production chunk was run. The production wall time of the walk, the cheap pass and the keyed writes at real D1 latency is unmeasured; the step diagnostic's `timings` (`walkMs`, `cheapMs`, `tmdbMs`, `statusMs`, `checkpointMs`) will show it. If the walk cannot finish inside the budget, the chunk backs off (`wall_budget`) and a query-side selection is the next change.
- The cheap pass touches at most 38 Films per chunk, so the first chunks of a new generation rewrite the hot Films gradually; Finds airings catch up over those chunks.
- The prediction queue refresh on an admission uses the document-path routine unchanged; its cost at production size inside the chunk budget is unmeasured.
- A decision conflict is skipped without a retry in the same chunk; the candidate counts as handled.
