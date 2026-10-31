# D1 catalog views (read-only)

`GET /api/d1/*` answers from the D1 database `iptv` (binding `DB`), not from R2. The routes only `SELECT`; no Worker path writes D1, and R2 stays authoritative for every other route. They sit under `/api/`, behind the same Cloudflare Access policy as the rest of the API. Source: [`src/catalog-d1.js`](../../../src/catalog-d1.js), test [`tests/catalog-d1.mjs`](../../../tests/catalog-d1.mjs).

The data is the backfilled copy of R2 (see the [D1 backfill runbook](../../runbooks/d1-backfill.md)); it does not follow R2 changes made after the backfill until a later phase writes D1 directly.

## Identifiers

- **Film:** `film:<id>` in D1; the route takes the part after `film:`, for example `/api/d1/films/tmdb:41009` or `/api/d1/films/10oS`.
- **Person:** `person:<role>/<key>`. Letterboxd persons use `actor/<slug>` and `director/<slug>`; TMDB persons use `tmdb_actor/<id>` and `tmdb_director/<id>`. The route takes the part after `person:`, for example `/api/d1/persons/director/martin-scorsese`. Each role is a separate row, so one human can appear as up to four persons; the review queues below find them.

## Routes

| Route | Answer |
| --- | --- |
| `GET /api/d1/status` | `{source:"d1",authoritative:false,films,persons,credits,candidates,predictions,ratings,lastImport,schemaVersion,projector}`. `projector` is the [enrichment projector](../../adr/0056-d1-enrichment-write-through.md) readout: `{mode,schema:false,schemaVersion,projectionTables}` until the whole of migration 0004 is present (all three projection tables and `schema_contract.version` 4); after it, `{mode,schema:true,checkpoints,absent,lastRun:{startedAt,finishedAt,outcome,leaseHeld,summary}|null}`. While `identity/tmdb-retirements.json` exists, `summary` also carries `tmdbRetirements: {valid,applied,held,reasons}` ([D1 schema](../data/d1-schema.md#enrichment-projector-schema-v4)). Read-only, like every route here. |
| `GET /api/d1/persons?q=&role=&source=&cursor=&limit=` | Persons ordered by id. `q` matches the original name, an accepted localized name or the id (substring). `role` is `actor` or `director`; `source` is `letterboxd` or `tmdb`. `limit` 1–100, default 50. Each item: `id`, `name`, `localName`, `films` (credit count), `source`, `key`. `nextCursor` is the last id of the page, or `null` |
| `GET /api/d1/persons/<role>/<key>` | One person: names, aliases, external ids, filmography (title, original title, year, role, position, current prediction, actual rating, watchlist flag), `sameSlug` (the same key under the other role of the same source), `coCredited` (persons of the other source credited in the same role on the same Film under the same name, with the number of such Films) and `nameOnlyOtherSource` (persons of the other source that share only a name, up to 20). 404 when absent |
| `GET /api/d1/films/<id>` | One film: title (accepted localization, else original), original title, canonical identity, year, runtime, genres, Letterboxd URL, watchlist flag, external ids (including untrusted `letterboxd_slug` aliases, [ADR 0052](../../adr/0052-letterboxd-slug-film-alias.md), and a `tmdb_tv` TV identity beside an untrusted retired `tmdb` movie id once the enrichment projector has applied `identity/tmdb-retirements.json`, [ADR 0057](../../adr/0057-tmdb-tv-identity-and-retired-movie-ids.md)), credits with names, current prediction and actual rating. A retired id answers `{redirect:"film:…"}`. 404 when absent |
| `GET /api/d1/persons/review?limit=` | Four duplicate queues, strongest evidence first, with totals: `crossRole` (one key of one source under both roles, a near-certain single person), `coCredit` (a Letterboxd and a TMDB person credited in the same role on the same Film under the same name, the provable cross-source match), `nameOnly` (one name held by both sources with no shared Film, a weak candidate), `sameName` (one name under different keys of one source, namesakes or one person). `totals.sharedName` counts every name both sources hold |

Errors: `405` for any method but GET, `503` when the Worker has no `DB` binding, `404` for an unknown route, person or film.

## Limits

- Name matching uses SQLite `lower()`, which folds ASCII only; Cyrillic names compare as stored.
- Cross-source evidence follows [ADR-0009](../../adr/0009-canonical-film-person-identity.md) and the identity rule of [AIR-201](https://trello.com/c/1uvzKiGg): only a shared verified Film with the same role and name is evidence; a name alone is a candidate. Nothing here links, merges or edits a person.
- `coCredit` needs a Film that carries credits from both sources. A reload from R2 gives watchlist Films only Letterboxd credits and catalog Films only TMDB credits, so `coCredit` is empty until the [TMDB credits for watchlist Films](../../runbooks/tmdb-watchlist-credits.md) are added to D1.
- `actual_rating` holds only ratings that came from `actual.json`; the owner's Letterboxd ratings live in the Letterboxd facts in R2 and are not in D1 yet.
