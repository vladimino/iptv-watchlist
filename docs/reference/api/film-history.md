# Film history — read-only per-film API

`GET /api/enrichment/history?filmId=<id>[&limit=<n>][&cursor=<cursor>]` returns one film's predictions, rating events and Letterboxd Diary viewings as one chronological list. It is owner-only like every Worker path (Cloudflare Access protects the whole Worker; the route adds no bypass and is not exposed through MCP). It only reads R2 and never writes, calls a model, requests Letterboxd, refreshes ratings, takes a lease or schedules work; `tests/get-side-effects.mjs` and `tests/film-history.mjs` check that.

Implementation: `filmHistoryRoute` in `src/enrichment.js` (reads), `buildFilmHistory` and `diaryLink` in `src/domain/film-history.js` (linking, ordering and shape, pure). The [prediction quality API](prediction-quality.md) evaluates these events.

## Request

| Parameter | Rule |
| --- | --- |
| `filmId` | Required. 1–80 letters, digits, `_` or `-`: a stored film id, the Letterboxd `lid` or `tmdb_<n>`. Otherwise 400. |
| `limit` | 1–100, default 50. Otherwise 400. |
| `cursor` | The `page.nextCursor` of the previous page: `<offset>.<digest>`. A malformed cursor is 400. |

## What is read

