# ADR 0059: Watchlist and catalog person filters share one derived reference

**Status:** Accepted  
**Original decision date:** 2026-10-31  
**Recorded at:** 2026-10-31  
**Approval source:** [explicit owner acceptance of ADR 0059 and visual approval of the amended Mermaid on 2026-10-31](https://trello.com/c/1uvzKiGg#comment-6ae589359fddf40d03a6a966), following [positive independent review of PR #265 HEAD 6b0a03f](https://github.com/vladimino/iptv-watchlist/pull/265#pullrequestreview-5721603785). This accepts the code-only derived read-model architecture, not production data writes, D1 read/authority cutover, feature flags, Scheduled Tasks or external calls.  
**Related work:** [AIR-201](https://trello.com/c/1uvzKiGg), [AIR-44](https://trello.com/c/ojtZjVc9), [AIR-16](https://trello.com/c/LtoEguNS)  
**Supersedes:** None  
**Superseded by:** [ADR 0062](0062-d1-person-identity-read.md) in part: one opt-in GET loads this projection from current D1 rows. The live site filters stay on the stored role id. Everything else here stands.

## Context

[ADR 0009](0009-canonical-film-person-identity.md) keeps Person ids role- and source-specific and forbids joining them on a name. [ADR 0058](0058-canonical-person-grouping.md) defines the pure grouping that does join them, and only on a source key, a verified coCredit or an owner decision. That grouping is not a consumer filter. Watchlist credits and catalog credits still name different records for one human, and a second mapping table in R2 would be another copy to undo.

[ADR 0051](0051-d1-domain-r2-blobs.md) keeps R2 authoritative until a domain is explicitly flipped. Film and Person rows in D1 are a projection, not that flip. A filter that queried D1 on the live site would cross that boundary.

## Decision

Watchlist and catalog person filters call one function, `filmsForPerson` in `src/domain/person-identity-projection.js` ([reference](../reference/domain/person-identity-projection.md)). It reads the grouping of records the caller already loaded and returns one human id, the member records, and a state:

- `trusted` — the members are one human by a source key, a verified coCredit or an owner `same`;
- `unresolved` — one record, with no candidate;
- `ambiguous` — a shared name, namesakes, or coCredit that is not unique;
- `conflicting` — the owner refused the join, or the join would put two keys of one source in one human.

A review is not a member. Actor and director filters use the credits of the members in that role only. The same selector yields the same human id on both surfaces when it resolves a human. A name is not a selector. Two keys that name different humans yield no films.

`crossSource: verified` means the members include both a Letterboxd record and a TMDB record. An owner `same` of two keys of one source does not.

A film id supplied more than once is coCredit evidence only when the copies agree on surface, verification and trusted identity. A contradictory copy stays a credit of each record and does not join sources.

The reversal of a join is a list of owner `different` decisions of exactly two record ids, one from each joined source group. Projecting again with those decisions separates the groups. A source key is not split.

The human id and the external ids (`letterboxd_person`, `tmdb_person`) come from the grouping. Provenance is the link basis and the record ids. Nothing is written. Projecting again with an owner `different` splits a coCredit or owner join; a source key is not split. `formerIds` still resolve.

**Not decided here:**

- loading this function from a Worker route, the site filters, or a D1 query;
- storing humans, former ids or owner decisions;
- any schema change, flag, or credit fetch.

The live programme, watchlist and catalog routes keep matching the role-specific id on the stored credit. Connecting them is a later owner approval, after Film and Person data for that read is known to be current.

## Alternatives considered

- **Filter on the client by comparing names or record ids.** A name match is the join ADR 0009 rejects. Comparing record ids cannot see a verified coCredit that lives on the other source. Rejected.
- **Store a Person-to-human map in R2.** A wrong join would then need a data restore. A derived reference is undone by projecting again. Rejected.
- **Make the D1 review queues the filter.** They list pairs, fold names with ASCII `lower()` only, and do not apply an owner decision. They stay a review view. Rejected.

## Consequences

- One explanation for a filter result: the state, the members, the links and the reviews.
- A trusted human can still carry a review about someone who was not joined. The films come from the members only.
- The live site does not change until a later card calls this function from a route. Shipping the module authorizes no read of production D1 and no write.

## Recovery and migration boundary

Rollback is reverting the change. There is no stored human, no flag, no binding and no schedule to restore. An owner `different` is the undo for a join, and it takes effect on the next projection. This ADR does not authorize a Worker read, a D1 or R2 write, a migration, or a cutover. R2 remains authoritative.

## Evidence

- **Original decision:** [AIR-201](https://trello.com/c/1uvzKiGg)
- **Implementation:** `src/domain/person-identity-projection.js`, `tests/person-identity-projection.mjs`
- **Dated verification:** not recorded. The tests are synthetic. No production read was made for this decision.
- **Uncertainty:** this consumer projection is verified by synthetic tests only, not by a production route/read. The grouping's production counts remain those of [ADR 0058](0058-canonical-person-grouping.md).

## Follow-ups

- The owner accepted this ADR and visually approved the [changed Film/Person lifecycle Mermaid](../architecture/film-person-lifecycle.md) on 2026-10-31 ([decision](https://trello.com/c/1uvzKiGg#comment-6ae589359fddf40d03a6a966)); no route cutover was approved.
- A later card may call the projection from a read path once Film and Person freshness and the read boundary are approved. Storing humans or decisions is a separate card.
