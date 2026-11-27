# D1 operator API disposition: endpoint and consumer matrix

**Captured:** 27 Nov 2026, offline. Source: `main` `81a57b9b0c37d5f861b296789161a3f376855d0f` (repository files and an offline harness only). No production read, no production write, no live request.
**Trello:** [AIR-658](https://trello.com/c/HoCuCbeL), owner direction and Controller handoff in the [card comment of 27 Nov 2026](https://trello.com/c/HoCuCbeL#comment-6b093ea38b3462537322973a). **Decision record:** [ADR 0223](../../adr/0223-retire-unused-d1-catalog-http-views.md), Accepted on 27 Nov 2026 after this report (dated historical evidence; the runtime was unchanged at the pinned SHA).
**Verdict:** the matrix below is the basis of the proposed disposition. It is a proposal, not a shipped runtime. Nothing here changes a route.

## Scope and method

`GET /api/d1/*` is served by `catalogD1Route` in `src/catalog-d1.js`, mounted by `routeRequest` in `src/worker.js`. This report lists every route of that module, every consumer found in the repository, and the observable behaviors that the disposition depends on.

- **Observed:** read from source at the pinned SHA, or reproduced with `tests/catalog-d1.mjs`'s own D1 stand-in (the real migrations `0001`–`0003` in the sqlite3 CLI, the route module loaded as the Worker bundle loads it). The probe script is not committed; it differs from the test only in the requests it sends.
- **Inferred:** stated as such. A repository search cannot prove that no person or tool outside the repository calls a route. That absence is therefore **not established**; the owner's direction on retirement is recorded and no further consumer is assumed.

## Endpoint and consumer matrix

| Route | Consumers found in the repository | Observed behavior and limits | Proposed disposition |
| --- | --- | --- | --- |
| `GET /api/d1/persons/<role>/<key>/identity` | Finds actor/director filter (`public/app.js`, the code that builds the identity path for the selected person); `tests/contextual-finds.mjs` | Bounded neighborhood read; malformed path answers 404 (the decode is guarded) | **Retain**, unchanged |
| `GET /api/d1/status` | Runbooks that read `projector.lastRun.summary` and `schemaVersion` (`tmdb-tv-identity-correction`, `d1-backfill`, `monitoring`); `tests/d1-status-context.mjs` | `ratings` is `count(*)` of `actual_rating` and `predictions` is `count(*)` of `prediction_current`, neither of which is the authority for those domains; the projector block describes a retired producer | **Retain and narrow** ([AIR-690](https://trello.com/c/RxGq4S9r)) |
| `GET /api/d1/persons/review` | No HTTP caller. `scripts/tmdb-watchlist-credits.mjs` loads `src/catalog-d1.js` into a `vm` context and calls the function `d1PersonReview` | The HTTP surface and the function are separate; the script depends on the function | **Retire the HTTP route; retain the function and its script consumer** |
| `GET /api/d1/persons` | None (docs, tests, GET-audit baseline) | Keyset list over `person` | **Retire** (typed 410) |
| `GET /api/d1/persons/<role>/<key>` | None | Filmography takes `predicted` from `prediction_current` and `rating` from `actual_rating`; the path decode is not guarded | **Retire** (typed 410) |
| `GET /api/d1/films/<id>` | None | See the probe below | **Retire** (typed 410) |

Other repository mentions of these routes are documentation, the GET-audit baseline entry (`tests/get-write-baseline.mjs`, one prefix registered with six samples), the reader registry entry (`src/canonical-catalog-reader.js`) and tests of the route module. None of them is a runtime caller.

## Offline probe of the contested behaviors (observed)

Fixture: three Films, one redirect `film:old` → `film:tmdb:1`, one `prediction_current` row and one `actual_rating` row for `film:tmdb:1`, none for `film:tmdb:3`.

| Request | Result |
| --- | --- |
| `GET films/tmdb:1` | 200 with `prediction` `{predicted:4.5,…}` and `rating` `{rating:4,…}` read from the legacy tables |
| `GET films/tmdb_1` (the `tmdb_<n>` storage key) | **404** `Film not found`, although the Film exists |
| `GET films/old` (retired id) | 200 `{"redirect":"film:tmdb:1"}`; the route reports the target and does not follow it |
| `GET films/tmdb:3` (no legacy rows) | 200 with `prediction: null` and `rating: null`, which says only that the legacy table has no row, not that the Film is unrated |
| `GET films/%E0%A4%A` (malformed percent escape) | the handler **throws `URIError`** (`decodeURIComponent` unguarded) |
| `GET persons/actor/%E0%A4%A` | the handler throws `URIError` |
| `GET persons/actor/%E0%A4%A/identity` | 404 `Person not found` (guarded) |
| `HEAD` and `POST films/tmdb:1` | 405 `Method not allowed`; `HEAD` is not served today |

An unhandled throw reaches the final `catch` of `routeRequest` in `src/worker.js`, which answers `502` with `{error:e.message}` and logs `route_error` (so a malformed escape is a 502, not a 4xx). This last step is read from source, not exercised through the Worker router.

Not exercised: a held, unreadable or moved Film/Person marker (covered by `tests/canonical-catalog-reader.mjs`), a 409 or any answer from a real D1.

## Findings that bear on the decision

1. **Legacy tables are written, not authoritative.** `actual_rating` and `prediction_current` are still written by `prediction-repository.js` and the offline importer. Personal facts and predictions are authoritative in the ratings domain (`ratings_view`, `ratings_document`) and `prediction_pointer`. A `null` or a value from the legacy tables must not be read as the owner's state.
2. **No route of this module produces `409`.** The marker moving during a read is a `503` with `reason: film_person_generation_moved`. The card's acceptance wording lists 409; for these routes it does not apply, and the test plan below does not invent it.
3. **Method semantics.** Only `GET` is served; `HEAD` and every other method answer 405 today. The retirement keeps that, so `HEAD` is not turned into 410.
4. **Access is not part of the route module.** `/api/*` stays behind the existing Cloudflare Access policy; a retirement changes no Access rule.
5. **Film Aggregate is not active.** [ADR 0216](../../adr/0216-canonical-film-lifecycle-and-unified-read-contract.md) keeps the aggregate internal route additive and dormant. A redirect from a retired route to it would point at a route that is not reachable.

## Proposed test and acceptance plan (for the implementation cards, not delivered here)

- **Retired routes** (`films/<id>`, `persons`, `persons/<role>/<key>`, `persons/review`): `GET` answers `410` with the typed body, before any marker read, D1 read or owner-review overlay; the same answer while the marker is `held`, missing or moved; a malformed percent escape answers `410`, not 502; `HEAD` and other methods keep `405`; an unknown `/api/d1/` path keeps its present behavior (404 when the existing gates admit it, 503 when the Film/Person marker gate or the owner-review authority refuses). The retirement match applies to the exact retired paths only, after the method and Access boundary and before both gates; it is not a blanket bypass. No HEAD capability and no 409 are added.
- **Retained routes:** `identity` keeps `200`, `404` and `503` exactly as `tests/catalog-d1.mjs` and `tests/canonical-catalog-reader.mjs` assert; `status` as defined by AIR-690.
- **Retained function:** `d1PersonReview` remains defined when `src/catalog-d1.js` is loaded without the route (the script loads the file whole); a test pins the script's call.
- **GET audit (ADR 0107):** `tests/get-write-audit.mjs` stays green and the six existing `/api/d1/` samples in `tests/get-write-baseline.mjs` stay in place, because the retired paths are still HTTP read paths. Zero storage reads on a retired path is asserted by a separate test of the route module. No new audit infrastructure.
- **Documentation:** the maintained references (`d1-catalog.md`, `read-side-effects.md`, `catalog.md`, `film-person.md`) and the three runbooks are updated in the same delivery as the code, not before it.

## Rollback

A code revert restores the routes. It changes no D1 or R2 data, authority marker, Access rule, flag or schedule. Nothing in this proposal needs a data operation.

## Limits of this report

- The absence of a consumer outside the repository (a person's bookmarks, an external script) is not proven.
- The Worker-level 502 for the malformed escape was read from source, not run through the router.
- Production counts, latencies and any live response were not read.

## Links

[ADR 0223](../../adr/0223-retire-unused-d1-catalog-http-views.md); successor cards [AIR-689](https://trello.com/c/miSF1gBD) (retire the unused HTTP routes) and [AIR-690](https://trello.com/c/RxGq4S9r) (D1 catalog status contract); [D1 catalog views](../../reference/api/d1-catalog.md); [read side effects](../../reference/api/read-side-effects.md).
