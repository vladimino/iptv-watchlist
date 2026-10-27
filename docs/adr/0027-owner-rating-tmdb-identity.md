# ADR 0027: An owner rating of a departed watchlist film resolves through its own metadata TMDB id to exactly one trusted Film

**Status:** Proposed (offline import contract and code only; it authorizes no R2 or D1 write, flag, Task, snapshot or acknowledged list)  
**Original decision date:** 2026-10-27  
**Recorded at:** 2026-10-27  
**Approval source:** owner decision G2-A on [AIR-180](https://trello.com/c/NrsSc6gk), 2026-10-27, carried by [AIR-190](https://trello.com/c/pyXBDUG4); this record awaits review  
**Related work:** [AIR-190](https://trello.com/c/pyXBDUG4), [AIR-180 audit](../evidence/d1-migration/air-180-class-c-audit-2026-10-27.md), [AIR-74](https://trello.com/c/5AdAmKPe), [ADR-0009](0009-canonical-film-person-identity.md), [ADR-0019](0019-live-d1-backfill-boundaries.md) item 8, [D1 schema reference](../reference/data/d1-schema.md)  
**Supersedes:** None (it adds one resolution path for one family; ADR-0019's ban on minting Film ids is unchanged)  
**Superseded by:** None

## Context

The importer resolves every stored Film id through `canonicalFilmId()` to a stored Film directly or through a redirect; anything else is class C. The [AIR-180 audit](../evidence/d1-migration/air-180-class-c-audit-2026-10-27.md) found that all 36 class C records of the AIR-175 snapshot belong to films that left the Letterboxd watchlist: their Letterboxd id no longer has a Film, but their `metadata.json` record (keyed by that id) still carries a TMDB id. For two owner ratings (group G2) that TMDB id is held, trusted and without conflict, by exactly one Film that came from EPG discovery and has no rating of its own. The owner chose to resolve these two ratings by that existing identity rather than keep them as a known gap.

## Decision

1. **Scope.** The rule applies to `enrichment/films/<id>/actual.json` (target `actual_rating`) only. Fingerprints, predictions, decisions and every other family keep the shared resolver unchanged (G1 and G3 are not touched). No title or name matching; no Film is created.
2. **When it applies.** Only when the shared resolver answers `film_unresolved` for the stored id. `identity_conflict`, `identity_unlinked`, `identity_unreadable` and any resolved answer are never overridden.
3. **The link.** The stored id must have its own `metadata.json` record (the key equals the record's `id`) with a TMDB id of digits only. That TMDB id must be held by **exactly one** Film, as a trusted, non-conflicting external id; no conflict record may name it; no other `metadata.json` record may carry the same TMDB id; and the Film must hold no Letterboxd id other than the stored one. Then the rating resolves to that Film with `via: "metadata_tmdb"`.
4. **Refusals.** Missing record, foreign record, missing or malformed TMDB id, or no holder: stays `film_unresolved`. Two holders, a conflicting TMDB id, a conflict record, another metadata record with the same TMDB id, or a holder with another Letterboxd id: `identity_conflict`. One holder that does not trust the TMDB id: `identity_unlinked`.
5. **One rating per Film.** A mapped rating never joins or replaces another rating of the same Film, whether equal or different: if the Film already receives a rating directly or through a redirect, or a second mapped rating names it, the mapped one stays unresolved with `rating_conflict` (or `identity_conflict` when the second comes from ambiguous metadata). The Film's own rating is unchanged.
6. **Provenance.** The unit keeps the source key and checksum as written; its identity provenance records `source`, `canonical`, `filmId`, `via: "metadata_tmdb"`, `tmdbId` and the `metadata.json` checksum (`metadataSha256`). `provenance.identity.metadata_tmdb` counts them.
7. **Same rule on both sides.** The write list (`actualUnit`) and the independent source projection (`projectSource`) take the same `ratingIdentity` result, built once per run from the Films, `metadata.json` and the full list of rating keys; the order of inputs does not change the result, and reruns are idempotent through the existing receipts.

## Alternatives considered

- **Keep the two ratings as acknowledged class C.** Rejected by the owner: they are owner data with an unambiguous existing Film.
- **Apply the same link to fingerprints and predictions (G1).** Rejected: those Films already carry their own payloads; G1 is a separate retirement decision.
- **Mint a "departed watchlist film" Film (G3).** Out of scope; it needs its own ADR.
- **Match by title and year.** Rejected by ADR-0009 and the card: not deterministic identity.

## Consequences

On the AIR-175 snapshot the two G2 ratings leave class C and are imported on their Films; class C becomes 34 records (G1 4, G3 30) and nothing else moves ([evidence](../evidence/d1-migration/air-190-g2-rating-identity-2026-10-27.md)). A later snapshot may resolve more or fewer ratings by the same rule; each is reported with its provenance. The runtime is unchanged: the Worker never reads this rule.

## Recovery and migration boundary

Code rollback restores class C for these records; a D1 database already holding the rows keeps them with their receipts until an approved re-import. R2 stays authoritative and no source object changes. Any D1 write, and the acknowledged list for the remaining class C, are separate owner approvals.

## Evidence

- [AIR-190 offline import on the AIR-175 snapshot](../evidence/d1-migration/air-190-g2-rating-identity-2026-10-27.md)
