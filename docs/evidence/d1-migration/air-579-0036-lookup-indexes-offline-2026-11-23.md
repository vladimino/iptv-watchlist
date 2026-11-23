# AIR-579: migration 0036 (two lookup indexes), offline evidence (23 Nov 2026)

Offline only: scratch sqlite databases built from the real `migrations/` chain by `tests/migration-0036-lookup-indexes.mjs` (core suite). **`0036` is not applied to any database**, no production read or write, no D1 SQL tool, no flag, Task, Workflow, cron or R2 operation, and `0034` and `0035` (AIR-554) are unchanged. The owner approved variant D1 for **offline preparation** on 23 Nov 2026 ([AIR-579](https://trello.com/c/OlcWhyM7)); that is a choice of implementation, not a production GO, which stays a separate decision ([runbook](../../runbooks/d1-lookup-indexes-0036-apply.md)). The earlier measurement is [here](air-579-index-candidates-offline-2026-11-23.md); its numbers are history.

## What the migration is

`migrations/0036_epg_discovery_lookup_indexes.sql` follows a complete version 35 and creates two non-unique indexes: the partial `published_epg_show_discovery_by_match (programme_run_id, match_reason) WHERE basis = 'discovery'` and `film_external_id_by_scheme_value (scheme, value)`. It then raises `schema_contract.version` 35 to 36. Its first statement inserts a second `schema_contract` row and so aborts the file unless the version is exactly 35, the seven tables and the two predecessor indexes it relies on exist, and neither new index name exists.

## What the test proves

- **The chain.** `33 -> 34 -> 35 -> 36` on scratch copies, equal to the helper chain at 35. `0036` on 33 and on 34 aborts, creates nothing and leaves the version.
- **Refusals.** At a version 35 that is inconsistent (a missing `0035` table, a missing predecessor index, an unexpected pre-existing index of a new name, a same-named index of another shape) the file aborts, creates **neither** index and leaves the version. A second apply on 36 aborts and changes nothing.
- **No data change.** A full `.dump` of the same populated database before and after differs only by the two `CREATE INDEX` lines and the one `schema_contract` row (still one row, now 36): every table row, trigger, fence, lease, CAS and authority row is identical.
- **Shape.** Both indexes are non-unique; one is partial with `WHERE basis = 'discovery'`; the columns are as named. The unique partial index of trusted external ids still enforces its rule.
- **The real statements.** The deployed `ASSIGNED_ROWS_DELETE` is read from `src/discovery-authority.js` (the run from the `published_epg_authority` pointer, the key bound by substitution at the sqlite CLI boundary, so this is not a bound-parameter D1 run). On a populated key (four rows in the published run, two in the historical run, one film per key): the delete removes exactly the four rows, survivors are identical with and without the indexes, the historical run is untouched, an orphan row of another film under the same key is removed in both, and a row of the same key with another basis is untouched. The three `film_external_id` lookups return identical rows for nine values, a conflicting and an untrusted one; the lookup by `film_id` keeps its primary-key plan and cost.
- **Plans and cost** (synthetic 20 k-row published run plus a 10 k-row historical run, 14,280 external ids; VM steps are the SQLite instruction count, a proxy for rows visited, not D1 `rows_read`):

| Statement | Plan before | Plan after | VM steps before | after |
| --- | --- | --- | --- | --- |
| `ASSIGNED_ROWS_DELETE` (four rows) | search by run, filter the rest | `published_epg_show_discovery_by_match (programme_run_id=? AND match_reason=?)` | 110,089 | 118 |
| `scheme='tmdb' AND value=?`, a hit | `SCAN` | `film_external_id_by_scheme_value (scheme=? AND value=?)` | 57,092 | 16 |
| the same, a miss | `SCAN` | same | 57,088 | 9 |
| the OR statement, a TMDB hit / a Letterboxd hit | `SCAN` | `MULTI-INDEX OR` | 93,813 / 93,815 | 29 / 29 |
| `scheme IN (...) AND value IN (SELECT ... json_each(?))` | `SCAN` | same index | 117,293 | 271 |

- **Write and build cost.** Index entries: **7,500** in the partial index (the Discovery-assigned rows, a quarter of the 30,000 synthetic show rows) and **14,280** in the other (one per external id); each is a D1 `rows_written` at the build and on every later write of such a row. The offline build took about 20 ms for these sizes.

## Existing tests that pinned schema 35

Every test that builds the whole chain and pins its version now expects 36 (`canonical-producer-chain`, `canonical-rated-admission-bundle`, `canonical-rated-admission-producer`, `prediction-aux-closed`, `prediction-aux-d1`, `watchlist-root-fence`), and `migration-pattern-limit` lists `0036` at the end of the pinned tail of the chain. The AIR-554 operator tests apply `0034` and `0035` explicitly and are unchanged.

## Not measured

The real sizes and the real Discovery share of `published_epg_show`; the production planner's choice (the scratch tables have no statistics); D1 `rows_read`, `rows_written` and latency; the effect of the extra index entries on the EPG publication's write count; the duration of the apply on production. No production effect is claimed; the first acceptance observation is the next natural EPG/Discovery run after an owner-approved apply.
