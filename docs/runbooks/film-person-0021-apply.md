# Film/Person migration 0021: owner GO and apply procedure (prepared, not applied)

**Status:** prepared offline for [AIR-374](https://trello.com/c/ha7ais3w) (H1). **Nothing has been applied.** This page and [`migrations/0021_d1_glob_pattern_limit.sql`](../../migrations/0021_d1_glob_pattern_limit.sql) authorize nothing: applying it to production D1 `iptv` is a separate owner GO under [authorization](../process/authorization-and-escalation.md) (a schema change, so L3 unless the owner classifies it otherwise). Every value that describes production is a dated observation and must be re-read live before the GO.

## 1. Why it exists, and what it is

D1 refuses to **evaluate** a `LIKE` or `GLOB` pattern longer than 50 bytes (error 7500, `LIKE or GLOB pattern too complex`; a 50-byte pattern runs and a 51-byte one fails, even in a constant `SELECT`). `CREATE TABLE` accepts such a `CHECK`, so migrations `0014` and `0015` created four tables whose normalized-UTC time `CHECK` is a 92-byte pattern, and every INSERT into them fails on D1: the H1 load was refused at its first batch (`film_rated_admission`, 40 rows, HTTP 400, nothing written; [evidence](../evidence/d1-migration/air-374-h1-load-refused-glob-limit-2026-11-13.md)). The sqlite3 CLI of the offline tests has no such limit, so nothing earlier could show it.

The file (read from `main`; its identity must be recomputed from `main` immediately before the GO with `git hash-object`, `sha256sum` and `wc -c`):

- One refuse-insert into `schema_contract` that aborts the whole file unless the version is exactly 20, the seven tables it needs exist (`film`, `person`, the two localization tables, `film_rated_admission`, `film_retention`, `canonical_producer_run`) **and all four target tables are empty**. A non-empty table is therefore never dropped.
- Four `DROP TABLE` and four `CREATE TABLE ... STRICT` with the same columns, keys and other `CHECK`s and an exactly equivalent time `CHECK` made of short `GLOB` and `substr()` tests; the two unique indexes of `film_rated_admission` are recreated; the shared no-downgrade trigger is `IF NOT EXISTS`; the version becomes 21.
- It writes no row of any domain and moves no marker, baseline, fence, flag, lease or schedule. A deploy does not apply it.

`tests/migration-pattern-limit.mjs` proves, on the sqlite stand-in over the real chain `0001` to `0021`: it refuses version 19, version 21 and a non-empty table (each of the four) without dropping anything; the rebuilt `CHECK`s accept and refuse exactly what the 92-byte ones did over a corpus of time strings and over every other column rule; columns, foreign keys, indexes and `STRICT` are unchanged; no pattern over 50 bytes remains in the final schema; and mutants of the file are killed. **Not verified:** the apply on production D1 itself (the D1 limit was observed with constant `SELECT`s and the refused batch; the DDL of this file has not been run on D1).

## 2. Order

`0020` first (it requires a complete version 19 and carries the same pattern fix for its own `CHECK`s), then `0021`, then the H1 load. The H1 verifier and loader gate on a schema version (the verifier requires 19 today), so the code that follows the applies (the expected schema version in `scripts/film-person-capture.mjs`, the H1 verifier and the test fixtures) is a separate PR that merges with or just before the corresponding apply. This page does not change them.

## 3. GO statement the owner signs (fill the brackets)

> GO to apply `migrations/0021_d1_glob_pattern_limit.sql` to production D1 `iptv` (id `[id]`), once, as one D1 execution of the file, by `[operator]`, between `[start]` and `[end]` Europe/Madrid (`[UTC]`). File identity from `main` `[sha]`: git blob `[blob]`, sha256 `[sha256]`, `[bytes]` bytes. Preflight (section 4) with the rows recorded: version 20, the four tables empty, marker `[mode/cutover/generation]`, baseline `[state/reference]`. After the apply: the readback of section 5. STOP rules of section 6. This GO does NOT authorize: any row write, the H1 load, a marker, baseline, fence or receipt change, a flag, Scheduled Task, cron, Workflow, a second apply, a different or edited statement, an R2 write, a Time Travel restore, a merge, or the apply of any other migration.

## 4. Read-only preflight (every statement is one `SELECT`; write nothing)

There is no scripted preflight kit for 0021 (an open item); the statements are listed here and read by hand through the D1 read path.

1. `SELECT id, version, note FROM schema_contract ORDER BY id` — exactly one row, `version` 20.
2. `SELECT name FROM sqlite_master WHERE type='table' AND name IN ('film','person','film_localization_source','person_localization_source','film_rated_admission','film_retention','canonical_producer_run') ORDER BY name` — 7 rows.
3. `SELECT (SELECT COUNT(*) FROM film_localization_source) AS a, (SELECT COUNT(*) FROM person_localization_source) AS b, (SELECT COUNT(*) FROM film_rated_admission) AS c, (SELECT COUNT(*) FROM film_retention) AS d` — `0, 0, 0, 0`.
4. The marker, fence, baseline, projector lease, projector window and Discovery lease statements of the [0020 preflight](film-person-0020-apply.md#4-read-only-preflight-immediately-before-the-apply-every-statement-is-one-select): recorded; no live projector lease, window `idle`, Discovery quiet, no EPG publication in flight.
5. The D1 Time Travel bookmark of `iptv`, recorded (a recovery point only; a restore loses every later write of every domain and is an owner decision).

## 5. Readback (immediately after)

`SELECT version FROM schema_contract WHERE id = 1` is 21 (one row); the four tables exist, are `STRICT`, empty, and `SELECT name, sql FROM sqlite_master WHERE tbl_name IN (the four)` shows no `GLOB` pattern over 50 bytes; `film_rated_admission` has its two unique indexes; marker, fence and baseline equal the preflight rows; the other counts of the 0020 readback did not move. Record counts and digests only.

## 6. STOP and recovery

Any refusal or error, a version other than 20, a non-empty table, a moved marker or baseline, a live lease or window, or an unknown outcome: **STOP, reads only, no retry.** Recovery is forward-fix, not restore. The refuse-insert makes a partial apply visible: version stays 20 and the file stops before any drop when a guard fails; if a later statement fails after the drops, the version is still 20, the four tables are missing, and the owner decides the fix-forward (the file is idempotent only through that guard, so it is never re-sent blindly).

## 7. After the apply

Merge the PR that moves the expected schema version, then re-run the H1 plan against a fresh narrow copy (the loader's `plan` must be `ok` and `noop: false`) under its own GO ([H1 package](film-person-h1-load-package.md)).
