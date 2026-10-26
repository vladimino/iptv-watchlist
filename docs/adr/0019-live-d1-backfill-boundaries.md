# ADR 0019: Live D1 backfill reads a verified production R2 baseline and maps identities by rule

**Status:** Proposed  
**Original decision date:** 2026-10-26 (proposal; not yet decided)  
**Recorded at:** 2026-10-26  
**Approval source:** not documented (owner decision pending on [AIR-74](https://trello.com/c/5AdAmKPe))  
**Related work:** [AIR-74](https://trello.com/c/5AdAmKPe), [AIR-73 offline parity](../evidence/d1-migration/air-73-offline-run.md), [AIR-74 readiness assessment](../evidence/d1-migration/air-74-backfill-readiness-2026-10-26.md)  
**Supersedes:** None (extends [ADR-0017](0017-staged-d1-migration.md) at its "separately approved live backfill" stage)  
**Superseded by:** None

## Context

[ADR-0017](0017-staged-d1-migration.md) stages the migration: offline parity, then a separately approved live backfill, then shadow writes and reads. The offline stage is complete and honest about its limits: against the 19 October 2026 archive the importer stored 18,412 receipts but reported 1,591 `reference_missing` conflicts, 45,586 unportable units and 2,533 unmapped objects, and `claimsFullParity` was false ([AIR-73 report](../evidence/d1-migration/air-73-offline-run.md)). Running that importer unchanged against production would reproduce those gaps, so it cannot satisfy the AIR-74 acceptance (a reconciled current baseline, idempotent reruns, recovery, manifest).

The repository today has no read path for a *current* production baseline. The only exporter (`migrationExportRoute` in `src/worker.js`, `scripts/migration-export.mjs`) is pinned to the legacy Site origin and refuses the Worker origin by design. Production R2 is written continuously by the two external Scheduled Tasks (hourly discovery and predictions, daily EPG publication), so an R2 listing is never an atomic snapshot. The D1 repositories (`src/canonical-repository.js`, `src/epg-repository.js`, `src/prediction-repository.js`) perform every write as a buffered, write-only transaction (the offline adapter rejects a read inside one), which is the shape a D1 batch can execute atomically. `wrangler.jsonc` carries only the R2 binding; the Worker must keep running on R2 throughout this stage.

## Decision

This ADR proposes the boundaries of the first live backfill. Nothing here is decided until the owner accepts it; nothing here authorizes a read of production R2, a D1 resource, a token or a write.

1. **Baseline source.** The backfill imports a verified baseline of the production bucket `iptv`, never the 19 October archive and never the legacy Site. The baseline is a local snapshot in the existing manifest shape (per-object key, size, ETag, raw-byte SHA-256, aggregate SHA-256, two bracketing listings), taken with read-only credentials scoped to the bucket. The preferred mechanism is a read-only R2 API token used by a local exporter over the S3-compatible API, because it needs no production Worker change, no Access change and cannot write by scope; the alternative is extending the Worker export route to the Worker origin behind Access, which deploys export code into production and needs an Access service token. The owner picks one; both are read-only by construction.
2. **Consistency without a production freeze.** No Scheduled Task is paused or edited for the backfill. The export window is chosen between hourly runs; the snapshot is accepted only when the two bracketing listings agree for every mapped key, the published generation pointer and the `sync.json` stage are identical before and after, the discovery continuation is `paused`/`settled` at both ends, and the prediction runner holds no live lease. Keys that changed between listings are re-downloaded in bounded rounds; a window that does not settle is recorded as `inconsistent` and the attempt stops. The manifest records the high-water mark (published `programmeRunId`, `sync.json` `updatedAt`, continuation `at`/`hopId`, latest enrichment run) so that a later delta export imports only keys whose checksum changed, through the same receipts.
3. **Identity reconciliation by rule, not by invention.** The enrichment spelling `tmdb_<n>` is the catalog form of the canonical Film id `film:tmdb:<n>` (the lifecycle reader emits it in `src/domain/film-person-reader.js`; `catalogId` in `src/domain/film-person-diagnostics.js` maps back). The importer resolves `enrichment/films/tmdb_<n>/…` to `film:tmdb:<n>`, a Letterboxd slug to `film:<slug>`, and a retired id to its survivor through the stored redirect, using one shared function. The receipt keeps the source key as written. A key that resolves to no stored Film stays a conflict: the importer never mints a Film from an enrichment key or a metadata record.
4. **Immutable prediction versions are a prerequisite, not a workaround.** `prediction_current.r2_key` and `prediction_history.r2_key` must name immutable objects; the mutable `predictions.json` bundle does not qualify. Before the prediction family enters the backfill, the Worker must write each new prediction version as its own object alongside the bundle (a separate code change with its own review), and existing versions must be materialized as new objects under a separate, explicit owner approval, or the prediction family is excluded from this backfill and the exclusion is written into the acceptance.
5. **Discovery evidence is derived by the resolver's own rule.** `epg/discovery-latest.json` items carry no `evidenceKey`; the resolver computes it from the observation's own fields (`candidateEvidence` in `src/discovery.js`) and stores it on decisions. The importer derives the key with that same shared function and marks it `derived` in the receipt. A decision whose stored key disagrees with the derived key is a conflict, not a repair.
6. **R2-only keys are declared, not unknown.** Operational objects with no D1 table (run files, events, started markers, leases, continuation records and diagnostics, queue and view projections, mood facets, generation copies, raw XML) are an explicit allowlist. Coverage reports them as `r2_only` separately from `unmapped`; a full-parity claim requires `unmapped` to be empty and every mapped family to read back equal, and lists the `r2_only` counts beside it.
7. **D1 resource and executor.** The database is created and the frozen `migrations/0001_schema_v1.sql` is applied by the owner, separately approved. The backfill runs as a local command against that database through an adapter whose multi-statement batch is atomic; atomicity is demonstrated on a scratch database with a deliberately failing last statement before the first production write. `wrangler.jsonc` does not gain a D1 binding in this stage; the Worker neither reads nor writes D1 until [AIR-75](https://trello.com/c/AXPYIVCa).
8. **Bounded batches, receipts, fences, stop.** Units are imported in bounded batches; each unit is receipted by source key and checksum after read-back; an interrupted run resumes from receipts; the second and third runs must apply zero rows. Any conflict outside the owner-accepted residual list stops the run and is documented before it continues. Parity is read back against the baseline manifest, not against the import's own write list.

Not decided here: the name of the database, the exact R2-only allowlist, whether the prediction family is in or out of this backfill, and the accepted residual conflicts. Those are GO/NO-GO items in the [readiness assessment](../evidence/d1-migration/air-74-backfill-readiness-2026-10-26.md).

## Alternatives considered

- **Import the 19 October archive into D1.** Rejected by the card itself: it is not current production, and it reproduces the known gaps.
- **Rewrite legacy ids inside the importer ad hoc.** Rejected: AIR-73 deliberately refused to rewrite ids; a mapping is acceptable only as one shared, tested rule that production code already embodies.
- **Point `prediction_current.r2_key` at the mutable bundle.** Rejected: it contradicts the schema contract and ADR-0001.
- **Pause the Scheduled Tasks for a clean freeze.** Not proposed: a Task change is a separate owner-approved operation, and bracketing listings plus a delta replay achieve a verifiable baseline without it.
- **Run the backfill from inside the Worker.** Not proposed: it would put D1 writes into the production code path before shadow writes are designed ([AIR-75](https://trello.com/c/AXPYIVCa)).

## Consequences

The backfill becomes verifiable and repeatable: every row traces to a source key and checksum, every mapped key traces to a receipt, a conflict or an allowlisted `r2_only` entry, and a rerun is provably empty. The costs are new code (a live exporter, the shared identity and evidence rules, an allowlist, a D1 adapter and a backfill command), a Worker change for immutable prediction versions, and an owner-run resource setup. The archive importer's reports remain valid history; the new rules make earlier conflict counts shrink by rule, which the readiness report records rather than hides.

## Recovery and migration boundary

R2 is not written by the backfill: the credentials are read-only by scope, and the Worker is untouched. D1 is not read by the runtime, so dropping and recreating the database is a complete rollback; receipts make a partial run resumable from the same baseline. A later delta import replaces nothing without a changed checksum. This ADR never authorizes creating a token, a database, a binding, or writing a row; each of those is an explicit owner approval recorded on [AIR-74](https://trello.com/c/5AdAmKPe).

## Evidence

- **Original decision:** pending; proposal on [AIR-74](https://trello.com/c/5AdAmKPe)
- **Implementation:** none yet
- **Dated verification:** [AIR-73 offline parity](../evidence/d1-migration/air-73-offline-run.md) (24 October 2026); [AIR-74 readiness assessment](../evidence/d1-migration/air-74-backfill-readiness-2026-10-26.md) (26 October 2026)
- **Uncertainty:** the atomicity of a multi-statement batch through the chosen D1 access path is to be demonstrated, not assumed; the exact R2-only allowlist and the prediction-family decision are open

## Follow-ups

[AIR-74](https://trello.com/c/5AdAmKPe) execution and acceptance; [AIR-75](https://trello.com/c/AXPYIVCa) shadow writes; a separate card for immutable prediction version objects if the owner keeps the prediction family in scope. Updates to [the D1 contract](../reference/data/d1-schema.md) and [the persistence diagram](../architecture/persistence-and-migration.md) follow acceptance, not this proposal.