| Source | Key | Used for |
| --- | --- | --- |
| Prediction bundle | `enrichment/films/<filmId>/predictions.json` | `current` and every replaced record in `history` |
| Immutable prediction versions | the `r2Key` of a record on the returned page | `version.status` of that record (one read per prediction event on the page) |
| Letterboxd fact record | `letterboxd/facts/links.json` (`letterboxd:<lid>` or `tmdb:<n>`), then `letterboxd/facts/films/<factKey>.json` | current rating and `ratingHistory` ([user facts](../integrations/letterboxd-user-facts.md)); a `redirectTo` is followed once; during a convergence (`migrating`) the overlay of source and target is read |
| Legacy rating log | `enrichment/diagnostics/rating-observations.json` | entries for any id of the film (the requested id, the record's `lid` and `tmdb_<n>`), written before the facts gate |
| Taste profile | `enrichment/profile/current.json` | `snapshot.profile` and `current.prediction.matchesCurrentProfile` |
| Diary viewing history | `letterboxd/diary/history.json` | `diary_viewing` events and `current.diary` of the linked lid ([Diary contract](../integrations/letterboxd-diary-history.md)) |
| Diary run state | `letterboxd/diary/state.json` | `snapshot.sources.diary.state` (coverage of the stored history) |

Predictions are stored under the queue's film id; asking by the other id of the same film returns its rating and Diary events but not those predictions.

### Diary link

Diary entries join a film only through their `identity` `{type: 'letterboxd_lid', value}`, never through a slug alias, a title or a TMDB id. The lid candidates are the requested `filmId` when it is not a `tmdb_<n>` id, and the `links.letterboxd` of the fact record read (after a redirect, the target; during a convergence, both source and target).

| `link.status` | When | Diary events |
| --- | --- | --- |
| `linked` | exactly one distinct candidate lid | every entry with that lid; `link.via` names where it came from (`requested_id`, `fact_record` or both, joined by `+`) |
| `ambiguous` | two or more distinct candidates (for example a requested lid whose fact record names another lid) | none: nothing proves which lid is this film |
| `unlinked` | no candidate (a `tmdb_<n>` id without a fact record lid) | none |

Entries without a lid (`identity: null`) are never attributed; `snapshot.sources.diary.unresolvedEntries` counts them across the whole history, because some may be viewings of this film.

## Response

```json
{
  "schemaVersion": 1, "filmId": "<id>", "readAt": "<UTC>",
  "snapshot": {"profile": {"version": 2, "profileHash": "..."},
               "sources": {"predictions": {"status": "recorded"}, "facts": {"status": "recorded", "factKey": "tmdb-348"}, "legacyRatingLog": {"status": "recorded"},
                           "diary": {"status": "recorded", "link": {"status": "linked", "lid": "<lid>", "via": "fact_record+requested_id", "candidates": ["<lid>"]},
                                     "unresolvedEntries": 0, "state": {"lastOutcome": "partial", "lastSuccessAt": "<UTC>", "coverage": {"newestWatchedDate": "2026-09-25", "oldestWatchedDate": "2024-01-02", "reachedEnd": false}, "resumePage": 4}}}},
  "current": {"prediction": {"generatedAt": "...", "contentSha256": "...", "matchesCurrentProfile": true},
              "rating": {"value": 4.5, "observedAt": "...", "source": "owner", "observationId": "...", "watchedAt": null},
              "diary": {"lid": "<lid>", "viewingCount": 2, "viewingCountExact": true, "lastWatchedAt": "2026-09-20", "rewatches": 1, "rewatchesExact": true}},
  "partial": false, "notes": ["prediction_lineage_unknown"],
  "events": [ ... ],
  "page": {"limit": 50, "offset": 0, "total": 10, "nextCursor": null}
}
```

- `sources.*.status` is `recorded`, `missing` or `unreadable` (a stored object that is not JSON). A film with nothing stored answers 200 with every source `missing` and no events.
- `sources.diary.link` is the [Diary link](#diary-link); `sources.diary.state` is the stored run state's `lastOutcome`, `lastSuccessAt`, `coverage` and `resumePage`, or `null` when none is stored.
- `current.diary` is the per-film Diary aggregate of the linked lid (`viewingCount`, `viewingCountExact`, `lastWatchedAt`, `rewatches`, `rewatchesExact`, as in the [Diary read API](../integrations/letterboxd-diary-history.md#read-api)), or `null` when the Diary is not linked or not readable. It is not the current rating.
- `partial` is true when a source (including the Diary history) is unreadable or a prediction on the page has a missing, mismatching or invalid version object.
- `notes` name known gaps of this film's history: `prediction_lineage_unknown` (a record has no `fingerprintPromptVersion` or `runId`; records written before those fields existed), `prediction_without_time`, `rating_history_starts_after_current_value` (a current rating with no recorded history: it was set before the history writer existed), `first_observed_is_not_a_rating_date`. Diary notes:
  - `diary_absence_is_not_unwatched`: always present when the Diary is considered; a film without Diary entries may still have been watched, and a film without `ratingHistory` may still have been rated.
  - `diary_history_missing`, `diary_history_unreadable`: no readable Diary history is stored.
  - `diary_coverage_partial`: a history exists, but the run state does not show a complete read (`lastOutcome: complete`, `coverage.reachedEnd` and no `resumePage`); older entries may be missing.
  - `diary_unlinked`, `diary_identity_disagreement`: the Diary is not linked (see [Diary link](#diary-link)).
  - `diary_viewings_lower_bound`: an entry's `viewings` is not certain, so it is a lower bound.
  - `diary_rewatch_unknown`: an entry, or a row of a day entry, has no re-watch marker.
  - `diary_entry_without_date`: a viewing-id entry has no watched date; it is ordered last.
  - `diary_same_day_order_unknown`: a Diary date coincides with the date of a timed event; their order within that day is a convention (see Events).
  - `diary_entries_may_overlap`: a viewing-id entry and a day entry share a date; they may describe the same viewing, read once without and once with a viewing id. Both are returned, neither is merged by guess.

### Events

Ordered by `at` ascending; ties by type (`prediction`, `rating`, `legacy_rating`, `diary_viewing`), then by `identity`; events without a time come last. Every event has a stable `identity` within the film. Most events carry a UTC instant; a `diary_viewing` carries only a calendar date (`atPrecision: "day"`) and is placed after every instant of the same UTC date and before the next date. The Diary date is the owner's local calendar day, so this placement is a deterministic convention, not a claim about the time of the viewing. Clients must ignore event types they do not know; the order among the other types is unchanged by Diary events.

| `type` | `at` | Fields |
| --- | --- | --- |
| `prediction` | `generatedAt` | `position` (`current` or `history`), `replacedAt` (history only), the stored values of `predictedRating`, `probability4Plus`, `confidence`, `matchSignals`, `mainRisk`, `moodLabels`, `generatedAt`, `tasteProfileVersion`, `tasteProfileHash`, `fingerprintHash`, `fingerprintSchemaVersion`, `fingerprintPromptVersion`, `predictionPromptVersion`, `runId`, `trigger`; `missingFields` (those that are `null`); `version` |
| `rating` | the entry's `recordedAt` (else `at`, else `observedAt`) | `kind` (`first_observed`, `changed`, `rolled_back`), `value`, `observedAt`, `source`, `sourceRef`, `observationId`, `previous`, `restored` (rollback only), `recordedAt`, `watchedAt: null` |
| `legacy_rating` | `observedAt` | `before`, `after`, `observedAt`, `source`, `generationId`, `programmeRunId`, `watchedAt: null` |
| `diary_viewing` | `watchedDate` (`YYYY-MM-DD`, `atPrecision: "day"`), or `null` | `watchedDate`, `sourceKey` (the Diary entry key: `viewing:<id>` or `day:<lid:…\|slug:…>\|<date>`), `keyBasis`, `viewingId`, `viewings`, `viewingsCertain`, `ratingAtEntry`, `ratingsAtEntry`, `rewatch` (`true`, `false` or `unknown`), `rewatchRows` and `rewatchUnknownRows` (day entries; `null` for viewing-id entries), `lid`, `linkedVia`, `slugs` (`[{value, firstObservedAt}]`, observed slugs as provenance, `firstObservedAt` `null` for older aliases), `firstObservedAt`, `observedAt`, `page`, `changes` (`{field, from, to, observedAt}`) |

- Each prediction event carries the rationale (`matchSignals`, `mainRisk`, `moodLabels`) and versions **of that record**, never the current ones. A field the record does not hold is `null` and listed in `missingFields`; nothing is filled from today's state.
- `version.status`: `none` (no pointer; written before immutable versions or with the flag off), `linked` (the object exists and its bytes hash to `contentSha256`), `missing`, `mismatch`, `invalid` (a pointer that does not name this film's version key).
- `observedAt` is when a value was seen, `generatedAt` when a prediction was made; neither is a watch date, and `watchedAt` of rating events is always `null` because the rating sources record none. Only a `diary_viewing` carries a watch date, its `watchedDate`; its `observedAt` and `firstObservedAt` are when the Diary was read.
- A `diary_viewing` is one Diary entry. A day entry with several viewings stays one event with its `viewings` count and `ratingsAtEntry` in diary order; it is never split into separate invented viewings. `ratingAtEntry` is the rating shown on that entry, never a rating observation and never the current rating. A `first_observed` rating existed before it was observed. A rollback and a later re-application of the same observation are separate events. The legacy log's account URL is not returned.

### Paging

`page.nextCursor` is `null` on the last page. The cursor binds the offset to a digest of the bundle, fact record, legacy log and, once one is stored, Diary history versions it was issued for (a film read before any Diary history existed keeps the same cursor form); if any of them changed since, the next page is refused with 409 `history_changed`, and the client starts again without a cursor. Pages are never mixed from two versions of the history.
