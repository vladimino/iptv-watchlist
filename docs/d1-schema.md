# D1 schema v1

[AIR-49](https://trello.com/c/YNaLFwtW) is this schema and the storage boundary. `migrations/0001_schema_v1.sql` is the only schema. It is not bound in `wrangler.jsonc`, the Worker does not open it, and nothing in this repository applies it to production. R2 bucket `iptv` remains the authoritative store.

[AIR-70](https://trello.com/c/8PRWRx2C), [AIR-71](https://trello.com/c/UAUUQ2jh), and [AIR-72](https://trello.com/c/MfAGc1Dd) are the later repositories. [AIR-73](https://trello.com/c/gX2xdQAz) is the later offline importer. Live backfill starts only at [AIR-74](https://trello.com/c/5AdAmKPe), after [AIR-69](https://trello.com/c/FlcWZX7W). [AIR-42](https://trello.com/c/drLBuWjl) still owns identity transitions, [AIR-43](https://trello.com/c/7NY6n1Az) still owns scoring, and [AIR-48](https://trello.com/c/rVf8rRoJ) still owns which observation is current. This schema does not copy those rules. [AIR-53](https://trello.com/c/gkuy1awG) is not built here.

Versioning and recovery are in [ADR 0001](adr/0001-d1-schema-v1.md).

## What is stored where

An observation key such as `heat|1995` is a `candidate` row. It is not a `film.id`. `film.id` starts with `film:`. A trusted external id is unique. A redirect keeps the retired id without creating a second Film. `accepted_tmdb_id` on a score does not reference `film`.

A generation has a phase of `published` or `withheld`. `published_generation` is the one current pointer, the same role as `epg/published-generation.json`. Moving it from generation A to generation B leaves A's rows in place. `published_film_show` reads only that pointer, and only when the pointed generation is `published`. `film_generation` is the membership row. Zero `film_show` rows under that membership are an explicit empty show list. A film show keeps `channel`, `epg_title`, `basis`, and `match_reason`, so a `title_duration` showing still explains the cautious mark. `film_epg_last_airing` is a historical fact and is not a show.

`candidate` is the latest observation: title, normalized title, year, raw titles, durations, description, airings, and `confirmed_tmdb_id`. A later broadcast may change that row. `candidate_generation` keeps the `observation_json`, schema version, and `evidence_key` for the generation that was scored, so generation A stays reconstructable after generation B. Shows for that generation stay on `candidate_show`. `confirmed_tmdb_id` does not insert a Film.

`film_metadata.payload_json` is the watchlist and `parseFilm` record: year, runtime, genres, synopsis, poster, and url. `film_person_credit` orders the director and the cast. `film_dimension` remains the lifecycle status and is not that record. `people.json` remains the name cache, not the credit edges.

`candidate_decision` is the AIR-48 decision: status, catalog film id, optional Film reference, TMDB id, identity source, provenance, and the attempt fields. `candidate_decision_history` keeps the decision it replaced. `score_result` is not that decision. A verified or terminal ambiguous decision does not need a score row.

Fingerprint, profile, and prediction bodies stay immutable R2 objects addressed by `r2_key` and `content_sha256`. `prediction_history.payload_json` is the full former prediction, and its `r2_key` names that version. It does not point at the mutable `predictions.json` bundle. A localization conflict keeps `source`, `provenance_json`, and `authority` beside the value and reason.

`identity_assertion`, `identity_rule_version`, and `identity_application` are separate from `film`. No workflow writes them yet.

`import_receipt` records one source key and checksum against one target. The same mapping a second time is a duplicate. There is no shared transaction with R2.

## R2 mapping

Until the write cutover, the R2 column is what production reads and writes. The D1 column is the future home, not a second live copy.

| R2 key or source | Future D1 | Role until cutover |
| --- | --- | --- |
| `watchlist.json` | `film`, `watchlist_film`, `film_metadata`, `film_person_credit` | R2 is the published watchlist |
| `programme.json` shows | `programme_generation`, `film_generation`, `film_show` | R2 is the published generation |
| `programme.json` film body | `film_metadata`, `film_person_credit` | Same catalog record as the watchlist film |
| `epg/published-generation.json` | `published_generation` | R2 is the one current pointer |
| `epg/discovery-latest.json` | `candidate`, `candidate_generation`, `candidate_show` | `candidate` is latest; each generation keeps its observation |
| `epg/discovery-resolution.json` | `candidate_decision`, `candidate_decision_history` | R2 is the decision record |
| `epg/discovered-films.json` | `film` and `film_external_id` when the row is a Film | The observation key stays a candidate |
| `metadata.json` | `film_metadata`, `film_person_credit`; `film_dimension` is only the lifecycle status | R2 cache of the same catalog record |
| `titles.json`, `people.json` | provisional `film_dimension` or `person_dimension` | R2 name cache, not the credit edges |
| Reviewed dictionaries in `data/` | reviewed dimension value and authority | Compiled into the Worker until a later writer |
| `enrichment/films/<id>/fingerprint.json` | `fingerprint_payload` | R2 keeps the body |
| `enrichment/films/<id>/predictions.json` | `prediction_current`, `prediction_history` | R2 keeps each version as its own object |
| `enrichment/films/<id>/actual.json` | `actual_rating` | R2 is the rating record |
| `enrichment/profile/current.json` and `profile/versions/<n>.json` | `profile_version` | R2 keeps the body |
| Raw EPG XML and export archives | no table | R2 archive only |

## EPG repository

[AIR-71](https://trello.com/c/UAUUQ2jh) is `src/epg-repository.js`. The Worker bundle does not include it, and it does not open R2 or a production D1 database. The caller passes a database. [AIR-43](https://trello.com/c/7NY6n1Az) still decides whether a score is accepted. [AIR-48](https://trello.com/c/rVf8rRoJ) still decides which observation is current. This module stores the result.

`publishGeneration` writes a new generation's film shows and candidate shows, including an explicit empty list, and the observation snapshot for that generation. A new `published` run must name the generation it succeeds (`expectedProgrammeRunId`, null only when nothing is published). That check is a statement in the same write: a delayed run that still names an older pointer is rejected and writes nothing. Replaying a committed run with the same payload does nothing, and a different payload for that run is rejected. A withheld generation stores its snapshot and shows without changing the latest candidate projection or the pointer. A candidate omitted from a new published generation keeps its observation and decision, loses `seen_in_latest`, and is no longer `current`. An empty show list does not clear `film_epg_last_airing`. When the published evidence key changes, the projection clears its terminal reason, retry time, attempt count, and last attempt time. The decision row stays until a decision for the new evidence is accepted.

`recordDecision` writes only when the published pointer, the generation membership, and the evidence key match, and that predicate is part of the same write. `applied` is true only when that fence still matches and the stored decision equals the input. An identical earlier decision for a candidate omitted from the current generation is rejected. A terminal decision is replaced only when the published generation carries a new evidence key. This is not a historical import. `recordScore` inserts a score in that same write only when both its id and its observation, generation, and scorer version are absent. Considered rows and the detail are inserted only when that statement inserted the parent, so a rejected repeat cannot append them. The call accepts the result only when this id is the stored row and the body matches. `score_result` already has that triple as a table unique key, so a second id cannot commit. An accepted score does not become a verified decision and does not insert a Film. An observation key that starts with `film:` or `person:` is rejected.

One publish, decision, or score is one database transaction. A failed statement leaves the earlier commit in place and does not leave the failed call half-written.

## Canonical repository

[AIR-70](https://trello.com/c/8PRWRx2C) is `src/canonical-repository.js`. The Worker bundle does not include it, and it does not open R2 or a production D1 database. The caller passes a database and the Film or Person view already produced by the lifecycle contract. [AIR-42](https://trello.com/c/drLBuWjl) still decides a link, a reviewed value, and an identity collision. This module stores that result.

`saveFilm` and `savePerson` replace the external ids, aliases, credits, and dimension rows for that record in one transaction. A repeated payload does not add another alias, credit, external id, conflict, or redirect. A stored `reviewed` localization stays in place unless the incoming localization is itself `reviewed` from `dictionary` or `owner`. A weaker value is kept as one alias and one conflict. Two records cannot both hold the same trusted external id. The second write is rejected and does not insert that record.

`applyLink` stores the survivor and, in that same transaction, retires the other id: its external ids are released, its row and canonical children are removed, and `film_redirect` points at the survivor. A read of the retired id follows the redirect. Watchlist membership moves to the survivor. A film that already belongs to a generation, or that has an EPG last-airing row, is not retired. Replaying the same link does nothing extra. A failed statement, including a credit whose person is absent, leaves the previous commit unchanged.

The module does not insert a candidate, a score, a programme generation, or prediction history. AIR-72 and AIR-73 are not implemented. None of these repositories run in production.

| Card | Reads and writes | Does not |
| --- | --- | --- |
| AIR-70 | `film`, `person`, credits, `film_metadata`, external ids, redirects, aliases, dimensions, conflicts, `watchlist_film` | score a candidate or choose shows |
| AIR-71 | the current generation pointer, shows, candidates, decisions, scores | mint a Film id from an observation key |
| AIR-72 | fingerprint pointer, profile, prediction current and history, actual rating | change identity |
| AIR-73 | `import_receipt` from a snapshot checksum | write production R2 or production D1 |

## Rollback

Deleting `migrations/0001_schema_v1.sql`, `tests/d1-schema.mjs`, `tests/fixtures/d1-schema-v1.sql`, this document, and the ADR removes the schema. Deleting `src/epg-repository.js` removes the local EPG adapter. Deleting `src/canonical-repository.js` and `tests/canonical-repository.mjs` removes the local Film and Person adapter. No database is created and no production row moves.
