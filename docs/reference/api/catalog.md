# Catalog of available films outside the watchlist

`GET /api/catalog/available` is a read-only query over the published EPG generation. It returns the verified catalog films that are **not** on the watchlist, are available now, in the 72-hour catch-up or within the next 24 hours, and carry a prediction that is current for the current taste profile. It is the shared source for discovery surfaces such as a "finds" section or similar-film suggestions; those consumers rank and present, this route only decides eligibility and returns a minimal display record.

The route does not change `GET /api/programme` or `GET /api/watchlist`, which keep serving the watchlist catalogue. It performs no R2 write, no model call, no TMDB call and no sync; the [GET side-effect test](../../../tests/get-side-effects.mjs) covers it like every other read.

## What it reads

| Object | Use |
| --- | --- |
| `epg/published-generation.json` | The generation pin. When the pointer names a published generation, the programme and the catalog are read **only** from that generation's copies (`epg/generations/<runId>/…`); an absent copy fails closed with `409` instead of falling back to the shared public keys, even when those keys already carry the new run id |
| `programme.json` | The watchlist films of that generation (exclusion by id and TMDB identity) and the run id the response is pinned to |
| `epg/discovered-films.json` | The catalog records: identity, display fields, credits, the shows of the generation that last confirmed them |
| `watchlist.json` | Further watchlist ids and TMDB identities to exclude, including films without a programme show |
| `enrichment/view-index.json` | The stored current prediction, the fingerprint facet and the actual rating per film |
| `enrichment/profile/current.json` | The profile version and hash a prediction must match to be current |

The ratings seed compiled into the Worker is applied to an in-memory copy of the view index. Unlike `GET /api/enrichment/view`, this route never writes that seed back. `started/` markers are not consulted: they belong to the watchlist UI and are not a watched signal for catalog films.

## Eligibility

A catalog record is returned only when every rule holds:

1. **Verified identity.** The record has a `tmdbId` and `canonicalIdentity` equal to `tmdb:<tmdbId>`. An observation key or a record without a verified identity is not a film here.
2. **Outside the watchlist.** Neither its id nor its TMDB identity appears among the programme's films or the watchlist's films. A watchlist film without a scheduled show is still a watchlist film.
3. **Not rated.** The view index has no `actualRating` for it, after the compiled ratings seed.
4. **Current prediction.** The stored prediction matches the current profile version and hash, the stored fingerprint hash, fingerprint schema version 1 and prediction prompt version 1. Without a profile nothing is current and the list is empty.
5. **Real shows of the pinned generation.** The record's `shows` were written by the pinned generation (`showsProgrammeRunId` equals the response's `programmeRunId`). Shows carried over from an earlier generation are not availability in the new one. `epgLastAiring` alone is not a show.
6. **Inside the window.** At least one show starts strictly after `now − 72h` and strictly before `now + 24h`. A start exactly 72 hours ago has expired; a start exactly 24 hours ahead is outside the horizon. Only shows inside the window are returned.

One entry per canonical identity: when two records share a TMDB identity, the one whose availability ends later is kept, then the smaller id. The list is ordered by `availableUntil`, then id, so the same stored state always produces the same order.

## Response

```json
{
  "programmeRunId": "…",
  "pinned": true,
  "generatedAt": "2026-06-15T10:00:00.000Z",
  "window": {"from": "2026-06-12T10:00:00.000Z", "to": "2026-06-16T10:00:00.000Z"},
  "profile": {"version": 1},
  "total": 1,
  "films": [{
    "id": "tmdb_7", "tmdbId": "7", "canonicalIdentity": "tmdb:7",
    "title": "…", "original": "…", "year": 2020, "runtime": 100, "genres": ["Драма"], "poster": "https://…", "url": "https://www.themoviedb.org/movie/7",
    "directors": [{"id": "tmdb_director/1", "name": "…"}], "actors": [{"id": "tmdb_actor/2", "name": "…"}],
    "shows": [{"channelId": "c1", "channel": "One", "start": 1760000000000, "end": 1760007200000, "status": "archive"}],
    "availableNow": true, "nextStart": 1760100000000, "availableUntil": "2026-06-18T12:00:00.000Z",
    "prediction": {"predictedRating": 4.5, "probability4Plus": 0.74, "confidence": "high", "matchSignals": ["…"], "mainRisk": "…", "moodIds": ["dark"]},
    "fingerprint": {"plotMechanics": ["investigation"], "moodIds": ["dark"], "execution": {"payoff": "strong"}}
  }],
  "channels": [{"channelId": "c1", "channel": "One", "films": 1}]
}
```

