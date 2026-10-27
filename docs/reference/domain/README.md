# Domain reference

Maintained source-verified domain contracts, distinct from dated rollout evidence and implementation flags:

- [Film/Person identity and lifecycle](film-person.md)
- [Admin Film/Person read contract](admin-read-contract.md) — offline query library `src/domain/admin-query.js`; fixture page `/admin` via `src/admin/fixtures.js`; live read API only after AIR-69
- [Film reviewed-title review contract](film-title-review.md) — offline validation/transition rules for the owner's preferred RU title (`src/domain/film-title-review.js`); the live writer is AIR-53, gated separately
- [Person reviewed-name review contract](person-name-review.md) — offline validation/transition rules for the owner's preferred RU name of one role-specific Person record, with explicit role links and owner-over-dictionary precedence (`src/domain/person-name-review.js`); the live writer is AIR-54, gated separately
- [Scored resolution and independent identity acceptance](scored-resolution.md)
- [Candidate discovery and optional search variants](candidate-discovery.md)
- [EPG non-film screening](nonfilm-screening.md) — `nonFilmEPGReason()` reason codes, identity precedence and reversible `excluded_nonfilm` decisions

Current rollout status belongs in Trello and production observations. See [the main documentation map](../../README.md) and [historical evidence](../../evidence/README.md).
