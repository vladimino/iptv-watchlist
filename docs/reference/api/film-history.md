# Film history — read-only per-film API

`GET /api/enrichment/history?filmId=<id>[&limit=<n>][&cursor=<cursor>]` returns one film's predictions and rating events as one chronological list. It is owner-only like every Worker path (Cloudflare Access protects the whole Worker; the route adds no bypass and is not exposed through MCP). It only reads R2 and never writes, calls a model, refreshes ratings, takes a lease or schedules work; `tests/get-side-effects.mjs` and `tests/film-history.mjs` check that.

Implementation: `filmHistoryRoute` in `src/enrichment.js` (reads), `buildFilmHistory` in `src/domain/film-history.js` (ordering and shape, pure). The [prediction quality API](prediction-quality.md) evaluates these events.

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

Predictions are stored under the queue's film id; asking by the other id of the same film returns its rating events but not those predictions.

## Response

```json
{
  "schemaVersion": 1, "filmId": "<id>", "readAt": "<UTC>",
  "snapshot": {"profile": {"version": 2, "profileHash": "..."},
               "sources": {"predictions": {"status": "recorded"}, "facts": {"status": "recorded", "factKey": "tmdb-348"}, "legacyRatingLog": {"status": "recorded"}}},
  "current": {"prediction": {"generatedAt": "...", "contentSha256": "...", "matchesCurrentProfile": true},
              "rating": {"value": 4.5, "observedAt": "...", "source": "owner", "observationId": "...", "watchedAt": null}},
  "partial": false, "notes": ["prediction_lineage_unknown"],
  "events": [ ... ],
  "page": {"limit": 50, "offset": 0, "total": 10, "nextCursor": null}
}
```

- `sources.*.status` is `recorded`, `missing` or `unreadable` (a stored object that is not JSON). A film with nothing stored answers 200 with every source `missing` and no events.
- `partial` is true when a source is unreadable or a prediction on the page has a missing, mismatching or invalid version object.
- `notes` name known gaps of this film's history: `prediction_lineage_unknown` (a record has no `fingerprintPromptVersion` or `runId`; records written before those fields existed), `prediction_without_time`, `rating_history_starts_after_current_value` (a current rating with no recorded history: it was set before the history writer existed), `first_observed_is_not_a_rating_date`.

### Events

Ordered by `at` ascending; ties by type (`prediction`, `rating`, `legacy_rating`), then by `identity`; events without a time come last. Every event has a stable `identity` within the film.

| `type` | `at` | Fields |
| --- | --- | --- |
| `prediction` | `generatedAt` | `position` (`current` or `history`), `replacedAt` (history only), the stored values of `predictedRating`, `probability4Plus`, `confidence`, `matchSignals`, `mainRisk`, `moodLabels`, `generatedAt`, `tasteProfileVersion`, `tasteProfileHash`, `fingerprintHash`, `fingerprintSchemaVersion`, `fingerprintPromptVersion`, `predictionPromptVersion`, `runId`, `trigger`; `missingFields` (those that are `null`); `version` |
| `rating` | the entry's `recordedAt` (else `at`, else `observedAt`) | `kind` (`first_observed`, `changed`, `rolled_back`), `value`, `observedAt`, `source`, `sourceRef`, `observationId`, `previous`, `restored` (rollback only), `recordedAt`, `watchedAt: null` |
| `legacy_rating` | `observedAt` | `before`, `after`, `observedAt`, `source`, `generationId`, `programmeRunId`, `watchedAt: null` |

- Each prediction event carries the rationale (`matchSignals`, `mainRisk`, `moodLabels`) and versions **of that record**, never the current ones. A field the record does not hold is `null` and listed in `missingFields`; nothing is filled from today's state.
- `version.status`: `none` (no pointer; written before immutable versions or with the flag off), `linked` (the object exists and its bytes hash to `contentSha256`), `missing`, `mismatch`, `invalid` (a pointer that does not name this film's version key).
- `observedAt` is when a value was seen, `generatedAt` when a prediction was made; neither is a watch date, and `watchedAt` is always `null` because no source records one. A `first_observed` rating existed before it was observed. A rollback and a later re-application of the same observation are separate events. The legacy log's account URL is not returned.

### Paging

`page.nextCursor` is `null` on the last page. The cursor binds the offset to a digest of the bundle, fact record and legacy log versions it was issued for; if any of them changed since, the next page is refused with 409 `history_changed`, and the client starts again without a cursor. Pages are never mixed from two versions of the history.