| Field | Meaning |
| --- | --- |
| `programmeRunId`, `pinned` | The generation the response is derived from. `pinned: false` means no published pointer existed and the programme's own run id was used |
| `generatedAt`, `window` | The clock the statuses were derived with and the availability envelope `(now − 72h, now + 24h)` |
| `profile` | The profile version predictions were checked against, or `null` |
| `films[].shows[].status` | `archive` (started and ended, still inside the 72-hour catch-up), `on_air` (started, not ended), `future` (not started) |
| `films[].availableNow` | Some returned show has started |
| `films[].nextStart` | The earliest returned show that has not started, or `null` |
| `films[].availableUntil` | The latest returned start plus 72 hours, when the last catch-up ends |
| `films[].prediction` | The stored current prediction: rating, probability of 4+, confidence, match signals, main risk and the canonical mood ids |
| `films[].fingerprint` | The fingerprint facet (plot mechanics, mood ids, the general execution dimensions without `unknown` / `not_applicable`) when the stored fingerprint is the one the prediction was made from, otherwise `null` |
| `channels` | One row per channel id with the number of returned films that have a show on it, for channel and period filters on the client |

Not included on purpose: synopsis, aliases, the raw prediction and fingerprint objects, the mood vocabulary (served by `GET /api/enrichment/view`), and any ranking. Thresholds, ordering for display and franchise de-duplication are consumer decisions.

## Consumers

The watchlist page's **«Находки»** section (`public/app.js`, `#finds`) is the first consumer. It reads this route on page load and with the other live refreshes and never adds a show or a prediction of its own. A cached answer is shown only while the loaded programme's run id equals the answer's `programmeRunId`: when the programme moves to a new generation the section is hidden until this route answers for that generation (a `409` during publication keeps it hidden), and an answer for a generation the programme has not reached yet waits for the programme; a failed refresh on the same generation keeps the last answer. On every render it re-checks each returned film against the loaded programme and view index (a film that has since entered the watchlist or received an actual rating disappears), re-derives the shows inside `(now − 72h, now + 24h)` with the browser clock (an expired catch-up hides the film without a new request), and keeps only a current prediction with `predictedRating ≥ 4.0`, `probability4Plus ≥ 0.70` and a known `confidence` other than `low`. The remaining films are ordered by `predictedRating`, then `probability4Plus`, then the nearest end of availability; one entry per canonical identity; an adjacent franchise part (same title stem after a trailing sequel number or «часть N») with identical rating and probability is skipped; at most five are shown and the list is never padded with weaker films. The section is hidden entirely when nothing qualifies. Each card carries the `NEW` badge at the top left of the poster, meaning a film outside the watchlist, not a new release; the usual title, year, poster and prediction; up to two mechanic or mood labels from `fingerprint` and `prediction.moodIds`; and the relevant airing (on air now, the next start, or the catch-up deadline). The title links to `url` on TMDB because the film has no page in the watchlist route. Channel scoping and contextual ranking are separate consumers and do not change this route.

## Errors

| Status | Body | When |
| --- | --- | --- |
| `503` | `{"error":"No published programme"}` | No programme has been published yet |
| `409` | `{"error":"Programme generation is not in place"}` | The pointer names a generation whose programme copy is absent or carries another run id (publication still copying); call again later rather than serving the previous generation or the shared public key |
| `409` | `{"error":"Catalog generation copy is not in place"}` | The pointer names a generation whose catalog copy is absent; the shared public catalog is not used as a substitute |

Without a published pointer the shared public keys are read and `pinned` is `false`. A missing view index or profile is not an error: the list is empty; a missing catalog is empty only when unpinned.

## Size and freshness

The response holds every eligible film of the pinned generation, so its size is bounded by the hot part of the catalog. Statuses and `availableUntil` are computed at request time; a client that caches the response must re-derive them from `shows[].start`/`end` with its own clock or request again. A new profile version empties the list until predictions are refreshed, which is the intended fail-closed behaviour: a stale prediction is never offered as current.
