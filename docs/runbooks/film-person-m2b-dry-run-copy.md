# Film/Person M2b: offline dry run of the EPG producer plan

**Role:** how the offline harness of M2 ([`scripts/epg-producer-dry-run.mjs`](../../scripts/epg-producer-dry-run.mjs)) is run to measure Film, Person and credit unit volume, statements prepared, and the local cost of planning and of the plan fingerprint. The producer design is [ADR 0128](../adr/0128-epg-canonical-producer-durable-execution.md). The measurement input is [ADR 0138](../adr/0138-m2b-synthetic-scale-measurement.md).

**This page authorizes nothing.** The primary path (section 0) touches no network, D1, R2, Cloudflare or connector. A production read is a separate operation-specific owner GO. The synthetic timings are not production latency, not parity and not the production `changedShare`.

## 0. Primary path: a synthetic catalog at the E6 aggregate scale

No production GO is required. Sections 2, 2a, 2b and 5 are the earlier full-table copy. That copy is unused, its delivery is blocked, and choosing among the section 2b options is not a prerequisite for this path or for a provisional D-C discussion.

`node scripts/epg-producer-m2b-synthetic.mjs layout` prints the count summary and writes nothing. `build <out.sqlite>` creates a new local sqlite file from the repository migrations and a deterministic layout (it refuses an existing file). `measure <out.sqlite>` runs the existing harness through its read-only guard and prints counts and timings only. The sqlite file stays on the operator's machine, is not committed, and is deleted when the run is no longer needed.

The layout seed is `m2b-synthetic-e6-2026-11-14`. Its totals are the sanitized E6 aggregates of 12 Nov 2026 ([evidence](../evidence/d1-migration/air-374-e6-production-measurement-2026-11-12.md)): 10,044 Films, 53,623 Persons, 107,064 credit rows, 34,936 dimension rows, 391 watchlist Films, 8,600 credit rows and 6,452 Persons on that watchlist, 399 metadata rows and 399 sync rows. The placement is a model that hits those totals (credit lists from 11 to 26 on the watchlist, Films with no credits, null titles, null metadata fields, missing and conflicting external ids, lists at the 50-credit cap, a few redirects). It is not a draw from production and not the production distribution.

Two loads are measured on that one catalog:

- **Steady.** The observed Films are the 391 watchlist members. Six departed Films are a deterministic sample of stored Films that are not on the watchlist (the same sample `inputsFromCopy` selects). The dated run planned 7,240 units: 397 `film_facts`, 6,452 `person_mutation`, 391 `film_credits`.
- **Elevated.** A second modelled cohort of the same credit shape (another 391 Films, 8,600 credit rows, 6,452 Persons), disjoint from the watchlist, is added to the watchlist, and six further Films outside both cohorts are the departed sample. The dated run planned 14,474 units. This cohort is not an E6 count.

Departed Films are part of both plans. The observed set is not reduced to the watchlist.

**Credit-cap stress, separate from both cohorts.** The catalog also holds Films at the 50-credit unit cap, outside the watchlist and outside the elevated cohort. `measure` observes one of those Films alone, through the same harness, and labels the result as not the E6 cohort. On the dated run that Film planned 52 units (1 `film_facts`, 50 `person_mutation`, 1 `film_credits`) and prepared 213 statements. The other cap Films are not part of that scenario.

- **Absence.** The steady departed ids plus three ids the store does not hold, planned as Film units only. The missing ids are `absent` and the fingerprint is `complete: false` (`unresolved_release`). A missing Film is not reported as a successful release.
- **Return.** The elevated run puts the steady departed Films onto the watchlist. They are observed units on that run and are not released again. On the dated run, 6 of 6 returned.

`person_state` is not built by the harness and is reported unmeasured. The harness `changedShare` on this catalog is a comparison with rows the fixture just wrote; stored units come out no-op. It is not the production share of units that apply. Local plan and fingerprint time is not a D1 round trip, not D1 CPU or write cost, and not a Workflow limit. The dated counts, the statement reconciliation and the residual gap are in the [measurement record](../evidence/d1-migration/air-465-m2b-synthetic-scale-2026-11-14.md).

