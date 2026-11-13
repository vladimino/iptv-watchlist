# Film/Person M2b: the EPG producer dry run on a local copy of the canonical rows (offline tool, nothing run in production)

**Role:** the exact procedure, statements, caps, stop rules and output of the dry run that ADR 0128 names M2b: the offline harness of M2 ([`scripts/epg-producer-dry-run.mjs`](../../scripts/epg-producer-dry-run.mjs)) run over a local sqlite copy of the canonical rows, to measure the Film, Person and credit unit volume per run, the cost of planning and of the plan fingerprint, and the size of a first pass. The authority for the design is [ADR 0128](../adr/0128-epg-canonical-producer-durable-execution.md).

**This page authorizes nothing, and nothing in the pull request that adds it authorizes a production read.** The tool [`scripts/epg-producer-m2b.mjs`](../../scripts/epg-producer-m2b.mjs) touches no network, D1, R2, Cloudflare or connector; it only prints statements and reads the files named on its command line. The reader of section 2a ([`scripts/epg-producer-m2b-reader.mjs`](../../scripts/epg-producer-m2b-reader.mjs)) is a pure function over an injected `request` and is likewise offline until it is handed to a connector. The copy of section 2 needs its own exactly scoped read-only owner GO.

## 1. What is already known, and what this adds

The first E6 production measurement ([evidence](../evidence/d1-migration/air-374-e6-production-measurement-2026-11-12.md)) gave the table volumes (10,044 Films, 53,623 Persons, 107,064 credit rows, 391 watchlist Films, 399 metadata rows) and about 395 members per published generation. A separate count probe is therefore not needed: the copy statements carry their own page and row caps. This tool adds what E6 could not give: the cost of planning at that volume, the unit volume of Person and credit kinds, and the fingerprint cost.

## 2. The copy (needs its own owner GO)

`node scripts/epg-producer-m2b.mjs emit-sql` prints, per table, ONE count statement (`SELECT COUNT(*) AS n, MAX(rowid) AS max_rowid FROM <table>`) and ONE keyset-paged statement (`SELECT rowid AS _rid, <columns> FROM <table> WHERE rowid > ? ORDER BY rowid LIMIT ?`), the page size, the per-table row cap, the operator protocol and a statements digest. The tables are exactly those the harness reads (a test fails if the harness reads another one): `film`, `film_metadata`, `film_sync_state`, `film_external_id`, `film_redirect`, `film_dimension`, `film_localization_source`, `watchlist_film`, `person`, `person_external_id`, `person_alias`, `film_person_credit` and `canonical_revision`.

Caps (proposals; the owner may lower them, never raise them in the field): 300,000 rows read per statement, 1,500,000 in total, 2,000 rows per page, 5,000 ms per statement and 120,000 ms in total, schema 21. The volumes above sum to roughly 210,000 rows plus the six tables E6 did not count.

**Operator protocol (what is enforced where).** The operator sends ONE statement per request, in the printed order, and reads the connector metrics (`rows_read`, `duration`) of EACH response before sending the next: a page above the per-statement caps, or a running total above the total caps, is a STOP and no further statement is sent. The operator records those metrics under `meta` for every statement. The offline tool cannot prevent a read; it re-checks the recorded metrics afterwards and refuses a capture that went over a cap or that lacks a metric. These are two different gates: the live stop is the operator's, the after-the-fact refusal is the tool's.

