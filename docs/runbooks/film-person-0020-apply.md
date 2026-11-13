# Film/Person migration 0020: owner GO and apply procedure (applied 13 Nov 2026)

> **Pattern limit (13 Nov 2026).** D1 evaluates no `LIKE` or `GLOB` pattern over 50 bytes (error 7500). The time `CHECK`s of this file were rewritten from one 77-byte pattern to short `GLOB` and `substr()` tests with the same accepted set before any apply; the file identity below is the rewritten file. It is applied first, then [`0021`](film-person-0021-apply.md) (which rebuilds four empty tables of `0014` and `0015` for the same reason), then the H1 load.

**Status:** prepared offline for [AIR-374](https://trello.com/c/ha7ais3w) stage S4-2 of [ADR 0128](../adr/0128-epg-canonical-producer-durable-execution.md) (Accepted as design). **Applied to production D1 `iptv` on 13 Nov 2026 (about 08:38 UTC) as one execution after the owner GO; schema version 20, readback as expected ([evidence](../evidence/d1-migration/air-374-h1-load-2026-11-13.md)). The procedure below is kept as written (it was a design before the apply) and does not authorize a second apply.** This page, the file [`migrations/0020_canonical_producer_run.sql`](../../migrations/0020_canonical_producer_run.sql), a merge, a deploy and a green CI are not the owner GO. The apply is step GA of the ADR delivery plan: a separate, operation-specific L3 GO with its own preflight and readback, modelled on the [schema 19 apply procedure](film-person-0019-apply.md). Counts and digests only in any evidence.

**Role:** the exact procedure and the exact owner GO text for applying `0020` to production D1 `iptv`. Every value that describes production is a dated observation from earlier evidence and **must be re-read live** before the GO. Things not verified are marked "not verified".

## 1. What the migration is, and is not

Facts read from the file:

- One file, 34 statements in order: (1) a refuse-insert into `schema_contract`, (2) two `CREATE TABLE ... STRICT` (`canonical_producer_run`, `canonical_producer_unit_result`), (3) seven `CREATE INDEX` (three on the run table, four on the result table; two are `UNIQUE` and partial), (4) twenty-three `CREATE TRIGGER`: twenty-two NEW trigger names plus the shared `schema_contract_no_downgrade`, which is `IF NOT EXISTS` and already exists in production, (5) one `UPDATE schema_contract` to version 20.
- File identity at the time of writing: git blob `1e58217fd645ddada306e67d39981fadbadf176b`, sha256 `e23f9bffc68aa46f5d0be77c984bcbbbfb5c2658916553c73474ea4257b6b633`, `23,409` bytes; the digest of the 34 statements alone (comments and blank lines removed) `a4f06455a53763ad118d5feb9d5b17ee47bfa3087ce39c1c2b100088e4cb71db`. The GO must name the identity read on `main` immediately before the apply, not this one if the file changed (`node scripts/film-person-0020-preflight.mjs identity` recomputes all of them).
- **The refuse-insert.** `INSERT INTO schema_contract (id, version, note) SELECT 1, 0, 'refused' WHERE NOT EXISTS (version 19 AND all six prerequisite tables present)`. On a complete v19 it inserts nothing (`changes` 0). On anything else it inserts a second row with `id=1`, which violates the primary key and aborts the file before a table is created, so a second apply, a skipped migration and an incomplete v19 are refused by design. The six tables: `film_person_authority`, `film_person_cas` (the marker the new triggers read) and the four receipt tables of `0019` (`canonical_write_receipt`, `canonical_receipt_baseline`, `canonical_receipt_watermark`, `canonical_receipt_baseline_seal`).
- **It writes no data row** except the `schema_contract` version and note. Both new tables start EMPTY. Nothing in the Worker bundle references them: `src/canonical-producer-run.js` (the pure layer of S4-1) is dormant and unbundled, `build.mjs` and `wrangler.jsonc` are unchanged, `wrangler.jsonc` has no migration directory and the CI workflow applies no migration, so a deploy applies nothing. The store, the driver and the wiring are S4-3 to S5-1 and do not exist.
- **What the triggers do.** All 22 new triggers are `BEFORE` triggers on the two new tables only. Inserts and updates are refused unless the marker is `d1`/`open` (`canonical_producer_not_open`), so at `r2`, `prepared` and `held` the tables are empty or frozen even against a code defect; deletes are refused always. The rest enforce the invariants the pure module defines and plain CHECKs cannot (the birth shape of a run, immutability of identity columns, the compare-and-set `revision` moving by exactly one, `applied_generation` set once, the replay move, the strike identity rules, the dictionary mint guard, the result state machine). No trigger is attached to any existing table, so nothing that runs today can fire one.
- **Production behaviour after the apply: none.** The only observable change is `schema_contract.version` 19 to 20. Code that reads the version uses `>=` comparisons except the capture gate (`SCHEMA_EXPECTED`, section 2). Not verified: every consumer of `schema_contract` was not read line by line (the 0019 reading found none that compares for equality outside `scripts/film-person-capture.mjs`).
- What it does not do: it does not move the marker, change the baseline, take the receipt baseline, start a writer, change a flag, schedule or cron, or touch R2.

The full column and rule inventory, the places where the SQL and the pure module can differ and the decisions to review are in the [S4-2 evidence note](../evidence/d1-migration/air-374-s4-2-producer-schema-20-offline-2026-11-12.md); the schema reference is [d1-schema.md](../reference/data/d1-schema.md#durable-canonical-producer-run-and-unit-result-schema-v20).

## 2. The code change that follows the apply (and what this PR deliberately does not do)

`scripts/film-person-capture.mjs` has `export const SCHEMA_EXPECTED` (21 on `main` once the bump PR of [`0021`](film-person-0021-apply.md#2-order) is merged, 19 before it) and `gateRefusals` answers `schema_unexpected:<n>` for any other version; the connector measuring run, `runCutoverMinimum` and `captureProjectorInputs` pass through it. The precedent of `0019` applies unchanged: **the schema-20 PR does not bump it**, because production is still 19 until the owner-approved apply is read back. Bumping first would make every capture run refuse with `schema_unexpected:19`; applying without the bump makes them refuse with `schema_unexpected:20`. So the order is GO, preflight, apply, readback, then the bump PR, prepared beforehand and merged only after the readback matches.

What this PR did so that merging it breaks nothing: the migration is a file under `migrations/` that no CI job, deploy step or Worker code applies (checked by `tests/canonical-producer-schema.mjs`); the tests that model production at schema 19 stop at `0019` (`tests/film-person-capture.mjs`, `film-person-connector.mjs`, `film-person-cutover-run.mjs`, `film-person-h1-verify.mjs`, `film-person-e6-measure.mjs` and its mutation runner); every other fixture builds the whole chain and is indifferent to the new version.

Files of the follow-up bump PR (one PR for `0020` and `0021` together, merged after the readback of `0021`, because applying `0020` alone would make the capture run refuse with `schema_unexpected:20`): `scripts/film-person-capture.mjs` (`SCHEMA_EXPECTED` 19 to 21), `scripts/film-person-e6-measure.mjs` (stop rule), `scripts/film-person-h1-verify.mjs` (`SCHEMA_VERSION` and the schema note of `0021`); the test fixtures (`<=19` to `<=21`, the `version` asserts and `schema moved` cases rebased, as the `0019` bump PR did); `tests/canonical-handoff-readiness.mjs` only if a blocker depends on the version (not verified); `docs/runbooks/deployment.md`, `migrations/README.md`, `docs/reference/data/d1-schema.md` and the ADR 0128 follow-ups state "applied" with the dated evidence link.

## 3. The GO statement the owner signs

Text to be shown to the owner with the preflight rows (fill the bracketed values from the live reads; a GO that does not name them is not this GO):

> GO to apply `migrations/0020_canonical_producer_run.sql` (blob `[git hash-object of the file on main]`, sha256 `[digest]`, `[bytes]` bytes, statements digest `[statementsSha256]`, 34 statements, on `main` `[sha]`) to production D1 database `iptv` (id `[from the account listing]`), as ONE D1 execution of the exact checked-in file and no other statement, between `[start]` and `[end]` Europe/Madrid (`[UTC]`). Precondition: every preflight row of section 4 matches, with the marker at `[mode/cutover/generation, read live]`. After it: only the section 6 readback. This GO does NOT authorize: any marker move, any write to a table other than the DDL of this file and the `schema_contract` row, the receipt baseline, the P5 loader, a producer store, driver or wiring, any flag, Scheduled Task or cron change, a bump of `SCHEMA_EXPECTED` before the readback matches, an R2 write, a retry after an unknown outcome without a readback, a drop of any new object, or a Time Travel restore.

Under [authorization levels](../process/authorization-and-escalation.md) this is an L3 step (schema change of a production database; precedents: AIR-357 `0012`, AIR-373 `0013`-`0016`, AIR-383 `0018`, AIR-374 `0019`). One file, one GO; the signature covers the apply and its readback and no later step.

## 4. Read-only preflight (immediately before the apply; every statement is one `SELECT`)

Run in this order through the Cloudflare D1 read path (the Cloudflare API connector `execute`, or `d1_database_query`) and keep the rows as evidence. Write nothing. Do not use `GET /api/enrichment/*`, `GET /api/events` or `epg_pipeline_status` as probes. The statements are emitted and judged by the offline tool [`scripts/film-person-0020-preflight.mjs`](../../scripts/film-person-0020-preflight.mjs) (section 4a). It touches no network, D1, R2 or connector; it is tested against the real migration chain over the sqlite3 stand-in and mutation-tested, and it has never been run against production (not verified in a run).

| # | Statement (shape) | Expected | Why it matters |
| --- | --- | --- | --- |
| 1 | Code and target: `main` SHA, the file identity of section 1 recomputed from `main`, the deployed Worker version, the D1 database named `iptv` and its id | file identity equals the GO; target is `iptv` | A GO names one file and one database |
| 2 | `SELECT id, version, note FROM schema_contract ORDER BY id` | exactly one row, `version` 19 | any other count or version is STOP |
| 3 | `SELECT name FROM sqlite_master WHERE type='table' AND name IN (` the six prerequisite tables `)` | 6 rows | an incomplete v19 makes the refuse-insert fire; STOP and escalate, never repair |
| 4 | `SELECT type, name FROM sqlite_master WHERE name GLOB 'canonical_producer_*'` | 0 rows | any table, index or trigger already present means a partial or foreign apply: STOP, no retry |
| 5 | `SELECT name FROM sqlite_master WHERE type='trigger' AND name='schema_contract_no_downgrade'` | 1 row | the shared trigger exists (the file's `IF NOT EXISTS` would otherwise create it) |
| 6 | One `SELECT` of eight `COUNT(*)` values: the four receipt tables, `canonical_revision`, `film_rated_admission`, `film_retention`, `tmdb_retirement_decision` | recorded, not judged | these rows must not move; the readback compares them (a later operation may have loaded them, so they are not expected to be 0) |
| 7 | `SELECT mode, cutover, generation FROM film_person_authority WHERE id=1`; `SELECT ok FROM film_person_cas WHERE id=1`; `SELECT state, reference FROM film_person_baseline WHERE id=1` | marker equal to the GO's; `ok` 1; baseline recorded | the apply must not meet a moved marker (any state is allowed, but the GO names it); the baseline is compared with the readback |
| 8 | `SELECT lease_id, lease_until FROM projection_run WHERE projection='enrichment'` | no row, or `lease_id` NULL, or `lease_until` earlier than the clock | a live projector lease blocks (never reset a lease) |
| 9 | `SELECT state, expires_at FROM projector_window WHERE id=1` | `idle` | not idle means the projector holds or requests an exclusive window |
| 10 | `SELECT id, lease_id, expires_at FROM discovery_lease` (`expires_at` is epoch milliseconds) | `lease_id` NULL or `expires_at` in the past | Discovery quiet |
| 11 | `epg_status` / `sync.json` stage; the EPG executor control phase | no publication in flight (`running`, `switching`, `metadata`, `epg` mean wait) | same stop list as the [window activation runbook](d1-projector-window-activation.md) |
| 12 | The D1 Time Travel bookmark for `iptv` recorded before the apply | a bookmark and its timestamp | a recovery point only; restoring it loses every later write of every domain and is an owner decision, never automatic (the connector path for this read is not verified) |
| 13 | Feature flags (`feature_flags` tool, read) and the registry of the hourly Predictions Task | recorded as observed; no change | not a gate for the DDL; recorded so the evidence names the concurrent writers |

### 4a. The offline tool (identity, emitted statements, verification of pasted results)

All commands are dry: they read the checked-in file and their arguments only and write nothing but JSON to standard output.

| Command | Output |
| --- | --- |
| `node scripts/film-person-0020-preflight.mjs identity` | git blob hash, sha256, byte count, statement count (34) and the digest of the statements of `migrations/0020_canonical_producer_run.sql`, recomputed from the file, with the apply result shape expected (34 `success`, first `changes` 0, last `changes` 1). The GO names these values. |
| `node scripts/film-person-0020-preflight.mjs preflight-sql` | The eleven read-only `SELECT` statements of rows 2 to 10 (ids `schema`, `prerequisites`, `existing_producer_objects`, `shared_trigger`, `unchanged_rows`, `marker`, `fence`, `baseline`, `projector_lease`, `projector_window`, `discovery_lease`) and the four rows that are not SQL (1, 11, 12, 13). |
| `node scripts/film-person-0020-preflight.mjs verify-preflight results.json --marker M [--now ISO]` | Judges the pasted results against section 4. `--marker` is the exact `mode/cutover/generation` the GO names and is mandatory: without it the tool refuses (`expected_marker_missing`); a marker row that differs is `marker_moved:<m>`. |
| `node scripts/film-person-0020-preflight.mjs readback-sql` | The twelve read-only statements of section 6 (ids `schema`, `objects`, `definitions`, `foreign_objects`, `producer_rows`, then the seven preflight statements whose rows are compared: `unchanged_rows`, `marker`, `fence`, `baseline`, `projector_lease`, `projector_window`, `discovery_lease`). Run it only after the apply. |
| `node scripts/film-person-0020-preflight.mjs verify-readback readback.json --preflight preflight.json --marker M` | Judges section 6: version 20 and the exact note; the 2 tables, 7 indexes, 22 new triggers and the shared one present by name; the stored `sql` of each of the 31 new objects equal to its statement in the file (`definition_mismatch`); nothing else matching `canonical_producer_*`; 0 rows in each new table; marker equal to `--marker`; fence `ok` 1; and, against the preflight bundle (the same `{id: rows}` shape, taken before the apply, version 19), the row counts, marker, fence, baseline and the three lease rows unchanged. A missing or unusable bundle is `preflight_bundle_missing` or a `preflight:`-prefixed refusal. |
| `... verify-preflight` or `verify-readback` with `--diagnostic` | Shape check only. It never passes: `ok` is always `false` and the output carries `diagnosticOnly: true` and `shapeOk`. |

A results file is JSON `{"<statement id>": <rows array or the D1 response envelope [{success,results}]>}`. The verifier exits 1 and names every refusal; a missing, failed or malformed result is a refusal, never an empty one. `ok` is evidence and never a permission: the GO of section 3 is separate, and the manual rows are not judged by the tool.

Evaluate: any row off its expected value is STOP, no apply, and the rows go to the owner. `inconsistent` means escalate; no repair and no retry is proposed. The lease and window rows, the hourly cron tick (`0 * * * *`: projector, EPG ensure, Discovery reconcile) and the Predictions Task matter exactly as in the [0019 procedure](film-person-0019-apply.md#4-read-only-preflight-immediately-before-the-apply-every-statement-is-one-select); a slot that ends before `:55` Madrid time is a proposal, not a measured quiet window.

## 5. The apply (only after the GO)

Method, following the recorded precedent of `0012`, `0013` and `0019`: **one D1 query whose `sql` is the exact text of the checked-in file**, executed through the Cloudflare Developer Platform connector `d1_database_query` (the path of the `0019` apply; the Cloudflare API connector's `execute` was refused for D1 writes with error 7500). `wrangler d1 execute iptv --remote --file migrations/0020_canonical_producer_run.sql` needs the owner's Cloudflare credentials on the operator machine and is not verified here.

Operator rules:

1. Paste the file content unchanged; compute the sha256 of the text sent and compare it with the GO.
2. Send it **once**. On a timeout, a lost response or any ambiguity, do not resend: run the section 6 readback first (the refuse-insert makes a second full apply fail, but a partial state must be read, not guessed).
3. Read every statement result. Expected: 34 results, all `success`; the first (the refuse-insert) with `changes` 0; the final `UPDATE` with `changes` 1.
4. No other statement, no `epg_sync_*`, no flag or Task change, no R2 access.

**Atomicity, stated truthfully.** Whether D1 runs a multi-statement `query` body in one transaction and rolls everything back on a failing statement, or stops at the failing statement and leaves earlier ones applied, is not verified here. The design puts the only refusal first (before any `CREATE`), so for every foreseeable failure (wrong version, incomplete v19, repeat apply) nothing has been created yet. A failure after the first statement could leave a partial schema; that is an unknown, not a guarantee, and it is the reason for the readback-before-retry rule. The trigger bodies contain `;` inside `BEGIN ... END`; the `0013` (six triggers) and `0019` (twenty) applies are the precedent that the connector accepts this; `0020` has 23 trigger statements of the same single-`SELECT` body shape (not verified for this file). Two further constructs are new relative to `0019` and are not verified on D1 itself: partial `UNIQUE` indexes (present since `0001`) and a trigger `WHEN` clause with a subquery over its own table (present in `0019` against another table).

## 6. Read-back (immediately after; same read path as the preflight)

| Item | Expected |
| --- | --- |
| `schema_contract` | one row, `version` 20, note `Schema v20: durable canonical producer run and unit result tables (empty). Follows a complete version 19.` |
| Tables | `canonical_producer_run`, `canonical_producer_unit_result` |
| Indexes | `canonical_producer_run_seq`, `canonical_producer_run_fresh`, `canonical_producer_run_updated`, `canonical_producer_unit_result_live`, `canonical_producer_unit_result_due`, `canonical_producer_unit_result_unit`, `canonical_producer_unit_result_state` (plus SQLite's automatic primary-key indexes; read by name, not by count) |
| Triggers | the 22 NEW names listed in the file (`canonical_producer_run_*` and `canonical_producer_unit_result_*`); the shared `schema_contract_no_downgrade` must remain present and is not counted as new |
| Stored text | `SELECT type, name, sql FROM sqlite_master` for the 31 new objects: each `sql` equals its statement of the file without the closing semicolon (the tool compares them; a difference is `definition_mismatch:<names>`) |
| Rows | both new tables: 0 rows |
| Unchanged | marker as in the preflight and the GO, fence `ok` 1, baseline as in the preflight, the eight preflight counts, projector lease and window and Discovery lease as in the preflight |

`verify-readback` evaluates every row above; "as in the preflight" is compared with the preflight results bundle (`--preflight`) and the marker pinned from the GO (`--marker`), so `ok: true` without either is impossible. A lease that moved during the operation is a changed writer state, STOP. A mismatch, an unexpected row count or a partial object set is STOP; escalate with the rows. No automatic repair, retry or downgrade. `handoffReadiness` is not affected by this apply (the producer wiring blocker stays; not verified by a run).

## 7. STOP conditions and recovery (truthful: forward-fix, not restore)

STOP and hand the evidence to the owner when: any preflight row is off; the file identity differs from the GO; a lease or window is not free; the apply result is not 34 successes; the outcome is unknown; the readback does not match; any other writer's state changed during the operation.

What recovery exists:

- **Before the apply or on a refusal at statement 1:** nothing was created; there is nothing to undo.
- **A successful apply is not reverted by a code revert, a deploy or a git revert.** `schema_contract_no_downgrade` makes the version non-decreasing, so version 20 stays.
- **The new tables are inert while the marker is `prepared`, `r2` or `held`** (the triggers refuse every write, and no code writes them). Leaving them in place is the safe default and the recommended remedy for any problem that is not the tables themselves.
- **A defect in the definitions is corrected FORWARD, by a new migration (`0021`), never by editing `0020` and never by a Time Travel restore.** A corrected migration must carry its own guard (version 20 and the tables empty, or an explicit data-preserving copy once rows exist), its own preflight, readback and owner GO. Dropping the empty tables is itself a schema write (`DROP TABLE` of two tables, their indexes and triggers; the `no_delete` triggers guard row deletes only) that needs the same; the version would stay 20 and a re-apply of `0020` is refused by its own guard, so a drop is a one-way door. This path is **designed here only and never rehearsed** (not verified).
- **A partial apply** (only possible if the connector is not transactional, not verified): read the set of objects present and the version, then the owner decides between completing the missing objects with a reviewed, file-specific fix and a drop of what exists. Never "run the file again".
- **D1 Time Travel** restores the whole database and loses every later write of every domain (EPG, Discovery, metadata, ratings, predictions, owner reviews); it is an owner decision for a corrupted database, not a remedy for this change.
- Once producer runs exist (after S5-1 and an `open` activation) the tables hold data and a drop is no longer a harmless option; that is later and out of this page. Rows are append-only: no pruning is decided.

## 8. After the apply

1. The bump PR (section 2) is merged after the readback matches, with its full CI.
2. Dated evidence under `docs/evidence/d1-migration/` (`air-374-0020-apply-<date>.md`): the preflight and readback rows, the file identity, the operator path, and what was not verified; the registry row; `migrations/README.md` status of `0020`; this page's status line.
3. The next steps stay separate: the store layer (S4-3), the durable driver (S4-4), the wiring (S5-1), the measurements and the activation holdpoint H2. The pass refuses before touching any unit while schema 20 is absent (`producer_store_missing`, ADR 0128 decision 13), so applying `0020` starts nothing by itself.
