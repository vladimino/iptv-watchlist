# AIR-579: index candidates for the two open hotspots, offline measurement and a decision request (23 Nov 2026)

Offline only: a scratch sqlite database built from the real `migrations/` chain, RCA-sized synthetic data, and `EXPLAIN QUERY PLAN` and SQLite VM steps. **Nothing is a migration and nothing is applied**: every candidate is created inside a throwaway copy by `tests/air-579-index-candidates-offline.mjs` (core suite), measured and discarded. No production read or write, no D1 SQL tool, no flag, Task, Workflow or cron. The two hotspots are those the [RCA](air-579-d1-overload-rca-2026-11-22.md) left open after [#917](https://github.com/vladimino/iptv-watchlist/pull/917): the `published_epg_show` delete by observation key and the `film_external_id` lookups by `(scheme, value)`. The RCA figures stay history.

VM steps are the SQLite instruction count of a statement, a proxy for the rows visited; D1 `rows_read` and latency were not measured. Table sizes are synthetic at the RCA's scale (a 20 k-row published run, 14 k external ids); the real sizes and the real share of Discovery-assigned rows were not read.

## 1. `ASSIGNED_ROWS_DELETE` (`src/discovery-authority.js:22`)

`DELETE FROM published_epg_show WHERE programme_run_id=(...) AND basis='discovery' AND match_reason=?` runs when a decision write changes the assigned identity of an observation, **and for every first decision of a key** (`assignedRowsDelete` returns the statement when `previous` is null). The only index besides the primary key is `(programme_run_id, start_ms)`, so each execution walks the whole run.

Synthetic: a published run of 20,000 shows (a quarter assigned by Discovery) plus a 10,000-row historical run that must stay.

| Variant | Plan | VM steps | Extra index entries (each is a D1 `rows_written`) | Rows deleted |
| --- | --- | --- | --- | --- |
| Today | search by run, filter the rest | 110,011 | 0 | reference |
| A1: index `(programme_run_id, basis, match_reason)` | `SEARCH ... (programme_run_id=? AND basis=? AND match_reason=?)` | 11 | 30,000 (one per show row of every run) | identical |
| **A2: partial index `(programme_run_id, match_reason) WHERE basis='discovery'`** | `SEARCH ... (programme_run_id=? AND match_reason=?)` | **10** | **7,500** (Discovery-assigned rows only, at the synthetic quarter) | identical |
| B: film-scoped delete (`... AND film_id=?`) | primary-key prefix `(programme_run_id, film_id)` | 37 | 0 | identical under an invariant, see below |

A1 and A2 execute the **same statement text** as today, so the rows deleted are identical by construction; the test checks the surviving rows are identical in a historical run that must stay untouched. Their cost is the write amplification: A1 adds one entry per show row on every EPG publication; A2 adds one only per Discovery-assigned row, here a quarter of A1's.

B needs no schema change, but it is exact only while every row of a key names the film of its stored verified decision (the invariant [ADR 0142](../../adr/0142-epg-owned-generation-addressed-discovery-slots.md) decision 4 describes and the existing "skip when the identity is unchanged" branch also relies on). The test shows the difference: with an orphan row of another film under the same key the current statement removes it and B leaves it. Decisions are never deleted in the code (no `DELETE FROM discovery_decision`), so the invariant holds for rows written by the D1-era code; **it is not proven for rows that predate it or came from an import**, and a production check of it (a read-only join of assigned rows against the stored decisions) was not run and needs the owner's decision on a D1 read.

## 2. The three `film_external_id` lookups by `(scheme, value)`

Synthetic: 14,280 rows, three schemes, 10 % untrusted and about 2 % conflicting duplicates of a value. Candidate: `CREATE INDEX film_external_id_by_value ON film_external_id(scheme, value)` (a plain index; the existing unique index is partial, `trusted=1 AND conflicting=0`, and cannot serve these statements, which read every trust state).

| Statement | Plan before | Plan after | VM steps before | after |
| --- | --- | --- | --- | --- |
| `scheme='tmdb' AND value=?` | `SCAN` | `SEARCH ... (scheme=? AND value=?)` | 57,088 | 9 |
| `(scheme='tmdb' AND value=?) OR (scheme='letterboxd' AND value=?)` | `SCAN` | `MULTI-INDEX OR` over the new index | 93,815 | 29 |
| `scheme IN (...) AND value IN (SELECT value FROM json_each(?))` (eight values) | `SCAN` | `SEARCH ... (scheme=? AND value=?)` | 117,283 | 243 |
| `scheme IN (...) AND film_id IN (SELECT value FROM json_each(?))` (control) | primary-key `SEARCH` | unchanged | 120 | 120 |

The test compares the returned rows with and without the index for eight values and for a conflicting and an untrusted value: identical. Write cost: one extra index entry per `film_external_id` row written (the table changes rarely: enrichment and admission writers), 14 k entries once to build.

## Decision request (the choice is the owner's; nothing here is applied)

| Option | Gain (offline) | Cost and risk |
| --- | --- | --- |
| **D1. One additive migration with A2 and the `film_external_id` index** | both hotspots from a run-wide or table-wide walk to a handful of steps, semantics unchanged by construction | a schema change: production is at schema 33 with `0034` and `0035` (AIR-554) in `main` and not applied, so the next free number is `0036` and the strict chain needs both first, or a separate owner-approved idempotent `CREATE INDEX IF NOT EXISTS` operation that leaves `schema_contract` unchanged and is later folded into a migration. Each needs an operator plan, an explicit owner GO and a rollback (`DROP INDEX`). Write cost: 1 entry per Discovery-assigned show row, 1 per external-id row |
| D2. Code-only B for the delete, no index on `film_external_id` | the delete only (110,011 to 37 steps); no schema | exact only under the invariant; an orphan row survives; needs the owner to accept the invariant or a read-only check of production first |
| D3. A1 instead of A2 | same read gain | four times the write cost of A2 at the synthetic share, on every EPG publication |

Recommendation: **D1 with A2**, because it keeps today's delete semantics and has the smallest write cost, and bundle the `film_external_id` index with it so one operation covers both. D2 is the only option that needs no schema change; take it only with the owner's acceptance of the invariant. Expected production effect is not claimed: the rows saved per execution follow the real table sizes and the number of executions on the next natural EPG/Discovery run.

## Not measured

Real table sizes and the real Discovery share of `published_epg_show`; the production planner's choice (the scratch tables are synthetic and have no statistics); D1 `rows_read`, `rows_written` and latency; how the extra index entries change the EPG publication's write count in production.