A copy the verifier marks `representative: false` is not a D-C input (`notADCInput`).

## 1. What is already known, and what the synthetic path adds

The first E6 production measurement ([evidence](../evidence/d1-migration/air-374-e6-production-measurement-2026-11-12.md)) gave the table volumes (10,044 Films, 53,623 Persons, 107,064 credit rows, 391 watchlist Films, 399 metadata rows) and about 395 members per published generation. Section 0 uses those aggregates as targets. It adds the planner's unit count for Person and credit kinds, the statement count of the no-op path, and the local plan and fingerprint time, on a model of that catalog. It does not add the production `changedShare`.

## 2. The copy (historical, unused, blocked; not the default)

This section is the procedure that was built for a production copy of the canonical rows. It is not the measurement path. Delivery of the full tables is blocked (section 2a). Choosing a delivery option in section 2b does not gate section 0 and does not gate a provisional D-C discussion. The record of the block stays as written.

`node scripts/epg-producer-m2b.mjs emit-sql` prints, per table, ONE count statement (`SELECT COUNT(*) AS n, MAX(rowid) AS max_rowid FROM <table>`) and ONE keyset-paged statement (`SELECT rowid AS _rid, <columns> FROM <table> WHERE rowid > ? ORDER BY rowid LIMIT ?`), the page size, the per-table row cap, the operator protocol and a statements digest. The tables are exactly those the harness reads (a test fails if the harness reads another one): `film`, `film_metadata`, `film_sync_state`, `film_external_id`, `film_redirect`, `film_dimension`, `film_localization_source`, `watchlist_film`, `person`, `person_external_id`, `person_alias`, `film_person_credit` and `canonical_revision`.

Caps (proposals; the owner may lower them, never raise them in the field): 300,000 rows read per statement, 1,500,000 in total, 2,000 rows per page, 5,000 ms per statement and 120,000 ms in total, schema 21. The volumes above sum to roughly 210,000 rows plus the six tables E6 did not count.

**Operator protocol (what is enforced where).** The operator sends ONE statement per request, in the printed order, and reads the connector metrics (`rows_read`, `duration`) of EACH response before sending the next: a page above the per-statement caps, or a running total above the total caps, is a STOP and no further statement is sent. The operator records those metrics under `meta` for every statement. The offline tool cannot prevent a read; it re-checks the recorded metrics afterwards and refuses a capture that went over a cap or that lacks a metric. These are two different gates: the live stop is the operator's, the after-the-fact refusal is the tool's.

