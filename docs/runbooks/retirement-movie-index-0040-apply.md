# Retirement ledger movie index, migration 0040: prerequisites, window, readback and forward-only rollback (the apply needs its own owner GO)

**Status:** prepared on 25 Nov 2026 under [AIR-667](https://trello.com/c/SbV827kN). The file is in the repository and **not applied**; a deploy applies nothing. Whether it has been applied is read live (`schema_contract`, `PRAGMA index_list`) and from a dated evidence page, never from this paragraph. **This runbook authorizes no operation.**

## Why

[ADR 0216](../adr/0216-canonical-film-lifecycle-and-unified-read-contract.md) decision 7 requires every lookup of the Film identity snapshot (`IDENTITY_SNAPSHOT_SQL`, `src/film-aggregate-resolver.js`) to be index-served. Its retirement column reads `tmdb_retirement_decision WHERE movie_id IN (...)` for every requested **or claimed** TMDB movie id. The ledger has no Film foreign key and a decision retires a movie id whatever Film it names, so the existing `tmdb_retirement_decision_film (film_id, seq)` cannot serve it; without this index the statement scans the ledger. The owner chose option A (an index, not a full-scan exception) on 25 Nov 2026 in the review of PR #1000. The index is a native prerequisite of resolver activation ([AIR-648](https://trello.com/c/zh0cfDWK)).

## What the apply does, and does not

- **Does:** one execution of `migrations/0040_tmdb_retirement_decision_movie_index.sql`: the non-unique, non-partial index `tmdb_retirement_decision_movie` on `tmdb_retirement_decision (movie_id)` and the version change 39 to 40. The legacy movie-id readers (`RETIREMENT_SQL` in `src/canonical-catalog-reader.js`, `RETIRED_SQL` in `src/canonical-letterboxd-claim.js`) are index-served by it too and return the same rows.
- **Does not:** write any ledger row (the only row that changes is the single `schema_contract` row), change `0016`, its triggers or the view `tmdb_retirement_current`, retirement or restore semantics, a writer, a marker, an authority, a lease, a public API, a flag, a Task or any Worker code, or activate the resolver. Offline proof: `tests/migration-0040-retirement-movie-index.mjs`.

## Prerequisites (checked immediately before the GO is used, not remembered)

1. `SELECT version FROM schema_contract WHERE id = 1` reads `39` with exactly one `schema_contract` row; `0039` is applied (its own GO). The file refuses anything else.
2. `tmdb_retirement_decision_film`, `tmdb_retirement_decision_tv` and `canonical_write_receipt_operation_history` exist; no object named `tmdb_retirement_decision_movie` exists, whatever its shape.
3. The GO names the live Git blob and SHA-256 of the file on `main`, the production D1 `iptv` and the exact execution path. This PR adds no operator script; if the owner wants the pinned-operator contract of `0036`/`0038` (target pin, digest pin, zero retries, independent readback), it is a separate reviewed change before the apply. Recheck the blob; do not use a remembered value.
4. If another migration has landed on `main` first, this file was renumbered and re-pinned before merge; the GO names the merged number and predecessor version.
5. No other migration, import or cutover is in flight, and no retirement decision is being recorded at the same moment (owner-only, rare; the GO states the window).
6. Before-state captured in the same window (read-only `SELECT`s, through the tool the GO names): the `schema_contract` row; `SELECT COUNT(*), MAX(seq) FROM tmdb_retirement_decision`; the Film/Person authority marker (mode, cutover, generation).

## Expected cost (a measurement, not a threshold)

One index entry per ledger row (D1 `rows_written`), plus the `sqlite_master` row and the `schema_contract` update; afterwards each new decision writes one extra index entry. The ledger is small; record the real count in the before-state.

## The step

Execute the unchanged file once, as **one** atomic batch (guard, `CREATE INDEX`, version update). Do not edit, split or blindly retry it. After a failed or unclear execution read the state back first and do not re-run: the file cannot run twice (it refuses anything but version 39).

## Readback (all must hold; record it in a dated evidence page under `docs/evidence/`)

- `schema_contract`: one row, `version` `40`, the v40 note.
- `PRAGMA index_list('tmdb_retirement_decision')` lists `tmdb_retirement_decision_movie` with `unique` 0 and `partial` 0; `PRAGMA index_info` names `movie_id`.
- Count and `MAX(seq)` of the ledger and the Film/Person marker equal the before-state.
- Where an authorized read path allows it: `EXPLAIN QUERY PLAN` of `SELECT seq FROM tmdb_retirement_decision WHERE movie_id IN (SELECT value FROM json_each('["1"]'))` reads `SEARCH tmdb_retirement_decision USING INDEX tmdb_retirement_decision_movie`. If no such path is authorized, say so in the evidence instead.

## Stop conditions

Version not 39, an expected predecessor object missing, an object of the new name present, another migration in flight, drift between the before-state and the apply, a failed or partial execution, or any readback difference.

## Rollback and forward recovery

A code revert changes no D1 object; the index stays. `schema_contract.version` never goes down (`schema_contract_no_downgrade`) and the ledger is never rolled back. Dropping the index changes no query result (only speed), but it would re-open the full scan that blocks activation, and `0040` cannot be re-applied afterwards (it refuses version 40). **No `DROP INDEX` without a separate owner approval**; treat any drop as forward recovery with its own dated evidence.

## What this page does not authorize

The apply itself, any other DDL, any D1 or R2 write, a flag, Task, Workflow or sync, resolver activation (AIR-648) or any AIR-646/AIR-647 step. Each needs its own explicit owner GO.
