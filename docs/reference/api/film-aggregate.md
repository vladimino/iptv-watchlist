# FilmAggregateV1 (internal, dormant)

The maintained contract of the unified Film read of [ADR 0216](../../adr/0216-canonical-film-lifecycle-and-unified-read-contract.md) (Accepted), delivery graph step 3 ([AIR-647](https://trello.com/c/WKSwJOwm)). The typed resolver and identity fence it builds on are delivery graph step 2 ([AIR-646](https://trello.com/c/OzZ7uZZj)); see the [Film/Person reference](../domain/film-person.md#unified-film-read-contract-adr-0216-accepted-resolver-and-sections-delivered-dormant).

**Status: dormant.** `src/film-aggregate.js` and `src/film-aggregate-resolver.js` are not in the Worker bundle (`build.mjs` does not name them, nothing in `src` imports them), so no deployed route answers this shape and no consumer is switched. The handler `handleFilmAggregateRequest` exists for the tests and for activation. Activation is [AIR-648](https://trello.com/c/zh0cfDWK), with its own owner GO, after [AIR-667](https://trello.com/c/SbV827kN) has installed the `tmdb_retirement_decision_movie` index in production. Bundling needs the identity digest moved from `node:crypto` to Web Crypto; that belongs to activation.

## Request

| | |
| --- | --- |
| Route (when activated) | `GET` or `HEAD /api/internal/film-aggregate?id=<typed id>` |
| Typed id | `film:<id>`, `tmdb_<n>`, `tmdb_tv:<n>` or a bare lid (ADR 0216 decision 2). Exactly one `id` parameter; anything else is `400 invalid`. |
| Other methods | `405` with `allow: GET, HEAD`; nothing is read |
| Caching | `cache-control: no-store` |
| Side effects | none (ADR 0107): only single plain `SELECT` statements run; the sections' binding refuses any other statement before it reaches D1. No R2, no network. |

## Response

`{contract: "film-aggregate/v1", identity, display, watchlist, availability, personal, predictions, history}` with HTTP `200` for the identity verdicts `found` and `redirected`. Every other verdict (`400 invalid`, `404 absent`, `409 conflict|unverified|cycle`, `410 retired`, `503 unavailable`) returns `contract` and `identity` only, with no section. `503 identity_moved` (the final identity fence moved or could not run) also returns no section.

Every section has a `status` (`present`, `absent`, `unknown`, `unavailable`, `partial`, `conflict`; `limited` only for `history`), its `source`, and its `token`. An unreadable token is `token: null, tokenStatus: "unavailable"` with the section `unavailable`.

| Section | Reads (authorized aliases only) | Token | Negative is stated only when |
| --- | --- | --- | --- |
| `display` | `film`, `film_metadata`, `film_localization_source`, `film_dimension` (localization), `owner_review_entry` of the survivor and every Film redirecting to it (depth 8), `film_person_credit` (60) | metadata `content_sha256`, owner-review digest, localization digest | never: per-field provenance (ADR 0214) is not delivered, so a missing or null metadata field is `unknown` |
| `watchlist` | `watchlist_authority`, `watchlist_current`, the current snapshot's `watchlist_member`, `watchlist_admission_pending`, `watchlist_membership_handoff`; projection `watchlist_membership_authority`, `watchlist_film`, `watchlist_film_fence` | source generation, `version`, `snapshotId`, `listSha256`; projection mode and generation | `source.member: false` only with source `d1`, open writes, a complete snapshot (member rows equal `film_count`), a non-empty lid set and no unsettled listed lid (an admission row not `resolved`/`superseded`, or a handoff row not `settled`, of any due time) |
| `availability` | `published_epg_show` of the pinned `programme_run_id` for the storage ids (50 rows) | `programmeRunId`, `generation`, show-rows digest | the empty `current` list is proved by the pinned generation; no authorized storage id is `unknown` |
| `personal` | `ratings_view` of the storage ids, with the ratings coverage below | ratings generation, view-rows digest, coverage token | `watched: false` or a known null rating (`absent`) only over every authorized alias with complete coverage |
| `predictions` | `prediction_pointer` of the storage ids (current only; the R2 body is named by `body.r2Key` and `body.contentSha256`, immutable, not read inline) | prediction generation, pointer-rows digest, coverage token | `absent` (`reason: none`) only with no pointer under any authorized key and complete coverage |
| `history` | nothing | none | never `present` in v1 |

**Storage ids** are each authorized lid and `tmdb_<n>` of the trusted, non-retired movie claim. A TV number is never a storage key. More than 8 authorized aliases of one scheme makes the affected sections `partial` with `reason: budget_exceeded`.

**Several aliases (C2).** Values are grouped by ratings fact key, so one fact reachable through two aliases is one value with every `storageId`. Two different current values (two ratings, two predictions) are `conflict` with each value and its `storageId`; no value is chosen and no key is renamed.

**History (decision 6a).** `limited` with `href` to the legacy `GET /api/enrichment/history?filmId=` only when the survivor has exactly one authorized lid, coverage is `complete`, the request is that lid or the survivor's `tmdb_<n>` and is not a redirect. Otherwise `unavailable`, `reason: history_migration_pending`, no `href`.

## Candidate coverage (decision 6b, G1)

`personal` and `predictions` carry `coverage: {status, reason?, token, candidates, notes?}`. Discovery reads the D1-owned ratings documents only at ratings `d1`/`open`:

1. Seeds are the authorized aliases in link-index form (`letterboxd:<lid>`, `tmdb:<n>`).
2. `letterboxd/facts/links.json` is checked by part count and byte size **before** it is read (40 parts, 2.4 MB), then read once and verified (one etag, SHA-256 of the text).
3. A seed missing from the index is an absence predicate.
4. The fact record of each reached key is read once (4 records per request, one redirect or migration hop; both sides count); the index is walked once (50 000 entries) for every other alias of the reached keys.
5. A candidate is settled only by another Film's single trusted, non-conflicting claim of that value, the Film present and not a redirect source, and for a movie id no non-superseded retirement. The survivor's own retired movie claim is not settlement.

`complete` needs all of: a non-empty seed set, every seed present, the document within its bounds, the traversal finished and every candidate settled. Otherwise `incomplete` with `ratings_evidence_unavailable`, `discovery_cap`, `seed_absent_unproved` or `unresolved_candidate`; `notes` names unresolved candidates. A candidate's value is never returned. Incomplete coverage makes the section `partial` (never `absent` or a single current value) unless authorized values already conflict, which stays `conflict`.

## Consistency and budget

- **Identity fence.** The resolver's final capture re-reads the identity read-set after every section; a change returns `503 identity_moved` with no section.
- **Per-section fence (E1).** Each section reads its data and tokens in one statement and re-reads that statement after all section reads. A difference makes that section `unavailable`, `reason: generation_moved`. The ratings after-read covers the marker, the etag of every document read, the `ratings_view` rows and the candidate settlement, and moves both `personal` and `predictions`. Availability fences the show rows too, because Discovery can change a run's rows without moving the generation.
- **Statements.** At most 40 D1 statements per request, counted on the binding. The identity fence is reserved first; each section reserves its after-statement before its first read; the ratings coverage reads run first. A section that cannot get its statements is `unavailable`, `budget_exceeded`. A typical request uses about 20.
- **Index use.** Every statement is served by a primary key or an existing index, checked by `EXPLAIN QUERY PLAN` in `tests/film-aggregate.mjs`. The one exception is the owner-ancestor step of `display`, which scans `film_redirect` (no index on `to_film_id`), the same read the accepted AIR-372 read model makes. The retirement reads use `tmdb_retirement_decision_movie` (AIR-667).

## Tests

`tests/film-aggregate.mjs` (core suite): ADR 0216 synthetic tests 1-4, 9-25 (15b included), the GET read audit of the dormant handler (test 17), the dormant-bundle checks and the plans. `tests/film-aggregate-resolver.mjs` covers tests 5-8 and 15a of the resolver.
