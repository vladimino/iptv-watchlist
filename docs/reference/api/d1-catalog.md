# D1 catalog views (read-only)

`GET /api/d1/*` answers from the D1 database `iptv` (binding `DB`), not from R2. The routes only `SELECT`. These routes do not write; the enrichment projector ([ADR 0056](../../adr/0056-d1-enrichment-write-through.md)) is off the cron trigger ([ADR 0155](../../adr/0155-retire-enrichment-projector-cron.md)) and its runner and write arms were removed in AIR-537 slice 3; the read-only projector readout no longer appears on any route ([D1 status contract](#d1-status-contract)). D1 is the only authority and the data routes are served only while the Film/Person marker is `open` ([ADR 0162](../../adr/0162-d1-only-authority-retire-rollback-toolchain.md)). Every `GET` to a **retained or unknown** `/api/d1/` path first reads the Film/Person marker ([ADR 0099](../../adr/0099-canonical-film-person-d1-authority.md), SELECTs of the marker tables only): `held`, an installed `r2` or `prepared` marker, a missing or malformed marker, a missing companion table and a failed marker read answer `503` `{error:"storage_unavailable",reason:"film_person_held"|"film_person_unavailable"}` and read nothing else; `open` answers from the same D1 rows and `authoritative:true` where the view carries the flag (`/api/d1/status`, `/api/d1/persons/<role>/<key>/identity`). The four [retired views](#retired-views) are the exception: their exact path shapes answer a typed `410` **before** that marker gate, any D1 read and the owner-review overlay, so they read no storage and do not depend on either marker. A non-`GET` request is not gated and answers `405` (HEAD included). For a retained or unknown path the owner-review overlay still runs after the D1 read and answers its own typed `503` `{error:"storage_unavailable",reason:"owner_review_unavailable"}` when the owner-review authority refuses, even for an unknown path's `404`; the owner-review marker is a separate domain and is unchanged. The existing outer boundaries run before this route and are unchanged: the Cloudflare Access policy on `/api/`, and the Worker's `/api/` preamble (a missing `BUCKET` binding answers `503` `{error:"Storage unavailable"}`; the Origin check and the degraded-origin write fence apply as for every `/api/` route). Source: [`src/catalog-d1.js`](../../../src/catalog-d1.js), test [`tests/catalog-d1.mjs`](../../../tests/catalog-d1.mjs).

Metadata records follow the D1 cache, which is served only while its schema v6 marker is `d1` ([ADR 0073](../../adr/0073-metadata-cache-d1-authority.md), [ADR 0162](../../adr/0162-d1-only-authority-retire-rollback-toolchain.md)); any other marker is refused with `metadata_cache_unavailable` (the retired enrichment projector used to fail its run the same way). Historical: before the D1-only retirement ([ADR 0162](../../adr/0162-d1-only-authority-retire-rollback-toolchain.md)) other domains reached D1 through a reload from R2 ([D1 backfill runbook](../../runbooks/d1-backfill.md)); that path is not a live authority. These routes still only `SELECT`.

## Identifiers

- **Film:** `film:<id>` in D1. No retained route takes a Film id.
- **Person:** `person:<role>/<key>`. Letterboxd persons use `actor/<slug>` and `director/<slug>`; TMDB persons use `tmdb_actor/<id>` and `tmdb_director/<id>`. The retained identity route takes the part after `person:`, for example `/api/d1/persons/director/martin-scorsese/identity`. Each role is a separate row, so one human can appear as up to four persons; the [duplicate review queues](#retired-views) are still computed by `d1PersonReview` for the credits script.

## Routes

| Route | Answer |
| --- | --- |
| `GET /api/d1/status` | The Film/Person status: `{source:"d1",authoritative,authority:{state,generation},schemaVersion,films,persons,credits}`. Units, sources and the transition from the earlier shape are in [D1 status contract](#d1-status-contract) |
| `GET /api/d1/persons/<role>/<key>/identity` | The derived Person reference for that one role record. See [below](#person-identity). 404 when the person is absent or the role is not `actor`, `director`, `tmdb_actor` or `tmdb_director` |

Errors for the retained and unknown paths: `405` for any method but GET (including HEAD), `503` when the Worker has no `DB` binding, the Film/Person marker gate refuses or the owner-review authority refuses, `404` for an unknown route or person.

## Retired views

[ADR 0223](../../adr/0223-retire-unused-d1-catalog-http-views.md) (AIR-689) retired four operator views. Each answers `410` with the typed body `{"error":"gone","reason":"d1_operator_view_retired"}`, with no redirect and no `Location`:

| Retired route | Notes |
| --- | --- |
| `GET /api/d1/films/<id>` | The Film read contract is not served here. No successor route is promised: the unified Film aggregate of [ADR 0216](../../adr/0216-canonical-film-lifecycle-and-unified-read-contract.md) is additive and is not claimed to be active |
| `GET /api/d1/persons` | No successor. The retained person read is the identity route below |
| `GET /api/d1/persons/<role>/<key>` | Use `GET /api/d1/persons/<role>/<key>/identity` for the derived Person reference |
| `GET /api/d1/persons/review` | The review queues are not served over HTTP. The function `d1PersonReview` in `src/catalog-d1.js` stays: [`scripts/tmdb-watchlist-credits.mjs`](../../runbooks/tmdb-watchlist-credits.md) loads it through `vm` |

How the `410` is decided:

- Only the **exact** retired path shapes match, on the raw pathname and **without decoding**: `persons`, `persons/review`, `persons/<role>/<key>` (role `actor`, `director`, `tmdb_actor`, `tmdb_director`; key one segment of 1 to 200 characters) and `films/<id>` (one segment of 1 to 200 characters, the same bound the handler had). A longer segment, an extra segment or a trailing slash is not a retired shape and is an unknown path. A malformed percent escape on such a path is a `410`, not a `502`.
- It runs after the Worker's existing boundaries (the `/api/` Access and storage-binding preamble, and the method check: only `GET` is decided) and **before** the Film/Person marker gate, any D1 read and the owner-review overlay. A retired path performs no storage read or write and answers `410` while the marker is held, missing or moved, and when `DB` is unbound. This is not a blanket bypass: Access is unchanged.
- `HEAD` and every other method keep `405`. No `409` and no HEAD support are added.
- `status`, `persons/<role>/<key>/identity` and every **unknown** path are not matched here. An unknown path keeps `404` when both gates admit the request and `503` when the Film/Person marker gate or the owner-review authority refuses it; a retired path never reaches the owner-review overlay.
- The legacy `prediction` and `rating` fields of the retired views (read from `prediction_current` and `actual_rating`) are no longer served. Their authorities are the prediction domain (`prediction_pointer`) and the ratings domain ([D1 schema](../data/d1-schema.md)); the legacy tables are unchanged.

Rollback is a code revert and deploy; it restores the handlers and changes no data, marker, Access rule, flag or schedule.

## D1 status contract

[AIR-690](https://trello.com/c/RxGq4S9r), [ADR 0223](../../adr/0223-retire-unused-d1-catalog-http-views.md) decision 5. `GET /api/d1/status` answers for the Film/Person domain only. It is not a monitoring endpoint and does not aggregate other domains.

```json
{"source":"d1","authoritative":true,"authority":{"state":"open","generation":7},"schemaVersion":54,"films":0,"persons":0,"credits":0}
```

| Field | Unit and source |
| --- | --- |
| `source` | Always `d1`. |
| `authoritative` | `true` only while the Film/Person marker is `open`; `false` only for the explicit local stand-in (`FILM_PERSON_DB_OPTIONAL=standin`). |
| `authority` | `{state, generation}` of the Film/Person marker that the route gate read for this same request ([authority per domain](../../architecture/persistence-and-migration.md#authority-per-domain)); no extra query. `state` is `open` in production. A held, missing, moved or unreadable marker never reaches this body: the route answers `503` `{error:"storage_unavailable",reason}` first. |
| `schemaVersion` | `schema_contract.version` (id 1); `null` when that row is absent. It is the installed D1 schema version, not proof that any domain is cut over. |
| `films` | `count(*)` of `film`: unique Films. A retired id (`film_redirect`) and an alias or external claim (`film_external_id`) are not Films and are not counted. |
| `persons` | `count(*)` of `person`: **role records**, one per `person:<role>/<key>`. One human can be up to four of them ([Identifiers](#identifiers)), so this is not a count of humans. |
| `credits` | `count(*)` of `film_person_credit`: Film-person credit rows. |

The counts are the three existing `COUNT(*)` reads plus the version read: no new census, limit or quota. The route only `SELECT`s, writes and repairs nothing, and has no fallback to R2 or to a legacy table. `GET` answers `200` or the typed `503` of the marker gate; `HEAD` and every other method keep `405`; no `409` exists. An unavailable value is a refusal or `null`, never `0`.

**Transition from the earlier shape (before AIR-690).** The fields below are no longer returned. A script that read one of them gets `undefined` and must use the named source.

| Removed | Why, and where to read the fact now |
| --- | --- |
| `ratings` (`count(*)` of `actual_rating`) | A legacy schema v1 table that is still written but is not the ratings authority; it was never the number of rated Films. Ratings authority and status: `ratings_view` / `ratings_document` ([D1 schema: ratings domain](../data/d1-schema.md#ratings-domain-schema-v10)) and the MCP tool `ratings_sync_status` ([MCP](mcp.md), `GET /api/letterboxd/ratings/status`). |
| `predictions` (`count(*)` of `prediction_current`) | A legacy schema v1 table, not the current prediction. Prediction authority is `prediction_pointer` and its immutable bodies ([D1 schema: prediction domain](../data/d1-schema.md#prediction-domain-schema-v7)); diagnostics: [prediction diagnostics](prediction-diagnostics.md) (`prediction_queue_overview`) and the other [prediction references](README.md). A pointer count, an alias row count and a unique-Film count are three different units. |
| `candidates`, `lastImport` | `candidate` is the Discovery domain and `import_receipt` belongs to the retired offline importer; neither is Film/Person health and neither has a maintained consumer. Discovery has its own status ([enrichment](enrichment.md), `epg_pipeline_status`). |
| `projector` (and its `schema`, `checkpoints`, `lastRun`, `cacheMode`, `predictionMode`, `ownerReviewMode`, ... fields) | The enrichment projector is retired ([ADR 0155](../../adr/0155-retire-enrichment-projector-cron.md), AIR-537). Its block described a producer that no longer runs and mixed other domains' markers into a Film/Person route. A stale or `schema:false` projector is not a health signal. The persisted `projection_*` rows are historical records ([monitoring runbook, historical section](../../runbooks/monitoring.md)). Domain markers have their own reads: cache and owner-review markers in [D1 schema](../data/d1-schema.md), prediction in the prediction references above. |

No new domain API is introduced or promised. Rolling the code back restores the earlier shape; it changes no data.

## Limits

- These routes stay read-only. Only the explicit local stand-in (a Film/Person domain that is not installed) answers `authoritative:false`. The marker-gated canonical bulk read model is in `src/canonical-read-model.js` ([Film/Person reference](../domain/film-person.md)).
- Name matching uses SQLite `lower()`, which folds ASCII only; Cyrillic names compare as stored.
- Cross-source evidence follows [ADR 0009](../../adr/0009-canonical-film-person-identity.md) and [ADR 0058](../../adr/0058-canonical-person-grouping.md): only a shared verified Film with the same role and name is evidence; a name alone is a candidate. The review queues (`d1PersonReview`) do not compute the [person identity projection](../domain/person-identity-projection.md). The [identity route](#person-identity) does. None of these routes link, merge or edit a person.

## Person identity

`GET /api/d1/persons/<role>/<key>/identity` calls `projectPersonIdentity` on a bounded neighborhood of the requested record ([ADR 0062](../../adr/0062-d1-person-identity-read.md)). The retired filmography route is not a substitute for it.

```json
{
  "source": "d1",
  "authoritative": false,
  "recordId": "person:actor/<key>",
  "bounded": false,
  "limitations": ["owner_decisions_not_stored", "role_links_not_stored"],
  "reference": {
    "state": "trusted",
    "crossSource": "verified",
    "humanId": "human:…",
    "formerIds": [],
    "memberIds": [],
    "links": [],
    "reviews": [],
    "externalIds": [],
    "reversal": {"destructive": false, "stored": false, "formerIds": [], "splits": []}
  },
  "films": {
    "actor": {"state": "trusted", "crossSource": "verified", "humanId": "human:…", "watchlist": [], "catalog": []},
    "director": {"state": "trusted", "crossSource": "verified", "humanId": "human:…", "watchlist": [], "catalog": []}
  }
}
```

`reference.state` is `trusted`, `unresolved`, `ambiguous` or `conflicting`. `films.actor` and `films.director` are the film ids `filmsForPerson` returns for that role, split by surface. An unknown or conflicting selector has empty lists. A shared name is a review and adds no film.

The neighborhood is the requested record, the other records of the same source key, the actor and director credits on their films, and up to 40 namesakes. A witness is pulled into the next round only when the projection already calls that witness the same human. Six rounds, 400 person ids and 800 film ids. The film, witness and namesake probes are separate `SELECT`s with `LIMIT cap+1`. A full page stops the read: the body is the same-key records only, `bounded` is true, and `limitations` includes `neighborhood_bounded`. A namesake page of 41 also adds `namesakes_truncated`. The same-key records' own films are included only when that list fits the film cap. Namesakes bring no extra films. The namesake probe matches SQLite `lower()` of the stored spelling, then `personFold` on the rows it received, and also tries the `ё`/`е` swap and the folded spelling as needles. A diacritic that `lower()` does not equate can be absent.

`limitations` always includes `owner_decisions_not_stored` and `role_links_not_stored`. D1 has no owner `same` or `different` and no role link, so the route passes neither and does not invent one. A Film that has a Letterboxd credit and no TMDB credit stays a credit of that Letterboxd record and does not create a cross-source member.

The Finds actor and director filter is the page reader ([ADR 0065](../../adr/0065-finds-person-filter-d1-read.md), [catalog filter context](catalog.md#filter-context)). It calls this GET only for a selected person. It uses `films.<role>.catalog` only when the body is unbounded, the reference and that role are trusted and cross-source verified, and a `co_credit` link lists the role. It binds `film:tmdb:<n>` to a published catalog film whose id is `tmdb_<n>` and whose `canonicalIdentity` is `tmdb:<n>`. It does not apply an owner decision, and it does not write.
- `coCredit` needs a Film that carries credits from both sources. A reload from R2 gives watchlist Films only Letterboxd credits and catalog Films only TMDB credits, so `coCredit` is empty until the [TMDB credits for watchlist Films](../../runbooks/tmdb-watchlist-credits.md) are added to D1.
- `actual_rating` holds only ratings that came from `actual.json`. It is not the owner's rating authority; the ratings domain is ([D1 schema](../data/d1-schema.md#ratings-domain-schema-v10)).
