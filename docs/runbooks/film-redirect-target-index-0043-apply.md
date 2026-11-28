# Film redirect target index, migration 0043: prerequisites, window, readback and forward-only rollback (the apply needs its own owner GO)

**Update 28 Nov 2026:** 0043 applied to production D1 `iptv` within the AIR-603 window ([evidence](../evidence/d1-migration/air-603-window-apply-2026-11-28.md)); the status text that follows describes the preparation and is kept as history. **Status:** prepared on 25 Nov 2026 under [AIR-647](https://trello.com/c/WKSwJOwm). The file is in the repository and **not applied**; a deploy applies nothing. Whether it has been applied is read live (`schema_contract`, `PRAGMA index_list`) and from a dated evidence page, never from this paragraph. **This runbook authorizes no operation.** By the owner's decision of 25 Nov 2026 it is not applied on its own: the approved pending migrations are applied together in the coordinated pre-activation window ([AIR-648](https://trello.com/c/zh0cfDWK)), with a separately approved exact chain, target, preflight and readback. Approval boundaries: 0039 to 0041 belong to the M1 chain of [AIR-603](https://trello.com/c/wc7pHJTB); 0042 belongs to ECM ([AIR-638](https://trello.com/c/JyQ3UkbR)), whose card allows combining it with another apply only with exact files and a separate GO; 0043 (this file) is AIR-647's, verified by AIR-648 before activation. A coordinated pre-activation window may cover 0039 to 0043, but each card keeps its own approval and evidence boundary: M1 does not authorize 0042 or 0043, ECM does not authorize 0043, and a combined apply needs the exact files and a separate owner GO.

## Why

[ADR 0216](../adr/0216-canonical-film-lifecycle-and-unified-read-contract.md) decisions 5 and 7 require every lookup of the FilmAggregateV1 `display` section (`src/film-aggregate.js`) to be index-served. The owner values of a Film are those of every owner-review link in the redirect tree that ends at it, because a link is a snapshot that a Film merge does not rewrite ([ADR 0081](../adr/0081-d1-authoritative-owner-reviews.md)). Finding the Films merged **into** a survivor is a lookup of `film_redirect` by `to_film_id`; `from_id` is the primary key, so no existing index serves it. The index lets a recursive CTE walk the tree through a SEARCH, bounded in depth (8) and breadth (64) inside the statement. The AIR-372 read model reads the same edges by target and the merge retarget (`UPDATE film_redirect SET to_film_id=? WHERE to_film_id=?`) updates by target; both use the index too.

## What the apply does, and does not

- **Does:** one execution of `migrations/0043_film_redirect_by_target.sql`: the non-unique, non-partial index `film_redirect_by_target` on `film_redirect (to_film_id)` and the version change 42 to 43.
- **Does not:** write any redirect row (the only row that changes is the single `schema_contract` row), change `0001`, a Film, a claim, a trigger, a marker, an authority, a lease, a writer, a public API, a flag, a Task or any Worker code, or activate the aggregate. Offline proof: `tests/migration-0043-film-redirect-index.mjs` (chain, refusals, dump parity on a populated forest, the real ancestry statement scanned before and searched after, readers by target and by `from_id`).

## Prerequisites (checked immediately before the GO is used, not remembered)

1. `schema_contract` holds exactly one row, `id` 1, `version` `42`; `0040`, `0041` and `0042` are applied (each under its own GO and evidence; chain order 0039, 0040, 0041, 0042, then this file).
2. The objects the file's guard checks are all present, read from `sqlite_master` (not inferred from the version integer). They are the objects of the immediate predecessors, by name: the tables `film`, `film_redirect` (its `CREATE` text names `to_film_id`), `film_identity_evidence` (its `CREATE` text has `source_order`), `tmdb_retirement_decision`, `identity_evidence_writer`, `identity_evidence_writer_change`; the indexes `tmdb_retirement_decision_movie` (0040), `film_identity_evidence_subject`, `_object`, `_scope`, `_superseded_once` (0041), `film_identity_evidence_scope_ref` and the unique `identity_evidence_writer_change_writer` (0042); the 19 triggers of the 0041 ledger (`film_identity_evidence_insert_open`, `_insert_conflict`, `_no_update`, `_no_delete`, `_insert_shape`, `_film_bound`, `_scope_target`, `_supersedes_target`), of 0042 (`film_identity_evidence_scope_arrival`, `_source_order`; `identity_evidence_writer_change_apply`, `_conflict`, `_current`, `_no_delete`, `_no_update`; `identity_evidence_writer_insert`, `_update`, `_no_delete`) and `schema_contract_no_downgrade`; the four ledger triggers 0042 replaced carry their 0042 text (`known_alias`, `NEW.film_id IS NOT NULL`, `discovery_observation`, `owner_action`); and **no** object named `film_redirect_by_target`. These are presence checks, not a claim of full schema integrity; 0042 is not modified.
3. The GO names the live Git blob and SHA-256 of the file on `main`, the production D1 `iptv` and the exact execution path. Recheck the blob; do not use a remembered value.
4. If another migration has landed on `main` first (an open migration PR can claim the same number; this file was written as 0042 and renumbered to 0043 when AIR-637's 0042 landed first), this file was renumbered and re-pinned before merge; the GO names the merged number and predecessor version, and the guard's predecessor is the then-current head.
5. No other migration, import or cutover is in flight, and no Film merge is running at the same moment (owner-initiated and rare; the GO states the window).
6. Before-state captured in the same window (read-only `SELECT`s, through the tool the GO names): the `schema_contract` row; `SELECT COUNT(*) FROM film_redirect`; `SELECT COUNT(*) FROM film`; the Film/Person authority marker (mode, cutover, generation).

## Expected cost (a measurement, not a threshold)

One index entry per redirect row (D1 `rows_written`), plus the `sqlite_master` row and the `schema_contract` update; afterwards each new merge writes one extra index entry per redirect it records or retargets. The table holds one row per merged Film; record the real count in the before-state.

## The step

Execute the unchanged file once, as **one** atomic batch (guard, `CREATE INDEX`, version update). Do not edit, split or blindly retry it. After a failed or unclear execution read the state back first and do not re-run: the file cannot run twice (it refuses anything but version 42).

## Readback (all must hold; record it in a dated evidence page under `docs/evidence/`)

- `schema_contract`: one row, `version` `43`, the v43 note.
- `PRAGMA index_list('film_redirect')` lists `film_redirect_by_target` with `unique` 0 and `partial` 0; `PRAGMA index_info` names `to_film_id`.
- The counts of `film_redirect` and `film` and the Film/Person marker equal the before-state.
- Where an authorized read path allows it: `EXPLAIN QUERY PLAN` of `SELECT from_id FROM film_redirect WHERE to_film_id IN (SELECT value FROM json_each('["film:x"]'))` reads `SEARCH film_redirect USING COVERING INDEX film_redirect_by_target`. If no such path is authorized, say so in the evidence instead.
- **Both indexes before activation.** Aggregate activation (AIR-648) needs `tmdb_retirement_decision_movie` (0040) **and** `film_redirect_by_target` (0043) read back in production; the activation card verifies the actual objects, reuses the evidence of the apply and never applies again.

## Stop conditions

Not exactly one `schema_contract` row at version 42, any predecessor object of prerequisite 2 missing, an object of the new name present, another migration in flight, drift between the before-state and the apply, a failed or partial execution, or any readback difference.

## Rollback and forward recovery

A code revert changes no D1 object; the index stays. `schema_contract.version` never goes down (`schema_contract_no_downgrade`) and no redirect row is rolled back. Dropping the index changes no query result (only speed), but it would take the ancestry step of the display section off an index, which blocks activation, and `0043` cannot be re-applied afterwards (it refuses version 43). **No `DROP INDEX` without a separate owner approval**; a wrong index would be corrected by a later forward migration.

## What this page does not authorize

The apply itself, any other DDL, any D1 or R2 write, a flag, Task, Workflow or sync, aggregate activation (AIR-648) or any consumer switch. Each needs its own explicit owner GO.
