# ADR 0065: Finds reads one Person identity from D1

**Status:** Proposed
**Original decision date:** 2026-10-31
**Recorded at:** 2026-10-31
**Approval source:** Pending the owner's decision. Independent review does not accept this record.
**Related work:** [AIR-16](https://trello.com/c/LtoEguNS), [AIR-275](https://trello.com/c/4x7hH0gI), [ADR 0009](0009-canonical-film-person-identity.md), [ADR 0051](0051-d1-domain-r2-blobs.md), [ADR 0057](0057-tmdb-tv-identity-and-retired-movie-ids.md), [ADR 0059](0059-person-identity-projection.md), [ADR 0062](0062-d1-person-identity-read.md)
**Supersedes:** [ADR 0062](0062-d1-person-identity-read.md) in part. That record left the live page on the stored role id. This record lets the Finds actor and director filter read the identity GET. The route, its bounds and the watchlist grid are unchanged.
**Superseded by:** None

## Context

[ADR 0062](0062-d1-person-identity-read.md) is one GET. It loads a bounded D1 neighborhood and returns the derived Person reference. R2 stays the authority. The watchlist grid matches a stored role id (`actor/<slug>`, `director/<slug>`, `tmdb_actor/<id>`, `tmdb_director/<id>`). Catalog credits on the published generation are TMDB ids. Those two id spaces do not meet, so a selected person used to leave Finds empty.

The published catalog (`GET /api/catalog/available`) remains the eligibility source: generation, watched and rated exclusion, availability and prediction freshness. D1 can lag that generation. Owner `same` and `different` decisions, and role links, are not rows in D1.

## Decision

The Finds actor and director filter is the one page reader of `GET /api/d1/persons/<role>/<key>/identity`.

1. The page keeps the Letterboxd or TMDB role id in the URL, presets and the watchlist grid. The grid does not call this route.
2. With an actor selected, a director selected, or both, the page requests that id's identity GET. `actor/<slug>` requests `/api/d1/persons/actor/<slug>/identity`. The same shape covers `director`, `tmdb_actor` and `tmdb_director`. With neither selected, the page makes no identity request.
3. An answer adds catalog films only when `bounded` is false, `reference.state` is `trusted`, `reference.crossSource` is `verified`, the role surface says the same, and `reference.links` contains `co_credit` whose `roles` include the selected role. `limitations` must include `owner_decisions_not_stored` and `role_links_not_stored`. The page does not treat that answer as an owner decision.
4. `films.actor.catalog` is used for the actor filter and `films.director.catalog` for the director filter. A D1 id `film:tmdb:<n>` matches a catalog film only when that film's id is `tmdb_<n>` and its `canonicalIdentity` is `tmdb:<n>`. Two catalog rows for one typed id match nothing. `film:tmdb_tv:<n>`, a retired or untrusted movie id, a letterboxd id and a bare number match nothing.
5. Actor and director combine with AND, and with every other hard facet. Inside a facet, OR is unchanged. A verified person match ranks before mechanics, moods and genres. The card says «Совпадает» only for a film in the confirmed set, and the text is escaped.
6. Anything else matches no catalog film: unknown, unresolved, ambiguous, conflicting, a bounded neighborhood, a missing co_credit for the role, 404, 503, a network error or a broken body. «Только начатые» and «Пересмотр» still leave no find. The failure stays in Finds. The grid and the other filters keep rendering.
7. The page keeps a few answers in memory, keyed by the programme generation and the request. A generation change drops them. A response for an older generation or an older selection is not shown. The same in-flight URL is not requested twice. There is no bulk person scan and no new external lookup.

The identity route is unchanged. This record authorizes no schema, flag, Access, Task, Cron, or R2/D1 write.

## Alternatives considered

- **Join on the displayed name.** [ADR 0009](0009-canonical-film-person-identity.md) forbids it. Rejected.
- **Match `film:tmdb:<n>` to any catalog row with that number.** A TV id and a retired movie id can share the number. Rejected.
- **Show the previous person's films while the next request runs.** A late response would be a wrong find. Rejected.
- **Move the watchlist grid onto this GET.** The grid's id is already the stored role id. Rejected.

## Consequences

- A verified coCredit can surface a catalog film the watchlist id could not name.
- D1 lag, a bounded neighborhood, or a missing coCredit leaves Finds empty for that person. The page does not guess.
- An owner decision that is not stored in D1 is not applied, and the answer says so.
- Revert removes the page reader. The route, R2 and D1 stay as they are.

## Recovery and migration boundary

Rollback is reverting the page reader. No row, flag, binding or schedule changes with it. This record authorizes no migration and no production write.

## Evidence

- **Implementation:** `public/app.js`, `tests/contextual-finds.mjs`
- **Contract:** [Catalog](../reference/api/catalog.md#filter-context), [D1 catalog views](../reference/api/d1-catalog.md#person-identity), [person identity projection](../reference/domain/person-identity-projection.md)
- **Diagram:** [Film/Person lifecycle](../architecture/film-person-lifecycle.md). The changed Person-reference figure needs the owner's visual approval.
