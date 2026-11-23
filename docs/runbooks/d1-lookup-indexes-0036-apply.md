# D1 lookup indexes, migration 0036: prerequisites, window, readback and forward-only rollback (the apply needs the owner GO recorded on the card and the reviewed operator below)

**Status:** **applied** to production on 23 Nov 2026 19:32 UTC (one guarded operator `--apply`, schema 35 to 36; [dated evidence](../evidence/d1-migration/air-579-0036-apply-2026-11-23.md)); the text below is the plan and the rules the apply followed and stays the reference for the stop conditions. Prepared on 23 Nov 2026 under [AIR-579](https://trello.com/c/OlcWhyM7). Production D1 `iptv` was at schema **35** after the AIR-554 P6 apply of `0034` and `0035` on 23 Nov 2026 13:24 UTC ([evidence](../evidence/prediction/air-554-p6-schema-apply-2026-11-23.md)); the earlier wording of this page about schema 33 is historical. The owner gave one conditional GO for the production apply of `0036` only, through the guarded operator below ([card comment of 23 Nov 2026 13:53 Madrid](https://trello.com/c/OlcWhyM7)). The GO covers one apply of the unchanged file through the reviewed operator and nothing else; any deviation is a STOP. Whether the apply has happened is read live (`--status`) and from the dated evidence page, not from this paragraph.

## The operator

`scripts/d1-lookup-indexes-0036-production.mjs` (offline tests: `tests/d1-lookup-indexes-0036-production.mjs`). It pins the production target (account `8d9331889a693d328ef306692adf9d24`, database `iptv`, UUID `3fba0e0a-44e9-4a3a-a7ba-edaee6bcafcb`, each checked against Cloudflare before any statement) and reads the token from the private environment, never printing it.

```bash
node scripts/d1-lookup-indexes-0036-production.mjs --target iptv --status
node scripts/d1-lookup-indexes-0036-production.mjs --target iptv --apply --confirm apply --migration-sha256 <FULL_SHA256_FROM_STATUS>
```

- `--status` (the default) only reads: the SHA-256 of the exact bytes of the file, `schema_contract`, the 13 aux tables, 3 receipt tables and 33 `prediction_aux_sealed_*` triggers of `0034`/`0035`, the tables and indexes `0036` needs, the two new index names, the authority rows, the three row-count baselines and the decision (`apply`, `already_applied`, or the refusal reason).
- `--apply` sends **one** atomic D1 batch of the four statements `migrationStatements()` extracts from the unchanged file (guard, two `CREATE INDEX`, version update). It is never split and never retried (the adapter runs with zero retries and a write is never repeated). It then reads back independently: version 36, `PRAGMA index_list/index_info` of both indexes, the plans of the real `ASSIGNED_ROWS_DELETE` and of a `(scheme, value)` lookup, the three counts and the authority rows unchanged. An unclear answer or any readback mismatch ends as `write_uncertain`: stop, read the state independently, do not re-apply and do not drop an index.
- The Time Travel bookmark is read before and after an apply.
## What this does, and does not

- **Does:** one execution of `migrations/0036_epg_discovery_lookup_indexes.sql`: two non-unique indexes and the version change 35 to 36.
  1. `published_epg_show_discovery_by_match` on `published_epg_show (programme_run_id, match_reason) WHERE basis = 'discovery'`, a **partial** index. It serves `ASSIGNED_ROWS_DELETE` (`src/discovery-authority.js`), which states `basis = 'discovery'` literally; the delete read every row of the published run (about 20 k) until now.
  2. `film_external_id_by_scheme_value` on `film_external_id (scheme, value)`, over every trust state. It serves the three lookups by `(scheme, value)`; the lookup by `film_id` already uses the primary key and is unchanged.
- **Does not:** write any row of any table (the only row that changes is the single `schema_contract` row), touch a marker, authority, lease, fence, CAS row, trigger or table, change a Worker query or any Worker code, or switch anything. A deploy applies nothing; the Worker returns the same rows before and after (offline proof: `tests/migration-0036-lookup-indexes.mjs`).
- **Evidence behind it:** [offline candidates](../evidence/d1-migration/air-579-index-candidates-offline-2026-11-23.md) and [0036 offline evidence](../evidence/d1-migration/air-579-0036-lookup-indexes-offline-2026-11-23.md). Production effect is **not** claimed: it needs the apply and a natural EPG/Discovery run.

## Prerequisites (checked immediately before the GO is used, not remembered)

1. `SELECT version FROM schema_contract WHERE id = 1` reads `35` with exactly one `schema_contract` row. The file refuses otherwise, so `0034` and `0035` must have been applied before, each under its own AIR-554 GO; **this plan does not require AIR-554 to be finished, only that those two files are applied in order.** Do not declare them applied from this page.
2. Neither `published_epg_show_discovery_by_match` nor `film_external_id_by_scheme_value` exists (the file refuses an index of either name, whatever its shape).
3. The GO names the live git blob of `migrations/0036_epg_discovery_lookup_indexes.sql` on `main`, the production D1 id, and the exact execution path (the same owner-approved path as the earlier applies). Recheck the blob; do not use a remembered value.
4. No other migration, import or cutover is in flight (in particular no AIR-554 closed-marker window).
5. A quiet window for Discovery and EPG: no `iptv-epg` or `iptv-discovery` Workflow instance queued, running or paused, no EPG publication in progress and no daily EPG run (03:24 UTC) or its Discovery catch-up about to start. The DDL is small, but a concurrent writer of `published_epg_show` would also pay the new index entry; do not run it inside the catch-up.
6. Before-state captured in the same window (read-only): `schema_contract` row (`version`, `note`); `SELECT COUNT(*)` of `published_epg_show`, of `published_epg_show WHERE basis = 'discovery'` and of `film_external_id`; `published_epg_authority` (mode, cutover, generation, programme run id); `discovery_authority` (mode, cutover, generation). The preflight reads are `SELECT` statements; the GO says which tool runs them, because the owner's rule is that a D1 SQL tool is not used without an explicit decision.

## Expected cost (a measurement, not a threshold)

Each index entry is a D1 `rows_written`. The partial index holds one entry per Discovery-assigned show row (synthetic 25 % of 30,000 = 7,500; the real share is unknown) and the other one entry per `film_external_id` row (about 14 k at the RCA's scale), plus the two `sqlite_master` rows and the `schema_contract` update. On the synthetic data the offline build took about 20 ms. The real row counts decide the real cost and are in the before-state above; on the Workers Paid baseline this is a measurement to record, not a gate. Afterwards every write of a Discovery-assigned show row and of a `film_external_id` row writes one extra index entry.

## The step (one owner GO, no other statement)

Execute `migrations/0036_epg_discovery_lookup_indexes.sql` once, through the operator above. Do not edit it, split it, retry it blindly or run any other DDL beside it. After a failed or partial execution read the state back first and do not re-run (the file cannot run twice: it refuses anything but version 35).

## Readback (all must hold; record it in a dated evidence page)

- `schema_contract`: one row, `version` `36`, the v36 note.
- `PRAGMA index_list('published_epg_show')` lists `published_epg_show_discovery_by_match` with `unique` 0 and `partial` 1; `PRAGMA index_list('film_external_id')` lists `film_external_id_by_scheme_value` with `unique` 0 and `partial` 0; `PRAGMA index_info` names `programme_run_id, match_reason` and `scheme, value`.
- `EXPLAIN QUERY PLAN` of the delete shape with a literal key reads `SEARCH published_epg_show USING ... published_epg_show_discovery_by_match`, and of a lookup `scheme = ? AND value = ?` `SEARCH film_external_id USING ... film_external_id_by_scheme_value`.
- The counts of the before-state are unchanged (`published_epg_show`, its Discovery-assigned rows, `film_external_id`); `published_epg_authority` and `discovery_authority` read exactly as before.
- The next natural EPG/Discovery run is the first acceptance observation: compare the `ASSIGNED_ROWS_DELETE` and `film_external_id` lookup signatures in D1 analytics with the [RCA](../evidence/d1-migration/air-579-d1-overload-rca-2026-11-22.md) window. Do not start a run to clear it.

## Stop conditions

Version not 35, an expected table or index missing, an index of either new name present, any other migration in flight, a live EPG or Discovery Workflow instance, any drift between the before-state and the moment of the apply, a failed or partial execution, or any difference in the readback.

## Rollback and forward recovery

A code revert changes no D1 object: the indexes stay and no Worker code depends on them. There is **no automatic undo** of a schema apply and `schema_contract.version` never goes down (`schema_contract_no_downgrade`). The functional rollback is to drop the indexes, which changes no query result (a statement returns the same rows without them, only slower):

```sql
DROP INDEX published_epg_show_discovery_by_match;
DROP INDEX film_external_id_by_scheme_value;
```

Dropping **does not** revert the version: the database then stays at schema 36 without the two objects, and `0036` cannot be re-applied (it refuses version 36). Any later file that fences on a complete version 36 must say whether it expects the indexes. Re-creating them is a new statement under a new owner GO, not a second run of `0036`. Treat a drop as forward recovery: record the reason, the state and the readback in dated evidence, and do not drop to "retry".

## What this page does not authorize

The apply of `0034` or `0035` (already applied), any apply of `0036` other than the single guarded one above, any DDL, any D1 or R2 write, any production read with side effects, a flag, Task, Workflow, cron or sync, and any AIR-554 step. Each needs its own explicit owner GO.
