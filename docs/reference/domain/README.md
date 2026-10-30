# Domain reference

Maintained source-verified domain contracts, distinct from dated rollout evidence and implementation flags:

- [Film/Person identity and lifecycle](film-person.md)
- [Admin Film/Person read contract](admin-read-contract.md) — read model and queue rules of the owner `/admin` page; pure query library `src/domain/admin-query.js`; the live read-only route is [`GET /api/admin/*`](../api/admin.md)
- [Film reviewed-title review contract](film-title-review.md) — offline validation/transition rules for the owner's preferred RU title (`src/domain/film-title-review.js`); the live writer is AIR-53, gated separately
- [Person reviewed-name review contract](person-name-review.md) — offline validation/transition rules for the owner's preferred RU name of one role-specific Person record, with explicit role links and owner-over-dictionary precedence (`src/domain/person-name-review.js`); the live writer is AIR-54, gated separately
- [Scored resolution and independent identity acceptance](scored-resolution.md)
- [Candidate discovery and optional search variants](candidate-discovery.md)
- [Prediction compatibility across taste-profile versions](prediction-compatibility.md) — pure evaluator `src/domain/prediction-compatibility.js` (ADR-0031); not yet called by any consumer
- [Fingerprint compatibility across schema and prompt versions](fingerprint-compatibility.md) — transition declarations, the fingerprint rule and the prediction boundary (ADR-0035); pure evaluator `src/domain/fingerprint-compatibility.js`, not yet called by any consumer
- [Data health: quality rules and the issue model](data-health.md) — pure evaluator `src/domain/data-health.js` that turns bounded stored projections into sorted, deduplicated health issues with stable ids, separate completeness/freshness/progress, formal thresholds and suggested actions; not yet called by any consumer
- [EPG non-film screening](nonfilm-screening.md) — `nonFilmEPGReason()` reason codes, identity precedence and reversible `excluded_nonfilm` decisions

Current rollout status belongs in Trello and production observations. See [the main documentation map](../../README.md) and [historical evidence](../../evidence/README.md).
