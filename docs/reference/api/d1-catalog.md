# D1 catalog views (read-only)

`GET /api/d1/*` answers from the D1 database `iptv` (binding `DB`), not from R2. The routes only `SELECT`. These routes do not write; the enrichment projector ([ADR 0056](../../adr/0056-d1-enrichment-write-through.md)) is off the cron trigger ([ADR 0155](../../adr/0155-retire-enrichment-projector-cron.md)) and its runner and write arms were removed in AIR-537 slice 3; only the read-only `projector` status readout below remains. D1 is the only authority and the routes are served only while the Film/Person marker is `open` ([ADR 0162](../../adr/0162-d1-only-authority-retire-rollback-toolchain.md)). Every `GET /api/d1/*` first reads the Film/Person marker ([ADR 0099](../../adr/0099-canonical-film-person-d1-authority.md), SELECTs of the marker tables only): `held`, an installed `r2` or `prepared` marker, a missing or malformed marker, a missing companion table and a failed marker read answer `503` `{error:"storage_unavailable",reason:"film_person_held"|"film_person_unavailable"}` and read nothing else; `open` answers from the same D1 rows and `authoritative:true` where the view carries the flag (`/api/d1/status`, `/api/d1/persons/<role>/<key>/identity`; the other views never carried it). A non-`GET` request is not gated (`405`). The owner-review overlay of these responses is reachable only through this route and so inherits the gate; the owner-review marker is a separate domain and is unchanged. They sit under `/api/`, behind the same Cloudflare Access policy as the rest of the API. Source: [`src/catalog-d1.js`](../../../src/catalog-d1.js), test [`tests/catalog-d1.mjs`](../../../tests/catalog-d1.mjs).

Metadata records follow the D1 cache, which is served only while its schema v6 marker is `d1` ([ADR 0073](../../adr/0073-metadata-cache-d1-authority.md), [ADR 0162](../../adr/0162-d1-only-authority-retire-rollback-toolchain.md)); any other marker is refused with `metadata_cache_unavailable` (the retired enrichment projector used to fail its run the same way). Historical: before the D1-only retirement ([ADR 0162](../../adr/0162-d1-only-authority-retire-rollback-toolchain.md)) other domains reached D1 through a reload from R2 ([D1 backfill runbook](../../runbooks/d1-backfill.md)); that path is not a live authority. These routes still only `SELECT`.

## Identifiers

- **Film:** `film:<id>` in D1; the route takes the part after `film:`, for example `/api/d1/films/tmdb:41009` or `/api/d1/films/10oS`.
- **Person:** `person:<role>/<key>`. Letterboxd persons use `actor/<slug>` and `director/<slug>`; TMDB persons use `tmdb_actor/<id>` and `tmdb_director/<id>`. The route takes the part after `person:`, for example `/api/d1/persons/director/martin-scorsese`. Each role is a separate row, so one human can appear as up to four persons; the review queues below find them.

## Routes

