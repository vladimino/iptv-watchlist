# Film retention: synthetic reconciliation

**Captured:** 2026-11-04, local `node tests/film-retention.mjs` on synthetic fixtures. No production R2, D1, Worker, flag or Scheduled Task
**Input:** in-memory stores. Letterboxd lids, one reviewed title, one fingerprint, one prediction history entry, one director credit, and a view-index map reduced to watchlist booleans. No private snapshot id is copied
**Method:** `readLifecycle` with the admission map; `d1EnrichmentPlan` against a stored change key; `catalogAvailable` on four catalog rows; `reconcileDepartedFilms` on labeled orphans. The function returns a class and writes nothing
**Scope:** contract test only. Not a live inventory and not a count of production Films
**Verdict:** **SYNTHETIC CONTRACT HOLDS.** A lid with a watchlist boolean stays one Film after the programme and the watchlist drop it, after a watched departure and after a plain removal. Re-adding that lid keeps one Film. Finds return only the row with no watchlist boolean and no watched mark. Orphans without an admitted lid are classified and not written
**Used by:** [AIR-191](https://trello.com/c/SBvIwv6P), [ADR 0084](../../adr/0084-durable-watchlist-film-retention.md) (Proposed)

## What the fixtures show

| Case | Result |
| --- | --- |
| Programme films empty, watchlist films empty, admissions `gone: false` and `kept: true`, metadata and a reviewed title on `gone` | Both Films remain. Membership of `gone` is false. The reviewed title, the prediction history entry and the director credit remain. A second read returns the same ids. Shadow parity matches |
| Same lid removed with a prediction, and again with the prediction and fingerprint deleted | The Film remains either way |
| The lid is placed back on the watchlist and the boolean becomes true | One Film, membership true |
| The programme already contains the lid and the boolean is set | One Film |
| Metadata and a fingerprint for a lid with no watchlist boolean | No Film |
| Two lids, one unverified TMDB id | Two Films. The offline classifier calls that pair `ambiguous` |
| Two lids, one Letterboxd slug | One alias collision on the view. The classifier calls that pair `conflict` |
| View index mixing a mood facet, a `tmdb_` key, a title key and a watched-only diary entry | The admission map keeps only the two Letterboxd lids whose `watchlist` is boolean |
| Stored key for the admitted Film, then the same view again | The plan writes nothing and does not mark the Film absent. The same stored row with an empty view is absent |
| Catalog rows: watchlist false, watched true, listed on the watchlist document, and one untouched row | Finds return only the untouched row |

## Offline classes

The classifier was run on a fixed set of labeled rows, not on a snapshot.

| Input | Outcome | Reason |
| --- | --- | --- |
| Lid already held by one Film | `resolved` | `existing_film`, same id |
| Trusted movie id held by exactly one Film | `resolved` | `existing_film`, that id |
| Lid with a watchlist boolean and no Film | `resolved` | `watchlist_fact`. The reader already keeps it. This row is not a repair write |
| Lid, or a trusted movie id, with no Film and no boolean | `unresolved` | `no_film` |
| Title and year, slug only, diary title, metadata cache without an id | `unresolved` | `no_identity` |
| `tmdb_tv` together with a movie id | `conflict` | `tmdb_tv` |
| Two lids, one slug | `conflict` | `slug_collision` |
| Lid whose trusted movie id disagrees with the Film that holds the lid | `conflict` | `trusted_tmdb`, and the existing id is named |
| Two existing Films trusted for one movie id | `conflict` | `trusted_tmdb` |
| Two lids, one unverified movie id | `ambiguous` | `unverified_tmdb` |

## Historical audit, not this measurement

The [27 October 2026 class C audit](air-180-class-c-audit-2026-10-27.md) reported 36 records on 15 Letterboxd ids that had left the watchlist. Thirty of those records, on 12 ids, had no Film, and five of the thirty were actual ratings. That audit is a snapshot of one export. It is not the set of lids the projector will upsert, and this file does not repeat its private ids. Rows from that audit that have no watchlist boolean stay `unresolved` under the classifier and are not imported here.

## Limits

- No production object was listed or read. The number of view-index lids that already carry a watchlist boolean is unknown.
- Accepting the ADR lets the already-enabled enrichment projector upsert admitted Films on its next run. This run did not start that projector and did not write D1 or R2.
- A code rollback does not remove rows a later projector run has written.
