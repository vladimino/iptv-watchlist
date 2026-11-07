# ADR 0099: Canonical Film/Person becomes D1-authoritative through a marker, a fenced writer and staged producer migration

**Status:** Proposed  
**Original decision date:** unknown (proposal drafted 2026-11-07, not yet decided)  
**Recorded at:** 2026-11-07  
**Approval source:** not documented. The owner authorized only architectural planning and decomposition on the [AIR-321 card](https://trello.com/c/KHJM2gnK) (comment of 2026-11-07); this draft is not accepted and authorizes no code, schema, import, flag or production operation.  
**Related work:** [AIR-321](https://trello.com/c/KHJM2gnK), [AIR-275](https://trello.com/c/4x7hH0gI), [AIR-343](https://trello.com/c/hCy6fLne), [ADR 0009](0009-canonical-film-person-identity.md), [ADR 0056](0056-d1-enrichment-write-through.md), [ADR 0058](0058-canonical-person-grouping.md), [ADR 0073](0073-d1-authoritative-metadata-cache.md), [ADR 0079](0079-d1-authoritative-published-epg.md), [ADR 0081](0081-d1-authoritative-owner-reviews.md), [ADR 0085](0085-d1-authoritative-discovery-ledger.md), [ADR 0086](0086-watchlist-fact-keeps-the-film.md), [ADR 0087](0087-rated-archive-admission.md), [audit and decomposition](../evidence/d1-migration/air-321-canonical-film-person-audit-2026-11-07.md)  
**Supersedes:** None (it would amend, not rewrite, the single-writer boundary of ADR 0056 once Accepted)  
**Superseded by:** None

## Context

D1 holds `film`, `person`, credits, aliases, external ids and redirects, but only as a projection: the D1 enrichment projector is the sole writer, it derives rows from R2 documents and D1-resident inputs, and no request route reads those tables for rendering (they feed `GET /api/d1/*`, which is `authoritative:false`). Six neighbouring domains are already D1-authoritative under their own markers; none holds a foreign key to `film` or `person`. No marker exists for canonical Film/Person. The audit in the linked evidence record is the factual base; a row in D1 or a successful `GET /api/d1/*` does not prove a cutover.

## Decision (proposed; every point needs the owner's decision)

1. **One authority, one marker.** Canonical identity, aliases, trusted external ids, redirects, localization and credits of Film and Person are owned by D1 under a new single-row marker (`mode r2|d1`, `cutover open|held`, `generation`) with a companion CAS fence row, following the pattern of `discovery_authority` and `ratings_domain_authority`. A missing or malformed marker fails closed; `held` blocks writers and keeps readers on the source they used before.
2. **Per-entity fenced mutations replace the delete-and-reinsert projection.** Writers go through repository mutations with a per-entity concurrency key and the marker generation in the same batch; credits are keyed upserts on `(film, person, role)` and never renumber, so D1-only TMDB credits survive. A Film is never created or merged by name, title and year, short code, actor name or a coinciding numeric id; `tmdb` and `tmdb_tv` stay distinct schemes; one trusted owner per `(scheme, value)` stays enforced.
3. **Neighbours keep their authority.** Published programme and watchlist membership (ADR 0079), owner reviews (ADR 0081), Discovery admission (ADR 0085), ratings facts and the metadata cache keep their own markers. They reference canonical Film/Person by a proven identity only. Owner precedence (owner, then reviewed dictionary, then automatic) is preserved and moves into the canonical read model rather than staying a post-hoc overlay.
4. **Producer inputs still in R2 get a D1 owner**, one at a time: automatic localization (`titles.json`, `people.json`), the verified rated-only admission document (the R2 object stays an immutable receipt), the watchlist retention flag and the TMDB retirement decision. A pending Letterboxd candidate is not a Film and its queue belongs to AIR-343, not here.
5. **Readers switch behind the marker, fail closed.** The canonical read model reads by id sets in bulk (no per-entity reads on a render path) and has no silent R2 fallback while the marker is `d1`. Person grouping stays a derived read model; no persisted human, owner decision or role link is introduced (ADR 0058/0059/0062 stand).
6. **Order.** Marker and fenced mutation API with the projector still the only writer (mode `r2`); producer inputs; readers; then a bounded fenced baseline plus delta with a parity and conflict ledger and activation. The projector and `D1_ENRICHMENT_WRITE` are retired by AIR-308 under AIR-275, not by this decision.
7. **Not decided here:** the marker's exact columns and the per-entity concurrency key; where automatic localization lives; whether R2 compatibility mirrors are kept current while the marker is `d1`; the TMDB retirement record; any production operation. The generation-pinned programme documents keep their embedded render fields.

## Alternatives considered

- **Flip the marker only, projector unchanged:** two owners of the same fields and R2 sources that still win; rejected in the audit.
- **Direct writers in every producer at once, projector removed:** the cleanest end state with the largest blast radius (EPG commit, `metadataSync`, Discovery, rated admission change together); kept as the second stage, not the first.
- **Derived-only (no authority change):** leaves the canonical tables a mirror and every reader on R2 documents; does not meet the AIR-321 goal.

## Consequences

- A real owner for canonical identity, with a rollback marker and a parity ledger before activation.
- New complexity: a per-entity concurrency key, a mutation API replacing a derivation, an input migration across three producers, and a read model that includes the owner overlay.
- Risk: a projector and a direct writer running together; mitigated by the single marker generation in every batch and by running the projector as a compare-only shadow before activation.
- Code rollback does not revert D1, markers or external writers.

## Recovery and migration boundary

Reversible by setting the marker back to `r2` before any producer stops writing R2; after producers switch, a documented reverse load is required (to be defined with the owner's mirror decision). Schema apply, import, activation and rollback are separate owner-approved production operations. This ADR authorizes none of them.

## Evidence

- **Original decision:** not recorded (proposal only).
- **Implementation:** none.
- **Dated verification:** [code-backed audit, 2026-11-07](../evidence/d1-migration/air-321-canonical-film-person-audit-2026-11-07.md); no production read.
- **Uncertainty:** production row counts, parity and class-C exceptions are unknown; the writer of the TMDB retirements object was not found in `src`.

## Follow-ups

The decomposition (C1 to C6) in the evidence record, pending the owner's approval; AIR-343 for the pre-Film queue; AIR-308 and AIR-79 for cleanup.