**Page manifest (a copy must be provably complete).** A results file keeps the ordered pages, not a flattened row list: per table the recorded count (`n`, `maxRowid`, `meta`) and every page with its cursor (`after` the previous page's last rowid, `last`), its rows (each with `_rid`) and its `meta`. The tool refuses: a first page that does not start at 0, a page that does not start where the previous one ended (a dropped, repeated or reordered page), a page that is not full before the last one, a last page that is full while the recorded count says more follows, rows out of rowid order, a row total that differs from the recorded count, a last rowid that differs from the recorded maximum, a populated table presented as empty, a missing metric, and any cap breach. The count statement is itself part of the recorded evidence: a count that was edited to match an emptied table cannot be detected offline, which is why the operator pastes the connector response as received.

Stop rules: any statement error or non-success, a page above its cap, a total above the total cap, a result row with other columns than planned, any non-scalar value, a schema version other than 21, a Film/Person marker that is not readable, a page chain that does not continue. On a stop the reader stops and reports; there is no retry loop.

**Scope (owner decision of 13 Nov 2026): the full tables above**, about 210,000 rows (largest: credits and Persons, about 160,000 rows) plus the six tables E6 did not count. A scope limited to the observed Films and the Persons they credit (about a tenth of the rows) would need different statements and a new review of this page; it was not chosen.

## 2a. The reader (reviewed code that executes the plan)

The operator protocol of section 2 is implemented by [`scripts/epg-producer-m2b-reader.mjs`](../../scripts/epg-producer-m2b-reader.mjs), so that the operator does not run it by hand. `readCopy({request, accountId, databaseId, plan, pageRows, now})` is a self-contained async function (no import, no network, no environment, no secret, no file): it only calls the injected `request({method, path, body})` in the shape of `cloudflare.request`, against the D1 query endpoint `POST /accounts/{id}/d1/database/{db}/query` with `{sql}` or `{sql, params}`. It runs offline against a fake connector over the sqlite stand-in in `tests/epg-producer-m2b-reader.mjs`.

What it does, in this order:

1. It refuses a plan it does not recognise BEFORE any request: a statements digest that is not a SHA-256, caps missing, a cap above the ceiling (300,000 / 1,500,000 / 2,000 / 5,000 ms / 120,000 ms, schema 21: a plan may lower the ceilings, never raise them), a statement that is not exactly the count or page statement built from its table and columns, an unsafe table or column name, a table twice.
2. It sends ONE statement per request in the printed order: `SELECT version FROM schema_contract WHERE id = 1`, the Film/Person marker read, then per table the count statement and the keyset pages (`_rid` cursor, page size 2,000). It awaits each response before it sends the next request.
3. It judges EACH response before the next request: the envelope is a success with one statement result, `meta.rows_read` and `meta.duration` are present, no per-statement cap and no running total (rows read, milliseconds) is above its cap.
4. It STOPS, returns `{ok:false, stop:{code, ...}, requests}` and sends no further request on: a request that throws; a response that is not a success or has the wrong shape; a missing metric; a cap breach (`over_cap_rows_read`, `over_cap_duration`, `over_cap_total_rows_read`, `over_cap_total_duration`); a schema version other than 21 (`schema_version`); an unreadable marker (`marker_unreadable`); a count that is invalid or above the per-statement cap; a page above the page size; a result row that is not an object, has other columns than planned or a non-scalar value; a `_rid` that does not increase (`rowid_order`); a table that returns more rows than its count (`count_changed`), fewer (`count_mismatch`) or another maximum rowid (`max_rowid_mismatch`). A defect of the reader itself is reported as `reader_defect`, never as a copy.
5. It assembles exactly the results file that `verifyResults` accepts (`_statementsDigest`, `_capturedAt`, `_pageRows`, per table `count` and `pages` with `after`, `last`, `rows` and `meta`) and returns it with `checks` (the schema version and the marker it read). A table ends at a short page, or at a full page that completes the recorded count (no empty terminal page is requested).

How it is run (only under a GO, section 5): `node scripts/epg-producer-m2b-reader-bundle.mjs digest` prints the statements digest and the reader digest; `node scripts/epg-producer-m2b-reader-bundle.mjs bundle --database <D1 database id>` prints the text of the `execute` body of the Cloudflare API connector (the function text, called with the plan inline and `cloudflare.request`) and, on stderr, the digest of that whole text. The operator pastes that text unchanged, stores the returned `results` in a local file OUTSIDE the repository, and continues with section 3. The offline tests prove that the text runs as an `execute` body and that every statement it sends passes `assertReadOnly`.

Digests of this version of the plan and the reader (the test fails if the runbook does not name them):

- statements digest (`emit-sql`, 26 statements): `ca84fae592b98b40696348f1c7af355284b8f5acc48e44749a5440aeb79a06b3`
- reader digest (SHA-256 of `String(readCopy)`): `f711600eb2dfc564fe836385f19474287d13a7e8d510ac6dbf3ac1ec632bd4bb`

Limits of the reader: it was proven against a fake connector only. Whether the `execute` call can return a results file of about 210,000 rows is not verified; if the connector truncates it, the run stops being usable and a per-table split needs its own review and GO. A run reads each page at a different instant (section 4).

## 3. Loading, verifying and running (offline)

1. `load-copy <results.json> <out.sqlite>` verifies the page manifest first (section 2) and builds a NEW sqlite file from the repository migrations and the verified pages. It refuses an existing output. The copy carries one extra table, `m2b_copy_manifest`, with the row count and maximum rowid each table was verified with.
2. `verify-copy <file.sqlite> [--allow-inconsistent]` checks the schema version, the planned tables, the caps, the manifest (a table that no longer holds the verified row count, or a copy without a manifest, is refused) and the foreign keys. **A copy with foreign-key violations is refused**; with `--allow-inconsistent` it is returned with `representative:false` and the reason.
3. `run <file.sqlite> [--departed N] [--max-films N] [--all-films] [--allow-inconsistent]` verifies the copy, runs the M2 harness through its read-only guard and prints counts and timings only. It checks that the file is byte-identical afterwards. A run on an inconsistent copy (only with `--allow-inconsistent`) is labelled `representative:false` and `notADCInput:true` and must never be used as a D-C input.

The observed inputs are derived from the stored rows: the observed Films are the watchlist members (about 395 per run), the departed units are a deterministic sample of Films that are off the watchlist, the Person rows are the Persons credited from the observed Films and the credit units are the observed Films that have credits.

## 4. Honest limits

- The inputs come from the rows the writer already stored, not from the sources of a real EPG commit (S5-1 is not wired): observed Film units come out no-op by construction. The run measures volume and cost. The share of Films that really change per run comes from the E6 `film_updates_by_day` counts (median 254 a day) and, later, from the differential of S5-2.
- `person_state` units (localized Person names) are not built and are reported unmeasured.
- Pages are read at different instants: a copy is a measurement input, never a baseline or a proof, and is not a consistent cut.
- The copy holds titles and stored metadata. It stays local, is never committed, never leaves the operator's machine and is deleted after the run.

## 5. Owner GO text (to be signed per run)

"GO: read-only copy of the M2b tables for the EPG producer dry run, full tables (about 210,000 rows plus the six tables E6 did not count). Statements: the output of `emit-sql` with digest `ca84fae592b98b40696348f1c7af355284b8f5acc48e44749a5440aeb79a06b3`; reader: `readCopy` of `scripts/epg-producer-m2b-reader.mjs` with digest `f711600eb2dfc564fe836385f19474287d13a7e8d510ac6dbf3ac1ec632bd4bb`, run as the `execute` body printed by the bundle command against the production D1 database `iptv` through the Cloudflare API connector; caps as in section 2 (300,000 rows read per statement, 1,500,000 in total, 2,000 rows per page, 5,000 ms per statement, 120,000 ms in total, schema 21), lowered to `<caps>` if I say so; operator `<operator>`; window `<window>` outside the hourly `:00` tick and the daily EPG run; any stop of the reader ends the run with no retry and no second attempt without a new GO; the local copy and the results file are deleted after the run. This GO covers this one run and is not a standing authorization."

Nothing here chooses a D-C parameter.
