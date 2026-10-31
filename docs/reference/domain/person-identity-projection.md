# Person identity projection

**Role:** consumer reference for one human across the watchlist and the catalog. Decision: [ADR 0059](../../adr/0059-person-identity-projection.md) (Proposed). Implemented by `src/domain/person-identity-projection.js`, over the grouping in [the canonical Person contract](canonical-person.md). Verified against the source on **2026-10-31**.

The projection is a read model. It does not query, write, or load inside the Worker. Programme, watchlist and catalog routes still match the role-specific id on the stored credit. Calling this module from a route is a separate approval.

## Call

`projectPersonIdentity({persons, credits, films, decisions})` takes the same input as `canonicalPersons`. A film may also carry `surface: 'watchlist'` or `'catalog'`. The same film id with two different surfaces is an issue `conflicting_surface`, and that credit matches neither surface.

`resolvePersonReference(projection, selector)` and `filmsForPerson(projection, {selector, role, surface})` are the filter. `personSurfaces(projection, selector, role)` is both surfaces of one selector. `role` is `actor` or `director`.

A selector is one of:

| Key | Matches |
| --- | --- |
| `humanId` | The human id, or a `formerIds` entry |
| `recordId` | A role record, such as `person:actor/<slug>` or `person:tmdb_actor/<id>` |
| `scheme` + `value` | `letterboxd_person` or `tmdb_person` |

A name is not a selector. A selector that names nothing is `unknown` and matches no films. Two keys that name different humans are `conflicting` and match no films.

## Reference

Each human is one reference:

| Field | Meaning |
| --- | --- |
| `humanId`, `formerIds` | The grouping's id, and the ids the other keys would have had alone. A former id still resolves |
| `state` | `trusted`, `unresolved`, `ambiguous` or `conflicting` |
| `crossSource` | `verified` when a coCredit or owner `same` joined two sources; `refused` when a join was refused; `ambiguous` when coCredit was not unique; `none` otherwise |
| `memberIds`, `roles` | The records that are this human, and their roles. A review is not a member |
| `externalIds` | `letterboxd_person` and `tmdb_person`, each with `trusted`, `conflicting` and `provenance.source: person_record_id` |
| `links` | Why the members are one human: `same_key`, `owner` or `co_credit` |
| `reviews` | Candidates that mention this human and did not join it |
| `credits` | `{filmId, role, surface}` of the members |
| `preferred`, `aliases`, `nameConflicts` | The grouping's names, unchanged |
| `reversal` | `destructive: false`, `stored: false`, and `splits`: an owner `different` on the person ids of each `co_credit` or `owner` link. A source key has no split |

`state` is `trusted` when the human has a link. It is `conflicting` when, with no link, a review is `conflicting_keys` or `owner_different`. It is `ambiguous` when, with no link, a review is `ambiguous_co_credit`, `name_only` or `same_name`. Otherwise it is `unresolved`.

A trusted human may still list a review. The other human in that review is not a member, and a filter does not return that human's films.

## Filter

`filmsForPerson` returns the member credits of the requested role. With `surface`, only that surface. The watchlist result and the catalog result of one selector share `humanId`, `state` and `crossSource`.

These do not add the other source:

- the same name on a remake and its original, with no shared verified Film;
- two records of one source and one name on one Film and role;
- one record with coCredit evidence toward two records;
- an owner `different`;
- a Film with two trusted ids, which is not a verified Film;
- a TMDB TV id that is not carried by a credit of both records under the same role and accepted name.

A verified Film may be a TMDB movie or a TMDB TV entry. The TV id is the Film's identity, not a person id.

## Rollback

The module stores nothing. Revert restores the previous behavior. There is no flag, binding, row or schedule to undo. An owner `different` undoes a coCredit or owner join on the next projection; the records stay as they are.
