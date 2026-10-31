# ADR 0062: One opt-in GET reads a Person's derived identity from D1

**Status:** Proposed
**Original decision date:** 2026-10-31
**Recorded at:** 2026-10-31
**Approval source:** Pending an explicit owner decision. The implementation handoff on [AIR-275](https://trello.com/c/4x7hH0gI) authorizes this one read-only route and its documentation. It does not accept this record, approve the changed Mermaid, switch a page, or authorize a write.
**Related work:** [AIR-275](https://trello.com/c/4x7hH0gI), [AIR-201](https://trello.com/c/1uvzKiGg), [AIR-44](https://trello.com/c/ojtZjVc9), [ADR 0051](0051-d1-domain-r2-blobs.md), [ADR 0056](0056-d1-enrichment-write-through.md), [ADR 0058](0058-canonical-person-grouping.md), [ADR 0059](0059-person-identity-projection.md)
**Supersedes:** [ADR 0059](0059-person-identity-projection.md) in part. That record left "loading this function from a Worker route or a D1 query" undecided. This record decides one route. The live site filters stay on the stored role id. The rest of 0059 stands.
**Superseded by:** None

## Context

[ADR 0059](0059-person-identity-projection.md) defines one derived Person reference. The caller loads records and the function returns one human, or an explicit unresolved, ambiguous or conflicting state. It does not query and does not write. [ADR 0058](0058-canonical-person-grouping.md) is the grouping underneath it.

D1 holds the Film and Person projection of R2. R2 stays the authority ([ADR 0051](0051-d1-domain-r2-blobs.md), [ADR 0056](0056-d1-enrichment-write-through.md)). The existing catalog routes list a role record and its credits. They do not answer which role records are one human. Loading every Person on each GET would scan the whole projection for one selector. Owner `same` and `different` decisions, and role links, are not rows in D1.

## Decision

`GET /api/d1/persons/<role>/<key>/identity` is the one Worker route that calls the projection. `<role>` is `actor`, `director`, `tmdb_actor` or `tmdb_director`. The route is GET-only, behind the same Access policy as the rest of `/api/`, and it only `SELECT`s. A missing person is 404. Any other method is 405. A Worker with no `DB` binding is 503.

The route loads a bounded neighborhood and passes it to `projectPersonIdentity` with `decisions: []` and empty `roleLinks`:

1. The requested record and every other record of the same source key.
2. Credits of those records, then the other actor and director credits on those films, so a second person of the same name keeps a coCredit from looking unique.
3. A witness joins the next round only when the projection says that witness is the same human. That round then loads the witness's same-key records and their films.
4. Up to 40 namesakes of the loaded names. A namesake is present so a shared name stays a review. The namesake's other films are not loaded.

Six rounds, at most 400 person ids and 800 film ids. Past either cap, or when the namesake query itself is cut at 40, the route does not return a partial witness list: it projects the same-key records only and sets `bounded: true` with `neighborhood_bounded`. A truncated namesake list that still fits the caps sets `namesakes_truncated` and keeps `bounded: false`.

The body is `{source:"d1", authoritative:false, recordId, reference, films, limitations, bounded}`. `reference` is the resolved human: `state`, `crossSource`, `humanId`, `formerIds`, `memberIds`, `links`, `reviews`, `externalIds`, `reversal`. `films.actor` and `films.director` each carry `state`, `crossSource`, `humanId`, `watchlist` and `catalog`, the film ids `filmsForPerson` returns for that role and surface. An unknown or conflicting selector has empty film lists. A name is not a selector.

`limitations` always includes `owner_decisions_not_stored` and `role_links_not_stored`. The route does not invent an owner decision from a shared name.

The existing `GET /api/d1/persons/<role>/<key>` filmography stays as it is. Programme, watchlist, catalog and discovery routes do not call this projection. D1 does not become the authority.

The pure modules enter the Worker bundle only as the `PersonIdentity` scope in front of `src/catalog-d1.js`. The enrichment projector, the site and the other writers do not load them.

## Alternatives considered

- **Project every Person on each GET.** Correct, and far past the cost of one selector. Rejected.
- **Return the partial neighborhood when the cap is hit.** A missing witness can turn an ambiguous coCredit into a trusted join. Fail closed to the same-key records. Rejected.
- **Add a table of humans or owner decisions in this change.** That is a schema migration and a writer. Rejected.
- **Point the live filters at this route now.** The handoff keeps that cutover for a later approval. Rejected.

## Consequences

- One explicit read answers the derived reference from current D1 rows.
- A human the owner has split in a decision that is not in D1 stays joined here, and the body says so.
- A neighborhood past the cap answers from the same-key records only. That answer can miss a coCredit that lives further out, and `bounded` says so.
- Revert removes the route. No row, flag, binding or schedule changes with it.

## Recovery and migration boundary

Rollback is reverting the route. R2 and D1 are untouched. This record authorizes no migration, no reload, no flag change, no page cutover and no D1 or R2 write.

## Evidence

- **Implementation:** `src/catalog-d1.js`, `scripts/bundle-scope.mjs`, `tests/catalog-d1.mjs`
- **Contract:** [D1 catalog views](../reference/api/d1-catalog.md), [person identity projection](../reference/domain/person-identity-projection.md)
- **Diagram:** [Film/Person lifecycle](../architecture/film-person-lifecycle.md). Visual approval of the changed Mermaid is an owner gate and is not claimed here.
