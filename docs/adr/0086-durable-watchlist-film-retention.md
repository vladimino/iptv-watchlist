# ADR 0086: A watchlist fact keeps the Film after the current lists drop it

**Status:** Accepted
**Original decision date:** 2026-11-04
**Recorded at:** 2026-11-04
**Approval source:** [owner acceptance of ADR 0086 and visual approval of its Mermaid, 2026-11-04](https://trello.com/c/SBvIwv6P#comment-6aeafa5843c0dab3d80ec717); independent technical PASS on [PR #359](https://github.com/vladimino/iptv-watchlist/pull/359#pullrequestreview-5766152449) at reviewed HEAD `edaabb5dc29c3cb30c2c5545cb6d724c9ff3588c`. Architecture and visual decision only; no production write or merge GO.
**Related work:** [AIR-191](https://trello.com/c/SBvIwv6P); historical class C audit [AIR-180](https://trello.com/c/NrsSc6gk); next Film/Person cutover [AIR-321](https://trello.com/c/KHJM2gnK). [AIR-77](https://trello.com/c/f3QzcNYf) was declined and is not a gate
**Supersedes:** None
**Superseded by:** None

## Context

Removing a film from the Letterboxd watchlist, marking it watched, recording a rating, or losing its shows does not mean the Film never existed. Membership, watched and rated state, and availability are independent. The lifecycle reader still builds the Film view from the current programme list or, when that list is absent, the current watchlist, and then from discovered films. A metadata cache row, a Letterboxd fact, a fingerprint or a prediction left behind does not by itself form a Film. The enrichment projector treats a Film missing from that view as absent. `releaseFilm` deletes only the watchlist membership row. That is missing durable admission and an incomplete reader, not a proven deletion of R2 or D1 bytes.

`GET /api/catalog/available` already hides a watched or rated film. That exclusion is display eligibility. It is not a reason to delete a Film. A departed film must not return as a first-watch offer and must not return to the ordinary watchlist grid. Re-adding it must use the same Film.

R2 remains the authority for the canonical Film and Person, for Letterboxd facts and ratings, and for immutable fingerprint and prediction bodies. D1 already owns the published programme and watchlist membership, the metadata cache, mutable prediction state and owner reviews, each under its own marker. This decision does not move Film authority to D1 and does not open a second Film store beside the cutover tracked as AIR-321.

The 27 October 2026 class C audit found 36 records on 15 Letterboxd ids that had left the watchlist, of which 30 records on 12 ids had no Film ([dated audit](../evidence/d1-migration/air-180-class-c-audit-2026-10-27.md)). That report is a snapshot, not a live inventory. A record in it is not proof that an R2 object was deleted.

## Decision

1. **Admission is one boolean already on the view index.** `enrichment/view-index.json` carries `watchlist: true` or `watchlist: false` when a Letterboxd fact record has a watchlist observation. `false` is a timestamped removal. It is not a watched mark and it does not put the film back on the watchlist. The projector reads that object, keeps only a Letterboxd lid (`/^[A-Za-z0-9_-]{1,80}$/`, and not a `tmdb_` key) whose `watchlist` field is a boolean, and passes that map to the reader. A missing or unreadable view index admits nobody. The rest of the index, including mood facets, stays out of the Film store.
2. **The same Film stays in the view.** The reader adds each admitted lid that the current programme-or-watchlist loop does not already contain, before TMDB retirements run. Metadata for that lid is the body only when the cache row's own id is absent or equals the lid. A cache row whose id names another film is not that body, and it does not drop the lid. A lid with no usable metadata row is still a Film, identity unresolved, and keeps the Letterboxd id. Watched, rating, a diary title, a fingerprint, a slug and a title/year do not admit. A `tmdb_<n>` alias does not mint a second Film.
3. **Membership is the current list.** `listedOnWatchlist` stays true only when the current watchlist document names the lid. `watchlist: false`, and a boolean that is true while the document does not list the lid, leave membership false. The watchlist grid keeps reading the watchlist document. Re-adding the lid produces one Film and membership becomes true again. Ratings, fingerprints, prediction history, a reviewed title and credits already linked by that id stay.
4. **The projector does not drop an admitted Film, and a missing body does not wipe a stored one.** A Film the view still contains is not marked absent and is not released. `releaseFilm` still deletes only `watchlist_film`, and still skips a redirected id. A Film that no source lists and that no watchlist fact admits is still marked absent, and only its membership is removed. When an admitted lid is on neither current list and has no usable metadata, and the Film row already exists, the projector writes watchlist membership only. Credits, `film_metadata`, trusted external ids, identity and metadata dimensions, and sync clocks stay as stored. A Film row that does not exist yet is still inserted. A repeated run over the same thin view writes nothing further.
5. **Finds exclude either boolean, through the same identity bridge as watched and rated.** A catalog row is excluded when its own view-index entry has `watchlist: true` or `watchlist: false`, or when a Letterboxd lid with either boolean bridges to that row's TMDB id. The bridge is one stored id from the metadata cache, the watchlist, the programme or a verified catalog record, and only while every stored id agrees. Two stored ids, or none, leave the lid unbridged. Titles are never compared. A missing `watchlist` field leaves the existing watched, rated and watchlist-document rules unchanged. The exclusion writes nothing.
6. **Historical rows are classified and not imported.** `reconcileDepartedFilms` is a pure function. It writes nothing and mints nothing. An existing Film is joined by its Letterboxd lid, or by exactly one trusted movie TMDB id, and that id is kept. Two trusted owners of one movie id, a lid whose trusted movie id disagrees with the Film that already holds the lid, a `tmdb_tv` id together with a movie id, and two lids that share a slug are `conflict`. Two lids that share one unverified movie id are `ambiguous`. A lid with a watchlist boolean and no Film is `resolved` as a watchlist fact, which the reader already keeps. A lid or trusted movie id with neither a Film nor that boolean, and any row that has only a title, a year, a slug, a diary title or a metadata cache, stay `unresolved`. A conflict stops for owner review. Nothing is retired silently.

What this decision does **not** do: it does not add a flag, a schema migration, a repair tool, or a second Film authority. It does not import the historical class C rows. It does not change the scoring model, transfer a rating across a weak match, or take the ratings or discovery cutovers.

## Alternatives considered

Minting a Film from `metadata.json` alone was rejected. The class C audit already recorded that a metadata row is not an identity, and a title, year or slug is weaker still. A new R2 ledger of departed films was rejected because the view index already stores the watchlist boolean. Treating `watchlist: false` as `watched: true` was rejected because removal and watching are different facts. Deleting the D1 Film row on release was rejected because membership is not the entity.

## Consequences

The Film view grows by every Letterboxd lid that already has a watchlist boolean, including lids the current programme and watchlist no longer list. Fingerprints, predictions and ratings stay attached by that id. Finds and the watchlist grid do not show the departed film. Shadow parity compares the metadata title when the film is on neither list, because that is the title the view shows.

`D1_ENRICHMENT_WRITE` is already `on`. Deploying this code makes the existing enrichment cron apply the wider view: a Film the view newly contains, and whose change key differs, is upserted under the existing lease, batch and query budget. A Film the view no longer contains is still marked absent, up to the existing absent guard. One run stays inside the existing query budget; a larger set continues on later runs. Accepting this ADR does not authorize that cron. Merge to `main` deploys the Worker, so the deploy waits for a separate explicit owner approval of those expanded writes. No new flag is added. The write is not a separate import, and it does not repair a row that has no watchlist boolean.

A person who appears only on a departed Film can be marked absent in `projection_state`. The Person row and `film_person_credit` stay. That mark is not a deletion of the Film.

The offline projection seed is unchanged. It still keys the view without this admission. Re-running it against a database that already holds admitted Films stops on a state conflict. That stop is intentional.

## Recovery and migration boundary

Accepting this record authorizes no production write. The expanded projector writes wait for a separate explicit owner approval, given before the deploy. Until that approval, this change stays off `main`. A historical repair, a D1 Film-authority change, a projection re-seed, a snapshot import, a ratings or discovery cutover, a flag change and a Scheduled Task change each remain their own approval as well.

Code rollback stops later runs from admitting further Films. It does not delete a Film row, a credit, a fingerprint, a prediction or an R2 object already written. `releaseFilm` still cannot delete those. Restoring a previous view that drops an admitted Film marks that Film absent and removes membership only.

## Evidence

- **Original decision:** Accepted on 2026-11-04 ([owner decision](https://trello.com/c/SBvIwv6P#comment-6aeafa5843c0dab3d80ec717)). The card is [AIR-191](https://trello.com/c/SBvIwv6P). No production D1 write or merge authorization.
- **Implementation:** the reader, the projector's optional view-index read, the membership-only write when the cache is missing, the Finds lid bridge, `tests/film-retention.mjs` and the departed-film section of `tests/d1-enrichment.mjs`
- **Dated verification:** [synthetic reconciliation, 4 November 2026](../evidence/d1-migration/film-retention-reconciliation-2026-11-04.md). No production bucket was read
- **Uncertainty:** how many production view-index lids already carry a watchlist boolean is not measured here. The October audit is not that count

## Follow-ups

AIR-321 remains the Film and Person authority cutover. A repair that joins historical rows with no watchlist boolean needs its own card and its own approval. The offline classifier's `conflict` rows are the input to that review, not a write.
