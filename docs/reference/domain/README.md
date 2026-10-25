# Domain reference

Maintained source-verified domain contracts, distinct from dated rollout evidence and implementation flags:

- [Film/Person identity and lifecycle](film-person.md)
- [Admin Film/Person read contract](admin-read-contract.md) — offline query library `src/domain/admin-query.js`; fixture page `/admin` via `src/admin/fixtures.js`; live read API only after AIR-69
- [Film reviewed-title review contract](film-title-review.md) — offline validation/transition rules for the owner's preferred RU title (`src/domain/film-title-review.js`); the live writer is AIR-53, gated separately
- [Scored resolution and independent identity acceptance](scored-resolution.md)
- [Candidate discovery and optional search variants](candidate-discovery.md)

Current rollout status belongs in Trello and production observations. See [the main documentation map](../../README.md) and [historical evidence](../../evidence/README.md).
