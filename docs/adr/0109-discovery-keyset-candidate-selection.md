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

1. Counts and reads a **keyset** of current-window observations (`seen_in_latest=1` and a show in the last 72 h / next 24 h) that are not a standing `verified` or `excluded_nonfilm` decision and are not inside a same-evidence retry/terminal fence.
2. Loads shows only for that page (range + key filter, under `BIND_CAP`).
3. Applies the existing JavaScript gates (`resolutionActionability`, non-film screen, alias reuse) to that page only.
4. Takes at most `limit` actionable keys **in observation_key order** and stores `selectAfter` so the next chunk continues after the last decided key. An empty page after the cursor wraps once to the start of the keyspace.
5. Runs the cheap pass on that page plus a bounded query of current verified rows for hot Film airing touches.
6. Loads the catalog after selection, then resolves TMDB as before.

`walkObservationPages` stays for pipeline status counts. Scoring, the detail gate, fenced writes, the lease, the 40 s budget and the 16-request TMDB cap are unchanged. No new table, index, cron, Task, Workflow binding or flag. No production chunk is authorized by this record.

What is **not** decided: a new SQL index; changing the 40 s budget; hot-first ordering across the whole ledger (fairness is key order plus wrap); treating a green test suite as production progress.

## Alternatives considered

- **Keep the full walk and only skip the decision-map load.** The walk still reads ~95 pages and can miss the walk deadline at live D1 latency; AIR-352 measured that cost.
- **Raise `PAGED_CHUNK_BUDGET_MS` or shorten backoff.** Forbidden by the incident card; it does not bound D1 reads.
- **New covering indexes / migration.** Not required for the keyset on the existing primary key and show table; a later card may add indexes if measured.

## Consequences

Each natural chunk with ready current observations can start TMDB or cheap writes inside the existing budget. `remaining` is the actionable size of the selected page (or `null` if selection itself ran out of time). Verified observations that the non-film screen no longer matches are not in the keyset until a later change. Status and footer still walk or count the full ledger on their own paths.

## Recovery and migration boundary

Code rollback restores the walk. It does not undo decisions already written. Deploy does not run a chunk, reset a lease, or change flags. Production acceptance is later natural Workflow chunks with non-zero `checked`/`touched`/`added` when ready observations exist.

## Evidence

- **Original decision:** [AIR-425](https://trello.com/c/oxFXx6Bn)
- **Implementation:** this PR
- **Dated verification:** [AIR-425 evidence](../evidence/discovery/air-425-keyset-selection-2026-11-10.md)
- **Uncertainty:** Worker CPU of `readDecisions` on production was not logged as a named span; it is inferred from `cheapMs: 0`, `preCommitMs` ≈ 34 s and `walkMs` ≈ 8 s. Monitor issue keys for the owner UI warning were not read.

## Follow-ups

AIR-410 remains the Events Log tick; this record does not change event delivery. AIR-424 is an independent Predictions `storage_error`.
