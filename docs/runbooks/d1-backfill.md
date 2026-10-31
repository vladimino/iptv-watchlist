# D1 backfill execution and recovery (owner approval required)

**Scope boundary:** the fenced snapshot, batch receipts and complete parity below protect a **bulk authoritative R2-to-D1 backfill**, not routine replay of a recoverable projector unit or a small read-only D1 check. Do not transplant this whole-database procedure into those operations. Where the current D1 projector offers idempotent unit-level replay and scoped readback, use that published contract and [risk classification](../process/agent-workflow.md#risk-proportional-operational-safeguards); keep target ownership and no-blind-retry. This statement does **not** turn the backfill CLI into a unit-replay CLI or authorize any D1 write. Full parity remains mandatory when claiming complete baseline migration or cutover.

`scripts/d1-backfill.mjs` imports one verified production baseline into the D1 database `iptv` without changing the runtime: R2 stays authoritative, the Worker reads D1 only through the read-only catalog views and keeps serving from R2. The decisions are [ADR-0019](../adr/0019-live-d1-backfill-boundaries.md); the contract (source and target identity, receipts, stop rules) is the [D1 contract](../reference/data/d1-schema.md#backfill-executor). This page is the procedure. None of its production steps is authorised by a merge, a deploy or this page: creating the database, applying the schema, reading production R2, creating credentials, running the import and any destructive recovery each need their own action-specific owner approval.

## Inputs and what each run checks

| Input | Where it comes from | Checked by the executor |
| --- | --- | --- |
| Snapshot directory | [read-only exporter](r2-snapshot-export.md), status `consistent_fenced` | every object re-hashed; status, fence and source identity re-read; NO-GO otherwise |
| Target database | `D1_BACKFILL_ACCOUNT_ID`, `D1_BACKFILL_DATABASE_ID`, `D1_BACKFILL_DATABASE_NAME` (default `iptv`) | uuid and name from the D1 API, frozen schema v1 tables, database identity receipts |
| Scratch database | `D1_BACKFILL_SCRATCH_DATABASE_ID`, never the target | atomicity probe at the configured batch size before every run |
| Credential | `D1_BACKFILL_API_TOKEN` in the environment only, scoped to D1 edit on the two databases | never written to a report, ledger or the repository |
| Acknowledged class C list | owner-reviewed JSON file, `--acknowledged` | only class C records; class A is never acknowledgeable |
| Batch limits | `D1_BACKFILL_MAX_BATCH_STATEMENTS` (default 1,000), `D1_BACKFILL_MAX_BATCH_BYTES` (default 1 MiB) | proven by the probe; larger units stop with `batch_too_large` |
| Schema | every target and dry-run database carries `0001`, `0002_generation_stage.sql` and `0003_candidate_show_identity.sql` (schema version 3, [ADR-0025](../adr/0025-candidate-show-identity.md)) | `schema_missing` or `schema_version_mismatch` before any write; with `--staged-generation`, chunks at most 950 statements and 1,000,000 bytes, never above the batch limits |

Outputs go to an absolute directory outside the repository: `report.json` (status, stop reasons, probe, identity findings, counts, parity, receipt audit, classes A/B/C and S (superseded payloads, [ADR-0029](../adr/0029-superseded-redirect-payloads.md)), adapter statistics; with `--staged-generation`, the `staged` section: per generation chunks planned/sent/already received, rows, bytes, largest chunk and row, requests, phase durations, commit statements/bytes/duration, and `staged.gate` against the 10-second commit budget) and `ledger.json` (every ledger row, the class C list with source key, checksum and reason, and the `superseded` list with both checksums). Exit code 0 is `completed`; 3 is `partial`, `stopped` or `no_go`; 2 is usage or configuration; 1 is an error.

## D1 HTTP API requirements

- `GET /accounts/{account}/d1/database/{uuid}` returns the database `uuid` and `name`; the fence compares both.
- `POST /accounts/{account}/d1/database/{uuid}/query` with a body `{sql}` executes the statements of one unit. Statements carry their values as SQL literals. The executor never sends `BEGIN`/`COMMIT`, which D1 rejects; whether a multi-statement request is all-or-nothing is exactly what the probe measures on the scratch database. The executor is correct only for a service that passes the probe at the configured size.
- Reads are single `SELECT` statements; their `results` rows are used as returned.
- Writes are never retried: a lost response or a `429`/`5xx` answer to a write stops the run with `write_uncertain`, because the batch may already have committed; the next run reconciles by reading back. Only reads are retried, within a bound.

## Sizes, memory and duration

- Units are small except one: a film, person, fingerprint, prediction version or rating unit is tens of statements; the programme generation unit writes every film membership, show and candidate of the published generation. As one statement list, at the production order of magnitude (about 22,000 candidates), it is 73,500 to 122,500 statements and 63 to 75 MiB, and one of its statements is about 710 KB, above the documented D1 limit of 100,000 bytes per statement ([size evidence](../evidence/d1-migration/generation-unit-size-2026-10-26.md); measure any size with `node scripts/d1-generation-size.mjs --films F --shows-per-film sf --candidates C --shows-per-candidate sc`). Without `--staged-generation` the run stops at that unit with `batch_too_large`. With it, the unit is staged per [ADR-0021](../adr/0021-staged-atomic-generation-import.md): at 1.25× the production candidates that is about 96 chunk requests of at most about 450 KB, a validation, a paged read-back of about 90,000 rows, one commit of 12 statements and a read-back of the committed generation ([local rehearsal](../evidence/d1-migration/air-168-staged-generation-local-2026-10-26.md)). The commit's duration on D1 grows with the rows it moves; the scratch verification below measured 1.6 s client and 0.66 s D1 server at 1.25× with synthetic generations ([scratch G4 evidence](../evidence/d1-migration/air-174-scratch-g4-2026-10-26.md)); staging storage holds one extra copy of the generation until an approved cleanup.
- Requests are sequential. Each unit costs roughly one to three reads, one write and one receipt write. A baseline of about 100,000 units is therefore several hundred thousand requests; bound each run with `--limit` and resume, which costs nothing because receipts make completed units free.
- `prepareImport` holds the mapped snapshot objects in memory (the 19 October archive was about 100 MB in total); run on a machine with a few GB of free memory.

## Scratch verification of the staged generation import (separate owner approval)

Only under an explicit owner approval naming the scratch database: apply `0001`, `0002` and `0003` to the scratch database (never to `iptv` in this step); stage a synthetic generation at 1.25× the production candidates (27,749 candidates, 2,300 films, two shows each) in chunks at the probe-proven size; interrupt after an arbitrary chunk and resume; validate, read back and commit; repeat the commit and commit a stale stage (both must change nothing); fail and discard a stage in bounded batches. Record requests, bytes, durations, any `429`/`5xx`, and the commit duration. GO for the generation unit in the production run needs every chunk accepted, an equal read-back after resume, and a commit of at most 10 seconds at 1.25×; otherwise NO-GO and no production write. No production payload is used in this step.

`scripts/d1-scratch-g4.mjs` ([AIR-174](https://trello.com/c/331Cq6IJ)) runs this verification. It uses synthetic data only and never reads R2.

**Target fence.** It talks only to the scratch database named in the environment:
- `D1_BACKFILL_ACCOUNT_ID`, `D1_BACKFILL_API_TOKEN` and `D1_BACKFILL_SCRATCH_DATABASE_ID`;
- `D1_G4_SCRATCH_DATABASE_NAME`, default `iptv-atomicity-scratch`.

It refuses the name `iptv` and the `D1_BACKFILL_DATABASE_ID` uuid. Every command checks the live uuid and name before anything else.

**Commands.** Each command is a separate step under its own owner approval. Outputs go to `--output`, an absolute directory outside the repository:
- `report.json`: steps, verdict, the commit's client and D1 server time, parity per final table, and request counts and timings by kind.
- `requests.jsonl`: one line per HTTP request with its kind, statement count, bytes, status and timings. It holds no SQL values and no credential.

| Command | Approval | Effect |
| --- | --- | --- |
| `--plan [--scale full\|real]` | none | Prints generation sizes, chunk counts, commands and GO criteria. Reads no credential and sends nothing |
| `--preflight` | scratch access, read-only | Identity, `sqlite_master` objects (objects outside the migrations are listed, never touched), `PRAGMA foreign_keys`, schema version, claim columns, harness stage states, final table counts |
| `--apply-schema --approved-scratch-writes` | apply `0001`, `0002` and `0003` to the scratch database (a database already on schema v2 gets `0003` only) | Applies each migration as one request, and only if none of its objects exists. A migration already complete is skipped. A partial schema, or a name taken by another object type, is `no_go: schema_partial` with no write |
| `--run --approved-scratch-writes` | synthetic writes to the scratch database | Runs the scenario below. The verdict is `GO`, `NO-GO`, or `INCOMPLETE` when the 1.25× generation was already committed by an earlier run |
| `--cleanup --approved-cleanup` | deleting staging rows, a separate approval | Discards the failed or superseded harness stages (`g4-prior`, `g4-rival`) in batches of 500. It never touches the published stage, the final tables or foreign objects |

**Scales.** `full` (the default) is the AIR-174 shape: 22,199 then 27,749 candidates (1.25× the production order of magnitude assumed then), two shows per candidate, run ids `g4-prior`, `g4-scaled`, `g4-rival`. `real` is 1.25× the AIR-175 production generation: 51,643 then **64,554** candidates, 2,300 films, one show per candidate (production has 0.63) and eight candidates whose slot carries a second EPG title (schema v3), run ids `g4r-prior`, `g4r-scaled`, `g4r-rival`. `real` runs on a scratch database that already holds the `full` run: its prior replaces the `full` pointer, and the legacy reference writes the `full` history first, so every final table is still compared row for row. `small` and `small_real` are the same two shapes at test size.

**Scenario.** `--run` takes these steps in order (`--scale full` by default):
1. Seed 2,300 synthetic films.
2. Stage and commit `g4-prior`: 22,199 candidates.
3. Send the first chunk of the 1.25× `g4-scaled` (27,749 candidates, two shows each) with a failing last statement. It must leave no staged row and no receipt.
4. A second executor of the same baseline must be refused (`stage_claimed_elsewhere`).
5. After the claim expires (the TTL is 60 s), an executor takes over and is interrupted before the middle chunk.
6. After the next expiry, a further executor takes over and resumes after the receipts.
7. Just before that executor's commit, the interrupted executor's fail must change nothing and its commit must be refused.
8. The timed commit runs (≤10 s).
9. A repeated commit must be refused.
10. The stale-pointer stage `g4-rival` must fail with `pointer_moved` and write nothing final.
11. A rerun must be a replay.
12. Every final table must equal, row for row, what the legacy `publishGeneration` writes into a local SQLite reference for the same two generations.

**What stops a run.** A real uncertain write (lost response, `429`/`5xx`) or a D1 failure stops the run with status `stopped`. Nothing is retried; read the report before any rerun. Behind an HTTPS proxy, run the script with `NODE_USE_ENV_PROXY=1` (Node 22.21 or later): Node's built-in `fetch` ignores `HTTPS_PROXY`, and the first describe then ends `stopped: network` before any write. `tests/d1-scratch-g4.mjs` rehearses every command against a fake D1 HTTP API. First real run: [scratch G4 evidence, 26 October 2026](../evidence/d1-migration/air-174-scratch-g4-2026-10-26.md) (GO).

## Procedure

**Discovery archive.** A snapshot taken after the [ADR 0034](../adr/0034-bounded-discovery-ledger.md) bounded ledger is active contains `epg/discovery-archive/v1/`: the pointer `current.json`, write-once manifest versions and segment versions, and the split's write-once copy of the source ledger. The importer reads the discovery family as the published active ledger, the manifest version it names (`archive.manifestId`) and exactly that manifest's segment versions; an active record wins over its archive copy. The resulting candidates, generation membership, shows and decisions are the rows a full-mode ledger produces. `report.json` carries `discoveryArchive`: mode, manifest, active, archived, `alsoArchived`, unique archived and `ledgerTotal` counts, and the number of referenced and unreferenced versions.

The run stops before any write, exit code 3, with one of these reasons:

| Stop reason | Meaning |
| --- | --- |
| `archive_manifest_unnamed` | the bounded ledger names no manifest |
| `archive_manifest_missing` | the named manifest is not in the snapshot |
| `archive_manifest_invalid` | the manifest's schema, segment table, segment object names or totals are inconsistent |
| `archive_segment_missing` | a segment version the manifest names is not in the snapshot |
| `archive_segment_sha256_mismatch` | the segment object's checksum differs from the manifest |
| `archive_segment_invalid` | a segment body, item count, payload key or key-to-segment hash is wrong |
| `archive_duplicate_key` | one key is in two segment versions of the named manifest |
| `archive_pointer_missing` | `current.json` is absent although the ledger is bounded |
| `archive_pointer_conflict` | `current.json` does not reach the named manifest through `parentManifestId`, so the snapshot mixes archive versions |
| `archive_counts_mismatch` | the ledger's `alsoArchived` or `uniqueArchivedItems` disagrees with what the segments hold |
| `discovery_ledger_copies_differ` | the root ledger and the published generation's copy differ, for example a cut taken during the generation handoff |

`current.json` may name a newer manifest than the published ledger (an archive swap without its publication); that is accepted when the chain reaches the named manifest. Manifest and segment versions outside the consistent read are `unreferenced`: listed in class B, kept in R2, not parsed and not counted as history. The source-ledger copy under `sources/` is R2-only archive. Any other key under `epg/discovery-archive/`, such as another archive version, is unknown and fails closed. A full-mode ledger is complete on its own, and archive objects next to it are unreferenced. The parity side reconstructs the archive independently of the importer's reader. The synthetic proof and its limits are in the [discovery archive import evidence](../evidence/d1-migration/air-261-discovery-archive-import-2026-10-28.md).

**Fingerprint version objects.** For every accepted fingerprint the Worker writes its immutable body `enrichment/films/<id>/fingerprints/<hash>.json` and generation record `enrichment/films/<id>/fingerprint-generations/<hash>-s<schema>-p<prompt>.json` ([ADR-0035](../adr/0035-selective-fingerprint-transition-compatibility.md) section 2; no switch since [ADR-0046](../adr/0046-retire-fingerprint-version-objects-switch.md)) before it moves `fingerprint.json`. Films whose fingerprints predate the writer have none. The importer checks both against `fingerprint.json` and the Worker's own content hash rule (`canonical` from `src/enrichment.js`, loaded, not copied). The pair the current record names is `mapped` through it; the `fingerprint_payload` row still comes from `fingerprint.json` alone. A valid older generation, or a body whose record write never followed, is `unreferenced`: listed in class B, kept in R2 for `restoreFingerprint`, not imported as history. `report.json` carries `fingerprintVersions`: bodies, generations, mapped, unreferenced and blocked counts. The run stops before any write, exit code 3, with one of these reasons:

| Stop reason | Meaning |
| --- | --- |
| `fingerprint_version_unreadable` | a body is not a JSON object |
| `fingerprint_body_identity_mismatch` | a body's `filmId` or `fingerprintHash` differs from its key |
| `fingerprint_body_hash_mismatch` | the body's content does not hash to the hash in its key |
| `fingerprint_generation_invalid` | a generation record is unreadable, has an unknown field, or its film, hash, schema or prompt version, `generatedAt`, `produced`, `fields` or `previous` is wrong for its key |
| `fingerprint_generation_body_missing` | a generation record names a body the snapshot does not hold |
| `fingerprint_current_body_mismatch` | `fingerprint.json` names a body whose content differs from its own |

A pointer that names a hash with no stored body or record is not a stop: the row comes from `fingerprint.json`, and the objects that exist are `unreferenced`. Only the Worker's own spelling of a key is a version key: the film segment must be exactly `encodeURIComponent` of the id it decodes to, and the schema and prompt versions are integers without leading zeros. Any other key under `fingerprints/` or `fingerprint-generations/`, including an alias such as `-s01-p1` or a needlessly or lower-case escaped film segment, is unknown and fails closed. The synthetic proof and the replay on a real snapshot are in the [fingerprint version import evidence](../evidence/d1-migration/air-264-fingerprint-version-keys-2026-10-29.md).

1. **Dry-run on SQLite (no production access beyond the approved snapshot).** `node scripts/d1-backfill.mjs --snapshot /abs/snapshot --output /abs/run-dry --target sqlite --database /abs/dry.sqlite` with a database created from `migrations/0001_schema_v1.sql`, `0002_generation_stage.sql` and `0003_candidate_show_identity.sql`. Review `report.json`: class A blockers, the class C list, class B families with their dispositions, parity, receipts. One dry-run is enough; a same-baseline rerun is not required, because `tests/d1-backfill.mjs` already proves that one applies nothing and sends no data write.
2. **Owner acknowledges the class C list** by producing the JSON file of `{sourceKey,targetTable,targetId,reason}` records from `ledger.json` after review. The acknowledgement records a known gap; it is not lossless parity.
3. **Create the databases** (owner, separate approval): `iptv` and a scratch database; apply migrations `0001`–`0004` to `iptv` only (`0004` since [ADR 0056](../adr/0056-d1-enrichment-write-through.md)).
4. **Back up before the first write.** Record the D1 bookmark of the empty target (Time Travel) and an export of it in the evidence; the bookmark is the restore point.
5. **Run in bounded batches.** `node scripts/d1-backfill.mjs --snapshot /abs/snapshot --output /abs/run-N --target d1 --limit 5000 --acknowledged /abs/class-c.json`, repeated until `completed`. The first command of each run is the probe on the scratch database; a run that does not pass it never reads the target.
6. **No mandatory rerun.** Run again on the same baseline only to resume a `partial` or `stopped` run; the receipts make that safe, and `tests/d1-backfill.mjs` covers the empty same-baseline rerun.
7. **Delta.** Export a fresh baseline with its own consistency proof (its `finishedAt` must be later than the target's newest baseline) and run with `--delta`: changed objects are re-imported, old receipts are `superseded`, anything `stale` or `foreign` is a class A blocker, and keys missing from the new inventory are anomalies for the owner, never deletions in D1.

## Seeding the projector on the loaded database, without a reload (AIR-275 phase 2)

When D1 still holds what the last reload built from a known snapshot, plus D1-only steps such as AIR-286, the projector's keys can be seeded from that same snapshot. No reload or replay is needed. Each production step is a separate owner approval, and Time Travel restore is an emergency step with its own approval: it rolls back the whole database, not one table.

1. **Read-only preflight.** Compare production with the reload build, table by table and row by row, for the R2-derived Film and Person tables. Confirm:
   - the baseline receipt (`import_receipt`, `manifest.json`) names the snapshot;
   - the only extra rows are the D1-only ones (AIR-286: `person:tmdb_*` people with their name aliases, and their credits on watchlist Films);
   - the watchlist membership count.
2. **Migration 0004.** Take a bookmark, then apply `migrations/0004_projection_state.sql`. Accept it only when `projection_state`, `projection_run` and `projection_fence` exist and `schema_contract.version` is 4. `/api/d1/status` then reports `projector.schema: true`.
3. **Seed plan.** Run `D1_BACKFILL_DATABASE_ID=<uuid> node scripts/d1-projection-seed.mjs --snapshot /abs/snapshot --target d1`, with the `D1_BACKFILL_*` credentials in the environment. It only reads, and stops with a reason when any fence fails:
   - the database identity;
   - the full schema v4;
   - the baseline receipt;
   - a live projector lease;
   - a key for an entity D1 does not hold;
   - a stored key that disagrees with the plan or lies outside it.

   It reports the planned keys and the D1-only people, which get no key.
4. **Seed.** Take a new bookmark, keep `D1_ENRICHMENT_WRITE` off, and run the same command with `--apply`.
   - The seed takes the projector's lease in `projection_run` (`seed:<uuid>`) before it reads the stored keys, so neither the projector nor a second seed can start.
   - Each request first checks the lease through `projection_fence`, renews it, and writes 250 rows idempotently.
   - A seed that lost its lease stops with `lease_lost` and writes nothing more.
   - It releases the lease at the end, and finishes by reading every key back.
   - A dead seed's lease expires after 10 minutes. A run stopped by an uncertain write is finished by running it again. If something else fails, stop with the flag off and look; do not restore by default.
5. **Projector.** Continue with `dry`, then `on`, as in step 7 of the reload below. Read the Cloudflare Workers memory and CPU metrics too: the run log carries no heap figure, and memory is shared by all requests of one isolate.

## Reload with the enrichment projector (AIR-275 phase 2)

Once the [enrichment projector](../adr/0056-d1-enrichment-write-through.md) writes D1, a reload must not restart it from nothing, and it must not lose what only D1 holds. Each production step below is a separate owner approval.

1. **Schema v4.** The backfill executor requires schema version 4. Build the local database from `0001`–`0004`; production `iptv` needs `0004` applied before its first reload under this procedure.
2. **Local build** from a fresh fenced snapshot, as in the procedure above (`--target sqlite --staged-generation --acknowledged …`).
3. **Seed the change keys.** Run `node scripts/d1-projection-seed.mjs --snapshot /abs/snapshot --database /abs/build.sqlite`. It writes a key for every Film and Person the build holds. Without it, the first projector run rewrites all of them: about 20,000 entities, at most 800 queries per hourly run.
4. **Load.** Make a data-only, foreign-key-ordered dump without `stage_*`, `generation_stage_chunk` and `schema_contract`. Then:
   1. Restore `iptv` to its empty-schema bookmark.
   2. Load the dump with the D1 Import API.
   3. Record the bookmark the import returns.
5. **Replay the D1-only steps** in their recorded order, each reproducible from its private artifact. Today that is the TMDB credits of the watchlist Films ([runbook](tmdb-watchlist-credits.md)). A derived Person reference is not stored, so a reload has nothing of it to replay. The projector keeps those credits on later rewrites, but a reload drops them until they are replayed.
6. **Verify** per-table counts against the build, plus the replayed rows.
7. **Projector.** Set `D1_ENRICHMENT_WRITE=dry` and read the summary in the Worker logs (`event: d1_enrichment_projection`). The changed counts should be only what R2 changed since the snapshot. The outcomes that stop a run:
   - `failed` with `reason` `input_missing`, `input_invalid` or `generation_unpublished` names the R2 input (`inputKey`) that was not complete. Nothing was written; the next hourly run tries again.
   - `deferred` with `writer_active` or `input_changed` means a sync or discovery chunk was writing, or an object changed during the reads. Nothing was written. This is normal now and then; a run that never gets through needs a look.
   - `absent_guard` or `membership_guard` means more Films, Persons or watchlist memberships vanished than a routine sync explains. Look at R2 before setting `on`. An intended mass removal goes through a reload.

   Then set `on`. Unsetting the flag stops it; rows it wrote stay until a Time Travel restore.

Do not run a D1-only write step while the projector is `on` without pausing it: the projector reads a watchlist Film's D1-only credits before its batch, so a credit inserted between that read and the batch is dropped.

## Metadata sync clocks (schema v5)

Migration `0005_film_sync_state.sql` adds `film_sync_state` and sets the contract version to 5 ([ADR 0070](../adr/0070-metadatasync-freshness-clocks.md), Proposed). A code deploy does not apply it. `metadataSync` does not read the rows. R2 stays authoritative.

**Applying `0005` starts a new class of live D1 writes.** Production already runs the enrichment projector with `D1_ENRICHMENT_WRITE=on` on the cron `37 * * * *`. There is no second flag. As soon as `schema_contract.version` is 5 and `film_sync_state` exists, the next cron reads R2 and inserts or updates those rows. Approving the migration is approving that activation. Applying the file and leaving the flag on is not a harmless preparatory step. Do not apply it, change the flag, or run the projector under this procedure until the owner has authorized both the migration and the writes it turns on.

1. **Preflight, read-only.** Confirm `schema_contract.version` is 4 and `film_sync_state` is absent. Confirm `D1_ENRICHMENT_WRITE` is `on`, so the operator can see that the next cron will write. Read `GET /api/d1/status` and the latest `d1_enrichment_projection` log: the last outcome should not be `lease_held`, `absent_guard` or `membership_guard`. Confirm no `sync.json` stage `metadata` or `epg` is inside its 15-minute window; a live writer defers the run, but the approval should not be followed by an accidental overlap. Record the D1 bookmark. Time Travel restores the whole database, not one table.
2. **Apply `0005` only with that double approval.** Accept the migration when `film_sync_state` exists and `schema_contract.version` is 5. Do not seed `metadata_sync` keys. The offline import does not write `film_sync_state`, and a seeded key with no row would make the projector skip the write.
3. **Observe the next cron before calling it settled.** `/api/d1/status` reports `projector.schema: true` with `schemaVersion: 5`. `syncCheckpoints` grows toward one row for each existing Film that `metadata.json` names, including a Film that has left the view while its cache entry remains. A cache key with no Film row adds neither a Film nor a sync row. The log event `d1_enrichment_projection` should be `complete` or `budget`, with `syncWrites` and no R2 write. Spot-read a few `film_sync_state` rows against the same clocks in `metadata.json`. A clock that does not change the Film is its own batch. A Film that is already being written takes the row in that same batch. The query budget stays 800 and the wall budget stays 60 seconds. What one run does not reach, the next run writes. Version 4 stays `schema: true` without the version 5 fields. Version 5 without the table is `schema: false`; Film and Person writes continue, and the sync write does not.
4. **Retry and tombstones.** A failed batch keeps the previous sync key, so the next run reads R2 again and writes the current clocks. It does not write those clocks back to R2. Removing a `metadata.json` entry deletes the row and stores the key `absent`. A Film that leaves the view keeps the row and the Film, and loses watchlist membership only. A later edit of the retained entry is still projected. The row is deleted when the entry itself is gone.
5. **Reload.** The backfill executor still requires schema version 4. A database at version 5 stops with `schema_version_mismatch` before any write. The reload procedure restores the empty-schema bookmark and loads a dump without `schema_contract`, which returns the database to version 4. Apply `0005` again after that load only with the same double approval. The projector then fills the rows from R2. Do not treat a missing `film_sync_state` as evidence that the writer is off: on schema v4 the table is absent by design.

**Rollback.** Unsetting `D1_ENRICHMENT_WRITE` stops further D1 writes, including `film_sync_state`. Rows already written stay. A Worker revert does not drop the table, does not return the contract to version 4, and does not restore R2. A reverted build that only accepts version 4 then reports `projector.schema: false`, while its Film and Person writes continue and it writes no sync rows. Restoring the pre-migration database is a Time Travel to the bookmark from the preflight, which rolls the whole database back and is its own approval. Do not drop the table by hand and leave version 5, and do not leave version 5 without the table.

## GO/NO-GO for one run

| Outcome in `report.json` | Meaning | Next step |
| --- | --- | --- |
| `completed`, no class A blocker, parity ok, receipts clean | the run is complete for this baseline | the acceptance report |
| `partial` | `--limit` reached | run again |
| `stopped: unexpected_conflict` / `class_a_blocker` | a row could not be written as the baseline says | stop the window; investigate the named unit; no manual row edit |
| `stopped: unacknowledged_record` | a class C record outside the acknowledged list | owner reviews and extends the list, or stops |
| `classes.S.count` > 0 (not a stop) | a retired Film id's payload superseded by the canonical Film's own newer payload | review the list in `ledger.json` with the acceptance report; the R2 objects stay; never add them to the acknowledged list |
| `no_go: snapshot_not_consistent` / `snapshot_not_production` | the input is not an accepted baseline | export again |
| `no_go: batch_not_atomic` / `batch_too_large` | the service did not prove atomicity at this size, or a unit is larger | do not write; adjust limits only with a new probe, or design staging |
| `no_go: target_identity_mismatch` / `scratch_identity_mismatch` / `schema_missing` / `database_identity_conflict` | wrong database, or not the database this lineage wrote | stop; check the environment and the database |
| `no_go: baseline_changed` | the target already holds another baseline | run with `--delta` only if a delta is intended |
| `no_go: baseline_rollback` | the snapshot is older than the newest baseline the target holds, or was imported before a newer one | export a fresh baseline; going back needs the recovery below, not a flag |
| `no_go: baseline_ambiguous` | two baselines are recorded at the same newest instant | stop; the owner decides from the evidence which lineage is real |
| `no_go: write_uncertain` | a write response was lost | rerun; the read-back reconciles |
| `no_go: schema_missing` / `schema_version_mismatch` | the database lacks migration `0002` or `0003`, or is not on schema version 3 | the owner applies the missing migration under its own approval; nothing was written |
| `no_go: stage_row_too_large` | one staged row would exceed 90,000 bytes | stop; the row is never split; investigate the source record |
| `no_go: stage_baseline_changed` / `stage_owned_elsewhere` | the run's stage was opened by another baseline or token | abandon and discard that stage under the cleanup approval, then rerun |
| `no_go: stage_claimed_elsewhere` | another execution of this baseline holds a live claim on the stage (`claimExpiresAt` in the details) | do not run two executors; if the other one is gone, rerun after `claimExpiresAt`, which takes the claim over; never edit the claim by hand |
| `no_go: stage_claim_lost` | another execution took this run's expired claim over; this run wrote nothing after that | let the other execution finish, or rerun after its claim expired; the stage and its receipts are intact |
| `no_go: stage_plan_changed` / `chunk_conflict` / `chunk_receipts_out_of_order` | the stage does not describe this plan (limits, counts, rows) | do not force; restore the limits of the earlier run, or abandon and discard the stage |
| `no_go: stage_validation_failed` / `stage_parity_mismatch` | staged rows differ from the plan; the stage is now `failed` | discard the stage under the cleanup approval and rerun; the final tables are unchanged |
| `no_go: pointer_moved` | another generation was published after this stage was planned; the stage is now `failed` | discard it; re-export a fresh baseline if the published generation is newer |
| `no_go: commit_readback_mismatch` | the commit landed but the final tables differ from the plan | stop the window; the owner decides between the recovery below and an investigation |
| `staged.gate.go: false` | a commit took longer than 10 seconds | NO-GO for production per ADR-0021, even though the commit itself succeeded |

## Stage cleanup (separate owner approval)

Staged rows of a `failed` or `superseded` stage stay until the owner approves their removal. `node scripts/d1-backfill.mjs --discard-stage <programmeRunId> --cleanup-approved --target d1|sqlite --output /abs/cleanup [--database /abs/dry.sqlite]` deletes staging rows only, in bounded batches, children before parents, and writes `cleanup.json`. `--abandon` first marks a stage that never committed (one left by another baseline) as failed; a committed stage is never abandoned. Without `--cleanup-approved` the command refuses (exit code 2). Final tables are never touched, so this is reversible only by re-staging, not by restore.

## Recovery and rollback

The executor never deletes, drops or resets anything. Recovery is an owner action with a written decision recorded before it is taken:

1. Stop: no further runs against the target.
2. Restore the target to the bookmark recorded in step 4 (D1 Time Travel), or delete and re-create the database and re-apply the frozen schema. Both are destructive and need their own approval.
3. Verify the identity fence on the restored database: no database identity receipt from the abandoned run remains; a restored database that still carries another baseline's receipt is refused with `baseline_changed`.
4. Re-run from step 5. Because the Worker never reads D1, none of this touches production behaviour; R2 is unchanged throughout.

The local rehearsal of this sequence (backup copy, run, restore, identity fence, re-import) is part of `tests/d1-backfill.mjs`.

## Evidence template for the production execution

Record in a dated file under `docs/evidence/d1-migration/`:

- Approvals: snapshot read, credential, database creation and schema, each run window, any recovery (who, when, what).
- Baseline: manifest aggregate SHA-256, `finishedAt`, baseline identity, exporter status and fence result.
- Target: database uuid and name, schema migrations applied (`0001`, `0002`, `0003`), restore bookmark, scratch database uuid.
- Probe: statements and bytes probed, `atomic`, `rowsAfterFailure`.
- Runs: for each run, command (without secrets), status, applied, resumed, reconciled, pending, stop reason, adapter statistics, and with `--staged-generation` the `staged` section and its gate.
- Result: parity (denominator, missing, extra, mismatched), receipts audit, class A blockers (must be empty), class B families with dispositions, class C list with the acknowledgement reference, delta result.
- Statement that no Worker path writes D1, Scheduled Tasks and flags are unchanged, and R2 remains authoritative.
