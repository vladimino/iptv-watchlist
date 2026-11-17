# AIR-79 D-2 inventory, closeout ledger and D-1 preparation, 17 November 2026

**Trello:** [AIR-79](https://trello.com/c/485tlGLA). **Code reference:** `main` at `3b5ae6d`. **Captured:** 17 November 2026 (UTC). Continues the [first audit](air-79-legacy-r2-runtime-audit-2026-11-17.md), the [orphaned ratings runtime slice](air-79-orphaned-ratings-runtime-2026-11-17.md), the [flag closure and export route slice](air-79-flag-closure-and-legacy-export-route-2026-11-17.md) and the [ratings storage migration retirement](air-79-ratings-storage-migration-retirement-2026-11-17.md).

## Scope and method

Documentation only: no code, flag, binding, marker, schedule or stored object is changed and no production read or write was made. The inventories below come from code reading (grep and file reads over `src/`, `scripts/`, `tests/`, `docs/`) done by delegated read-only research; the author spot-checked the gate semantics (`readAuthority`, `catalogReaderGate`, the `legacy` state) and the alias finding against the code. Items marked **(U)** were not verified. Markers are the values the maintained documentation records, not a live read.

## D-2: Film/Person `existing` arms

**Result: nothing removed. Deferred with a named owner decision.**

The gate maps `legacy`, `r2` and `prepared` to mode `existing` (the old R2 answers) and `open` to `d1`; `held` and any unreadable or malformed marker throw before an arm is chosen (`src/film-person-authority.js` `readAuthority` and `readSource`, `src/canonical-catalog-reader.js` `catalogReaderGate`). At the recorded production state (`d1` / `open`, generation 2) no `existing` arm is reachable, and the `held` contract never reaches one. Still, every arm is also the `legacy` seam: `legacy` is returned when the database binding is absent, when `schema_contract` has no table, or when its version is below the Film/Person minimum. Local development and the vm-scoped tests that load the Worker without `CanonicalCatalogReader` depend on it, and so do the `typeof CanonicalCatalogReader === 'undefined'` guards beside the arms.

| Arm | Where | Verdict |
| --- | --- | --- |
| `localizedTitleStore` (programme and watchlist titles), `catalogMetadataRead`, film-route identity bridge skip, `ratingsFilmLabels` R2 branch | `src/worker.js` | Retained: legacy seam and vm-scoped tests |
| `catalogArchiveFallback` R2 body | `src/worker.js` | Retained: holds the `held` contract and the generation-moved check |
| `frozenCanonicalMirrorsLocked`, `canonicalMirrorsWritable` | `src/worker.js`, `src/canonical-catalog-reader.js` | Retained: write fence. The defensive `typeof` fallback was not proved unreachable **(U)** |
| `adminLoadDictionaries`, admin health source list, `lbaVersion` and compare | `src/admin/*` | Retained: legacy seam, diagnostics |
| `footerStatus` metadata read, `filmHistoryBridge` (`not_open`), migration export of the mirrors | `src/enrichment.js` | Retained: legacy seam; `not_open` is a defined contract state |
| `catalogD1Route` pre-open dispatch (`authoritative=false`) | `src/catalog-d1.js` | Retained: dispatch, not an R2 read; the `held` refusal stays |
| `CANONICAL_READER_REGISTRY` rows 1 to 15 (`freeze`, `moved: true`) | `src/canonical-catalog-reader.js` | Retained: they feed `activationAudit`, `handoffReadiness` and four registry tests; a row can be dropped only together with its arm |
| Registry rows 16 to 20 (`exception`) | same | Retained: independent mirrors and immutable sources that stay R2 by decision, not `existing` arms |

Dependent on the `r2` and `prepared` states existing at all, so part of the same decision: the `prepared` to `open` flip and its markers in `src/film-person-open-handoff.js`, `MARKER_R2` in `src/film-person-baseline.js`, the projector modes in `src/d1-enrichment.js`, and the loader, measure and preflight scripts. The only cosmetic candidate, the alias `canonicalReaderMode` in `src/canonical-read-model.js`, is imported by two tests; removing it is not a meaningful slice.

**Owner decision needed before any D-2 code:** retire the `legacy` seam and the `r2`/`prepared` states together (vm-scoped tests would always supply the reader and a marker stand-in, and the flip and baseline tooling goes with them). Without it, the safe state is the one on `main`. Collision risk if done later: 58 commits touched `src/worker.js`, `src/canonical-catalog-reader.js`, `src/enrichment.js` or `src/admin/*` since 10 November. Tests that would need migration: `canonical-catalog-titles`, `canonical-catalog-metadata`, `canonical-admin-dictionaries`, `canonical-catalog-reader`, `canonical-read-model`, `catalog-film`, `canonical-catalog-reader-mutation` and the registry tests; the vm-scoped Worker tests were not enumerated **(U)**.

## Closeout ledger

`removed | retained with reason | deferred with next action`, across the AIR-79 slices delivered so far.

| Verdict | Item | Slice |
| --- | --- | --- |
| Removed | Nine uncalled Worker functions of the retired films-list scan, removal lookup and ratings phase helpers | [PR #711](https://github.com/vladimino/iptv-watchlist/pull/711) |
| Removed | `GET /api/migration-export/*` route from the Worker bundle (module moved under `tests/support/`; no `MIGRATION_EXPORT_*` binding exists) | [PR #712](https://github.com/vladimino/iptv-watchlist/pull/712), [PR #716](https://github.com/vladimino/iptv-watchlist/pull/716) |
| Removed | `ratings_storage_migrate`, `POST /api/letterboxd/ratings/migrate`, the conversion code and witness writes; replaced by the storage schema guard ([ADR 0161](../../adr/0161-retire-ratings-storage-migration.md)) | [PR #721](https://github.com/vladimino/iptv-watchlist/pull/721) (D-3, delivered) |
| Retained | Film/Person `existing` arms and registry rows | D-2 above |
| Retained | Compatibility mirrors and their writers, immutable prediction and fingerprint bodies, raw inputs and archives, receipts, the `held` reader contracts, write fences, `*_DB_REQUIRED`, stand-in modes | audits above |
| Deferred | Rollback toolchain for six domains | D-1 below, owner gate |
| Deferred | F-1 poster hydration through `epg/discovered-films.json`; F-2 `setStarted` metadata lookup | [AIR-515](https://trello.com/c/FMWcvvWI) and [AIR-516](https://trello.com/c/03h5WhiT), separate cards, not duplicated here |
| Retained | Historical D1 document `letterboxd/ratings/migration.json` (unread) | D-3 |

The flag and binding audit of the earlier slice stands as recorded there (live readout 13:44 UTC and a read-only binding inventory); this change adds no production read, so those counts are not refreshed. It is not an unfinished production cleanup.

## D-1: preparation only (implementation is not authorized)

Owner decision of 17 November: D1 stays authoritative and a return to R2 is not planned. This section is the matrix and the questions; it changes nothing and does not decide anything for the owner.

**Findings that shape the slices**

1. Every `*_authority` migration seeds the marker at `mode='r2'` and the CHECK constraints allow `r2` and `d1`. A fresh local or test database reaches `d1` only through import and activate, so removing the tooling needs a harness helper that sets the marker directly. Dropping `r2` from the CHECK is a migration and is not recommended (the downgrade triggers exist).
2. The Worker never calls any import, activate, seal, release or revert function; only scripts and tests do.
3. Discovery has no revert at all (`scripts/discovery-production.mjs` rejects `--revert`), and Film/Person has none either (trigger in migration `0013`).
4. Fail-closed asymmetry: ratings and predictions have `*_DB_REQUIRED`; the metadata cache returns `r2` silently when the binding or table is missing, and published EPG returns `r2` on a missing table. This, not the revert tooling, is the real production exposure of the `r2` arms.
5. Stand-in modes are environment-gated (`PUBLISHED_EPG_DB_OPTIONAL`, `OWNER_REVIEW_DB_OPTIONAL`), not production state.

**Proposed matrix** (R = remove, K = retain)

| Domain | Remove | Retain, with reason |
| --- | --- | --- |
| Owner reviews | import, activate and revert functions, `r2` read arms, `scripts/owner-review-authority.mjs` | owner-review mirror, `writes='held'` refusal, fail-closed result |
| Metadata cache | import, activate and revert functions, `r2` arms of load and save, both scripts | d1 mirror write, `metadata.json` mirror (the projector reads it); needs a fail-closed guard in place of the silent `r2` return |
| Ratings documents | `importDocuments`, `activateDocuments`, `releaseHeld`, `sealHeld`, `revertMarker`, their script commands, the `mode:'r2'` branch of `putOwned` and `requireOpen` | `readRatingsAuthority`, the `held` refusal, `RATINGS_DB_REQUIRED`, R2 fall-through for non-owned keys, events and raw inputs |
| Mutable predictions | import, activate, release, reconcile and revert functions, the reserve and complete write helpers, `r2` arms of queue, lease and profile, both scripts | immutable bodies, `PREDICTION_DB_REQUIRED`, d1 arms, offline backfill |
| Published EPG | import, activate, seal, release and revert, both scripts, the `persistWatchlist` R2 write tail, the non-D1 `catalogGenerationCopy` read | **(a)** the `held` reader contract (readers on the R2 pointer, mirror repair stops, publish throws), **(c)** mirror writers, hourly ensure, raw inputs, seal payloads |
| Discovery | `--load`, `--import`, `--hold`, `--activate` commands, cutover scripts, R2 lease, continuation, workflow-state and decisions-map tails, four admin recovery writers | the `held` fence, the `projector_window` fence, immutable segments, `epg/discovered-films.json` (F-1) |
| Film/Person | nothing | no revert exists; D-2 above |

Non-R2 recovery and fencing to keep everywhere **(b)**: fenced and CAS batches, generation fences, `held` refusals, `*_DB_REQUIRED`, the D1 Time Travel runbook, forward-fix, the downgrade triggers.

**Slice order, smallest coupling first:** owner reviews, metadata cache, ratings documents, predictions, published EPG, Discovery; a documentation and ADR slice comes first, and the harness marker helper belongs to the first code slice. Each slice deletes the functions, script, tests and the matching runbook section in one change, and updates the write-site tables.

**Questions for the owner** (recommended answer first)

1. Is a revert of any marker to `r2` formally unsupported? Recommended: yes; the only reversal is forward-fix or Time Travel.
2. Does a Time Travel restore that returns an older marker stay supported? Recommended: keep the `held` readers and fail-closed readers so a restored state is safe, with no tooling to re-enter `held`.
3. Keep import tooling for an R2 to D1 disaster reload? Recommended: remove; R2 is a stale mirror and the runbook already forbids replaying the October snapshot.
4. Keep the offline `scripts/d1-backfill.mjs`, `offline-import.mjs`, `snapshot-store.mjs` and `r2-snapshot-export.mjs`? Recommended: retain and label historical.
5. Keep the stand-in modes? Recommended: retain for the harness, document `OWNER_REVIEW_DB_OPTIONAL`, assert absent in production.
6. Replace the metadata cache silent `r2` fallback with a fail-closed guard? Recommended: yes, as its own approved behavior change with a test.
7. Leave `r2` in the CHECK constraints and seed rows? Recommended: leave.
8. Keep the published-EPG `held` reader contract although nothing can enter `held` after removal? Recommended: keep, with a test.
9. Remove the Discovery R2 tails and keep the fence? Recommended: yes, updating the R2 write-site count tests.
10. Is F-1 a prerequisite for the Discovery slice? Recommended: no; record it as untouched.
11. Keep the `d1-backfill.md` sections as history or archive them with a banner? Recommended: archive.

**Outline of the superseding ADR** (number to be taken from the register when written; nothing is drafted as accepted): *Retire the R2 authority rollback toolchain; D1 is the only authority.* Decision: markers move only forward and `r2` stays a historical schema value; the tooling in the matrix is removed per slice; the `held` contracts, fences, `*_DB_REQUIRED`, stand-ins, immutable bodies, mirrors and offline tools stay; the metadata cache becomes fail-closed if question 6 is approved. Recovery boundary: forward-fix through the fenced adapters and D1 Time Travel (whole database, owner approval, read-back of every marker); R2 mirrors are not a restore source; code rollback restores no marker. It would supersede in part the revert, import, activate, hold and seal sections of ADRs 0073, 0078, 0079, 0081, 0084 and 0085, not their schema, fence or authority decisions. Not verified before writing it: the live markers of all six domains (including the prediction `writes` state), the live `*_DB_REQUIRED` bindings, the test-by-test coupling, and ADRs 0017, 0051, 0076, 0108, 0141 and 0142 **(U)**.

## Verification

Documentation-only change, so the expensive suite is skipped by the repository's rule. Checked locally: `git diff --check`, the documentation governance and timeless-documentation checks. CI of the pull request and the independent review are recorded on the pull request and the card.
