# AIR-374 P6: differential natural-path harness and computed handoff readiness (offline)

**Captured:** 2026-11-11, local runs only (sqlite3-CLI D1 stand-in on the real migration chain 0001 to 0018). No production, R2, D1, Cloudflare, connector or Trello access of any kind. Authority: the owner decisions of 11 Nov 2026 on [AIR-374](https://trello.com/c/ha7ais3w), recorded in [ADR 0117](../../adr/0117-film-person-d1-handoff-owner-decisions.md); canonical writers per [ADR 0120](../../adr/0120-canonical-film-writers-identity-metadata-membership.md).

**Result:** code evidence only. Nothing is bundled, no marker moves, no migration is applied, no flag is added. `handoffReadiness` reports NOT ready for the current repository, by design. This page proves no live state.

## What was compared

One database per scenario is built by the projector path at marker `prepared`; the canonical side is a copy of it moved to `open` (generation 2) with every row unchanged, so both paths start from identical rows. The projector path is `createCanonicalRepository` (`projectPerson`, `projectFilm`, `projectLink`, `projectFilmSyncState`, `releaseFilm`); the canonical path is `mutatePerson`, `recordPersonState`, `mutateFilm`, `writeFilmFacts`, `recordLocalizationConflicts` and `mergeFilms`. The resulting rows are compared on 14 tables: `film` (including `canonical_identity` and `original_title`), `person`, `film_external_id`, `person_external_id`, `film_alias`, `person_alias`, `film_person_credit`, `film_dimension`, `person_dimension`, `watchlist_film`, `film_redirect`, `film_sync_state`, `film_metadata`, `localization_conflict`.

## Result of the 19 scenarios

| Verdict | Scenarios |
| --- | --- |
| IDENTICAL (4) | standalone localization conflict rows; trusted TMDB id collision refused by both paths; redirected id refresh refused by both paths; the fail-closed marker matrix |
| Named exceptions only (15) | first write; normal refresh; rated-only Film survives; departed watchlist member survives; owner-reviewed Film localization survives a refresh; owner-reviewed Person name survives a refresh; untrusted claim accepted; merge of a retired Film into its survivor; redirected-id membership release; source drops ids and credits; missing source clock; blank incoming values; reviewed identity protected; cast reordered; canonical identity over an untrusted TMDB id |
| Unclassified | **0** (a difference in neither list fails the test) |

Ids, aliases, credits and redirects are identical after a normal refresh and after a merge; the only credit differences are the named ones below. The fail-closed scenario shows every canonical writer refusing before any row changes at `r2`, `prepared`, `held`, legacy (contract below 13) and an unreadable marker, the projector's marker condition failing at `open`, and the route naming exactly one writer.

## Named exceptions (never reported as parity)

From `P6_DIFFERENTIAL_EXCEPTIONS` (`src/canonical-film-writers.js`): `sync_null_clock_keeps_stored` and `identity_provenance_title_source` (accepted); `blank_never_overwrites`, `reviewed_owner_rows_protected`, `redirected_film_refused` (draft). From `EXTRA_EXCEPTIONS` (`src/canonical-differential-registry.js`, all draft): `credits_not_pruned_by_the_planner`, `external_ids_not_pruned_by_the_planner`, `credit_ordinals_kept`, `updated_at_is_write_time`, `noop_write_keeps_updated_at`, `held_localization_not_recorded`, `canonical_identity_requires_trusted_tmdb`. Every registered exception is met by at least one scenario (an exception nothing exercises fails the harness). Each draft one is a decision for the owner and blocks readiness until its `status` becomes `accepted`.

Two findings are worth the owner's attention: (1) when a reviewed or owner localization holds against an automatic value, the projector also records the alias and the `localization_conflict` row, while `writeFilmFacts` keeps the value and records neither, so the producer must call `recordLocalizationConflicts` and `mutateFilm` itself (the Person writer already does this); (2) the planner only upserts, so an id or credit the source drops stays until an explicit removal.

## Computed handoff readiness

With the current repository (prepared marker, verified baseline, schema 18, empty classes) `handoffReadiness` returns `ready:false` with these 26 blockers: `exception_not_accepted:<id>` for the 10 draft exceptions; `receipts_schema_missing` (production is schema 18; migration 0019, merged with P2c, is not applied); `receipts_protocol_unregistered` (derived: no atomic operation in the `src/canonical-receipts.js` registry); `producer_not_wired:` `epg_commit`, `metadata_sync`, `discovery_admission`, `rated_admission_retention`; `reader_not_moved:` `worker_programme_read`, `worker_watchlist_read`, `worker_catalog_read`, `admin_read`, `admin_limbo`, `admin_health`, `owner_review_d1_gate`; `empty_class_not_loaded:` `ratedAdmission:0/708`, `retention:0/401`, `retirement:0/4`. All seven former gaps are cleared by evidence (the writer is registered in `CALLS` and `RECONCILE` and the verified differential registry marks it covered). A synthetic, fully satisfied fixture (schema 19 with the real receipt tables, small class counts, free lease, idle window, atomic operations registered for every kind, readers moved, exceptions accepted) returns `ready:true`.

## Tests

| File | Covers |
| --- | --- |
| `tests/canonical-differential.mjs` (+ `tests/canonical-differential-helper.mjs`) | The 19 scenarios; one shared template database copied per scenario; classification gate; every registered exception is met; the coverage registry equals the former gaps, names only scenarios that ran and tables they filled. |
| `tests/canonical-handoff-readiness.mjs` | Not ready today (exact list); ready in the synthetic fixture; each blocker flips alone (marker, baseline, lease, window states and expiry, receipts schema and protocol, each producer, each reader, each class too many or too few or unreadable, each gap by writer, readback, coverage or entry, each unaccepted exception); read-only (SELECT only, no batch, file unchanged); registries are data (a copy with comments removed and one with boasting comments give today's blockers, flipping a boolean flips one blocker); registries agree with the repository (bundle, migrations, importers). |
| `tests/canonical-differential-mutation.mjs` | 39 mutants: unclassified differences injected into scenarios, wrong registry claims (a scenario that did not run, a table not compared, a table never filled, a renamed gap, an unproven exception, a dropped exception, a gap without a writer), and one readiness rule removed or inverted (33 variants). All killed. |
| `tests/canonical-producers.mjs` (updated) | The readiness assertions now describe the computed result; the dormancy and importer checks are unchanged. |

## Not verified

No live state, no production probe, no deployed bundle, no CI result is claimed here. The reader and producer registries are not derived from the readers' or call sites' files; the P4 slice-2 and P3 PRs own their entries. Migration 0019 is in the repository (P2c) and not applied in production. The baseline is recorded by the activation operation after `open`, so before the flip it is expected to be absent: `receipts_baseline_missing`, `receipts_baseline_unverified`, `unreceipted_changes` and `receipts_attention_open` are exercised here only on local `open` fixtures. `READER_REGISTRY` stays standalone; PR #532 (`CANONICAL_READER_REGISTRY`) was not merged at the time of writing.
