# Domain reference

Maintained source-verified domain contracts, distinct from dated rollout evidence and implementation flags:

- [Film/Person identity and lifecycle](film-person.md)
- [Admin Film/Person read contract](admin-read-contract.md) — read model and queue rules of the owner `/admin` page; pure query library `src/domain/admin-query.js`; the live read-only route is [`GET /api/admin/*`](../api/admin.md)
- [Film reviewed-title review contract](film-title-review.md) — validation and transition rules for the owner's preferred RU title (`src/domain/film-title-review.js`); the live writer is `POST /api/admin/films/<storedId>/title-review`, stored in `admin/owner-reviews.json` ([ADR 0072](../../adr/0072-owner-reviewed-localization-overlay.md), Proposed)
- [Person reviewed-name review contract](person-name-review.md) — offline validation/transition rules for the owner's preferred RU name of one role-specific Person record, with explicit role links and owner-over-dictionary precedence (`src/domain/person-name-review.js`); the live writer is AIR-54, gated separately
- [Canonical Person: identities, aliases and roles](canonical-person.md) — pure read model `src/domain/canonical-person.js` ([ADR 0058](../../adr/0058-canonical-person-grouping.md)) that groups role- and source-specific Person records into canonical humans by source key, verified coCredit or owner decision, with collision guards, review candidates and reviewed name precedence; the Worker loads it only inside the person identity read
- [Person identity projection](person-identity-projection.md) — consumer reference `src/domain/person-identity-projection.js` ([ADR 0059](../../adr/0059-person-identity-projection.md), Accepted) that answers a watchlist person filter and a catalog person filter with one human id and a trusted, unresolved, ambiguous or conflicting state; one D1 GET calls it, Finds reads that GET for a selected actor or director, and the watchlist grid still matches the stored role id
- [Scored resolution and independent identity acceptance](scored-resolution.md)
- [Candidate discovery and optional search variants](candidate-discovery.md)
- [Prediction compatibility across taste-profile versions](prediction-compatibility.md) — pure evaluator `src/domain/prediction-compatibility.js` (ADR-0031); not yet called by any consumer
- [Fingerprint compatibility across schema and prompt versions](fingerprint-compatibility.md) — transition declarations, the fingerprint rule and the prediction boundary (ADR-0035); pure evaluator `src/domain/fingerprint-compatibility.js`, not yet called by any consumer
- [Data health: quality rules and the issue model](data-health.md) — pure evaluator `src/domain/data-health.js` that turns bounded stored projections into sorted, deduplicated health issues with stable ids, separate completeness/freshness/progress, formal thresholds and suggested actions; the limbo inventory view `src/domain/limbo-inventory.js` names the cause each stuck or waiting film is in, behind the owner route `/api/admin/limbo`
- [Discovery observation recovery assessment](discovery-recovery.md) — pure judgement `src/domain/discovery-recovery.js` of one EPG observation: verdict, whether a retry of it would help, the next expected step and time, identity review instead of retry, and the gate of the one guarded action `discovery_reconsider`; mirrors the resolver's rules
- [Discovery observation index](discovery-observation-index.md) — the bounded, sharded, generation-scoped projection of current unresolved observations that the resolver chunk writes and the owner reads use instead of the ledger: layout, scope, bounds, writer and reader states
- [EPG non-film screening](nonfilm-screening.md) — `nonFilmEPGReason()` reason codes, identity precedence and reversible `excluded_nonfilm` decisions

Current rollout status belongs in Trello and production observations. See [the main documentation map](../../README.md) and [historical evidence](../../evidence/README.md).