**Page manifest (a copy must be provably complete).** A results file keeps the ordered pages, not a flattened row list: per table the recorded count (`n`, `maxRowid`, `meta`) and every page with its cursor (`after` the previous page's last rowid, `last`), its rows (each with `_rid`) and its `meta`. The tool refuses: a first page that does not start at 0, a page that does not start where the previous one ended (a dropped, repeated or reordered page), a page that is not full before the last one, a last page that is full while the recorded count says more follows, rows out of rowid order, a row total that differs from the recorded count, a last rowid that differs from the recorded maximum, a populated table presented as empty, a missing metric, and any cap breach. The count statement is itself part of the recorded evidence: a count that was edited to match an emptied table cannot be detected offline, which is why the operator pastes the connector response as received.

Stop rules: any statement error or non-success, a page above its cap, a total above the total cap, a result row with other columns than planned, any non-scalar value, a schema version other than 21, a Film/Person marker that is not readable, a page chain that does not continue. On a stop the reader stops and reports; there is no retry loop.

**Scope (historical proposal, owner chat selection of 13 Nov 2026, later replaced).** The owner's chat reply of 13 Nov 2026 was "1 - M2b на production: полные таблицы", a scope choice only. On 14 Nov 2026 the owner replaced that requirement with the synthetic catalog of section 0 ([ADR 0138](../adr/0138-m2b-synthetic-scale-measurement.md)). The full-table scope is not the default and is not signed. About 210,000 rows (largest: credits and Persons, about 160,000 rows) plus the six tables E6 did not count.

## 2a. The reader (reviewed code that executes the plan)

The operator protocol of section 2 is implemented by [`scripts/epg-producer-m2b-reader.mjs`](../../scripts/epg-producer-m2b-reader.mjs), so that the operator does not run it by hand. `readCopy({request, accountId, databaseId, plan, pageRows, now})` is a self-contained async function (no import, no network, no environment, no secret, no file): it only calls the injected `request({method, path, body})` in the shape of `cloudflare.request`, against the D1 query endpoint `POST /accounts/{id}/d1/database/{db}/query` with `{sql}` or `{sql, params}`. It runs offline against a fake connector over the sqlite stand-in in `tests/epg-producer-m2b-reader.mjs`.

What it does, in this order:

1. It refuses a plan it does not recognise BEFORE any request. The reviewed plan is bound INTO the text of `readCopy`: the statements digest and the ORDERED 13 tables with their ORDERED columns of `COPY_PLAN`; a caller-supplied plan is only data that must equal them (`plan_not_approved`: another digest, another or extra table, an extra, missing, reordered or other column, tables in another order, a table left out), so a self-consistent, well-formed plan for an unapproved table (for example `schema_contract`) sends NO request. A test keeps the text in step with `COPY_PLAN` and the digest of `emit-sql`. Also refused: a statements digest that is not a SHA-256, caps missing, a cap above the ceiling (300,000 / 1,500,000 / 2,000 / 5,000 ms / 120,000 ms, schema 21: a plan may lower the ceilings, never raise them), a statement that is not exactly the count or page statement built from its table and columns, an unsafe table or column name, a table twice.
2. It sends ONE statement per request in the printed order: `SELECT version FROM schema_contract WHERE id = 1`, the Film/Person marker read, then per table the count statement and the keyset pages (`_rid` cursor, page size 2,000). It awaits each response before it sends the next request.
3. It judges EACH response before the next request: the envelope is a success with one statement result, `meta.rows_read` and `meta.duration` are present, no per-statement cap and no running total (rows read, milliseconds) is above its cap.
4. It STOPS, returns `{ok:false, stop:{code, ...}, requests}` and sends no further request on: a request that throws; a response that is not a success or has the wrong shape; a missing metric; a cap breach (`over_cap_rows_read`, `over_cap_duration`, `over_cap_total_rows_read`, `over_cap_total_duration`); a schema version other than 21 (`schema_version`); an unreadable marker (`marker_unreadable`); a count that is invalid or above the per-statement cap; a page above the page size; a result row that is not an object, has other columns than planned or a non-scalar value; a `_rid` that does not increase (`rowid_order`); a table that returns more rows than its count (`count_changed`), fewer (`count_mismatch`) or another maximum rowid (`max_rowid_mismatch`). A defect of the reader itself is reported as `reader_defect`, never as a copy.
5. It assembles exactly the results file that `verifyResults` accepts (`_statementsDigest`, `_capturedAt`, `_pageRows`, per table `count` and `pages` with `after`, `last`, `rows` and `meta`) and returns it with `checks` (the schema version and the marker it read). A table ends at a short page, or at a full page that completes the recorded count (no empty terminal page is requested).

**Delivery is BLOCKED.** `node scripts/epg-producer-m2b-reader-bundle.mjs digest` prints the statements digest and the reader digest. `node scripts/epg-producer-m2b-reader-bundle.mjs bundle ...` and `bundleText` REFUSE (exit 3, nothing on stdout): no `execute` text is offered. The reader returns the whole results object (about 210,000 rows) as ONE result of an `execute` call, and the Cloudflare API connector returns about 6,000 tokens of content by default; truncation would be discovered only after every authorized read had finished, leaving no usable local copy and requiring a new GO. No file or pipe handoff from the connector to a local file exists in this procedure, and none has been tested. The offline tests still prove that the function text runs as an `execute` body (through `executeBodyText`, a test-only function) and that every statement it sends passes `assertReadOnly`. Read budgets are NOT relaxed to work around this, and no source row goes into GitHub or a chat.

Digests of this version of the plan and the reader (the test fails if the runbook does not name them):

- statements digest (`emit-sql`, 26 statements): `ca84fae592b98b40696348f1c7af355284b8f5acc48e44749a5440aeb79a06b3`
- reader digest (SHA-256 of `String(readCopy)`): `1cdbc0e55daf75435cbe39e99af89ef2bc099f652e91a5907cfe11e1b8530612`

Limits of the reader: it was proven against a fake connector only. A run reads each page at a different instant (section 4). The single-result delivery of a full-table capture does not work (above), so the full-table `execute` capture stays BLOCKED. It is not waiting on a choice among section 2b before the synthetic measurement can proceed.

### 2b. Delivery paths that were not chosen (not a prerequisite)

These three options were written down and none was chosen. They are not a menu that blocks section 0 or a provisional D-C discussion. They remain unused.

- **Chunked connector handoff.** Per-table or per-page chunks, each independently verified, with a manifest and global cap and stop accounting. Honest estimate: about 210,000 rows is likely tens of MB of JSON (row size not measured); at about 24 KB (about 6,000 tokens) per returned result that is on the order of thousands of `execute` calls, each a production read that must also be reviewed so that it adds nothing beyond the plan, and the pages would be read at far more different instants. It is neither tested nor proposed as realistic.
- **Local operator export with the owner's own credentials** (the route of the `iptv-credentials` skill, an owner-run read-only export written straight to a local file outside the repository). It needs its own tested reader and its own exactly scoped GO.
- **Observed-subset scope** (the observed Films and the Persons they credit, about a tenth of the rows): different statements, a new review of this page, and possibly a size the connector can return. A later small sample, if one is justified, is section 6, not this option.

Any of these would need its own review and GO. This section chooses none, and none has to be chosen.

## 3. Loading, verifying and running (offline)

1. `load-copy <results.json> <out.sqlite>` verifies the page manifest first (section 2) and builds a NEW sqlite file from the repository migrations and the verified pages. It refuses an existing output. The copy carries one extra table, `m2b_copy_manifest`, with the row count and maximum rowid each table was verified with.
2. `verify-copy <file.sqlite> [--allow-inconsistent]` checks the schema version, the planned tables, the caps, the manifest (a table that no longer holds the verified row count, or a copy without a manifest, is refused) and the foreign keys. **A copy with foreign-key violations is refused**; with `--allow-inconsistent` it is returned with `representative:false` and the reason.
3. `run <file.sqlite> [--departed N] [--max-films N] [--all-films] [--allow-inconsistent]` verifies the copy, runs the M2 harness through its read-only guard and prints counts and timings only. It checks that the file is byte-identical afterwards. A run on an inconsistent copy (only with `--allow-inconsistent`) is labelled `representative:false` and `notADCInput:true` and must never be used as a D-C input.

The observed inputs are derived from the stored rows: the observed Films are the watchlist members (about 395 per run), the departed units are a deterministic sample of Films that are off the watchlist, the Person rows are the Persons credited from the observed Films and the credit units are the observed Films that have credits. Section 0 uses this same derivation on the synthetic file.

## 4. Honest limits

- The inputs come from the rows the writer already stored, not from the sources of a real EPG commit (S5-1 is not wired): observed Film units come out no-op by construction. The run measures volume and cost. The share of units that really apply is the production `changedShare`, which this harness does not measure. E6 `film_updates_by_day` (median 254) is not that share. The later source is the differential of S5-2.
- `person_state` units (localized Person names) are not built and are reported unmeasured.
- Pages are read at different instants: a copy is a measurement input, never a baseline or a proof, and is not a consistent cut.
- The copy holds titles and stored metadata. It stays local, is never committed, never leaves the operator's machine and is deleted after the run.
- The synthetic catalog of section 0 has the same no-op property, for the same reason: the harness reads back rows the fixture wrote. Its local timings are not production latency.

## 5. Owner GO text (historical template, not signable)

**This text is a TEMPLATE and cannot be signed: the delivery path is blocked (section 2a), and the full-table scope is no longer the measurement path (section 0, [ADR 0138](../adr/0138-m2b-synthetic-scale-measurement.md)).** It is kept so the scope of that historical proposal stays visible.

"GO: read-only copy of the M2b tables for the EPG producer dry run, full tables (about 210,000 rows plus the six tables E6 did not count). Statements: the output of `emit-sql` with digest `ca84fae592b98b40696348f1c7af355284b8f5acc48e44749a5440aeb79a06b3`; reader: `readCopy` of `scripts/epg-producer-m2b-reader.mjs` with digest `1cdbc0e55daf75435cbe39e99af89ef2bc099f652e91a5907cfe11e1b8530612`, delivered by <the delivery path the owner decided and a reviewed, tested handoff for it; the single-result `execute` body is BLOCKED>, against the production D1 database `iptv`; caps as in section 2 (300,000 rows read per statement, 1,500,000 in total, 2,000 rows per page, 5,000 ms per statement, 120,000 ms in total, schema 21), lowered to `<caps>` if I say so; operator `<operator>`; window `<window>` outside the hourly `:00` tick and the daily EPG run; any stop of the reader ends the run with no retry and no second attempt without a new GO; the local copy and the results file are deleted after the run. This GO covers this one run and is not a standing authorization."

Nothing here chooses a D-C parameter.

## 6. Optional later sample of production rows

Not part of the synthetic measurement, and not authorized by this page. Take one only when a named residual gap cannot be closed any other way, under a new card and an operation-specific owner GO. It is not one of the section 2b options and it is not the full tables.

One statement, one result, with caps the owner sets at or below 20,000 rows, 2,000 rows per page, 5,000 ms and schema 21. The Film id list is the watchlist union a departed set chosen by the same SHA-256 order the harness uses, and it must not be only the watchlist. Persons and credits are those of that Film list, not a separate Person table scan. Representative means the sample's credit-list min, median and max and its distinct Persons are reported next to the E6 aggregates, and the gap is written down. Rows stay local, are deleted after the run, and do not enter GitHub or a chat. The GO names the exact statement text, its digest, the caps, the operator, the window outside the hourly `:00` tick and the daily EPG run, and that a stop ends the run with no retry.

```sql
SELECT rowid AS _rid, id, contract_version, canonical_identity, original_title, updated_at
FROM film
WHERE id IN (SELECT film_id FROM watchlist_film)
   OR id IN (/* departed ids, the harness hash order, not a watchlist member */)
ORDER BY rowid LIMIT 2000;

SELECT rowid AS _rid, film_id, person_id, role, ordinal
FROM film_person_credit
WHERE film_id IN (/* the same Film id list, watchlist and departed */)
ORDER BY rowid LIMIT 2000;

SELECT rowid AS _rid, id, role_id, contract_version, updated_at
FROM person
WHERE id IN (
  SELECT person_id FROM film_person_credit
  WHERE film_id IN (/* the same Film id list */)
)
ORDER BY rowid LIMIT 2000;
```

The same shape, with the planned columns, covers `film_metadata`, `film_sync_state`, `film_external_id`, `film_dimension`, `film_localization_source`, `person_external_id`, `person_alias` and `canonical_revision`, each restricted to that Film or Person set. A count statement per table uses the same restriction. These statements are not the approved `emit-sql` plan; a reader for them needs its own review. They are not run from this page.

Related: [decision pack](film-person-d-c-decision-pack.md), [synthetic measurement](../evidence/d1-migration/air-465-m2b-synthetic-scale-2026-11-14.md), [ADR 0138](../adr/0138-m2b-synthetic-scale-measurement.md), [runbook index](README.md).
