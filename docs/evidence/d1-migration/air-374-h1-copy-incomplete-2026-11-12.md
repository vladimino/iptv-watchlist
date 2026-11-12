# AIR-374 H1: the loader refuses an unfinished connector copy

**Captured:** 2026-11-12 (UTC), offline, from `origin/main` at `25da4f7`. Authority: [AIR-374](https://trello.com/c/ha7ais3w), the finding of the [H1 rehearsal](air-374-h1-rehearsal-2026-11-12.md). **Nothing was run against production.** No D1, R2, Cloudflare, connector, MCP or Trello call was made, no credential was read. Production impact: none; the loader is an offline tool, not bundled into the Worker, and nothing under `src/` changed.

**Result in one sentence:** `copyReadBinding` in `scripts/film-person-prepared-loader.mjs` now reads the connector's copy log and refuses (`copy_incomplete`) unless all eight tables behind the loader's state statements are recorded `done`, so `plan`, `sql` and `verify` can no longer read a copy cut after the identity tables and before `film_rated_admission`.

## Contract

- **Where:** `copyReadBinding`, the one place every loader command reads the copy through; the check runs before any state row is read.
- **Which tables:** derived from `STATE_STATEMENTS` (one `FROM` each, asserted at load): `schema_contract`, `film_person_authority`, `film_person_baseline`, `film_external_id`, `film_redirect`, `film_rated_admission`, `film_retention`, `tmdb_retirement_decision`. The other tables of the connector's copy plan are not required.
- **Refusal:** `STOP copy_incomplete: <statement id>` (exit 1, nothing on stdout) for the first state statement whose table is not `done = 1` or is not logged; `copy_incomplete: log` when the log cannot be read as rows of a table name and `done` 0 or 1 (a log table without its twin, a missing column, a non-0/1 or null `done`, a nameless or duplicated row). The detail is a statement id or `log`, never a row value.
- **Log absent:** a sqlite file with no `connector_copy_log` and no `connector_copy_table` was not made by the connector tool and is read as before. This is kept because the loader test's stand-in database and the rehearsal's synthetic production (compared with the copy through the same binding) are such files, and the connector tool always creates both tables in its `ddl` step; the pinned counts, marker and baseline of the plan remain the completeness check for such a file.

## Tests

- `tests/film-person-prepared-loader.mjs` section 11: a complete copy is accepted and plans; each of the eight tables not done, and each missing from the log, one by one; an empty log; malformed logs (only one log table, no `done` column, `done` 2, text or null, a nameless row, a duplicated row); a log-free file is accepted; a post-load cut before `film_rated_admission` is refused by `plan`, `verify` and `sql` with the same code and no output file; the refusal holds no row value.
- `tests/film-person-h1-rehearsal.mjs` section 7 now asserts the refusal on the real connector-made partial copies: a cut inside the identity tables (`identity`) and a post-load cut before `film_rated_admission` are both refused by `plan` and `verify`; the finished copy is still planned.
- `tests/film-person-prepared-loader-mutation.mjs`: nine mutants added (82 in all), each killed by section 11 alone.

## Not proved

A live copy: the log of a production copy has not been read by this change. A copy whose log was edited by hand is out of scope (the operator copy is a private local file).
