# AIR-504: ADR 0150 reclassification of the AIR-500 admission inventory

**Captured:** reclassified 2026-11-16 from the AIR-500 D1 read (2026-11-15 23:32–23:44 UTC / 16 November 2026 00:32–00:44 Europe/Madrid). No new production SELECT, no Worker GET, no MCP write, no TMDB call.
**Used by:** [AIR-504](https://trello.com/c/jUaNE1Rs). Inventory only. This report does not authorize `catalog_policy_exclude` against production.
**Code read:** ADR 0150 on `main` after AIR-501; source audit [AIR-500](air-500-false-film-identity-audit-2026-11-16.md).
**Verdict:** identity_correct is not sufficient. Documentary-only and Music+Documentary current admissions, and Music-only titles with an explicit performance phrase, are in-scope for the new writer after an owner GO per film. Ambiguous Live tokens are not.

## Why identity_correct is not enough

`discovery_identity_correct` rejects one observation. It does not change `discovery_admission`. `refreshPredictionQueue` rebuilds from current admissions plus the watchlist, so a rejected concert film returns to the hot queue. AIR-504 therefore adds `catalog_policy_exclude@1` ([ADR 0152](../../adr/0152-catalog-policy-exclusion.md)).

## Reclassification of the 9 832 AIR-500 current movie admissions

AIR-500 used ADR 0149, so Music-only concert films stayed `needs_review` and Documentary-only stayed `valid_film`. Under ADR 0150, using only fields already in that report (genre display names, titles, overviews were not stored for every row):

| Class | Count in AIR-500 | ADR 0150 | AIR-504 disposition |
| --- | --- | --- | --- |
| Documentary-only (`документальный` / equivalent, no other genre) | 67 | `documentary` | Eligible for policy exclude after owner GO. Do not delete ratings if a `ratings_view` row exists |
| Music+Documentary only | 23 | `documentary` (Documentary wins) | Same |
| Music-only | 39 | concert if a title performance phrase; `concert_recording_ambiguous` if only a bare Live/Concert token; otherwise still a Music feature | Named Live-at / Concert examples below are `concert`. Two AIR-500 `valid_film` Music-only titles without concert/live/tour/festival labels stay films |
| TV Movie never alone | 226 | not concert from genre alone | Out of scope unless a later read shows independent title+overview phrases |
| Feature films, including Music plus Drama | rest | not excluded | Out of scope |

XMLTV `categories` were empty on every active observation in AIR-500, so a concert category is not available as corroboration. Title `Live at` / `in concert` on a Music-only card is enough under ADR 0150.

## Hot queue examples (AIR-500 named rows)

None of these four had a `ratings_view` row or a fingerprint/prediction pointer in that capture. Watchlist flag was absent. They are the first candidates for an owner GO after this code deploys; this report does not execute them.

| film_id | AIR-500 verdict | ADR 0150 | Why |
| --- | --- | --- | --- |
| `tmdb_1326142` | needs_review | `concert` | Music-only, title contains `Live at` |
| `tmdb_238858` | needs_review | `concert` | Music-only, title contains `Concert` and `Live in` |
| `tmdb_1356259` | named with the hot queue in the AIR-504 card | treat as concert only after preview | Preview must re-read the live payload |
| `tmdb_252384` | named with the hot queue in the AIR-504 card | treat as concert only after preview | Preview must re-read the live payload |

A documentary example that already has a prediction (`tmdb_686970` in session notes) keeps that immutable body if excluded; the queue drop is the catalog/admission change, not a delete of `prediction_pointer`.

## What a later execute must leave untouched

Published EPG generation and `title_year` / `title_unique` / `title_duration` shows. Letterboxd ratings and watchlist facts. Fingerprint and prediction version objects. Film/Person R2 sources while that domain stays `prepared`.

## Uncertainty

Live generation, queue place and admission payloads may have moved since the AIR-500 snapshot. `ownerPolicyExclude` re-reads the current admission and refuses when the payload is no longer ADR 0150 `documentary` or `concert`.
