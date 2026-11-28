# Ratings projection fact-key index, migration 0055: prerequisites, window, readback and forward-only rollback (applied 28 Nov 2026)

**Update 28 Nov 2026:** 0055 was applied to production D1 `iptv` at 08:35 UTC under an owner operation-specific GO, with one atomic batch and an independent readback ([evidence](../evidence/d1-migration/air-653-0055-apply-2026-11-28.md)); the text that follows is the preparation and the contract, kept as history. It cannot be applied again (the file refuses anything but version 54).

**Status:** prepared on 28 Nov 2026 under [AIR-653](https://trello.com/c/YSPVkb1M). The file is in the repository and **not applied**; a deploy applies nothing. Whether it has been applied is read live (`schema_contract`, `PRAGMA index_list`) and from a dated evidence page, never from this paragraph. **This runbook authorizes no operation.**

## Why

The Letterboxd claim planner ([ADR 0184](../adr/0184-ratings-confirmed-letterboxd-claim-on-existing-film.md), `src/canonical-letterboxd-claim.js`) corroborates the Ratings projection with `SELECT alias_id,fact_key FROM ratings_view WHERE alias_id=? OR alias_id=? OR fact_key=?`, and the bounded private capture of [AIR-652](../evidence/film-person/air-652-prediction-alias-bridge-cohort-preflight-2026-11-25.md) reads the same projection by `fact_key`. `alias_id` is the primary key; `fact_key` had no index, so SQLite had to `SCAN ratings_view` (the OR cannot use only one of its terms). The AIR-652 evidence recorded that as a live-run blocker; the owner decided on 28 Nov 2026 to remove it with this index inside AIR-653, not with a new card, a new dependency, a new limit or a planner change. The blocker of the earlier evidence page is historical: it stays as written, and this runbook is the current applicability.

## What the apply does, and does not

- **Does:** one execution of `migrations/0055_ratings_view_fact_key_index.sql`: the non-unique, non-partial index `ratings_view_fact_key` on `ratings_view (fact_key)` and the version change 54 to 55. The planner statement becomes a `MULTI-INDEX OR` of three index SEARCHes and returns the same rows (offline proof `tests/migration-0055-ratings-view-fact-key-index.mjs`, including a rival alias on one fact key, an alias that points elsewhere and a lid with no row).
- **Does not:** write any projection row (the only row that changes is the single `schema_contract` row), change `0010`, the Ratings authority marker, a trigger, the planner or any of its limits, a writer, a flag, a Task, a lease or any Worker code, and it starts no claim, backfill or promotion. It is not the L3 operation of AIR-653: the promotion keeps its own plan and GO.

## Measurements (read-only, 28 Nov 2026 about 06:57 UTC; a baseline, refresh at the apply)

- Production D1 `iptv`: schema 54, file size about 2.65 GB, `ratings_view` **4,513 rows** (the whole table is small; the old scan was bounded in practice by that count, but not by any cap in code, and AIR-627 saw such a predicate time out when the table was larger). Ratings authority `d1`/`open`, generation 4711; Film/Person authority `d1`/`open`, generation 2.
- **Cost:** one index entry per projection row, so about 4,513 D1 `rows_written` for the build plus the `sqlite_master` row and the `schema_contract` update (about 4,515 in total; index writes count, [AGENTS.md](../../AGENTS.md) treats the number as a measurement, not a threshold). Afterwards each projection insert writes one extra index entry. Size on disk is on the order of the key bytes of 4.5 thousand short strings, a fraction of a megabyte.
- **Duration:** a single `CREATE INDEX` over a few thousand rows is expected in milliseconds to a small number of seconds. The batch is atomic and holds the single D1 writer for that time; no artificial long window is needed.
- **Writers of the table:** the only statement that writes `ratings_view` in the Worker is the Ratings D1 projection upsert (`src/ratings-d1.js`, `INSERT INTO ratings_view`), reached from the Letterboxd Sync ratings step (and the owner baseline import). The Letterboxd Sync runs four slots a day (due 03:30, 09:30, 15:30 and 21:30 UTC) and each run took about 0.5 to 4 minutes in the last ten runs; at 06:57 UTC the pipeline was `idle`, no ratings lease was live and the next slot was due 09:30 UTC. Prediction runs, Discovery and the EPG pipeline do not write this table.

## Prerequisites (checked immediately before the GO is used, not remembered)

1. `schema_contract` holds exactly one row, `id` 1, `version` `54`; `0054` is applied.
2. The objects the file's guard checks are present, read from `sqlite_master`: the table `ratings_view` (its `CREATE` text has `fact_key`) with **no explicit index** on it (only the implicit primary-key autoindex), the index `tmdb_retirement_decision_movie`, the trigger `schema_contract_no_downgrade`, the three legacy 0001 identity tables absent, and no object named `ratings_view_fact_key` whatever its shape. The guard refuses otherwise (its refusal inserts `id` 0, which `CHECK (id = 1)` always forbids, so it aborts even if the singleton row is missing). These are names and a column, not a full integrity proof of earlier migrations.
3. The GO names the live Git blob and SHA-256 of the file on `main` (compute `sha256sum migrations/0055_ratings_view_fact_key_index.sql` from the merged commit, not a remembered value), the production account and D1 `iptv` database identity, and this execution path (see **The step**). No new operator, card or large window is needed: the path is the one proven in AIR-603, applied to this one unchanged file, and the historical window manifest (38 to 54) is not changed.
4. If another migration has landed on `main` first, this file is renumbered and re-pinned before merge; the GO names the merged number and the predecessor version.
5. Quiet window, short and not artificial: the Letterboxd Sync is idle with no live ratings lease and the next slot is not due within a few minutes (an off-slot time, for example between 04:00 and 09:00 UTC, with the Controller reading `ratings_sync_status` immediately before). No other migration, import, cutover or owner baseline import is in flight. A held or moving Ratings marker is a stop.
6. Before-state captured in the same window (read-only `SELECT`s through the tool the GO names): the `schema_contract` row; `SELECT COUNT(*) FROM ratings_view`; the Ratings authority marker (mode, cutover, generation); the Film/Person authority marker (mode, cutover, generation); the feature flags; `ratings_sync_status` (pipeline, lease).

## The step

**Mechanism.** One D1 REST `query` request whose body is `{"batch":[{"sql":...},{"sql":...},{"sql":...}]}`: the statements of the unchanged file (the guard insert, `CREATE INDEX`, the version update), split by `migrationStatements` exactly as in AIR-603. Cloudflare documents that statements of one D1 batch run in one SQL transaction and that a failing statement rolls the whole sequence back ([D1 batch](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch); the REST `batch` body is the same operation). A single request carrying one semicolon-joined `sql` string is **not** used: its failure semantics are not established here. Atomicity is still not assumed of the transport: the file's own guard aborts before anything changes unless version 54 and the guarded objects are present, and the version update is the last statement, so a partial or lost outcome is visible as a version that did not move together with an index that exists, and is settled by readback, never by repeating the call.

**Invocation (after the owner's separate GO; credentials from the [credential conventions](../../.claude/skills/iptv-credentials/SKILL.md), `D1_BACKFILL_*`, behind a proxy `NODE_USE_ENV_PROXY=1`).** The pinned account and database identity are enforced by `productionTarget` and `adapter.describe()`; `retries:0` means a transient status on this write is never repeated.

```bash
node --input-type=module -e "
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {createD1Adapter} from './scripts/d1-backfill.mjs';
import {createPublishedBinding,migrationStatements,productionTarget,PRODUCTION_DATABASE_ID,PRODUCTION_DATABASE_NAME} from './scripts/published-epg-production.mjs';
const file='migrations/0055_ratings_view_fact_key_index.sql',bytes=fs.readFileSync(file);
if(createHash('sha256').update(bytes).digest('hex')!==process.env.GO_SHA256)throw new Error('file digest differs from the GO');
const adapter=createD1Adapter({target:productionTarget(process.env),databaseId:PRODUCTION_DATABASE_ID,retries:0});
const described=await adapter.describe();
if(described.uuid!==PRODUCTION_DATABASE_ID||described.name!==PRODUCTION_DATABASE_NAME)throw new Error('target identity differs from the GO');
const binding=createPublishedBinding(adapter);
await binding.batch(migrationStatements(bytes.toString('utf8')).map(sql=>binding.prepare(sql).bind()));
console.log('batch answered; read the state back before any further step');
"
```

`GO_SHA256` is the digest named by the GO. The snippet makes exactly one request; it never retries and never re-runs. Offline, with the same code and a stub transport, the file produces one POST of three statements (guard, `CREATE INDEX`, version update). If the call throws or its response is lost, **do not re-run**: read the state back (below). The file cannot run twice (it refuses anything but version 54), so a repeat after a committed apply is refused with zero writes, but the outcome is still judged from the readback, not from the refusal.

**Narrow live preflight (read-only `SELECT`s, immediately before):** the `schema_contract` row; `SELECT COUNT(*) FROM ratings_view`; the Ratings authority marker and the Film/Person marker (mode, cutover, generation); `PRAGMA index_list('ratings_view')`; `ratings_sync_status` (pipeline idle, no live ratings lease, next slot not due within the window); the feature flags. Nothing else is measured.

## Readback (all must hold; record it in a dated evidence page under `docs/evidence/`)

- `schema_contract`: one row, `version` `55`, the v55 note.
- `PRAGMA index_list('ratings_view')` lists `ratings_view_fact_key` with `unique` 0 and `partial` 0; `PRAGMA index_info` names `fact_key`.
- `SELECT COUNT(*) FROM ratings_view` and the Ratings authority marker (generation unchanged: the apply is not a Ratings write), the Film/Person marker and the flags equal the before-state.
- `EXPLAIN QUERY PLAN SELECT alias_id,fact_key FROM ratings_view WHERE alias_id='x' OR alias_id='tmdb_1' OR fact_key='y'` reads a `MULTI-INDEX OR` whose third term is `SEARCH ratings_view USING INDEX ratings_view_fact_key (fact_key=?)` and has no `SCAN ratings_view`. The same for `SELECT * FROM ratings_view WHERE fact_key IN (SELECT value FROM json_each('["a"]')) LIMIT 5` (the capture predicate).
- Collateral, scoped to what the apply could touch: the `ratings_view` count, the Ratings authority generation and the schema version are as expected; no concurrent ratings write or competing schema operation was in flight (the status read before and after); the next natural Letterboxd Sync run is not disturbed (read-only status). It is not a census of every concurrently changing table.

## Stop conditions

Not exactly one `schema_contract` row at version 54, any predecessor object of prerequisite 2 missing, an object of the new name present, a live ratings lease or a due Sync slot inside the window, drift between the before-state and the apply, a failed or partial execution, or any readback difference.

## Rollback and forward recovery

A code revert changes no D1 object; the index stays. `schema_contract.version` never goes down (`schema_contract_no_downgrade`) and no projection row is rolled back. Dropping the index changes no query result (only speed) and would re-open the scan that the AIR-653 planning relies on; it would be a **new numbered migration** `DROP INDEX ratings_view_fact_key` with its own guard, tests and **separate owner GO**, and `0055` cannot be re-applied afterwards. Treat any drop as forward recovery with its own dated evidence. A failed apply leaves the atomic batch rolled back; read the state back before any decision.

## What this page does not authorize

The apply itself, any other DDL, any D1 or R2 write, a flag, Task, Workflow, lease change or sync, the live `dry_run` of `letterboxd_claim_backfill` (still not run on production: the capture and the planner stay offline and bounded as AIR-653 states), the claim backfill or any promotion. Each needs its own explicit owner GO.
