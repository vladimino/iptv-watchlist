import path from 'node:path';

// AIR-490. Every tests/*.mjs file is named here exactly once. tests/test-classification.mjs fails when a file is missing, duplicated or new.
// core: result, contract, integrity, CAS/fence/replay, boundedness, call or SQL counts, timeouts as semantics, and resource hard caps a safe deploy needs.
// non-functional: runner wall-clock, latency, p95, throughput, CPU or heap profiles, benchmarks, and mutation testing (how well the tests kill mutants).
// split: one file holds both. nonFunctional(id, fn) in tests/suite-gate.mjs runs fn only in the non-functional suite.
// support: imported library, not a test. fixture: historical file the public suite does not run.
// A name containing budget, memory or mutation is not itself the classification.
export const CORE_REASON='Result, contract, integrity, CAS/fence/replay, boundedness, call or SQL counts, timeout semantics, or a resource hard cap a safe deploy needs. No runner wall-clock, percentile latency, throughput, heap profile, or mutant-kill check.';
export const FILES={
 "actual-rating-filter.mjs": {
  "suite": "core"
 },
 "activity-ui.mjs": {
  "suite": "core"
 },
 "activity.mjs": {
  "suite": "core"
 },
 "admin-actions-presentation.mjs": {
  "suite": "core"
 },
 "admin-actions-view.mjs": {
  "suite": "core"
 },
 "admin-actions.mjs": {
  "suite": "core"
 },
 "admin-discovery-recovery-page.mjs": {
  "suite": "core"
 },
 "admin-film-title-api.mjs": {
  "suite": "core"
 },
 "admin-film-title-page.mjs": {
  "suite": "core"
 },
 "admin-health-api.mjs": {
  "suite": "core"
 },
 "admin-identity-work-api.mjs": {
  "suite": "core"
 },
 "admin-identity-work-page.mjs": {
  "suite": "core"
 },
 "admin-letterboxd-apply.mjs": {
  "suite": "core"
 },
 "admin-letterboxd-archive-api.mjs": {
  "suite": "core"
 },
 "admin-letterboxd-page.mjs": {
  "suite": "core"
 },
 "admin-limb-startup.mjs": {
  "suite": "core"
 },
 "admin-limbo-api.mjs": {
  "suite": "core"
 },
 "admin-limbo-page.mjs": {
  "suite": "core"
 },
 "admin-channels-api.mjs": {
  "suite": "core"
 },
 "admin-channels-domain.mjs": {
  "suite": "core"
 },
 "admin-channels-page.mjs": {
  "suite": "core"
 },
 "admin-settings-page.mjs": {
  "suite": "core"
 },
 "admin-posters-api.mjs": {
  "suite": "core"
 },
 "admin-posters-page.mjs": {
  "suite": "core"
 },
 "admin-posters-run.mjs": {
  "suite": "core"
 },
 "admin-prediction-recovery-api.mjs": {
  "suite": "core"
 },
 "admin-prediction-recovery-page.mjs": {
  "suite": "core"
 },
 "admin-query.mjs": {
  "suite": "core"
 },
 "admin-read-api.mjs": {
  "suite": "core"
 },
 "admin-shell.mjs": {
  "suite": "core"
 },
 "adr-0142-examples.mjs": {
  "suite": "core",
  "note": "Auditable index of ADR 0142 examples onto covering tests; not a coverage certificate by itself."
 },
 "air-100-rollout.mjs": {
  "suite": "core"
 },
 "air-376-small-fixes.mjs": {
  "suite": "core"
 },
 "air-566-residual-nonfilm-audit.mjs": {
  "suite": "core"
 },
 "air-566-serial-rule-replay.mjs": {
  "suite": "core"
 },
 "air-579-index-candidates-offline.mjs": {
  "suite": "core"
 },
 "air-86-replay.mjs": {
  "suite": "core"
 },
 "air-94-screening-audit.mjs": {
  "suite": "core"
 },
 "air-97-rescore.mjs": {
  "suite": "core"
 },
 "air-99-census.mjs": {
  "suite": "core"
 },
 "air-99-detail.mjs": {
  "suite": "core"
 },
 "alias-provenance.mjs": {
  "suite": "core"
 },
 "build-atomic-dist.mjs": {
  "suite": "core"
 },
 "candidate-discovery.mjs": {
  "suite": "core"
 },
 "candidate-show-identity.mjs": {
  "suite": "core"
 },
 "canonical-catalog-reader-mutation.mjs": {
  "suite": "non-functional",
  "note": "Every assertion is that a one-rule mutant is killed by the matching functional test, or that a neutral edit is not. That measures how effective the tests are. It is not a check of production behaviour."
 },
 "canonical-catalog-reader.mjs": {
  "suite": "core"
 },
 "canonical-catalog-titles-mutation.mjs": {
  "suite": "non-functional",
  "note": "Every assertion is that a one-rule mutant is killed by the matching functional test, or that a neutral edit is not. That measures how effective the tests are. It is not a check of production behaviour."
 },
 "canonical-catalog-titles.mjs": {
  "suite": "core"
 },
 "canonical-catalog-metadata.mjs": {
  "suite": "core"
 },
 "canonical-admin-dictionaries.mjs": {
  "suite": "core"
 },
 "canonical-footer-export.mjs": {
  "suite": "core"
 },
 "canonical-mirror-put.mjs": {
  "suite": "core"
 },
 "canonical-dictionary-producer-mutation.mjs": {
  "suite": "non-functional",
  "note": "Every assertion is that a one-rule mutant is killed by the matching functional test, or that a neutral edit is not. That measures how effective the tests are. It is not a check of production behaviour."
 },
 "canonical-dictionary-producer.mjs": {
  "suite": "core"
 },
 "canonical-differential-helper.mjs": {
  "suite": "core"
 },
 "canonical-differential-mutation.mjs": {
  "suite": "non-functional",
  "note": "Every assertion is that a one-rule mutant is killed by the matching functional test, or that a neutral edit is not. That measures how effective the tests are. It is not a check of production behaviour."
 },
 "canonical-differential.mjs": {
  "suite": "core"
 },
 "canonical-discovery-admission-producer-mutation.mjs": {
  "suite": "non-functional",
  "note": "Every assertion is that a one-rule mutant is killed by the matching functional test, or that a neutral edit is not. That measures how effective the tests are. It is not a check of production behaviour."
 },
 "canonical-discovery-admission-producer.mjs": {
  "suite": "core"
 },
 "canonical-epg-person-producer-mutation.mjs": {
  "suite": "non-functional",
  "note": "Every assertion is that a one-rule mutant is killed by the matching functional test, or that a neutral edit is not. That measures how effective the tests are. It is not a check of production behaviour."
 },
 "canonical-epg-person-producer.mjs": {
  "suite": "core"
 },
 "canonical-epg-producer-mutation.mjs": {
  "suite": "non-functional",
  "note": "Every assertion is that a one-rule mutant is killed by the matching functional test, or that a neutral edit is not. That measures how effective the tests are. It is not a check of production behaviour."
 },
 "canonical-epg-producer.mjs": {
  "suite": "core"
 },
 "canonical-exception-decisions.mjs": {
  "suite": "core"
 },
 "canonical-film-external-ids-producer-mutation.mjs": {
  "suite": "non-functional",
  "note": "Every assertion is that a one-rule mutant is killed by the matching functional test, or that a neutral edit is not. That measures how effective the tests are. It is not a check of production behaviour."
 },
 "canonical-film-external-ids-producer.mjs": {
  "suite": "core"
 },
 "discovery-catalog-read-log.mjs": {
  "suite": "core"
 },
 "letterboxd-admission-callers.mjs": {
  "suite": "core"
 },
 "letterboxd-admission-closed.mjs": {
  "suite": "core"
 },
 "letterboxd-admission-documents.mjs": {
  "suite": "core"
 },
 "letterboxd-admission-import.mjs": {
  "suite": "core"
 },
 "letterboxd-archive-apply-d1.mjs": {
  "suite": "core"
 },
 "letterboxd-archive-readers-d1.mjs": {
  "suite": "core"
 },
 "letterboxd-admission-d1.mjs": {
  "suite": "core"
 },
 "letterboxd-admission-authority.mjs": {
  "suite": "core"
 },
 "film-lid-admission-merge.mjs": {
  "suite": "core"
 },
 "film-lid-admission-migration.mjs": {
  "suite": "core"
 },
 "letterboxd-lid-only-proof.mjs": {
  "suite": "core"
 },
 "letterboxd-real-markup-h1.mjs": {
  "suite": "core"
 },
 "letterboxd-lid-only-admission-d1.mjs": {
  "suite": "core"
 },
 "admin-lid-recheck-route.mjs": {
  "suite": "core"
 },
 "lid-attach-helpers.mjs": {
  "suite": "core"
 },
 "lid-attach-migrations.mjs": {
  "suite": "core"
 },
 "lid-tmdb-attach-d1.mjs": {
  "suite": "core"
 },
 "letterboxd-check-legacy-report.mjs": {
  "suite": "core"
 },
 "letterboxd-owner-race-d1.mjs": {
  "suite": "core"
 },
 "letterboxd-owner-action-atomic.mjs": {
  "suite": "core"
 },
 "import-fence-helper.mjs": {
  "suite": "core"
 },
 "film-dimension-import-fence.mjs": {
  "suite": "core"
 },
 "letterboxd-claim-activation-rehearsal.mjs": {
  "suite": "core"
 },
 "letterboxd-claim-backfill.mjs": {
  "suite": "core"
 },
 "canonical-letterboxd-claim.mjs": {
  "suite": "core"
 },
 "prediction-alias-bridge-cohort.mjs": {
  "suite": "core"
 },
 "canonical-film-writers-mutation.mjs": {
  "suite": "non-functional",
  "note": "Every assertion is that a one-rule mutant is killed by the matching functional test, or that a neutral edit is not. That measures how effective the tests are. It is not a check of production behaviour."
 },
 "canonical-film-writers.mjs": {
  "suite": "core"
 },
 "canonical-handoff-readiness.mjs": {
  "suite": "core"
 },
 "canonical-metadata-sync-producer.mjs": {
  "suite": "core"
 },
 "canonical-rated-admission-bundle.mjs": {
  "suite": "core"
 },
 "canonical-rated-admission-producer.mjs": {
  "suite": "core"
 },
 "canonical-person-mutation-producer-mutation.mjs": {
  "suite": "non-functional",
  "note": "Every assertion is that a one-rule mutant is killed by the matching functional test, or that a neutral edit is not. That measures how effective the tests are. It is not a check of production behaviour."
 },
 "canonical-person-mutation-producer.mjs": {
  "suite": "core"
 },
 "canonical-person-state-mutation.mjs": {
  "suite": "non-functional",
  "note": "Every assertion is that a one-rule mutant is killed by the matching functional test, or that a neutral edit is not. That measures how effective the tests are. It is not a check of production behaviour."
 },
 "canonical-person-state.mjs": {
  "suite": "core"
 },
 "canonical-person.mjs": {
  "suite": "core"
 },
 "canonical-producer-adapters-mutation.mjs": {
  "suite": "non-functional",
  "note": "Every assertion is that a one-rule mutant is killed by the matching functional test, or that a neutral edit is not. That measures how effective the tests are. It is not a check of production behaviour."
 },
 "canonical-producer-adapters.mjs": {
  "suite": "core"
 },
 "canonical-producer-budget-boundaries.mjs": {
  "suite": "core"
 },
 "canonical-producer-budget-lib.mjs": {
  "suite": "support",
  "note": "AIR-572 library: the Producer budget fixture and the chain driver. Executing this file runs no check; canonical-producer-budget.mjs and canonical-producer-budget-boundaries.mjs import it."
 },
 "canonical-producer-budget.mjs": {
  "suite": "core"
 },
 "canonical-producer-chain.mjs": {
  "suite": "core"
 },
 "canonical-producer-driver-mutation-b.mjs": {
  "suite": "non-functional",
  "note": "Every assertion is that a one-rule mutant is killed by the matching functional test, or that a neutral edit is not. That measures how effective the tests are. It is not a check of production behaviour."
 },
 "canonical-producer-driver-mutation-lib.mjs": {
  "suite": "support",
  "note": "Library of runMutationPart. Executing this file runs no check. The two driver part files import it and run the mutant-kill checks in the non-functional suite."
 },
 "canonical-producer-driver-mutation.mjs": {
  "suite": "non-functional",
  "note": "Every assertion is that a one-rule mutant is killed by the matching functional test, or that a neutral edit is not. That measures how effective the tests are. It is not a check of production behaviour."
 },
 "canonical-producer-driver.mjs": {
  "suite": "core"
 },
 "canonical-producer-events.mjs": {
  "suite": "core"
 },
 "canonical-producer-movie-ref.mjs": {
  "suite": "core"
 },
 "canonical-producer-run-mutation.mjs": {
  "suite": "non-functional",
  "note": "Every assertion is that a one-rule mutant is killed by the matching functional test, or that a neutral edit is not. That measures how effective the tests are. It is not a check of production behaviour."
 },
 "canonical-producer-run.mjs": {
  "suite": "core"
 },
 "canonical-producer-schema-mutation.mjs": {
  "suite": "non-functional",
  "note": "Every assertion is that a one-rule mutant is killed by the matching functional test, or that a neutral edit is not. That measures how effective the tests are. It is not a check of production behaviour."
 },
 "canonical-producer-schema.mjs": {
  "suite": "core"
 },
 "canonical-producer-store-mutation.mjs": {
  "suite": "non-functional",
  "note": "Every assertion is that a one-rule mutant is killed by the matching functional test, or that a neutral edit is not. That measures how effective the tests are. It is not a check of production behaviour."
 },
 "canonical-producer-store.mjs": {
  "suite": "core"
 },
 "canonical-producers.mjs": {
  "suite": "core"
 },
 "canonical-read-model.mjs": {
  "suite": "core"
 },
 "film-aggregate.mjs": {
  "suite": "core"
 },
 "migration-0043-film-redirect-index.mjs": {
  "suite": "core"
 },
 "film-metadata-provenance.mjs": {
  "suite": "core"
 },
 "migration-0049-film-metadata-provenance.mjs": {
  "suite": "core"
 },
 "migration-0047-catalog-enrichment.mjs": {
  "suite": "core"
 },
 "catalog-enrichment-plan.mjs": {
  "suite": "core"
 },
 "catalog-enrichment-store.mjs": {
  "suite": "core"
 },
 "catalog-enrichment-units-scoped.mjs": {
  "suite": "core"
 },
 "catalog-enrichment-units.mjs": {
  "suite": "core"
 },
 "catalog-enrichment-sources.mjs": {
  "suite": "core"
 },
 "catalog-enrichment-producer.mjs": {
  "suite": "core"
 },
 "catalog-enrichment-drain.mjs": {
  "suite": "core"
 },
 "catalog-enrichment-settings.mjs": {
  "suite": "core"
 },
 "admin-film-metadata-api.mjs": {
  "suite": "core"
 },
 "admin-film-metadata-page.mjs": {
  "suite": "core"
 },
 "catalog-enrichment-workflow.mjs": {
  "suite": "core"
 },
 "catalog-enrichment-letterboxd-credits.mjs": {
  "suite": "core"
 },
 "catalog-enrichment-monitor.mjs": {
  "suite": "core"
 },
 "catalog-enrichment-events.mjs": {
  "suite": "core"
 },
 "catalog-enrichment-wake.mjs": {
  "suite": "core"
 },
 "catalog-enrichment-recorded-tmdb.mjs": {
  "suite": "core"
 },
 "catalog-enrichment-discovery.mjs": {
  "suite": "core"
 },
 "migration-0050-discovery-enrichment.mjs": {
  "suite": "core"
 },
 "migration-0053-provenance-other-language.mjs": {
  "suite": "core"
 },
 "migration-0054-retire-identity-assertion.mjs": {
  "suite": "core"
 },
 "catalog-enrichment-bootstrap.mjs": {
  "suite": "core"
 },
 "upstream-cooldown.mjs": {
  "suite": "core"
 },
 "upstream-cooldown-callers.mjs": {
  "suite": "core"
 },
 "removal-ratings-cooldown.mjs": {
  "suite": "core"
 },
 "upstream-cooldown-metadata.mjs": {
  "suite": "core"
 },
 "film-aggregate-resolver.mjs": {
  "suite": "core"
 },
 "prediction-lid-only-exclusion.mjs": {
  "suite": "core"
 },
 "lid-only-consumers.mjs": {
  "suite": "core"
 },
 "prediction-lid-only-real-path.mjs": {
  "suite": "core"
 },
 "prediction-lid-only-merge.mjs": {
  "suite": "core"
 },
 "film-readiness.mjs": {
  "suite": "core"
 },
 "film-history-aggregate.mjs": {
  "suite": "core"
 },
 "canonical-readiness-classes.mjs": {
  "suite": "core"
 },
 "canonical-receipted-writers-mutation.mjs": {
  "suite": "non-functional",
  "note": "Every assertion is that a one-rule mutant is killed by the matching functional test, or that a neutral edit is not. That measures how effective the tests are. It is not a check of production behaviour."
 },
 "canonical-receipted-writers.mjs": {
  "suite": "core"
 },
 "canonical-receipts-mutation.mjs": {
  "suite": "non-functional",
  "note": "Every assertion is that a one-rule mutant is killed by the matching functional test, or that a neutral edit is not. That measures how effective the tests are. It is not a check of production behaviour."
 },
 "canonical-receipts.mjs": {
  "suite": "core"
 },
 "canonical-repository-context.mjs": {
  "suite": "core"
 },
 "canonical-repository-projected-link.mjs": {
  "suite": "core"
 },
 "canonical-repository.mjs": {
  "suite": "core"
 },
 "card-ux.mjs": {
  "suite": "core"
 },
 "catalog-availability-writes.mjs": {
  "suite": "core"
 },
 "catalog-available-user-facts.mjs": {
  "suite": "core"
 },
 "catalog-available.mjs": {
  "suite": "core"
 },
 "catalog-completed-d1.mjs": {
  "suite": "core"
 },
 "catalog-d1.mjs": {
  "suite": "split",
  "note": "The route contract stays in core. Twenty timed identity reads are scenario catalog-d1-identity-read-latency."
 },
 "catalog-film.mjs": {
  "suite": "core"
 },
 "catalog-poster-footer.mjs": {
  "suite": "core"
 },
 "catalog-poster-monitor.mjs": {
  "suite": "core"
 },
 "catalog-poster-weekly-d1.mjs": {
  "suite": "core"
 },
 "catalog-poster-weekly.mjs": {
  "suite": "core"
 },
 "catalog-posters-d1.mjs": {
  "suite": "core"
 },
 "catalog-posters.mjs": {
  "suite": "core"
 },
 "catalog-watched-d1.mjs": {
  "suite": "core"
 },
 "channel-finds.mjs": {
  "suite": "core"
 },
 "concert-broadcast-admission.mjs": {
  "suite": "core"
 },
 "confidence-assessment-ui.mjs": {
  "suite": "core"
 },
 "content-search.mjs": {
  "suite": "core"
 },
 "contextual-finds.mjs": {
  "suite": "core"
 },
 "continuation-diagnostics.mjs": {
  "suite": "core"
 },
 "continuous-drain.mjs": {
  "suite": "core"
 },
 "coverage-percent.mjs": {
  "suite": "core"
 },
 "cron-schedule-simulation.mjs": {
  "suite": "core"
 },
 "d1-backfill.mjs": {
  "suite": "core"
 },
 "d1-enrichment.mjs": {
  "suite": "core"
 },
 "d1-projection-seed.mjs": {
  "suite": "core"
 },
 "d1-schema.mjs": {
  "suite": "core"
 },
 "d1-standin.mjs": {
  "suite": "core"
 },
 "d1-status-context.mjs": {
  "suite": "core"
 },
 "daily-quality.mjs": {
  "suite": "core"
 },
 "data-health.mjs": {
  "suite": "core"
 },
 "deferred-completion-status.mjs": {
  "suite": "core"
 },
 "diary-first-ratings.mjs": {
  "suite": "core"
 },
 "discovery-activity.mjs": {
  "suite": "core"
 },
 "discovery-admission-packed.mjs": {
  "suite": "core",
  "note": "8,312-film write stays in core. newTrips*350<60000 is a cap on round trips at a fixed 350ms model, not the runner clock. localMs is only logged."
 },
 "discovery-archive-import.mjs": {
  "suite": "core"
 },
 "admin-identity-owner-action.mjs": {
  "suite": "core"
 },
 "admin-identity-revoke-page.mjs": {
  "suite": "core"
 },
 "admin-identity-group-page.mjs": {
  "suite": "core"
 },
 "discovery-catalog-read-census.mjs": {
  "suite": "core"
 },
 "discovery-chunk-catalog-read-census.mjs": {
  "suite": "core"
 },
 "discovery-held-slot-read.mjs": {
  "suite": "core"
 },
 "discovery-identity-group.mjs": {
  "suite": "core"
 },
 "discovery-identity-revoke.mjs": {
  "suite": "core"
 },
 "discovery-owner-evidence.mjs": {
  "suite": "core"
 },
 "discovery-owner-evidence-schema.mjs": {
  "suite": "core"
 },
 "discovery-intent-migration-0027.mjs": {
  "suite": "core"
 },
 "discovery-authority.mjs": {
  "suite": "core"
 },
 "discovery-bounded-d1-rehearsal.mjs": {
  "suite": "core"
 },
 "discovery-bulk-replay.mjs": {
  "suite": "core",
  "note": "AIR-523 batched replay of a new generation's assigned rows. Round-trip and statement counts are asserted, wall time is not."
 },
 "discovery-replay-timeline.mjs": {
  "suite": "core",
  "note": "AIR-535 offline replay benchmark. Round trips per restored row and chunk counts under a MODELLED clock are asserted; no wall-clock or latency threshold."
 },
 "discovery-bundle-slot-scan.mjs": {
  "suite": "core",
  "note": "The built Worker bundle must resolve slotScanConfirmation inside assignObservationSlots. A direct module import does not load that scope."
 },
 "discovery-bounded-drain.mjs": {
  "suite": "core"
 },
 "discovery-bounded-fence.mjs": {
  "suite": "core"
 },
 "discovery-bounded-lib.mjs": {
  "suite": "core"
 },
 "discovery-conflict-diagnostics.mjs": {
  "suite": "core",
  "note": "Typed discovery_conflict / fence classification, failedAt phase and UNIQUE category. No production read."
 },
 "discovery-chunk-budget.mjs": {
  "suite": "split",
  "note": "Same-key reads, fences and the injected preChunkMs gap stay in core. The concurrent-versus-sequential runner ratio is scenario discovery-chunk-budget-concurrent-walk."
 },
 "discovery-chunk-memory.mjs": {
  "suite": "core",
  "note": "The chunk must release inputs and keep the same decisions. That is a resource bound, not a speed target."
 },
 "discovery-decisions-read.mjs": {
  "suite": "core"
 },
 "discovery-events.mjs": {
  "suite": "core"
 },
 "discovery-identity-review.mjs": {
  "suite": "core"
 },
 "discovery-ledger-archive.mjs": {
  "suite": "core"
 },
 "discovery-ledger-install.mjs": {
  "suite": "core"
 },
 "discovery-ledger-split.mjs": {
  "suite": "core"
 },
 "discovery-observation-index.mjs": {
  "suite": "core"
 },
 "discovery-operational-status.mjs": {
  "suite": "core"
 },
 "discovery-paged-write.mjs": {
  "suite": "core"
 },
 "discovery-pipeline-d1-status.mjs": {
  "suite": "core"
 },
 "discovery-pipeline.mjs": {
  "suite": "core"
 },
 "discovery-production.mjs": {
  "suite": "core"
 },
 "discovery-reconsider.mjs": {
  "suite": "core"
 },
 "discovery-fast-recovery.mjs": {
  "suite": "core"
 },
 "discovery-fence-collision.mjs": {
  "suite": "core"
 },
 "discovery-recovery.mjs": {
  "suite": "core"
 },
 "discovery-revalidation.mjs": {
  "suite": "core"
 },
 "discovery-seal-busy.mjs": {
  "suite": "core"
 },
 "discovery-seal-interrupted.mjs": {
  "suite": "core"
 },
 "discovery-seal-publish.mjs": {
  "suite": "core"
 },
 "discovery-seal-reads.mjs": {
  "suite": "core"
 },
 "discovery-seal-restart.mjs": {
  "suite": "core"
 },
 "discovery-seal-resume.mjs": {
  "suite": "core"
 },
 "discovery-seal-throughput.mjs": {
  "suite": "core",
  "note": "Production-sized seal stays in core. The assertions are round-trip and statement caps plus crash, fence and replay. standinWallMs is only logged."
 },
 "discovery-slot-assignment.mjs": {
  "suite": "core"
 },
 "discovery-status-memory.mjs": {
  "suite": "core",
  "note": "Operational status must not follow ledger size in statement count. Milliseconds are only logged."
 },
 "discovery-user-read-fence.mjs": {
  "suite": "split",
  "note": "Fence, HTTP 503 and R2-fallback refusals are core. The delayed-catalog wait is gated nonFunctional."
 },
 "discovery-workflow-bundle.mjs": {
  "suite": "core"
 },
 "discovery-workflow-rollover.mjs": {
  "suite": "core"
 },
 "discovery-workflow.mjs": {
  "suite": "core"
 },
 "documentation-governance.mjs": {
  "suite": "core"
 },
 "effective-window.mjs": {
  "suite": "core"
 },
 "enrichment.mjs": {
  "suite": "core"
 },
 "letterboxd-claim-provenance-d1.mjs": {
  "suite": "core"
 },
 "letterboxd-inferred-pair-repair.mjs": {
  "suite": "core"
 },
 "letterboxd-view-double.mjs": {
  "suite": "core"
 },
 "reservation-guard-fixture.mjs": {
  "suite": "core"
 },
 "view-index-d1-input.mjs": {
  "suite": "core"
 },
 "view-index-fixture.mjs": {
  "suite": "core"
 },
 "watchlist-composition.mjs": {
  "suite": "core"
 },
 "watchlist-d1.mjs": {
  "suite": "core"
 },
 "watchlist-membership-0037-production.mjs": {
  "suite": "core"
 },
 "watchlist-membership.mjs": {
  "suite": "core"
 },
 "watchlist-routes.mjs": {
  "suite": "core"
 },
 "watchlist-worker.mjs": {
  "suite": "core"
 },
 "epg-checkpoint-worker.mjs": {
  "suite": "core"
 },
 "epg-checkpoint-certificate.mjs": {
  "suite": "core"
 },
 "epg-checkpoint-d1.mjs": {
  "suite": "core"
 },
 "epg-channel-d1.mjs": {
  "suite": "core"
 },
 "epg-channel-policy.mjs": {
  "suite": "core"
 },
 "epg-channel-policy-dry-run.mjs": {
  "suite": "core"
 },
 "epg-checkpoint-production.mjs": {
  "suite": "core"
 },
 "watchlist-authority-production.mjs": {
  "suite": "core"
 },
 "letterboxd-sync-control-production.mjs": {
  "suite": "core"
 },
 "migration-index-docs.mjs": {
  "suite": "core"
 },
 "migration-0036-lookup-indexes.mjs": {
  "suite": "core"
 },
 "d1-lookup-indexes-0036-production.mjs": {
  "suite": "core"
 },
 "migration-0040-retirement-movie-index.mjs": {
  "suite": "core"
 },
 "watchlist-bootstrap.mjs": {
  "suite": "core"
 },
 "watchlist-cutover.mjs": {
  "suite": "core"
 },
 "watchlist-root-fence.mjs": {
  "suite": "core"
 },
 "watchlist-mirror.mjs": {
  "suite": "core"
 },
 "letterboxd-qa-matrix.mjs": {
  "suite": "core"
 },
 "letterboxd-film-admission-race.mjs": {
  "suite": "core"
 },
 "migration-statements.mjs": {
  "suite": "core"
 },
 "epg-commit-durable-enqueue.mjs": {
  "suite": "core"
 },
 "epg-commit-interrupted-handoff.mjs": {
  "suite": "core"
 },
 "epg-commit-memory.mjs": {
  "suite": "core",
  "note": "The commit must fold a large ledger without holding it. That is a memory bound required for a safe deploy, not a latency target."
 },
 "epg-diagnostic-bindings-ready.mjs": {
  "suite": "core"
 },
 "epg-event-publication-d1.mjs": {
  "suite": "core"
 },
 "epg-event-publication.mjs": {
  "suite": "core"
 },
 "epg-extended-future.mjs": {
  "suite": "core"
 },
 "epg-mirror-reconciliation.mjs": {
  "suite": "core"
 },
 "epg-orchestration.mjs": {
  "suite": "core"
 },
 "epg-workflow-rollover.mjs": {
  "suite": "core"
 },
 "epg-path-a-feasibility.mjs": {
  "suite": "core",
  "note": "The tiny-scale replay must be exact and must refuse bad paths. heapUsed>0 only proves a sample was recorded."
 },
 "epg-path-a-workerd.mjs": {
  "suite": "core"
 },
 "epg-phase-markers.mjs": {
  "suite": "core"
 },
 "epg-priority-gate.mjs": {
  "suite": "core"
 },
 "epg-priority-pause.mjs": {
  "suite": "core"
 },
 "epg-producer-dry-run-mutation.mjs": {
  "suite": "non-functional",
  "note": "Every assertion is that a one-rule mutant is killed by the matching functional test, or that a neutral edit is not. That measures how effective the tests are. It is not a check of production behaviour."
 },
 "epg-producer-dry-run.mjs": {
  "suite": "core"
 },
 "epg-producer-m2b-mutation.mjs": {
  "suite": "non-functional",
  "note": "Every assertion is that a one-rule mutant is killed by the matching functional test, or that a neutral edit is not. That measures how effective the tests are. It is not a check of production behaviour."
 },
 "epg-producer-m2b-reader-mutation.mjs": {
  "suite": "non-functional",
  "note": "Every assertion is that a one-rule mutant is killed by the matching functional test, or that a neutral edit is not. That measures how effective the tests are. It is not a check of production behaviour."
 },
 "epg-producer-m2b-reader.mjs": {
  "suite": "core"
 },
 "epg-producer-m2b-synthetic.mjs": {
  "suite": "core"
 },
 "epg-producer-m2b.mjs": {
  "suite": "core"
 },
 "epg-published-at.mjs": {
  "suite": "core"
 },
 "epg-r2-known-length.mjs": {
  "suite": "core",
  "note": "Known-length publish at tens of megabytes stays in core. The assertions are sizes, counts and the type error. seedMs and publishMs are only logged."
 },
 "epg-ratings-attempt.mjs": {
  "suite": "core"
 },
 "epg-repository.mjs": {
  "suite": "core"
 },
 "epg-run-certificate.mjs": {
  "suite": "core"
 },
 "epg-slot-uniqueness.mjs": {
  "suite": "core"
 },
 "epg-status-ledger-mode.mjs": {
  "suite": "core"
 },
 "epg-title-collision.mjs": {
  "suite": "core"
 },
 "epg-trace-boundaries.mjs": {
  "suite": "core"
 },
 "event-outbox.mjs": {
  "suite": "core"
 },
 "events-pagination-ui.mjs": {
  "suite": "core"
 },
 "events-result-status.mjs": {
  "suite": "core"
 },
 "events-screen.mjs": {
  "suite": "core"
 },
 "events-type-filter.mjs": {
  "suite": "core"
 },
 "evidence-json-paths.mjs": {
  "suite": "core"
 },
 "execution-filters.mjs": {
  "suite": "core"
 },
 "expired-diagnostics-settle.mjs": {
  "suite": "core"
 },
 "facet-picker-focus.mjs": {
  "suite": "core"
 },
 "facet-pickers.mjs": {
  "suite": "core"
 },
 "feature-flags.mjs": {
  "suite": "core"
 },
 "film-admission.mjs": {
  "suite": "core"
 },
 "film-availability.mjs": {
  "suite": "core"
 },
 "film-card-actions.mjs": {
  "suite": "core"
 },
 "film-compare.mjs": {
  "suite": "core"
 },
 "film-history.mjs": {
  "suite": "core"
 },
 "film-page.mjs": {
  "suite": "core"
 },
 "film-permalink.mjs": {
  "suite": "core"
 },
 "film-person-0019-preflight-mutation.mjs": {
  "suite": "non-functional",
  "note": "Every assertion is that a one-rule mutant is killed by the matching functional test, or that a neutral edit is not. That measures how effective the tests are. It is not a check of production behaviour."
 },
 "film-person-0019-preflight.mjs": {
  "suite": "core"
 },
 "film-person-0020-preflight-mutation.mjs": {
  "suite": "non-functional",
  "note": "Every assertion is that a one-rule mutant is killed by the matching functional test, or that a neutral edit is not. That measures how effective the tests are. It is not a check of production behaviour."
 },
 "film-person-0020-preflight.mjs": {
  "suite": "core"
 },
 "film-person-authority.mjs": {
  "suite": "core"
 },
 "film-dimension-parity.mjs": {
  "suite": "core"
 },
 "film-dimension-retirement.mjs": {
  "suite": "core"
 },
 "film-localization-projection-mutation.mjs": {
  "suite": "non-functional",
  "note": "Every assertion is that a one-rule mutant is killed by the matching functional test, or that a neutral edit is not. That measures how effective the tests are. It is not a check of production behaviour."
 },
 "film-localization-projection.mjs": {
  "suite": "core"
 },
 "film-localization-reconciler.mjs": {
  "suite": "core"
 }, "film-localization-repair.mjs": {
  "suite": "core"
 },
 "film-person-gate-reuse.mjs": {
  "suite": "core"
 },
 "film-person-backfill.mjs": {
  "suite": "core"
 },
 "film-person-diagnostics.mjs": {
  "suite": "core"
 },
 "film-person-e6-measure-mutation.mjs": {
  "suite": "non-functional",
  "note": "Every assertion is that a one-rule mutant is killed by the matching functional test, or that a neutral edit is not. That measures how effective the tests are. It is not a check of production behaviour."
 },
 "film-person-e6-measure.mjs": {
  "suite": "core",
  "note": "Percentile arithmetic and stop rules of the measurement kit are functional. This file does not assert a runner latency."
 },
 "film-person-localize.mjs": {
  "suite": "core"
 },
 "film-person-reader.mjs": {
  "suite": "split",
  "note": "The lifecycle contract, including the 2500-film hot result, stays in core. The 8s runner bound is scenario film-person-reader-completed-slots-index."
 },
 "film-person.mjs": {
  "suite": "core"
 },
 "film-retention.mjs": {
  "suite": "core"
 },
 "film-route.mjs": {
  "suite": "core"
 },
 "film-show-layout.mjs": {
  "suite": "core"
 },
 "film-sync-state.mjs": {
  "suite": "core"
 },
 "film-timeline.mjs": {
  "suite": "core"
 },
 "film-title-review.mjs": {
  "suite": "core"
 },
 "filter-preset-ui.mjs": {
  "suite": "core"
 },
 "filter-presets-d1.mjs": {
  "suite": "core"
 },
 "filter-presets.mjs": {
  "suite": "core"
 },
 "filters-window.mjs": {
  "suite": "fixture",
  "note": "Historical integration fixture, intentionally absent from the public suite."
 },
 "finds-availability.mjs": {
  "suite": "core"
 },
 "finds-title-exclusion.mjs": {
  "suite": "core"
 },
 "finds-watched-hit-area.mjs": {
  "suite": "core"
 },
 "finds-watched-mark.mjs": {
  "suite": "core"
 },
 "finds.mjs": {
  "suite": "core"
 },
 "fingerprint-compatibility-spec.mjs": {
  "suite": "core"
 },
 "fingerprint-compatibility.mjs": {
  "suite": "core"
 },
 "fingerprint-evidence.mjs": {
  "suite": "core"
 },
 "fingerprint-migration-queue.mjs": {
  "suite": "core"
 },
 "fingerprint-readers.mjs": {
  "suite": "core"
 },
 "fingerprint-source-derivation.mjs": {
  "suite": "core"
 },
 "fingerprint-version-import.mjs": {
  "suite": "core"
 },
 "footer-canonical-producer.mjs": {
  "suite": "core"
 },
 "footer-collection.mjs": {
  "suite": "core"
 },
 "footer-memory.mjs": {
  "suite": "split",
  "note": "AIR-519. Equivalence of the indexed D1 identity claims, the copy-free coverage and the projected footer blocks, and the degraded malformed record stay in core. The production-sized heap and CPU reproduction is scenario footer-memory-production-size; the owner Limbo pair under a heap cap is scenario owner-limbo-memory-production-size."
 },
 "footer-resilience.mjs": {
  "suite": "split",
  "note": "Status, degraded names and unknown values stay in core. The measured 3s waits are scenarios footer-resilience-silent-source and footer-resilience-hung-freshness. A real hang still hits the per-file timeout."
 },
 "generation-stage-faults.mjs": {
  "suite": "core"
 },
 "generation-stage-lib.mjs": {
  "suite": "core"
 },
 "generation-stage-withheld.mjs": {
  "suite": "core"
 },
 "generation-stage.mjs": {
  "suite": "core"
 },
 "get-side-effects.mjs": {
  "suite": "core"
 },
 "get-write-audit-harness.mjs": {
  "suite": "core"
 },
 "get-write-audit-lib.mjs": {
  "suite": "core"
 },
 "get-write-audit.mjs": {
  "suite": "core"
 },
 "get-write-baseline.mjs": {
  "suite": "core"
 },
 "heavy-read-turns.mjs": {
  "suite": "core"
 },
 "identity-evidence.mjs": {
  "suite": "core"
 },
 "identity-evidence-claim-bridge.mjs": {
  "suite": "core"
 },
 "identity-evidence-import.mjs": {
  "suite": "core"
 },
 "identity-evidence-writer.mjs": {
  "suite": "core"
 },
 "identity-evidence-discovery-decision.mjs": {
  "suite": "core"
 },
 "identity-work-inventory.mjs": {
  "suite": "core"
 },
 "internal-continuation.mjs": {
  "suite": "core"
 },
 "interrupted-continuation.mjs": {
  "suite": "core"
 },
 "interrupted-recovery.mjs": {
  "suite": "core"
 },
 "item-failures.mjs": {
  "suite": "core"
 },
 "json-array-stream-parity.mjs": {
  "suite": "core"
 },
 "json-schema-lite.mjs": {
  "suite": "core"
 },
 "last-chance.mjs": {
  "suite": "core"
 },
 "lease-recovery.mjs": {
  "suite": "core"
 },
 "letterboxd-archive-preview.mjs": {
  "suite": "core"
 },
 "letterboxd-archive-zip.mjs": {
  "suite": "core"
 },
 "letterboxd-baseline-chunks.mjs": {
  "suite": "core"
 },
 "letterboxd-baseline-import.mjs": {
  "suite": "core"
 },
 "letterboxd-diary.mjs": {
  "suite": "core"
 },
 "letterboxd-facts.mjs": {
  "suite": "core"
 },
 "letterboxd-identity-resolve.mjs": {
  "suite": "core"
 },
 "letterboxd-import-registry.mjs": {
  "suite": "core"
 },
 "letterboxd-inferred.mjs": {
  "suite": "core"
 },
 "letterboxd-diary-identity-d1.mjs": {
  "suite": "core"
 },
 "letterboxd-diary-identity-mutation.mjs": {
  "suite": "non-functional",
  "note": "Every assertion is that a one-rule mutant is killed by the matching functional test. That measures how effective the tests are. It is not a check of production behaviour."
 },
 "letterboxd-diary-identity.mjs": {
  "suite": "core"
 },
 "prediction-skipped-event.mjs": {
  "suite": "core"
 },
 "prediction-aux-closed.mjs": {
  "suite": "core"
 },
 "prediction-aux-cutover-production.mjs": {
  "suite": "core"
 },
 "prediction-aux-export-convert.mjs": {
  "suite": "core"
 },
 "prediction-aux-d1.mjs": {
  "suite": "core"
 },
 "prediction-aux-worker.mjs": {
  "suite": "core"
 },
 "prediction-aux-import.mjs": {
  "suite": "core"
 },
 "prediction-aux-budget.mjs": {
  "suite": "core"
 },
 "prediction-aux-bench-lib.mjs": {
  "suite": "core"
 },
 "prediction-aux-p3-benchmark.mjs": {
  "suite": "core"
 },
 "r2-fake-bucket-lib.mjs": {
  "suite": "support",
  "note": "Fake S3-compatible R2 bucket over loopback HTTP (paged listing, conditional HEAD and GET, signature check, write refusal) shared by tests/r2-snapshot-export.mjs, tests/r2-snapshot-export-scoped.mjs and tests/prediction-aux-export-convert.mjs. Executing this file runs no check."
 },
 "prediction-catalog-held-event.mjs": {
  "suite": "core"
 },
 "ratings-diary-admission-d1.mjs": {
  "suite": "core"
 },
 "ratings-diary-identity.mjs": {
  "suite": "core"
 },
 "letterboxd-rated-admission.mjs": {
  "suite": "core"
 },
 "letterboxd-rated-candidates.mjs": {
  "suite": "core"
 },
 "letterboxd-reconcile.mjs": {
  "suite": "core"
 },
 "letterboxd-slug-alias.mjs": {
  "suite": "core"
 },
 "letterboxd-tmdb-rebase.mjs": {
  "suite": "core"
 },
 "letterboxd-tmdb-search.mjs": {
  "suite": "core"
 },
 "lifecycle-diagnostics.mjs": {
  "suite": "core"
 },
 "lifecycle-parity.mjs": {
  "suite": "core"
 },
 "ledger-mode-fixture.mjs": {
  "suite": "support",
  "note": "Helper that marks an offline env as isolated so full/frozen ledger modes can be exercised without the retired production binding."
 },
 "limbo-inventory.mjs": {
  "suite": "core"
 },
 "live-refresh.mjs": {
  "suite": "core"
 },
 "live-telemetry.mjs": {
  "suite": "core"
 },
 "local-api.mjs": {
  "suite": "core"
 },
 "local-d1.mjs": {
  "suite": "core"
 },
 "local-dev-smoke.mjs": {
  "suite": "core"
 },
 "local-standins.mjs": {
  "suite": "core"
 },
 "local-fixtures.mjs": {
  "suite": "core"
 },
 "local-store.mjs": {
  "suite": "core"
 },
 "local-timeshift.mjs": {
  "suite": "core"
 },
 "localization-sources.mjs": {
  "suite": "core"
 },
 "match-hint.mjs": {
  "suite": "core"
 },
 "mcp-tool-call-log.mjs": {
  "suite": "core"
 },
 "mcp-tools.mjs": {
  "suite": "core"
 },
 "mcp.mjs": {
  "suite": "core"
 },
 "memory-bucket.mjs": {
  "suite": "core"
 },
 "metadata-cache-production.mjs": {
  "suite": "core"
 },
 "metadata-cache.mjs": {
  "suite": "core"
 },
 "migration-export-route-absent.mjs": {
  "suite": "core"
 },
 "migration-export.mjs": {
  "suite": "core"
 },
 "migration-import.mjs": {
  "suite": "core"
 },
 "migration-pattern-limit.mjs": {
  "suite": "core"
 },
 "mirror-fallback-client.mjs": {
  "suite": "core"
 },
 "mirror-fallback-routes.mjs": {
  "suite": "core"
 },
 "mirror-fault-classifier.mjs": {
  "suite": "core"
 },
 "mirror-read-write-fence.mjs": {
  "suite": "core"
 },
 "mirror-read.mjs": {
  "suite": "core"
 },
 "monitor-policy.mjs": {
  "suite": "core"
 },
 "discovery-queue-state.mjs": {
  "suite": "core"
 },
 "monitor-message.mjs": {
  "suite": "core"
 },
 "monitor-canonical-producer.mjs": {
  "suite": "core"
 },
 "monitor-runtime.mjs": {
  "suite": "core"
 },
 "monitor-telegram.mjs": {
  "suite": "core"
 },
 "mood-vocabulary.mjs": {
  "suite": "core"
 },
 "names.mjs": {
  "suite": "fixture",
  "note": "Historical integration fixture, intentionally absent from the public suite."
 },
 "nonfilm-screening.mjs": {
  "suite": "core"
 },
 "offline-importer.mjs": {
  "suite": "core"
 },
 "orphaned-continuation.mjs": {
  "suite": "core"
 },
 "owner-review-d1.mjs": {
  "suite": "core"
 },
 "period-counters.mjs": {
  "suite": "core"
 },
 "period-filter.mjs": {
  "suite": "core"
 },
 "persist-watchlist-tail.mjs": {
  "suite": "core"
 },
 "person-identity-projection.mjs": {
  "suite": "core"
 },
 "person-name-editor.mjs": {
  "suite": "core"
 },
 "person-name-review.mjs": {
  "suite": "core"
 },
 "personal-filters.mjs": {
  "suite": "core"
 },
 "prediction-ab-report.mjs": {
  "suite": "core"
 },
 "prediction-assessment.mjs": {
  "suite": "core"
 },
 "prediction-authority-scope.mjs": {
  "suite": "core"
 },
 "prediction-batch-start-budget.mjs": {
  "suite": "core"
 },
 "prediction-batch-start-parity-lib.mjs": {
  "suite": "core"
 },
 "prediction-batch-start-parity.mjs": {
  "suite": "core"
 },
 "prediction-orphan-start-signal.mjs": {
  "suite": "core"
 },
 "prediction-no-progress-series.mjs": {
  "suite": "core"
 },
 "prediction-batch-start-deferred.mjs": {
  "suite": "core"
 },
 "prediction-task-id-lib.mjs": {
  "suite": "core"
 },
 "prediction-air-588-abandoned-start.mjs": {
  "suite": "core"
 },
 "prediction-air-588-request-reuse.mjs": {
  "suite": "core"
 },
 "prediction-air-588-ordering.mjs": {
  "suite": "core"
 },
 "prediction-air-588-envelope.mjs": {
  "suite": "core"
 },
 "prediction-air-588-lease-ttl.mjs": {
  "suite": "core"
 },
 "prediction-task-id.mjs": {
  "suite": "split",
  "note": "Owner-label, join, fencing and refusal semantics stay in core. The runner-clock bound of the join wait is scenario prediction-task-id-join-bound."
 },
 "prediction-batch-start-keyed.mjs": {
  "suite": "split",
  "note": "Join, claim fencing, pending and refusal semantics stay in core. The runner-clock bound of the join wait is scenario prediction-batch-start-keyed-join-bound."
 },
 "prediction-batch-start.mjs": {
  "suite": "core"
 },
 "prediction-batch-submit.mjs": {
  "suite": "split",
  "note": "Settlement, byte cap and the round-trip cap stay in core. Offline wall time is scenario prediction-batch-submit-wall."
 },
 "prediction-batch-validate.mjs": {
  "suite": "split",
  "note": "Verdicts and the request-size cap stay in core. The p95 of 200 calls is scenario prediction-batch-validate-p95."
 },
 "prediction-caller-failure-claim.mjs": {
  "suite": "core"
 },
 "prediction-closed-contract.mjs": {
  "suite": "core"
 },
 "prediction-compatibility.mjs": {
  "suite": "core"
 },
 "prediction-confidence.mjs": {
  "suite": "core"
 },
 "prediction-d1-flow-lib.mjs": {
  "suite": "core"
 },
 "prediction-diagnostics.mjs": {
  "suite": "core"
 },
 "prediction-pending-queue-only.mjs": {
  "suite": "core"
 },
 "prediction-domain-production.mjs": {
  "suite": "core"
 },
 "prediction-domain.mjs": {
  "suite": "core"
 },
 "prediction-dry-run-isolation.mjs": {
  "suite": "core"
 },
 "prediction-epg-independence.mjs": {
  "suite": "core",
  "note": "EPG seal does not block batch selection, submit or manifest_spent. Airtime does not change fingerprint freshness."
 },
 "prediction-event-details.mjs": {
  "suite": "core"
 },
 "prediction-manifest-size.mjs": {
  "suite": "core"
 },
 "prediction-materialization.mjs": {
  "suite": "core"
 },
 "prediction-overlay-index.mjs": {
  "suite": "core",
  "note": "The production-shaped overlay asserts query counts and field parity. Wall time is only logged."
 },
 "prediction-quality.mjs": {
  "suite": "core"
 },
 "prediction-queue-budget.mjs": {
  "suite": "core",
  "note": "The encoded queue must fit the character cap. Write time is only logged."
 },
 "prediction-queue-cas.mjs": {
  "suite": "core"
 },
 "prediction-hot-parity.mjs": {
  "suite": "core",
  "note": "AIR-536: read-only parity of the actual hot outstanding work against the persisted hot queue on 3,200 films; unknown is never a PASS."
 },
 "prediction-hot-reconcile-same-generation.mjs": {
  "suite": "core",
  "note": "AIR-529: new Discovery show assignments in the same published EPG generation move the shows signature and the next batch start rebuilds hot/cold."
 },
 "prediction-queue-discovery-independence.mjs": {
  "suite": "core",
  "note": "A run under a Discovery storm must settle each film once and bound whole-catalog reads. Milliseconds are only logged."
 },
 "prediction-queue-head-seed-d1.mjs": {
  "suite": "core"
 },
 "prediction-queue-hotenteredat.mjs": {
  "suite": "core"
 },
 "prediction-scoring-ab-harness.mjs": {
  "suite": "core"
 },
 "prediction-scoring-candidate-v2.mjs": {
  "suite": "core"
 },
 "prediction-scoring-candidate.mjs": {
  "suite": "core"
 },
 "prediction-recovery.mjs": {
  "suite": "core"
 },
 "prediction-recovery-intent.mjs": {
  "suite": "core"
 },
 "prediction-recovery-slots.mjs": {
  "suite": "core"
 },
 "prediction-footer-health.mjs": {
  "suite": "core"
 },
 "prediction-retry-exhausted.mjs": {
  "suite": "core"
 },
 "prediction-repository.mjs": {
  "suite": "core"
 },
 "prediction-start-diagnostics.mjs": {
  "suite": "core"
 },
 "prediction-start-ledger-seal.mjs": {
  "suite": "core"
 },
 "prediction-step-timing.mjs": {
  "suite": "split",
  "note": "The logical-clock timer contract stays in core. Real hrtime overhead is scenario prediction-step-timing-overhead."
 },
 "prediction-versions.mjs": {
  "suite": "core"
 },
 "profile-compatibility-spec.mjs": {
  "suite": "core"
 },
 "profile-publisher.mjs": {
  "suite": "core"
 },
 "programme-catalog-d1-route.mjs": {
  "suite": "core"
 },
 "programme-catalog-presentation.mjs": {
  "suite": "core"
 },
 "programme-catalog-route.mjs": {
  "suite": "core"
 },
 "programme-catalog-ui.mjs": {
  "suite": "core"
 },
 "programme-display-window.mjs": {
  "suite": "core"
 },
 "producer-outcome-0038-production.mjs": {
  "suite": "core"
 },
 "producer-chain-operator.mjs": {
  "suite": "core"
 },
 "programme-freshness.mjs": {
  "suite": "core"
 },
 "programme-policy-projection.mjs": {
  "suite": "core"
 },
 "projector-marker-guard.mjs": {
  "suite": "core"
 },
 "projector-view-parity.mjs": {
  "suite": "core"
 },
 "projector-window-epg.mjs": {
  "suite": "core"
 },
 "projector-window-r2-instrumented.mjs": {
  "suite": "core"
 },
 "projector-window-r2-inventory.mjs": {
  "suite": "core"
 },
 "projector-window-r2-writes.mjs": {
  "suite": "core"
 },
 "projector-window.mjs": {
  "suite": "core"
 },
 "published-epg-completed.mjs": {
  "suite": "core"
 },
 "published-epg-production.mjs": {
  "suite": "core"
 },
 "published-epg.mjs": {
  "suite": "core"
 },
 "queue-compatibility.mjs": {
  "suite": "core"
 },
 "r2-snapshot-export.mjs": {
  "suite": "core"
 },
 "r2-snapshot-export-scoped.mjs": {
  "suite": "core"
 },
 "rating-history.mjs": {
  "suite": "core"
 },
 "rating-identity.mjs": {
  "suite": "core"
 },
 "ratings-api.mjs": {
  "suite": "core"
 },
 "ratings-cursor-merge.mjs": {
  "suite": "core"
 },
 "ratings-d1.mjs": {
  "suite": "core"
 },
 "ratings-epg.mjs": {
  "suite": "core"
 },
 "ratings-event-details.mjs": {
  "suite": "core"
 },
 "ratings-event.mjs": {
  "suite": "core"
 },
 "ratings-harness.mjs": {
  "suite": "core"
 },
 "ratings-legacy-link.mjs": {
  "suite": "core"
 },
 "ratings-storage-schema.mjs": {
  "suite": "core"
 },
 "ratings-orchestration.mjs": {
  "suite": "core"
 },
 "letterboxd-sync.mjs": {
  "suite": "core"
 },
 "letterboxd-sync-watchlist.mjs": {
  "suite": "core"
 },
 "letterboxd-sync-repository.mjs": {
  "suite": "core"
 },
 "letterboxd-sync-effects.mjs": {
  "suite": "core"
 },
 "letterboxd-sync-bundle.mjs": {
  "suite": "core"
 },
 "letterboxd-sync-ratings.mjs": {
  "suite": "core"
 },
 "letterboxd-sync-monitor.mjs": {
  "suite": "core"
 },
 "letterboxd-sync-admission.mjs": {
  "suite": "core"
 },
 "letterboxd-sync-fence.mjs": {
  "suite": "core"
 },
 "ratings-queue-v2.mjs": {
  "suite": "core"
 },
 "ratings-refresh.mjs": {
  "suite": "core"
 },
 "ratings-run.mjs": {
  "suite": "core"
 },
 "ratings.mjs": {
  "suite": "core"
 },
 "receipt-operation-key.mjs": {
  "suite": "core"
 },
 "removal-rating-lookup.mjs": {
  "suite": "core"
 },
 "removal-ratings.mjs": {
  "suite": "core"
 },
 "resolution-acceptance.mjs": {
  "suite": "core"
 },
 "return-home.mjs": {
  "suite": "core"
 },
 "run-diagnostics.mjs": {
  "suite": "core"
 },
 "run-history.mjs": {
  "suite": "core"
 },
 "run-tests-runner.mjs": {
  "suite": "core"
 },
 "scheduled-task-s8-taskid-candidates.mjs": {
  "suite": "core",
  "note": "Offline exact candidate prompt integrity: S7 and S10 source and S8 SHA-256, fixed task ownership, and a three-occurrence manifestSize change from either baseline. No runtime, throughput or latency measurement."
 },
 "scheduled-task-s10-taskid-candidates.mjs": {
  "suite": "core",
  "note": "Offline exact candidate prompt integrity: S7 source and S10 SHA-256, fixed task ownership, and a three-occurrence S7-to-S10 change. No runtime, throughput or latency measurement."
 },
 "scheduled-task-air-588-envelope-candidates.mjs": {
  "suite": "core"
 },
 "scheduled-task-s7-taskid-candidates.mjs": {
  "suite": "core",
  "note": "Offline exact candidate prompt integrity: SHA-256, fixed task ownership, and a three-occurrence S5-to-S7 change. No runtime, throughput or latency measurement."
 },
 "scheduled-task-prompt-v2.mjs": {
  "suite": "core"
 },
 "scheduled-task-timing.mjs": {
  "suite": "core"
 },
 "schema-preflight.mjs": {
  "suite": "core"
 },
 "scored-discovery.mjs": {
  "suite": "core"
 },
 "scored-resolution.mjs": {
  "suite": "core"
 },
 "serial-episode-screening.mjs": {
  "suite": "core"
 },
 "search-scopes-ui.mjs": {
  "suite": "core"
 },
 "shortlist.mjs": {
  "suite": "core"
 },
 "show-replacement.mjs": {
  "suite": "core"
 },
 "similar-films.mjs": {
  "suite": "core"
 },
 "slot-duration-classes.mjs": {
  "suite": "core"
 },
 "snapshot.mjs": {
  "suite": "core"
 },
 "sort-default.mjs": {
  "suite": "core"
 },
 "sources.mjs": {
  "suite": "fixture",
  "note": "Historical integration fixture, intentionally absent from the public suite."
 },
 "sqlite-session-semantics.mjs": {
  "suite": "core"
 },
 "sqlite-session.mjs": {
  "suite": "core",
  "note": "LARGE_ANSWER selects quote mode so large values stay correct. It is not a suite speed gate."
 },
 "started-d1.mjs": {
  "suite": "core"
 },
 "started.mjs": {
  "suite": "core"
 },
 "status-footer-ui.mjs": {
  "suite": "core"
 },
 "status-footer.mjs": {
  "suite": "core"
 },
 "stop-observability.mjs": {
  "suite": "core"
 },
 "story-filters.mjs": {
  "suite": "core"
 },
 "submit-validation.mjs": {
  "suite": "core"
 },
 "suite-gate.mjs": {
  "suite": "support",
  "note": "Helper that skips nonFunctional callbacks unless IPTV_TEST_SUITE=non-functional. Executing this file runs no check."
 },
 "superseded-redirect.mjs": {
  "suite": "core"
 },
 "synopsis.mjs": {
  "suite": "fixture",
  "note": "Historical integration fixture, intentionally absent from the public suite."
 },
 "test-pass-record.mjs": {
  "suite": "core"
 },
 "test-classification.mjs": {
  "suite": "core"
 },
 "throughput.mjs": {
  "suite": "core",
  "note": "Despite the name, the file checks queue admission, idempotency and failure boundaries. It does not assert a rate."
 },
 "timeless-documentation.mjs": {
  "suite": "core"
 },
 "titles.mjs": {
  "suite": "fixture",
  "note": "Historical integration fixture, intentionally absent from the public suite."
 },
 "tmdb-connection.mjs": {
  "suite": "core"
 },
 "tmdb-retirement-decisions.mjs": {
  "suite": "core"
 },
 "tmdb-tv-identity.mjs": {
  "suite": "core"
 },
 "tmdb-tv-runtime.mjs": {
  "suite": "core"
 },
 "tmdb-watchlist-credits.mjs": {
  "suite": "core"
 },
 "unscheduled.mjs": {
  "suite": "fixture",
  "note": "Historical integration fixture, intentionally absent from the public suite."
 },
 "url-state.mjs": {
  "suite": "core"
 },
 "user-read-memory.mjs": {
  "suite": "split",
  "note": "AIR-586. Equivalence of the programme, view and Finds answers on the projected Discovery catalog (generated bundle) and the D1 projected read stay in core. The production-sized heap of the four user reads one after the other is scenario user-reads-memory-production-size."
 },
 "view-index-seed-membership.mjs": {
  "suite": "core"
 },
 "view-index-d1-export.mjs": {
  "suite": "core"
 },
 "view-index-d1-source.mjs": {
  "suite": "core"
 },
 "view-index-membership-parity.mjs": {
  "suite": "core"
 },
 "viewing.mjs": {
  "suite": "core"
 },
 "watchlist-card-rating.mjs": {
  "suite": "core"
 },
 "watchlist-chance.mjs": {
  "suite": "core"
 },
 "watchlist-event-ratings.mjs": {
  "suite": "core"
 },
 "xmltv-categories-observation.mjs": {
  "suite": "core"
 }
};
export const SUITES=['core','non-functional','split','support','fixture'];
const REPO_TESTS=path.resolve(path.dirname(new URL(import.meta.url).pathname),'..','tests');

export function entryOf(file){
 return FILES[file]??null;
}
// files is the directory listing already limited to *.mjs. suite is core, non-functional or all.
// A directory other than this repository's tests/ folder is not classified: every file is runnable, which is how the runner's own fixtures work.
export function selectSuite(files,directory,suite){
 if(path.resolve(directory)!==REPO_TESTS)return files;
 const wanted=suite==='all'?new Set(['core','split','non-functional']):suite==='non-functional'?new Set(['non-functional','split']):new Set(['core','split']);
 const selected=[];
 for(const file of files){
  const entry=FILES[file];
  if(!entry){const error=new Error('unclassified test file '+file+'; add it to scripts/test-classification.mjs');error.code='unclassified';throw error;}
  if(entry.suite==='support'||entry.suite==='fixture')continue;
  if(wanted.has(entry.suite))selected.push(file);
 }
 return selected;
}
