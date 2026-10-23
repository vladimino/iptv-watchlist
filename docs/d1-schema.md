# D1 schema v1

[AIR-49](https://trello.com/c/YNaLFwtW) is this schema and the storage boundary. `migrations/0001_schema_v1.sql` is the only schema. It is not bound in `wrangler.jsonc`, the Worker does not open it, and nothing in this repository applies it to production. R2 bucket `iptv` remains the authoritative store.

[AIR-70](https://trello.com/c/8PRWRx2C), [AIR-71](https://trello.com/c/UAUUQ2jh), and [AIR-72](https://trello.com/c/MfAGc1Dd) are the later repositories. [AIR-73](https://trello.com/c/gX2xdQAz) is the later offline importer. Live backfill starts only at [AIR-74](https://trello.com/c/5AdAmKPe), after [AIR-69](https://trello.com/c/FlcWZX7W). [AIR-42](https://trello.com/c/drLBuWjl) still owns identity transitions, [AIR-43](https://trello.com/c/7NY6n1Az) still owns scoring, and [AIR-48](https://trello.com/c/rVf8rRoJ) still owns which observation is current. This schema does not copy those rules. [AIR-53](https://trello.com/c/gkuy1awG) is not built here.

Versioning and recovery are in [ADR 0001](adr/0001-d1-schema-v1.md).

## What is stored where

An observation key such as `heat|1995` is a `candidate` row. It is not a `film.id`. `film.id` starts with `film:`. A trusted external id is unique. A redirect keeps the retired id without creating a second Film. `accepted_tmdb_id` on a score does not reference `film`.

A generation has a phase of `published` or `withheld`. `published_generation` is the one current pointer, the same role as `epg/published-generation.json`. Moving it from generation A to generation B leaves A's rows in place. `published_film_show` reads only that pointer, and only when the pointed generation is `published`. `film_generation` is the membership row. Zero `film_show` rows under that membership are an explicit empty show list. A film show keeps `channel`, `epg_title`, `basis`, and `match_reason`, so a `title_duration` showing still explains the cautious mark. `film_epg_last_airing` is a historical fact and is not a show.

A candidate keeps the observation the scorer reads: title, normalized title, year, raw titles, durations, description, airings, and `confirmed_tmdb_id`. `observation_json` is that same observation at `observation_schema_version` 1. Shows for one generation live on `candidate_show`, including channel and EPG title. A later generation adds its own shows and does not rewrite the observation or delete the earlier shows. `confirmed_tmdb_id` does not insert a Film.

`candidate_decision` is the AIR-48 decision: status, catalog film id, optional Film reference, TMDB id, identity source, provenance, and the attempt fields. `candidate_decision_history` keeps the decision it replaced. `score_result` is not that decision. A verified or terminal ambiguous decision does not need a score row.

Fingerprint, profile, and prediction bodies stay immutable R2 objects addressed by `r2_key` and `content_sha256`. `prediction_history.payload_json` is the full former prediction, and its `r2_key` names that version. It does not point at the mutable `predictions.json` bundle. A localization conflict keeps `source`, `provenance_json`, and `authority` beside the value and reason.

`identity_assertion`, `identity_rule_version`, and `identity_application` are separate from `film`. No workflow writes them yet.

`import_receipt` records one source key and checksum against one target. The same mapping a second time is a duplicate. There is no shared transaction with R2.

## R2 mapping

Until the write cutover, the R2 column is what production reads and writes. The D1 column is the future home, not a second live copy.

| R2 key or source | Future D1 | Role until cutover |
| --- | --- | --- |
| `watchlist.json` | `film`, `watchlist_film` | R2 is the published watchlist |
| `programme.json` shows | `programme_generation`, `film_generation`, `film_show` | R2 is the published generation |
| `epg/published-generation.json` | `published_generation` | R2 is the one current pointer |
| `epg/discovery-latest.json` | `candidate`, `candidate_generation`, `candidate_show` | R2 is the observation ledger |
| `epg/discovery-resolution.json` | `candidate_decision`, `candidate_decision_history` | R2 is the decision record |
| `epg/discovered-films.json` | `film` and `film_external_id` when the row is a Film | The observation key stays a candidate |
| `metadata.json` | `film_dimension` for metadata | R2 cache, not a second identity |
| `titles.json`, `people.json` | provisional `film_dimension` or `person_dimension` | R2 cache |
| Reviewed dictionaries in `data/` | reviewed dimension value and authority | Compiled into the Worker until a later writer |
| `enrichment/films/<id>/fingerprint.json` | `fingerprint_payload` | R2 keeps the body |
| `enrichment/films/<id>/predictions.json` | `prediction_current`, `prediction_history` | R2 keeps each version as its own object |
| `enrichment/films/<id>/actual.json` | `actual_rating` | R2 is the rating record |
| `enrichment/profile/current.json` and `profile/versions/<n>.json` | `profile_version` | R2 keeps the body |
| Raw EPG XML and export archives | no table | R2 archive only |

## Later repositories

These names are the boundary. This pull request does not implement them and does not call them.

| Later card | Reads and writes | Does not |
| --- | --- | --- |
| AIR-70 | `film`, `person`, external ids, redirects, aliases, dimensions, conflicts, `watchlist_film` | score a candidate or choose shows |
| AIR-71 | the current generation pointer, shows, candidates, decisions | mint a Film id from an observation key |
| AIR-72 | fingerprint pointer, profile, prediction current and history, actual rating | change identity |
| AIR-73 | `import_receipt` from a snapshot checksum | write production R2 or production D1 |

## Rollback

Deleting `migrations/0001_schema_v1.sql`, `tests/d1-schema.mjs`, `tests/fixtures/d1-schema-v1.sql`, this document, and the ADR removes the schema. No database is created and no production row moves.
