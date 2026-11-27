# ADR 0223: Retire the unused `/api/d1/*` catalog views with a typed 410 and narrow the D1 status contract

**Status:** Accepted  
**Original decision date:** 2026-11-27 ([Product Owner disposition recorded by the Delivery Controller](https://github.com/vladimino/iptv-watchlist/pull/1036#issuecomment-7214650030); option A). The earlier [owner concept direction](https://trello.com/c/HoCuCbeL#comment-6b093ea38b3462537322973a) of the same day is superseded by this final decision.  
**Recorded at:** 2026-11-27, from `main` `81a57b9b`.  
**Approval source:** [Product Owner disposition of 27 Nov 2026](https://github.com/vladimino/iptv-watchlist/pull/1036#issuecomment-7214650030), recorded by the Delivery Controller from the owner's chat statement «Утверждаю ADR 0223, вариант A. Переводи в Accepted.»: option A, retire the unused HTTP views and narrow `status`, as reviewed at `072ccbc8` in the [technical PASS review](https://github.com/vladimino/iptv-watchlist/pull/1036#pullrequestreview-6085957627). This is an architecture acceptance only: it grants no implementation of the successor cards and no production operation.  
**Related work:** [AIR-658](https://trello.com/c/HoCuCbeL); successors [AIR-689](https://trello.com/c/miSF1gBD) and [AIR-690](https://trello.com/c/RxGq4S9r); evidence [D1 operator API disposition](../evidence/film-person/air-658-d1-operator-api-disposition-2026-11-27.md).  
**Supersedes:** only the clause of [ADR 0216](0216-canonical-film-lifecycle-and-unified-read-contract.md) decision 11 that says `GET /api/d1/films/<id>` "Stays an operator view". Choice F2 of ADR 0216 was rejected there and stays rejected. The reciprocal metadata is recorded in ADR 0216 and its registry row; ADR 0216 keeps its Accepted status and original provenance.  
**Superseded by:** None

## Context

`GET /api/d1/*` (`src/catalog-d1.js`) was built as read-only relational views for an operator. Today:

- Only `GET /api/d1/persons/<role>/<key>/identity` has a runtime consumer (the Finds actor and director filter). `GET /api/d1/status` is read by runbooks. The function `d1PersonReview` is loaded by `scripts/tmdb-watchlist-credits.mjs` through `vm`; its HTTP route has no caller.
- `GET /api/d1/films/<id>`, `GET /api/d1/persons` and `GET /api/d1/persons/<role>/<key>` have no consumer in the repository.
- `films/<id>` answers 404 for the `tmdb_<n>` storage key although the Film exists, reports a retired id as `{redirect}` without following it, and returns `prediction` and `rating` read from the legacy tables `prediction_current` and `actual_rating`. Those tables are still written but are not the authority: the ratings domain and `prediction_pointer` are. A `null` there says only that the legacy row is absent. The person routes carry the same legacy fields in the filmography.
- A malformed percent escape in the unguarded handlers throws and reaches the Worker's final `catch`, which answers 502.
- `status` counts `actual_rating` and `prediction_current` as `ratings` and `predictions`, and reports a retired projector.

[ADR 0216](0216-canonical-film-lifecycle-and-unified-read-contract.md) kept `films/<id>` as an operator view and listed replacing it in place as the rejected alternative F2. The [evidence](../evidence/film-person/air-658-d1-operator-api-disposition-2026-11-27.md) records what was observed and what is only inferred. The absence of consumers outside the repository is not proven.

## Decision

1. **Retire four HTTP views.** `GET /api/d1/films/<id>`, `GET /api/d1/persons`, `GET /api/d1/persons/<role>/<key>` and `GET /api/d1/persons/review` answer `410` with the typed body `{"error":"gone","reason":"d1_operator_view_retired"}`. There is no redirect, no `Location` and no pointer to the Film aggregate, which is not active.
2. **The 410 is decided for the exact retired paths only, before both authority gates.** After the existing router boundaries (Access, and the method check: only `GET` reaches this decision), the four retired path shapes are matched without decoding the path, before the Film/Person marker gate, any D1 read and the owner-review overlay. A retired route reads no storage, answers 410 while the marker is held, missing or moved, and a malformed percent escape on it answers 410, not 502. This is not a blanket bypass: a retained route, including `identity` and `status`, and an **unknown** `/api/d1/` path keep their present behavior, which for an unknown path is 404 when the existing gates admit the request and 503 when the Film/Person marker gate or the owner-review authority refuses it.
3. **Method and access semantics are unchanged.** Only `GET` is served; `HEAD` and every other method keep 405. `/api/*` stays behind the existing Cloudflare Access policy.
4. **Retained.** `GET /api/d1/persons/<role>/<key>/identity` is unchanged. The function `d1PersonReview`, its definition in `src/catalog-d1.js` and the script that loads it stay as they are; only its HTTP route is retired.
5. **`GET /api/d1/status` is narrowed to its own responsibility** (the Film/Person domain: schema, authority state, Film, Person and credit counts, and the diagnostics a runbook really needs). It stops presenting `actual_rating` and `prediction_current` counts as the ratings and prediction domains, and the retired projector leaves the current contract (kept only as clearly historical context where a runbook needs it). It does not become a global monitoring API, a count of one table is not replaced by a count of another without defining the unit, and an unknown value is never reported as zero. The exact fields and runbook text are decided in the status card, inside this boundary.
6. **Once this ADR is Accepted, only one clause of ADR 0216 is superseded.** `films/<id>` does not stay an operator view; it is retired. Replacing it in place by the unified Film aggregate (F2) remains a rejected alternative and is not a delivery step: the aggregate route stays additive and any consumer migration is separately accepted.
7. **Not changed:** writers, the legacy tables, any schema or authority, the public Film page and aggregate migrations, and the documentation limits work of the operator-view card.

## Alternatives considered

- **Fix in place** (typed resolver for `tmdb_<n>`, follow the redirect, drop the legacy fields, guard the decode). It keeps code and tests for four views that nobody calls, and the resolver would duplicate what the Film aggregate is for. Rejected.
- **Retain as is, documentation only.** The legacy fields would stay readable as if authoritative, and the 404 and 502 behaviors would remain. Rejected.
- **Redirect retired routes to the Film aggregate.** The aggregate route is dormant, so the target is not reachable. Rejected for now; a later accepted consumer migration may revisit it.
- **Retire `status` too.** Runbooks read it, and the Film/Person diagnostics have no other HTTP surface. Rejected.

## Consequences

- Less unreachable code and no misleading legacy fields behind an operator route. A caller outside the repository, if any exists, gets a typed 410 instead of a silent partial answer.
- The retirement is observable and reversible. The cost is two atomic delivery cards and the update of the maintained references and runbooks with them.
- The route module still contains `d1PersonReview` for the script; removing the function is a separate decision if the script goes away.
- The GET audit keeps its coverage. The four 410 tombstones are still HTTP read paths, so the six existing samples of the `/api/d1/` prefix in `tests/get-write-baseline.mjs` stay unchanged; no sample is removed and no new audit infrastructure is added. That a retired path performs no storage read is asserted by a separate test of the route module.

## Recovery and migration boundary

A code revert restores the routes. It changes no D1 or R2 data, authority marker, Access rule, flag or schedule, and nothing here needs a data operation. This ADR authorizes no production operation and no implementation: [AIR-689](https://trello.com/c/miSF1gBD) and [AIR-690](https://trello.com/c/RxGq4S9r) start only after their prerequisite is complete and with their own review. Their acceptance covers the 410 answers (before the marker gate, including a malformed escape), `405` and the unknown-path behavior unchanged (no HEAD capability and no 409 are added), the retained identity route and `d1PersonReview` script call, the narrowed `status`, the unchanged GET-audit samples plus the separate zero-storage-read test, and the updated maintained documentation.

## Evidence

- **Owner direction:** [AIR-658 card comment, 27 Nov 2026](https://trello.com/c/HoCuCbeL#comment-6b093ea38b3462537322973a).
- **Implementation:** none; the routes are unchanged at the recorded `main`.
- **Dated verification:** [offline matrix and probe, 27 Nov 2026](../evidence/film-person/air-658-d1-operator-api-disposition-2026-11-27.md).
- **Uncertainty:** consumers outside the repository are not proven absent; the Worker-level 502 for a malformed escape was read from source.

## Follow-ups

[AIR-689](https://trello.com/c/miSF1gBD) retires the four HTTP views. [AIR-690](https://trello.com/c/RxGq4S9r) defines the narrowed `status` contract. Current state belongs to Trello and GitHub.