| Route | Answer |
| --- | --- |
| `GET /api/d1/status` | `{source:"d1",authoritative:false,films,persons,credits,candidates,predictions,ratings,lastImport,schemaVersion,projector}`. `projector` is the [enrichment projector](../../adr/0056-d1-enrichment-write-through.md) readout: `{mode,schema:false,schemaVersion,projectionTables}` until the projection tables and the contract version agree. Version 4 with all three projection tables, and version 5 with those tables plus `film_sync_state`, are `{mode,schema:true,checkpoints,absent,lastWriteAt,lastWriteAgeSec,windowMode,lastRun:{startedAt,finishedAt,outcome,leaseHeld,summary}|null}`. `lastWriteAt` is the newest `projected_at` of the projector's own keys (null while it has written none) and `lastWriteAgeSec` its age in seconds at the read; `mode` and `windowMode` are always `null` (the retired selectors `D1_ENRICHMENT_WRITE` and `D1_ENRICHMENT_WINDOW` are ignored; [ADR 0103](../../adr/0103-projector-exclusive-window.md) is historical). The status only reads. When a run took an exclusive window, `summary.window` is `{outcome,waitMs,expiresAt,generationAtGrant,generationAtFirstBatch,heldMs}` with `outcome` `granted` or `not_applicable` (no window table, or the Discovery authority is not `d1`); a refused or ended window is a `deferred` run with `reason` `window_busy`, `window_not_granted` or `window_lost`, and `summary.window.outcome` names the same reason. The summary never carries a payload. Version 5 also adds `schemaVersion`, `syncCheckpoints` and `syncAbsent` ([ADR 0070](../../adr/0070-metadatasync-freshness-clocks.md)). The version 4 success object does not carry those three fields. Version 6 with the cache tables adds `cacheMode`, `cacheGeneration` and `mirrorGeneration` as well ([ADR 0073](../../adr/0073-metadata-cache-d1-authority.md)). Version 5 does not carry those three. Version 6 without the cache tables is `schema: false`. While `identity/tmdb-retirements.json` exists, `summary` also carries `tmdbRetirements: {valid,applied,held,reasons}` ([D1 schema](../data/d1-schema.md#enrichment-projector-schema-v4)). Read-only, like every route here. Since [AIR-392](https://trello.com/c/ivMqVpKC) `summary` also carries `timing`, `phases` and `detail`, additive phase timings of the run (whole milliseconds, fixed names, no payload) described in the [monitoring runbook](../../runbooks/monitoring.md#d1-projector-run-phase-timing-air-392); they are measurements only. |
| `GET /api/d1/persons?q=&role=&source=&cursor=&limit=` | Persons ordered by id. `q` matches the original name, an accepted localized name or the id (substring). `role` is `actor` or `director`; `source` is `letterboxd` or `tmdb`. `limit` 1–100, default 50. Each item: `id`, `name`, `localName`, `films` (credit count), `source`, `key`. `nextCursor` is the last id of the page, or `null` |
| `GET /api/d1/persons/<role>/<key>` | One person: names, aliases, external ids, filmography (title, original title, year, role, position, `predicted` from `prediction_current` and `rating` from `actual_rating` with the same [operator view limits](#operator-view-limits-of-get-apid1filmsid), watchlist flag), `sameSlug` (the same key under the other role of the same source), `coCredited` (persons of the other source credited in the same role on the same Film under the same name, with the number of such Films) and `nameOnlyOtherSource` (persons of the other source that share only a name, up to 20). 404 when absent |
| `GET /api/d1/persons/<role>/<key>/identity` | The derived Person reference for that one role record. See [below](#person-identity). 404 when the person is absent or the role is not `actor`, `director`, `tmdb_actor` or `tmdb_director` |
| `GET /api/d1/films/<id>` | One film: title (accepted localization, else original), original title, canonical identity, year, runtime, genres, Letterboxd URL, watchlist flag, external ids (including untrusted `letterboxd_slug` aliases, [ADR 0052](../../adr/0052-letterboxd-slug-film-alias.md), and a `tmdb_tv` TV identity beside an untrusted retired `tmdb` movie id when the D1 rows carry it (historically the enrichment projector applied `identity/tmdb-retirements.json`; it was removed in AIR-537 slice 3 and nothing applies that object now), [ADR 0057](../../adr/0057-tmdb-tv-identity-and-retired-movie-ids.md)), credits with names, and the schema v1 `prediction` and `rating` fields described in [operator view limits](#operator-view-limits-of-get-apid1filmsid). A retired id answers `{redirect:"film:…"}`. 404 when absent |
| `GET /api/d1/persons/review?limit=` | Four duplicate queues, strongest evidence first, with totals: `crossRole` (one key of one source under both roles, a near-certain single person), `coCredit` (a Letterboxd and a TMDB person credited in the same role on the same Film under the same name, the provable cross-source match), `nameOnly` (one name held by both sources with no shared Film, a weak candidate), `sameName` (one name under different keys of one source, namesakes or one person). `totals.sharedName` counts every name both sources hold |

Errors: `405` for any method but GET, `503` when the Worker has no `DB` binding, `404` for an unknown route, person or film.

**Proposed, not live:** [ADR 0223](../../adr/0223-retire-unused-d1-catalog-http-views.md) (Proposed) would retire `persons`, `persons/<role>/<key>`, `persons/review` and `films/<id>` with a typed `410`, keep the identity route and `d1PersonReview`, and narrow `status`. Until that ADR is Accepted and delivered, every route in the table above behaves as documented.

## Limits

- These routes stay read-only. Only the explicit local stand-in (a Film/Person domain that is not installed) answers `authoritative:false`. The marker-gated canonical bulk read model is in `src/canonical-read-model.js` ([Film/Person reference](../domain/film-person.md)).
- Name matching uses SQLite `lower()`, which folds ASCII only; Cyrillic names compare as stored.
- Cross-source evidence follows [ADR 0009](../../adr/0009-canonical-film-person-identity.md) and [ADR 0058](../../adr/0058-canonical-person-grouping.md): only a shared verified Film with the same role and name is evidence; a name alone is a candidate. The filmography and the review queues do not compute the [person identity projection](../domain/person-identity-projection.md). The [identity route](#person-identity) does. None of these routes link, merge or edit a person.

## Person identity

`GET /api/d1/persons/<role>/<key>/identity` calls `projectPersonIdentity` on a bounded neighborhood of the requested record ([ADR 0062](../../adr/0062-d1-person-identity-read.md)). The filmography route above is unchanged.

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
- `actual_rating` holds only ratings that came from `actual.json`. It is not the owner's rating authority; see the next section.

## Operator view limits of `GET /api/d1/films/<id>`

`GET /api/d1/films/<id>` is an operator view of the schema v1 Film tables, not the Film read contract. [ADR 0216](../../adr/0216-canonical-film-lifecycle-and-unified-read-contract.md) keeps it as an operator view and does not migrate it to the unified Film aggregate.

- `prediction` is the JSON object `{predicted, profileVersion, updatedAt}`, read from the `prediction_current` columns `predicted_rating`, `taste_profile_version` and `updated_at`, or `null` when there is no row. It is not the current prediction. The prediction domain's authority is `prediction_pointer` and the immutable bodies it points at ([D1 schema: prediction domain](../data/d1-schema.md#prediction-domain-schema-v7)).
- `rating` is the JSON object `{rating, source, recordedAt}`, read from the `actual_rating` columns `rating`, `source` and `recorded_at`, or `null` when there is no row. It is not the owner's rating, watched or Diary state. Those personal facts are in the ratings domain, `ratings_view` and `ratings_document` ([D1 schema: ratings domain](../data/d1-schema.md#ratings-domain-schema-v10)).
- `null` in either field means only that the schema v1 table has no row for this id. It does not prove that the Film is unrated or has no prediction.
- The URL takes the part of the D1 Film id after `film:` (for example `tmdb:41009`, see [Identifiers](#identifiers)); the handler URL-decodes it, prepends `film:` and reads that `film.id` primary key only, without resolving external claims; a retired id answers the `film_redirect` target and is not followed. It does not resolve a `tmdb_<n>` storage key, a `letterboxd_lid` alias or other typed identity, so a 404 does not prove that no Film exists.
- A consumer that needs the current personal or prediction picture reads the authoritative domains, or the Film aggregate of ADR 0216 once it is delivered. The route, its response shape and its SQL are unchanged.
