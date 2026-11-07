# ADR 0099: Canonical Film/Person becomes D1-authoritative through a marker, a fenced writer and staged producer migration

**Status:** Accepted  
**Original decision date:** 2026-11-07  
**Recorded at:** 2026-11-07  
**Approval source:** Owner explicitly accepted ADR 0099 on 2026-11-07 after the [independent architecture review PASS of PR #400](https://github.com/vladimino/iptv-watchlist/pull/400#issuecomment-6709978903) at HEAD `eca6265`. The architecture and eight-part decomposition are accepted, subject to the two implementation invariants below. This decision authorizes no schema apply, production import, authority activation, flag or Task edit, or other production operation.  
**Related work:** [AIR-321](https://trello.com/c/KHJM2gnK), [AIR-275](https://trello.com/c/4x7hH0gI), [AIR-343](https://trello.com/c/hCy6fLne), [ADR 0009](0009-canonical-film-person-identity.md), [ADR 0056](0056-d1-enrichment-write-through.md), [ADR 0058](0058-canonical-person-grouping.md), [ADR 0073](0073-d1-authoritative-metadata-cache.md), [ADR 0079](0079-d1-authoritative-published-epg.md), [ADR 0081](0081-d1-authoritative-owner-reviews.md), [ADR 0085](0085-d1-authoritative-discovery-ledger.md), [ADR 0086](0086-watchlist-fact-keeps-the-film.md), [ADR 0087](0087-rated-archive-admission.md), [audit and decomposition](../evidence/d1-migration/air-321-canonical-film-person-audit-2026-11-07.md)  
**Supersedes:** None (it would amend, not rewrite, the single-writer boundary of ADR 0056 once Accepted)  
**Superseded by:** None

## Context

D1 holds `film`, `person`, credits, aliases, external ids and redirects, but only as a projection: the D1 enrichment projector is the sole writer, it derives rows from R2 documents and D1-resident inputs, and no request route reads those tables for rendering (they feed `GET /api/d1/*`, which is `authoritative:false`). Six neighbouring domains are already D1-authoritative under their own markers; none holds a foreign key to `film` or `person`. No marker exists for canonical Film/Person. The audit in the linked evidence record is the factual base; a row in D1 or a successful `GET /api/d1/*` does not prove a cutover.

## Decision (accepted architectural choices; implementation details remain gated)

1. **Scope.** D1 owns canonical Film and Person identity, trusted typed external ids, aliases, redirects, entity lifecycle, localization and credits. The generation-pinned programme and watchlist documents and their embedded render fields stay with the published-EPG domain (AIR-319). Ratings, Discovery admission, the metadata cache and owner reviews keep their own authorities. A link between domains is made only through a verified identity, never by title and year, name, short code or a coinciding numeric id; `tmdb` and `tmdb_tv` stay distinct schemes and one trusted owner per `(scheme, value)` stays enforced.
2. **One domain marker and a per-entity revision.** A single-row marker `film_person_authority` (`mode`, `cutover`, `generation`) with a companion CAS fence row, plus a per-entity revision. Every canonical mutation proves both the current domain generation and the target entity revision in its atomic D1 batch. A mutation that spans entities (a redirect, a merge that adopts credits and aliases) declares its entity set, carries the expected revision of each, asserts and bumps all of them, and re-asserts that a redirect target is not itself a redirect. A lost revision is a retryable conflict, never a partial write. The storage form of the revision is a C1 design point.
3. **The marker is a state machine, and activation fails closed.** States: no table (legacy), `r2` (initial), `prepared` (D1 baseline loaded and parity-verified, R2 still authoritative, direct writers compare only), `open` (D1 authoritative), `held` (a freeze after activation). Transitions: `r2`→`prepared`→`open`, `prepared`→`r2` (reversible), `open`→`held`, `held`→`open` after validation; each activation step is an owner gate. Once the marker exists, a missing or malformed row, a read error, `held` or a failed parity gate fails closed (readers answer 503, writers refuse) and never sends readers back to R2; R2 reads are allowed only in the verified no-table, `r2` and `prepared` states. Correction to an earlier draft: `held` after activation does not mean R2.
4. **Per-entity fenced mutations replace the delete-and-reinsert projection.** Credits are keyed upserts on `(film, person, role)` and never renumber, so the D1-only TMDB credits (AIR-286) survive. The rule that a reviewed or owner value is never downgraded (`guardReviewed`) moves into the mutation API.
5. **Automatic localization is stored as sources, resolved at read.** D1 keeps automatic source values with provenance separately from the effective preferred title or name. The existing dimension tables hold one effective value per entity and the audit found no authority ranking in the SQL, so the recommendation is a small new source table, with the effective value resolved in the canonical bulk read model as owner > reviewed dictionary > automatic. Owner-review entries, audit, revisions and CAS stay in the owner-review domain. The precedence applies to every D1 read consumer, not only `GET /api/d1/*`.
6. **R2 mirrors and rollback.** R2 keeps immutable source inputs and receipts. Once `open`, no R2 object is a competing mutable owner of a Film/Person field. Recommended mirror policy: the published programme and watchlist mirrors stay current (AIR-319); `titles.json` and `people.json` are frozen at activation as archive snapshots and their consumers move to the read model; the retention flag in `enrichment/view-index.json` keeps its prediction role only. **Two meanings of rollback:** before activation (`prepared`→`r2`) it is a reversible marker move; after activation a code revert, or setting `mode=r2` after D1-only writes, is not a rollback. Recovery is `held`, then a fenced, owner-approved reverse reconciliation (rebuild the R2 documents from canonical D1, validate against the parity ledger, stay `held` until the owner accepts), and only then `r2`.
7. **TMDB retirements.** The writer is traced: no code writes `identity/tmdb-retirements.json`; the owner writes it by hand under the [runbook](../runbooks/tmdb-tv-identity-correction.md) (one write so far, AIR-291, four Films). The recommendation is a D1-owned, owner-only, append-only decision and history model with trusted provenance, a unique request id for replay and no implicit un-retirement (a separate explicit owner decision is the only inverse); the R2 object stays an input and audit artifact. Nothing is migration-ready until its card is accepted.
8. **Person grouping stays derived** (ADR 0058/0059/0062): no persisted human, no automatic person merge, no new owner cross-source link.
9. **Order and the single writer.** One generation-fenced writer handoff with one owner per field at each stage and a compare-only shadow before activation (the field table is in the evidence record); the R2-sourced projector never races a direct writer. Foundation first (marker, revisions, fenced API, projector still the only writer), then localization, the admission and retention inputs, the retirement model and the read model in parallel as inactive code, then producer integration, then a baseline with a parity ledger, then activation as a separate owner-gated card. Deploying schema or API is not a change of authority. The projector and `D1_ENRICHMENT_WRITE` are retired by AIR-308 under AIR-275, not here.
10. **Implementation-level choices still open:** the exact marker columns and the revision's storage form belong to C1; no production operation is approved by this ADR. Atomic child cards may be created under AIR-321 following this owner's architecture approval.
11. **Mandatory implementation invariants from independent review:** the authority must not be marked `prepared` until a complete fenced full-plus-delta baseline has passed its parity gate; partially loaded data remains under the verified `r2` authority. The projector must remain the *only canonical writer* through `r2` and `prepared`. New producers stay inactive or compare-only until the generation-fenced handoff to `open`, at which point the projector becomes compare-only/off, with no period of simultaneous writers or missing canonical writer. C1/C4/C6a/C6b acceptance tests must prove both conditions.

## Alternatives considered

- **Flip the marker only, projector unchanged:** two owners of the same fields and R2 sources that still win; rejected in the audit.
- **Direct writers in every producer at once, projector removed:** the cleanest end state with the largest blast radius; kept as the later stage, not the first.
- **Derived only, no authority change:** leaves the canonical tables a mirror and every reader on documents; does not meet the AIR-321 goal.
- **Reuse the localization dimension for source values:** it holds one effective value per entity, so source values and the effective value would collide; a separate source table is the recommendation, to be confirmed.

## Consequences

- A real owner for canonical identity, a fail-closed activation and a parity ledger before the marker flips.
- New complexity: a revision per entity and multi-entity batches, a mutation API replacing a derivation, a source table and a decision table, input migration across several producers, and a read model that carries owner precedence.
- Risk: the projector and a direct writer running together; mitigated by the one marker generation in every batch, the single-owner field table and the compare-only shadow.
- Code rollback reverts neither D1, nor the marker, nor external writers.

## Recovery and migration boundary

Reversible before activation by moving the marker back; after activation only through `held` and an owner-approved reverse reconciliation. Schema apply, import, marker flip and any rollback are separate owner-approved production operations, each its own card gate. This ADR authorizes none of them.

## Evidence

- **Original decision:** not recorded (proposal only).
- **Implementation:** none.
- **Dated verification:** [code-backed audit, 2026-11-07](../evidence/d1-migration/air-321-canonical-film-person-audit-2026-11-07.md); no production read.
- **Uncertainty:** production row counts, parity and class-C exceptions are unknown; the revision's storage form is open.

## Follow-ups

The approved architectural decomposition (C1, C2, C3a, C3b, C4, C5, C6a, C6b) is detailed in the evidence record; implement it through separately scoped Trello cards and approvals. AIR-343 remains the pre-Film queue; AIR-308 and AIR-79 remain under AIR-275 for cleanup.
