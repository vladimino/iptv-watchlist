# Film/Person migration 0019: owner GO and apply procedure (design, not executed)

**Role:** the exact procedure and the exact owner GO text for applying [`migrations/0019_canonical_write_receipt.sql`](../../migrations/0019_canonical_write_receipt.sql) to production D1 `iptv` (holdpoint H0 of the [decision pack](film-person-holdpoint-decision-pack.md)), written for [AIR-374](https://trello.com/c/ha7ais3w). It follows the pattern of the [schema 13–16 preflight](film-person-schema-preflight.md). **This page authorizes nothing and nothing in it has been executed.** The owner decision of 12 Nov 2026 is to PREPARE this specific future GO (exact file identity, live preflight template, connector query and readback plan, and the SCHEMA_EXPECTED 18 to 19 PR ready beforehand and merged only after a successful apply and readback); the apply is a separate GO with checked parameters, and neither that decision nor the merge of the PR carrying this page authorizes it. The decision records are [ADR 0119](../adr/0119-durable-canonical-write-receipts.md) and [ADR 0117](../adr/0117-film-person-d1-handoff-owner-decisions.md) (parent [ADR 0099](../adr/0099-canonical-film-person-d1-authority.md)). A merge, a deploy, a green CI and this page are not the GO. Counts and digests only in any evidence.

Verified against `origin/main` at the time of writing (file identity below); every value that describes production is a dated observation from earlier evidence and **must be re-read live** before the GO. Things not verified are marked "not verified".

## 1. What the migration is, and is not

Facts read from the file:

- One file, 28 statements in order: (1) a refuse-insert into `schema_contract`, (2) four `CREATE TABLE ... STRICT` (`canonical_write_receipt`, `canonical_receipt_baseline`, `canonical_receipt_watermark`, `canonical_receipt_baseline_seal`), (3) two `CREATE INDEX` on `canonical_write_receipt`, (4) twenty `CREATE TRIGGER` statements: nineteen NEW trigger names plus the shared `schema_contract_no_downgrade`, which is `IF NOT EXISTS` and already exists in production, (5) one `UPDATE schema_contract` to version 19.
- File identity at the time of writing: git blob `275cbcfee8f18e7dbb45a12d34ff45c38b3240f4`, sha256 `75acd55e8ecff540a89f3c0ff53c6971b78ef67f4d9c62a7491eec4b345ed818`, 15,398 bytes. The GO must name the identity read on `main` immediately before the apply, not this one if the file changed.
- **The refuse-insert.** `INSERT INTO schema_contract (id, version, note) SELECT 1, 0, 'refused' WHERE NOT EXISTS (version 18 AND all eight prerequisite tables present)`. On a complete v18 it inserts nothing (`changes` 0). On anything else it inserts a second row with `id=1`, which violates the primary key (`id INTEGER PRIMARY KEY CHECK (id=1)`) and aborts the file before a table is created. So a second apply, a skipped migration and an incomplete v18 are refused by design. The eight tables: `film_person_authority`, `film_person_cas`, `film_person_baseline`, `canonical_revision`, `film_rated_admission`, `tmdb_retirement_decision`, `epg_orchestration_document`, `projector_window`.
- **It writes no data row** except the `schema_contract` version and note. The four new tables start EMPTY. Nothing in the Worker bundle references them (`src/canonical-receipts.js` is dormant and unbundled; nothing imports it; no producer calls it).
- **What the triggers do at `prepared`.** All 19 new triggers (the 20th `CREATE TRIGGER` statement is the pre-existing shared one) are `BEFORE` triggers on the four new tables only. Receipt inserts and updates are refused unless the marker is `d1`/`open` (`canonical_receipt_not_open`); baseline, watermark and seal inserts are refused unless `d1`/`open`; updates and deletes of the baseline tables and of receipts are refused always. No trigger is attached to `film`, `person`, `canonical_revision`, the marker, the projector tables or any existing table, so nothing that runs today can fire one. At the current marker (`prepared`/`open`/generation 1) the four tables cannot be written by anyone, including the Worker.
- **Production behaviour after the apply: none.** The only observable change is `schema_contract.version` 18 to 19. Code that reads the version uses `>=` comparisons (`FILM_PERSON_MIN_VERSION=13`, `RECEIPT_MIN_VERSION=19`, the loader's `>=16`, the projector's `Number(version)>=6`/`>=7`) except the capture gate, below. Not verified: every consumer in `src/` was not read line by line; a grep of `schema_contract` readers found no equality check on 18 outside `scripts/film-person-capture.mjs`.
- What it does not do: it does not move the marker, change the baseline, take the receipt baseline (a later activation step after `open`), start a writer, change a flag, schedule or cron, or touch R2.

## 2. The code change that MUST follow in the same operation

`scripts/film-person-capture.mjs` line 33 is `export const SCHEMA_EXPECTED=18;` and `gateRefusals` answers `schema_unexpected:<n>` for any other version. The connector measuring run, `runCutoverMinimum` and `captureProjectorInputs` all pass through it. Consequences, both real:

- **Bump before the apply** (a merged PR that sets 19 while production is 18): every capture/measurement run refuses with `schema_unexpected:18`. The gate fails closed; it does not damage data, but the capture path is unusable until the apply lands.
- **Apply without the bump:** the same refusal, `schema_unexpected:19`.

So the apply and the bump are one operation with this order: GO, preflight, apply, readback, then the bump PR (opened ready beforehand, merged only after the readback matches). Files to change, all in one PR (the "SCHEMA_EXPECTED PR"):

| File | Change |
| --- | --- |
| `scripts/film-person-capture.mjs` | `SCHEMA_EXPECTED` 18 to 19 |
| `tests/film-person-capture.mjs` | fixture chain `Number(name.slice(0,4))<=18` (line 26) to `<=19`; `version===18` asserts (line 141, line 270 `{id:1,version:18}` stubs) and the `schema moved` case that passes `expectedSchema:17` and expects `schema_unexpected:18` (lines 230-232) re-based on 19 and 18; the comment on lines 25 |
| `tests/film-person-connector.mjs` | migration filter `<=18` (line 39) to `<=19`; comment on line 38 |
| `tests/film-person-cutover-run.mjs` | migration filter `<=18` (line 27) to `<=19`; comment on line 26 |
| `tests/canonical-handoff-readiness.mjs` | the `production()` helper (line 26) lowers the contract to 18 to represent production; once production is 19 the helper and the assertion at line 243 ("migration 0019 exists ... NOT applied") must describe the applied state, and the `receipts_schema_missing` expectation changes to absent |
| `docs/runbooks/film-person-open-handoff.md`, `docs/adr/0119-...md` (Follow-ups), `migrations/README.md` (status of `0019`), `docs/reference/data/d1-schema.md` | state "applied" with the dated evidence link (a dated evidence file is added; see section 8) |

Tests that stop at 0018 for other reasons need no change (`tests/projector-window.mjs`, `tests/discovery-chunk-budget.mjs`, `tests/discovery-operational-status.mjs`, `tests/film-person-prepared-loader.mjs` build their own 0001-0018 chains; the loader refuses only `schema_below_16`). Not verified: whether the full suite stays green with the bump; the executor runs `npm test` on the PR.

## 3. The GO statement the owner signs

This section is the prepared TEXT of a future GO; presenting it, and approving the plan to prepare it, is not the GO. Each actual D1 execution needs the owner's explicit approval with the checked parameters. Text to be shown to the owner with the preflight rows (fill the bracketed values from the live reads; a GO that does not name them is not this GO):

> GO to apply `migrations/0019_canonical_write_receipt.sql` (blob `[git hash-object of the file on main]`, sha256 `[digest]`, `[bytes]` bytes, on `main` `[sha]`) to production D1 database `iptv` (id `[from the account listing]`), as ONE D1 execution of the exact checked-in file and no other statement, between `[start]` and `[end]` Europe/Madrid (`[UTC]`). Precondition: every preflight row of section 4 matches. After it: only the section 5 readback and the opening of the SCHEMA_EXPECTED PR. This GO does NOT authorize: any marker move, any write to a table other than the DDL of this file and the `schema_contract` row, the receipt baseline, the P5 loader, any flag, Scheduled Task or cron change, a merge of a producer, an R2 write, a retry after an unknown outcome without a readback, a drop of any new object, or a Time Travel restore.

Under [authorization levels](../process/authorization-and-escalation.md) this is an L3 step (schema change of a production database, with a standing precedent of per-file GOs: AIR-357 `0012`, AIR-373 `0013`-`0016`, AIR-383 `0018`). One file, one GO; the signature covers the apply and its readback and no later step.

## 4. Read-only preflight (immediately before the apply; every statement is one `SELECT`)

Run in this order through the Cloudflare D1 read path (the Cloudflare API connector `execute`, or `d1_database_query`) and keep the rows as evidence. Write nothing. Do not use `GET /api/enrichment/*`, `GET /api/events` or `epg_pipeline_status` as probes. The offline helper `scripts/schema-preflight.mjs` knows only migrations 0013 to 0016 (`SEQUENCE`) and has no 0019 mode; the statements below are specified here and are **not** generated or tested by any tool (not verified in a run). Run each statement through `assertReadOnly`-style discipline by hand: a single `SELECT`.

| # | Statement (shape) | Expected | Why it matters |
| --- | --- | --- | --- |
| 1 | Code and target: `main` SHA, the file identity of section 1 recomputed from `main`, the deployed Worker version (deployments list or the post-merge deploy run), the D1 database named `iptv` and its id | file identity equals the GO; target is `iptv` | A GO names one file and one database |
| 2 | `SELECT id, version, note FROM schema_contract ORDER BY id` | exactly one row, `version` 18 | `schema_contract_rows` other than 1, or any other version, is STOP |
| 3 | `SELECT name FROM sqlite_master WHERE type='table' AND name IN (` the eight prerequisite tables `)` | 8 rows | an incomplete v18 makes the refuse-insert fire; STOP and escalate, never repair |
| 4 | `SELECT type, name FROM sqlite_master WHERE name GLOB 'canonical_*receipt*'` | 0 rows | any of the four tables, two indexes or the 19 new triggers already present means a partial or foreign apply: STOP, no retry |
| 5 | `SELECT name FROM sqlite_master WHERE type='trigger' AND name='schema_contract_no_downgrade'` | 1 row | the shared trigger exists (the file's `IF NOT EXISTS` would otherwise create it) |
| 6 | `SELECT COUNT(*) AS n, MAX(revision) AS m FROM canonical_revision` | `n` 0, `m` NULL | the baseline of ADR 0119 expects 0; a non-zero value is not a blocker for the DDL but changes the later baseline step and must be reported |
| 7 | `SELECT mode, cutover, generation FROM film_person_authority WHERE id=1`; `SELECT ok FROM film_person_cas WHERE id=1`; `SELECT state, reference FROM film_person_baseline WHERE id=1` | `prepared`/`open`/1; `ok` 1; `verified` and a reference of the form `cutover_accepted/v2:<digest>` equal to the [AIR-373 record](../evidence/d1-migration/air-373-baseline-prepared-2026-11-11.md) | the apply must not meet a moved marker; a marker other than the GO names is STOP |
| 8 | `SELECT lease_id, lease_until FROM projection_run WHERE projection='enrichment'` | no row, or `lease_id` NULL, or `lease_until` earlier than the database/Worker clock | a live projector lease blocks (never reset a lease); wait for expiry or release |
| 9 | `SELECT state, expires_at FROM projector_window WHERE id=1` | `idle` | not idle means the projector holds or requests an exclusive window |
| 10 | `SELECT id, lease_id, expires_at FROM discovery_lease` (column names from migration 0011; `expires_at` is epoch milliseconds) | `lease_id` NULL or `expires_at` in the past | Discovery quiet: the apply touches only the schema contract row and new tables, but a Discovery chunk that reads the version mid-run is avoided |
| 11 | `epg_status` / `sync.json` stage; the EPG executor control phase | no publication in flight (`running`, `switching`, `metadata`, `epg` mean wait) | same stop list as the [window activation runbook](d1-projector-window-activation.md) |
| 12 | The D1 Time Travel bookmark for `iptv` (`wrangler d1 time-travel info iptv`, a read) recorded before the apply | a bookmark and its timestamp | recorded as a recovery point only; restoring it loses every later write of every domain and is an owner decision, never automatic (the connector path for this read is not verified) |
| 13 | Feature flags (`feature_flags` tool, read) and the registry of the hourly Predictions Task | recorded as observed; no change | not a gate for the DDL; recorded so the evidence names the concurrent writers |

Which of these matter and which do not:

- **Projector lease free and window idle (rows 8, 9): matter.** The file's `UPDATE schema_contract` and the DDL take the database write lock briefly; the rule inherited from the 0013-0016 sequence is no live projector lease. The projector also reads `schema_contract` (`SELECT version`) at each run.
- **Discovery quiet (row 10): matters mildly**, same reason; check, do not assume.
- **Predictions Task (hourly): does not matter for correctness.** It writes R2 and prediction state, none of which the DDL touches, and it never reads the four new tables. Prefer a slot with no prediction run in progress anyway, so that a failure is easy to attribute. The baseline measuring runs needed a quiet Predictions window because they compare R2 ETags; this apply does not.
- **Cron `0 * * * *`:** the hourly tick runs the projector (when `D1_ENRICHMENT_WRITE` is `on`), the EPG ensure and the Discovery reconcile. A tick that starts during the apply is not harmful by design (the new objects are inert) but makes the evidence harder to read; a slot that ends before `:55` and starts after the previous tick has finished (for example `:40` to `:55` Madrid time, to be confirmed against the live lease rows) is a proposal, not a measured quiet window.

Evaluate: any row off its expected value is STOP, no apply, and the rows go to the owner. `inconsistent` means escalate; no repair and no retry is proposed.

## 5. The apply (only after the GO)

Method, following the recorded precedent for `0012` and `0013`: **one D1 query whose `sql` is the exact text of the checked-in file**, executed through the Cloudflare Developer Platform connector `d1_database_query` (the path used on 11 Nov 2026 for the baseline record and the `r2` to `prepared` move; the Cloudflare API connector's `execute` was refused for D1 writes with error 7500 on that day). `wrangler d1 execute iptv --remote --file migrations/0019_canonical_write_receipt.sql` is the alternative that needs the owner's Cloudflare credentials on the operator machine; it was not used in this repository's recorded applies and is not verified here. The Developer Platform connector is deprecated (see the baseline runbook).

Operator rules:

1. Paste the file content unchanged; compute the sha256 of the text sent and compare it with the GO.
2. Send it **once**. On a timeout, a lost response or any ambiguity, do not resend: run the section 6 readback first (the refuse-insert makes a second full apply fail, but a partial state must be read, not guessed).
3. Read every statement result. Expected: 28 results, all `success`; the first (the refuse-insert) with `changes` 0; the final `UPDATE` with `changes` 1.
4. No other statement, no `epg_sync_*`, no flag or Task change, no R2 access.

**Atomicity, stated truthfully.** The 0013 apply record shows a multi-statement file executed as one D1 query with all statements reported. What is not verified: whether D1 runs a multi-statement `query` body in one transaction and rolls it all back on a failing statement, or stops at the failing statement and leaves the earlier ones applied. The design therefore puts the only refusal first (before any `CREATE`), so for every foreseeable failure (wrong version, incomplete v18, repeat apply) nothing has been created yet. A failure after the first statement (a syntax or resource error mid-file) could leave a partial schema; that is an unknown, not a guarantee, and it is the reason for the readback-before-retry rule and the STOP rules below. The D1 trigger bodies contain `;` inside `BEGIN ... END`; the 0013 apply (six triggers) is the precedent that the connector accepts this; `0019` has 20 `CREATE TRIGGER` statements (19 new names) and the same shape (not verified for this file).

## 6. Read-back (immediately after; same read path as the preflight)

| Item | Expected |
| --- | --- |
| `schema_contract` | one row, `version` 19, note `Schema v19: durable canonical write receipt and activation baseline (empty). Follows a complete version 18.` |
| Tables | the four new tables present (`canonical_write_receipt`, `canonical_receipt_baseline`, `canonical_receipt_watermark`, `canonical_receipt_baseline_seal`) |
| Indexes | `canonical_write_receipt_due`, `canonical_write_receipt_target` (plus SQLite's automatic primary-key indexes; read by name, not by count) |
| Triggers | the 19 NEW names listed in the file (20 `CREATE TRIGGER` statements; the shared `schema_contract_no_downgrade` is `IF NOT EXISTS` and must remain present, not counted as new): `canonical_write_receipt_insert_open`, `_update_open`, `_insert_shape`, `_insert_generation`, `_immutable`, `_transition`, `_attempts`, `_generation`, `_no_delete`, `_insert_baseline`; `canonical_receipt_baseline_insert`, `canonical_receipt_watermark_insert`, `canonical_receipt_baseline_seal_insert`, `canonical_receipt_watermark_no_update`, `_no_delete`, `canonical_receipt_baseline_no_update`, `_no_delete`, `canonical_receipt_baseline_seal_no_update`, `_no_delete` |
| Rows | `canonical_write_receipt`, `canonical_receipt_baseline`, `canonical_receipt_watermark`, `canonical_receipt_baseline_seal`: 0 rows each |
| Unchanged | marker `prepared`/`open`/1, fence `ok` 1, baseline `verified` with the same reference, `canonical_revision` 0 rows, projector lease and window as in the preflight, `film_rated_admission`, `film_retention`, `tmdb_retirement_decision` counts as before (0 each until H1) |
| `handoffReadiness` (read-only, run on an operator copy or by the same SELECTs) | `receipts_schema_missing` absent; the other 29 blockers unchanged |

A mismatch, an unexpected row count or a partial object set is STOP; escalate with the rows. No automatic repair, retry or downgrade.

## 7. STOP conditions and recovery (truthful)

STOP and hand the evidence to the owner when: any preflight row is off; the file identity differs from the GO; a lease or window is not free; the apply result is not 28 successes; the outcome is unknown; the readback does not match; any other writer's state changed during the operation.

What recovery exists:

- **Before the apply or on a refusal at statement 1:** nothing was created; there is nothing to undo.
- **A successful apply is not reverted by a code revert, a deploy or a git revert.** `schema_contract_no_downgrade` makes the version non-decreasing, so version 19 stays.
- **The new tables are inert while the marker is `prepared`, `r2` or `held`** (the triggers refuse every write, and no code writes them). Leaving them in place is the safe default and the recommended remedy for any problem that is not the tables themselves.
- **Dropping the empty tables is itself a schema write** (`DROP TABLE` of four tables and their triggers; the `no_delete` triggers only guard row deletes) and needs its own explicit owner GO, preflight and readback; the version would stay 19 and a later re-apply of the file would be refused by its own guard (the tables would be absent but the version is not 18), so a drop is a one-way door that needs a corrected replacement migration. This path is **designed here only and never rehearsed** (not verified).
- **A partial apply** (only possible if the connector is not transactional, not verified): read the set of objects present and the version, then the owner decides between completing the missing objects with a reviewed, file-specific fix and a drop of what exists. Never "run the file again": it is refused or fails on existing objects.
- **D1 Time Travel** restores the whole database and loses every later write of every domain (EPG, Discovery, metadata, ratings, predictions, owner reviews); it is an owner decision for a corrupted database, not a remedy for this change.
- Once the receipt baseline is recorded and receipts exist (after `open`), the tables hold data and a drop is no longer a harmless option; that is later and out of this page.

## 8. After the apply

1. The SCHEMA_EXPECTED PR (section 2) is merged after the readback matches, with its full CI.
2. Dated evidence under `docs/evidence/d1-migration/` (`air-374-0019-apply-<date>.md`): the preflight and readback rows, the file identity, the operator path, and what was not verified; the registry row; `migrations/README.md` status of `0019`.
3. The next steps stay separate: the P5 loader (H1), the producers (P3), the flip and the receipt baseline (H2). Applying 0019 clears exactly one of the 30 `handoffReadiness` blockers (`receipts_schema_missing`).
