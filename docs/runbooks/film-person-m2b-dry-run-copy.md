# Film/Person M2b: the EPG producer dry run on a local copy of the canonical rows (offline tool, nothing run in production)

**Role:** the exact procedure, statements, caps, stop rules and output of the dry run that ADR 0128 names M2b: the offline harness of M2 ([`scripts/epg-producer-dry-run.mjs`](../../scripts/epg-producer-dry-run.mjs)) run over a local sqlite copy of the canonical rows, to measure the Film, Person and credit unit volume per run, the cost of planning and of the plan fingerprint, and the size of a first pass. The authority for the design is [ADR 0128](../adr/0128-epg-canonical-producer-durable-execution.md).

**This page authorizes nothing, and nothing in the pull request that adds it authorizes a production read.** The tool [`scripts/epg-producer-m2b.mjs`](../../scripts/epg-producer-m2b.mjs) touches no network, D1, R2, Cloudflare or connector; it only prints statements and reads the files named on its command line. The bounded copy of section 2 needs its own exactly scoped read-only owner GO.

## 1. What is already known, and what this adds

The first E6 production measurement ([evidence](../evidence/d1-migration/air-374-e6-production-measurement-2026-11-12.md)) gave the table volumes (10,044 Films, 53,623 Persons, 107,064 credit rows, 391 watchlist Films, 399 metadata rows) and about 395 members per published generation. A separate count probe is therefore not needed: the copy statements carry their own page and row caps. This tool adds what E6 could not give: the cost of planning at that volume, the unit volume of Person and credit kinds, and the fingerprint cost.

## 2. The copy (needs its own owner GO)

`node scripts/epg-producer-m2b.mjs emit-sql` prints one keyset-paged statement per table (`SELECT rowid AS _rid, <columns> FROM <table> WHERE rowid > ? ORDER BY rowid LIMIT ?`), the page size, the per-table row cap and a statements digest. The tables are exactly those the harness reads (a test fails if the harness reads another one): `film`, `film_metadata`, `film_sync_state`, `film_external_id`, `film_redirect`, `film_dimension`, `film_localization_source`, `watchlist_film`, `person`, `person_external_id`, `person_alias`, `film_person_credit` and `canonical_revision`.

Caps (proposals; the owner may lower them, never raise them in the field): 300,000 rows read per statement, 1,500,000 in total, 2,000 rows per page, 5,000 ms per statement and 120,000 ms in total, schema 21. The volumes above sum to roughly 210,000 rows plus the six tables E6 did not count.

Stop rules: any statement error or non-success, a page above its cap, a total above the total cap, a result row with other columns than planned, any non-scalar value, a schema version other than 21, a Film/Person marker that is not readable. On a stop the reader stops and reports; there is no retry loop.

Owner options: (a) the full tables above (largest: credits and Persons, about 160,000 rows); (b) a scope limited to the observed Films (the watchlist members) and the Persons they credit, which keeps about a tenth of the rows but needs different statements and a new review of this page.

## 3. Loading, verifying and running (offline)

1. `load-copy <results.json> <out.sqlite>` builds a NEW sqlite file from the repository migrations and the pasted pages. It refuses an existing output, a digest that is not the one of `emit-sql`, a table outside the plan, a missing table, extra or missing columns, a non-scalar value and any table or total above the caps.
2. `verify-copy <file.sqlite>` checks the schema version, the planned tables, the caps and counts the foreign-key violations (page boundaries can split a pair).
3. `run <file.sqlite> [--departed N] [--max-films N] [--all-films]` verifies the copy, runs the M2 harness through its read-only guard and prints counts and timings only. It checks that the file is byte-identical afterwards.

The observed inputs are derived from the stored rows: the observed Films are the watchlist members (about 395 per run), the departed units are a deterministic sample of Films that are off the watchlist, the Person rows are the Persons credited from the observed Films and the credit units are the observed Films that have credits.

## 4. Honest limits

- The inputs come from the rows the writer already stored, not from the sources of a real EPG commit (S5-1 is not wired): observed Film units come out no-op by construction. The run measures volume and cost. The share of Films that really change per run comes from the E6 `film_updates_by_day` counts (median 254 a day) and, later, from the differential of S5-2.
- `person_state` units (localized Person names) are not built and are reported unmeasured.
- Pages are read at different instants: a copy is a measurement input, never a baseline or a proof, and is not a consistent cut.
- The copy holds titles and stored metadata. It stays local, is never committed, never leaves the operator's machine and is deleted after the run.

## 5. Owner GO text (to be signed per run)

"GO: read-only copy of the M2b tables for the EPG producer dry run. Statements: the output of `emit-sql` with digest `<digest>`; caps as in section 2 (lowered to `<caps>` if I say so); operator `<operator>`; window `<window>` outside the hourly `:00` tick and the daily EPG run; the local copy is deleted after the run. This GO covers this one run and is not a standing authorization."

Nothing here chooses a D-C parameter.
