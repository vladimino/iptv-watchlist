# ADR 0109: A D1 paged discovery chunk selects candidates by keyset, not by walking the ledger

**Status:** Proposed  
**Original decision date:** 2026-11-10  
**Recorded at:** 2026-11-10  
**Approval source:** pending owner acceptance on AIR-425  
**Related work:** [AIR-425](https://trello.com/c/oxFXx6Bn), [ADR 0085](0085-d1-authoritative-discovery.md), [AIR-352 budget](../evidence/d1-migration/air-352-chunk-budget-2026-11-05.md)  
**Supersedes:** None (the paged walk remains for status counts)  
**Superseded by:** None

## Context

When the active D1 ledger is above the whole-document read cap, the resolver chunk used `walkObservationPages`: one `ROW_NUMBER` page-start query, then pages of 500 loaded four at a time, plus a whole-document `epg/discovery-resolution.json` read before the walk. Eligibility ran in JavaScript over every row. If the walk stopped before the last batch, the chunk stored `partial` / `wall_budget` / `remaining: null` / `checked: 0` and backed off five minutes.

A production generation of 47,059 active observations (10 November 2026, Europe/Madrid) repeated that outcome. Two natural chunks reported `pages: 95` (the start-list length, not the pages loaded), `walkMs` 6–9 s, `cheapMs: 0`, `tmdbCalls: 0`, `preCommitMs` ≈ 34 s. `cheapMs: 0` shows the cheap pass never ran, so the walk was incomplete: the decision-map load and the walk together consumed the 30 s walk deadline. About 4,900 observations were ready. The Workflow was alive and backing off; it was not idle and not an exhausted queue.

Raising the 40 s wall or the 5-minute backoff does not select a candidate. AIR-352 already named query-side selection as the follow-up.

## Decision

A D1 paged chunk **does not walk the ledger and does not load the decision map**. It:

1. Counts and reads a **keyset** of current-window observations (`seen_in_latest=1` and a show in the last 72 h / next 24 h) whose joined decision is still `resolutionActionability`-eligible **as far as SQL can see**: not `verified`; not a same-evidence `excluded_nonfilm`; not a same-evidence terminal or future `retry_at`. A missing decision `evidence_key` is treated as same evidence, matching JavaScript. The title non-film screen stays in JavaScript on that page. Same-evidence `excluded_nonfilm` reactivation when only the screen rule changes (evidence_key unchanged) is **not** decided here.
2. Loads shows only for that page (range + key filter, under `BIND_CAP`).
3. Applies the existing JavaScript gates (`resolutionActionability`, non-film screen, alias reuse) to that page only.
4. Takes at most `limit` of those keys for TMDB (hot-sorted **within the page**). Stores `selectAfter` as the last key of the **handled prefix in observation_key order**: cheap-skipped or TMDB-checked keys. Unprocessed pending keys are not jumped. An empty page after the cursor wraps once to the start of the keyspace.
5. Runs the cheap pass on that page plus a bounded keyset of current verified rows for hot Film airing touches. `touchAfter` advances independently through that verified keyspace (wrap once) so later verified observations are not starved.
6. Loads the catalog after selection, then resolves TMDB as before.

`remaining` is `max(0, SQL COUNT − settled this chunk)` when the count ran, otherwise `null`. It is the **global** actionable set, not the page. `stage=complete` and the continuation `complete` checkpoint require `remaining === 0` and no cheap work left. A finished page with `COUNT > 0` stays `partial`. `remaining: null` is not an empty queue.

`walkObservationPages` stays for pipeline status counts. Scoring, the detail gate, fenced writes, the lease, the 40 s budget and the 16-request TMDB cap are unchanged. No new table, index, cron, Task, Workflow binding or flag. No production chunk is authorized by this record.

What is **not** decided: a new SQL index; changing the 40 s budget; hot-first ordering across the whole ledger (fairness is key order plus wrap, with hot-sort only inside the selected page); treating a green test suite or a sqlite `EXPLAIN` as production D1 latency.

## Alternatives considered

- **Keep the full walk and only skip the decision-map load.** The walk still reads ~95 pages and can miss the walk deadline at live D1 latency; AIR-352 measured that cost.
- **Raise `PAGED_CHUNK_BUDGET_MS` or shorten backoff.** Forbidden by the incident card; it does not bound D1 reads.
- **New covering indexes / migration.** Not required for the keyset on the existing primary key and show table; a later card may add indexes if measured.
- **Advance `selectAfter` to the last selected row.** Loses unprocessed keys when `limit` or the wall budget is smaller than the page. Rejected.

## Consequences

Each natural chunk with ready current observations can start TMDB or cheap writes inside the existing budget. Workflow and Events Log `remaining` mean the global SQL set after this chunk's settled keys. Standing same-evidence `excluded_nonfilm` and `verified` rows are not TMDB-actionable; evidence-key change reopens terminal, retry and excluded rows; verified identity is not reopened by evidence change (same as JavaScript). Status and footer still walk or count the full ledger on their own paths.

The `SELECT COUNT(*)` with an `EXISTS` show check is a global query every chunk. Sqlite `EXPLAIN QUERY PLAN` on schema 18 is recorded in the AIR-425 evidence file; **production D1 latency of that count is not proven** and is accepted only after natural chunks.

## Recovery and migration boundary

Code rollback restores the walk. It does not undo decisions already written. Deploy does not run a chunk, reset a lease, or change flags. Production acceptance is later natural Workflow chunks with non-zero `checked`/`touched`/`added` when ready observations exist, **and** with `stage=partial` while `remaining > 0`.

## Evidence

- **Original decision:** [AIR-425](https://trello.com/c/oxFXx6Bn)
- **Implementation:** this PR
- **Dated verification:** [AIR-425 evidence](../evidence/discovery/air-425-keyset-selection-2026-11-10.md)
- **Uncertainty:** Worker CPU of `readDecisions` on production was not logged as a named span; it is inferred from `cheapMs: 0`, `preCommitMs` ≈ 34 s and `walkMs` ≈ 8 s. Monitor issue keys for the owner UI warning were not read. COUNT/EXISTS cost on live D1 is unknown.

## Follow-ups

AIR-410 remains the Events Log tick; this record does not change event delivery. AIR-424 is an independent Predictions `storage_error`. Same-evidence excluded_nonfilm reactivation when only the title screen changes is a later card.
