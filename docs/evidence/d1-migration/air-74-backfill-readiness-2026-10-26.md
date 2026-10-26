# AIR-74 live backfill readiness assessment, 26 October 2026

> Dated preparation report. It records what the repository and the production read-only state support today and what must exist before the first live D1 backfill. It is not an authorization to read production R2, create a D1 resource or token, or write a row. Current operational state must be re-read live. Decisions proposed from it are in [ADR-0019](../../adr/0019-live-d1-backfill-boundaries.md) (Proposed).

| Field | Value |
| --- | --- |
| Captured at | 2026-10-26, 09:30–10:46 UTC (two read-only `epg_pipeline_status` / `epg_status` reads, no production writes) |
| Pinned source | GitHub `main` `27263d94d11b5499963c9753b3dcd91d536c9832` |
| Pinned generation | published `programmeRunId` `360a7571-9535-4aa7-876c-669c9ca05b7b`, stage `complete`, failures 0 |
| Scope | AIR-74 acceptance (reconciled current baseline, idempotent reruns, recovery/rollback, manifest; runtime stays on R2) against the merged AIR-49/70/71/72/73 code and the AIR-73 offline result |
| Method | Code reading of `src/offline-importer.js`, `scripts/offline-import.mjs`, `scripts/migration-export.mjs`, `src/migration-export.js`, the three repositories, `migrations/0001_schema_v1.sql`, `wrangler.jsonc`; the [AIR-73 report](air-73-offline-run.md) counts; two read-only MCP status reads |
| Verdict | **NO-GO for execution today; GO for the preparation plan.** Nine gaps below must close, each with its own PR or owner approval, before a dry-run and then a production backfill |
| Used by | [AIR-74](https://trello.com/c/5AdAmKPe) planning; [ADR-0019](../../adr/0019-live-d1-backfill-boundaries.md) |
| Superseded by | none yet (the execution report of the backfill, when it exists) |
| Uncertainty | production R2 key inventory is inferred from the archive and the Worker code, not listed; D1 batch atomicity through the chosen access path is unverified; Scheduled Task timing is nominal |
| Operational authority | none; R2 bucket `iptv` remains the production authority, D1 is unbound and unapplied |

## Production read-only state at capture

| Reading | Value | Why it matters for a baseline |
| --- | --- | --- |
| Published generation | `360a7571-9535-4aa7-876c-669c9ca05b7b`, `complete`, failures 0, localization mismatches 0 | The baseline must pin one published generation and the shared `programme.json` must carry it |
| Discovery continuation | `paused`, health `settled`, `remainingChunks` 4, `generationConflict` null (10:46 UTC); `running`/`orphaned` with `chunkCompleted: true` at 09:30 UTC before [AIR-161](https://trello.com/c/R8qPW7Ks) was deployed | The hourly task keeps writing `epg/*` and `enrichment/*` between runs; a snapshot window must sit between runs and prove the continuation did not move |
| Discovery ledger | 51,362 ledger candidates, 22,199 in the latest generation, 1,895 verified films, 1,905 confirmed | Order of magnitude for `candidate`, `candidate_generation`, `candidate_show`, `candidate_decision` rows |
| Prediction coverage | 2,300 / 2,300 current predictions, hot 1,851, cold 440, 0 pending / deferred (10:37 UTC per the AIR-69 acceptance) | About 2,300 `predictions.json` bundles, each with a `history` list; none is an immutable version object today |
| Scheduled Tasks | hourly predictions and discovery catch-up; daily EPG at 17:00 Europe/Madrid; both enabled | Writers are never off; a freeze is not available without a Task change |
| Worker config | `wrangler.jsonc`: R2 `BUCKET=iptv` only, no `d1_databases` | The Worker must stay like this through AIR-74 |

## What the merged code already provides

| Capability | Where | Status for live use |
| --- | --- | --- |
| Frozen schema v1 and its test | `migrations/0001_schema_v1.sql`, `tests/d1-schema.mjs` | Ready; applied only to a local SQLite in CI |
| Write-only buffered transactions in every repository | `src/canonical-repository.js`, `src/epg-repository.js`, `src/prediction-repository.js`; the offline adapter rejects a read inside a transaction (`openSqlite` in `scripts/offline-import.mjs`) | Ready in shape: every write is a statement list that a D1 batch can execute atomically; no adapter for D1 exists yet |
| Unit model, receipts by source key and checksum, resume, `uncheckpointed → readback → reconciled` | `importBatch`, `checkpoint`, `storedMatches` in `src/offline-importer.js` | Ready; receipts are the restart fence the live run needs |
| Independent source projection and read-back parity with denominators | `projectSource`, `verifyParity`, `parityClaim` | Ready; the full-parity claim does not yet distinguish unmapped-by-design keys |
| Manifest with per-object SHA-256, two bracketing listings, resumable download, `verifySnapshot` | `scripts/migration-export.mjs` | Pinned to the legacy Site origin and its export route; refuses the Worker origin; the Worker route itself is disabled unless Site-only variables are set |
| Snapshot loader and lifecycle reader | `scripts/snapshot-store.mjs`, `src/domain/film-person-reader.js` | Checks the legacy source identity in the manifest; a production baseline needs a new source identity field |
| Identity spellings | `film-person-reader.js:12` emits `tmdb_<n>`; `film-person.js:44` mints `film:tmdb:<n>`; `catalogId` in `film-person-diagnostics.js:17` maps back | The rule exists in production code but is not exported as one function and not used by the importer |
| Evidence key | `candidateEvidence` in `src/discovery.js:12`, stored on decisions | Not exported to the importer; `readDiscovery` requires an `evidenceKey` field the items do not carry |

## Gaps between the AIR-73 result and the AIR-74 acceptance

The AIR-73 counts are the archive's; production has grown since, but every class below still exists in the current Worker's storage layout.

| # | Gap | AIR-73 evidence | Root cause in the code | Proposed closure (ADR-0019 item) | Needs |
| --- | --- | --- | --- | --- | --- |
| 1 | No read path to a current production baseline | The 19 October archive is the only snapshot | `exportSnapshot` requires the Site origin; `migrationExportRoute` returns 404 on the Worker origin and needs Site-only variables | Read-only R2 API token and a local S3-API exporter writing the same manifest shape, or the Worker route opened on the Worker origin behind Access with a service token (1) | Owner choice; token or Access approval; code PR |
| 2 | Listing is not atomic while writers run hourly | Archive status `provisional_no_change_detected` with the scheduled job stopped by hand | Hourly and daily Tasks write `epg/*`, `enrichment/*`, `events/*`, `started/*`, leases | Window between hourly runs; acceptance predicates on pointer, `sync.json`, continuation and runner lease; bounded re-download rounds; high-water mark in the manifest; delta export later (2) | Code PR (exporter predicates); no Task change |
| 3 | 1,576 fingerprint and 2 rating conflicts from the `tmdb_<n>` versus `film:tmdb:<n>` spelling, plus 1 redirect source | `reference_missing`, films stored under the canonical id | `filmIdFromEnrichmentKey` prefixes `film:` without translating the catalog spelling; redirects are not followed for enrichment keys | One exported identity rule shared with the reader and used by the importer; redirect followed to the survivor; source key kept on the receipt (3) | Code PR with legacy-spelling and redirect regressions |
| 4 | 10 metadata-only films and 1 slug-only fingerprint and 2 ratings on them | `reference_missing` with no stored row | The reader does not mint a Film from `metadata.json` alone, by design | Stay conflicts; owner accepts them as the residual list or asks for a separate identity decision (3, 8) | Owner decision |
| 5 | 1,986 prediction bundles unportable | `prediction_version_object_missing` | `enrichment.js` writes one mutable `predictions.json` bundle; the schema and ADR-0001 require an immutable object per version | Worker writes each new version as its own object; existing versions are materialized once under approval, or the family is excluded from this backfill (4) | Separate card: Worker PR, ADR-0014 compatibility note, approval for the one-time R2 write |
| 6 | 43,599 discovery items and the generation unportable | `observation_fields_missing` | Items carry no `evidenceKey`; the resolver computes it at run time | Importer derives the key with the exported `candidateEvidence`; a decision whose stored key differs is a conflict (5) | Code PR with derivation parity test against stored decisions |
| 7 | 2,533 unmapped objects | `mood-facet.json`, run files, `events/`, `started/`, queue and view projections, leases, continuation records | No D1 table by design; coverage treats them like unexpected keys | Explicit `r2_only` allowlist, separate coverage class, parity claim defined on mapped families with `unmapped` empty (6) | Code PR and a contract update in `docs/reference/data/d1-schema.md` |
| 8 | No D1 database, binding, or write adapter | None | `wrangler.jsonc` has no `d1_databases`; the repositories only ever met SQLite | Owner creates the database and applies `0001_schema_v1.sql`; a local backfill command with an atomic-batch adapter; no Worker binding in this stage (7) | Owner approvals; code PR; scratch-database atomicity demonstration |
| 9 | No execution runbook or GO/NO-GO record | None | The only procedures are archived Site procedures | `docs/runbooks/` page for export, dry-run, backfill, parity, stop, rollback; this report's checklist filled in with dates and results | Docs PR after the tooling exists |

## Proposed sequence (each step its own PR or approval)

1. **Plan accepted.** [ADR-0019](../../adr/0019-live-d1-backfill-boundaries.md) accepted or amended by the owner; the open items below answered.
2. **Importer rules.** Shared identity rule, derived evidence key, `r2_only` allowlist, parity claim on mapped families; synthetic regressions for legacy spellings, redirects, derived evidence equal to stored decisions, allowlisted keys. No production access.
3. **Live baseline exporter.** Local command producing the manifest shape `verifySnapshot` already checks, with a production source identity, bracketing listings, the acceptance predicates and the high-water mark; read-only credentials from outside the repository. Tested against a fake S3 listing; the first production read is an owner-approved step.
4. **Prediction versions.** Separate card: Worker writes immutable version objects; one-time materialization approved separately; or the family is excluded and the exclusion is recorded.
5. **Dry-run.** Approved production export → local SQLite import with the new rules → parity report → owner review. Expected: conflicts reduced to the accepted residual list, `unmapped` empty, prediction family per step 4.
6. **D1 resource.** Owner creates the database and applies the schema; a scratch database proves batch atomicity with a failing last statement.
7. **Backfill.** Bounded batches with receipts into the production D1; stop on any conflict outside the residual list; parity against the baseline manifest; second and third runs apply zero rows; a delta export imports only changed checksums.
8. **Acceptance report.** Dated execution report in this folder with the manifest identity, counts, residual conflicts, rerun results and rollback readiness; `docs/reference/data/d1-schema.md` and the persistence diagram updated; runtime still on R2.

## GO/NO-GO checklist (to be filled in with dates)

| Gate | Condition | Status |
| --- | --- | --- |
| G0 | ADR-0019 accepted; open items decided (database name, prediction family in or out, residual conflicts, R2-only allowlist, export mechanism) | open |
| G1 | Importer rules merged with regressions; CI green | open |
| G2 | Live exporter merged; read-only credential created and verified read-only by scope | open (owner approval) |
| G3 | Dry-run report reviewed: `unmapped` empty, conflicts only in the residual list, two local reruns apply zero rows | open |
| G4 | D1 database created, schema applied, scratch atomicity demonstrated | open (owner approval) |
| G5 | Production backfill window approved and executed; parity against the baseline manifest; reruns apply zero rows | open (owner approval) |
| G6 | Acceptance report merged; `wrangler.jsonc` still without D1; Scheduled Tasks unchanged | open |

## What this report does not establish

- The production key inventory and sizes: they are inferred from the Worker's storage code and the archive, not from a listing.
- That a multi-statement batch is atomic on the chosen D1 access path.
- Any permission: reading production R2 in full, creating a token or a database, materializing prediction objects and writing D1 rows are each separate owner approvals.
