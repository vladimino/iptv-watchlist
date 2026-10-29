# Catalog of available films outside the watchlist

`GET /api/catalog/available` is a read-only query over the published EPG generation. It returns the verified catalog films that are **not** on the watchlist and that the owner has neither watched nor rated (and, through the [display-only title exclusion](#display-only-title-exclusion), that do not match a private list of watched films without a proven identity), are available now, in the 72-hour catch-up or within the next 24 hours, and carry a prediction that is current for the current taste profile. It is the shared source for discovery surfaces such as a "finds" section or similar-film suggestions; those consumers rank and present, this route only decides eligibility and returns a minimal display record.

The route does not change `GET /api/programme` or `GET /api/watchlist`, which keep serving the watchlist catalogue. It performs no R2 write, no model call, no TMDB call and no sync; the [GET side-effect test](../../../tests/get-side-effects.mjs) covers it like every other read.

## What it reads

| Object | Use |
| --- | --- |
| `epg/published-generation.json` | The generation pin. When the pointer names a published generation, the programme and the catalog are read **only** from that generation's copies (`epg/generations/<runId>/…`); an absent copy fails closed with `409` instead of falling back to the shared public keys, even when those keys already carry the new run id |
| `programme.json` | The watchlist films of that generation (exclusion by id and TMDB identity) and the run id the response is pinned to |
| `epg/discovered-films.json` | The catalog records: identity, display fields, credits, the shows of the generation that last confirmed them |
| `watchlist.json` | Further watchlist ids and TMDB identities to exclude, including films without a programme show |
| `enrichment/view-index.json` | The stored current prediction and fingerprint facet, and the owner's `watched` and `actualRating` per id (see [Watched and rated films](#watched-and-rated-films)) |
| `enrichment/profile/current.json` | The profile version and hash a prediction must match to be current |
| `letterboxd/display-exclusion.json` | On every request: the private list of normalized names and years for the [display-only title exclusion](#display-only-title-exclusion) |
| `metadata.json` | The Letterboxd metadata cache of films that are or were on the watchlist, read for the stored TMDB id of a Letterboxd id (see [Watched and rated films](#watched-and-rated-films)) and for a poster fallback: a catalog record without its own TMDB poster takes the cached `https://` poster of the record with the same stored id (whose cached TMDB id is the same or absent), or of the same TMDB id. Every cached record for that stored id, and every cached record for that TMDB id, must carry the same poster: once two disagree the key stays conflicted regardless of further records or their order, and a conflicted TMDB identity yields no poster even through the stored-id match. No other field is taken from it and nothing is fetched |

The ratings seed compiled into the Worker is applied to an in-memory copy of the view index. Unlike `GET /api/enrichment/view`, this route never writes that seed back. `started/` markers are not consulted: they belong to the watchlist UI and are not a watched signal for catalog films.

## Eligibility

A catalog record is returned only when every rule holds:

1. **Verified identity.** The record has a `tmdbId` and `canonicalIdentity` equal to `tmdb:<tmdbId>`. An observation key or a record without a verified identity is not a film here.
2. **Outside the watchlist.** Neither its id nor its TMDB identity appears among the programme's films or the watchlist's films. A watchlist film without a scheduled show is still a watchlist film.
3. **Not watched and not rated.** Neither the record's own id nor any other id of the same TMDB film is watched or rated in the view index, after the compiled ratings seed. See [Watched and rated films](#watched-and-rated-films).
4. **Current prediction.** The stored prediction matches the current profile version and hash, the stored fingerprint hash, fingerprint schema version 1 and prediction prompt version 1; a prediction the shared evaluator keeps across profile versions also counts ([prediction compatibility](../domain/prediction-compatibility.md#one-rule-for-every-consumer)). Without a profile nothing is current and the list is empty.
5. **Real shows of the pinned generation.** The record's `shows` were written by the pinned generation (`showsProgrammeRunId` equals the response's `programmeRunId`). Shows carried over from an earlier generation are not availability in the new one. `epgLastAiring` alone is not a show.
6. **Inside the window.** At least one show starts strictly after `now − 72h` and strictly before `now + 24h`. A start exactly 72 hours ago has expired; a start exactly 24 hours ahead is outside the horizon. Only shows inside the window are returned.
7. **Not hidden by the display-only title exclusion**, when its list is valid. See [Display-only title exclusion](#display-only-title-exclusion).

### Watched and rated films

A view-index entry is **consumed** when it has `watched: true` or a non-null `actualRating`. `watched: false` alone, or `actualRating: null` alone (a watchlist film the films list shows without a rating, or an explicitly cleared rating), is not. A rated film is never returned, so a prediction never stands in for an actual rating, and the response carries no `watched` or `actualRating` field.

A catalog record is excluded when its own entry is consumed, or when any consumed entry belongs to the same TMDB film:

- an entry keyed `tmdb_<n>` belongs to TMDB id `n`;
- an entry keyed by a Letterboxd id belongs to the TMDB id stored for that Letterboxd id in `metadata.json`, in `watchlist.json`, in the programme or on a verified catalog record with that id, and only while every one of those stored values is the same. A Letterboxd id with two different stored TMDB ids, or with none, excludes only a catalog record with that very id.

Titles, years and aliases are never compared, so a remake or a namesake of a watched film is still offered. A watched export film without an accepted identity is therefore not excluded by this rule; the separate [display-only title exclusion](#display-only-title-exclusion) covers part of those films and never counts as identity. The same reading works with either value of `LETTERBOXD_FACTS`: with the gate on, the [fact projection](../integrations/letterboxd-user-facts.md#projections) writes `watched` and `actualRating` under every trusted alias of a film (its Letterboxd id and `tmdb_<n>`), and the stored TMDB id covers a record that has only its Letterboxd id; with the gate off, the legacy index holds ratings under the Letterboxd id and the stored TMDB id carries them to the `tmdb_<n>` record. The route reads neither the fact records nor the link index, so it stays a bounded read of fixed keys. Watchlist exclusions are unchanged and independent of these facts: a watched film that is on the watchlist again (a rewatch) stays on the watchlist and is excluded as a watchlist film.

One entry per canonical identity: when two records share a TMDB identity, the one whose availability ends later is kept, then the smaller id. The list is ordered by `availableUntil`, then id, so the same stored state always produces the same order.

### Display-only title exclusion

A separate, weaker rule hides a catalog film that matches a watched or rated Letterboxd export film which has no accepted identity ([ADR-0028](../../adr/0028-finds-display-only-watched-exclusion.md); namesake guards relaxed for the `strict_original_exact_year_v2` tag by [ADR-0033](../../adr/0033-finds-exclusion-namesake-relaxation.md)). It only removes the film from this response: it writes nothing, links no Letterboxd id to a TMDB id, records no fact or rating, and no other route reads it. The watchlist, the programme, predictions and the taste profile are unaffected.

**No switch.** The rule runs on every request ([ADR 0041](../../adr/0041-retire-finds-title-exclusion-switch.md)). The former `FINDS_TITLE_EXCLUSION` variable is retired and inert whatever it holds (see the [flag register](../feature-flags.md)). Whether films are hidden depends only on the list object: without a valid list nothing is hidden.

**The list.** One private R2 object, replaced only as a whole, built offline by `scripts/letterboxd-display-exclusion.mjs` and placed by a separately approved operation ([runbook](../../runbooks/finds-display-exclusion.md)); the Worker has no writer for it.

The builder writes the `strict_original_exact_year_v2` tag. It lists a watched or rated export film that has no accepted identity, a year and a non-empty normalized name. When other export films (in any list, identified or not) share that name, it lists the film only if every one of them has a year, the watched or rated ones have pairwise different years, and every watchlist-only one is at least two years from every watched or rated one; otherwise the name is dropped as a whole (`droppedExportNamesake`). `keptExportNamesake` counts the entries whose name the export carries more than once. A list with the legacy `strict_original_exact_year` tag, built when every repeated name was dropped, is still read with the legacy catalog guard below.

```json
{"schemaVersion": 1, "kind": "letterboxd_display_exclusion", "rule": "strict_original_exact_year_v2", "normalization": "normTitle_v1",
 "source": {"type": "letterboxd_export", "archiveSha256": "<64 hex>", "exportedAt": "<ISO time>", "baselinePlanSha256": "<64 hex>"},
 "builtAt": "<ISO time>", "counts": {"exportFilms": 0, "withIdentity": 0, "droppedNoYear": 0, "droppedNoName": 0, "droppedExportNamesake": 0, "keptExportNamesake": 0, "entries": 0},
 "entries": [{"title": "<normalized name>", "year": 2000}], "contentSha256": "<sha256 of JSON.stringify(entries)>"}
```

The list is used only when every check passes; otherwise the rule is `unavailable` for that request, every film is shown and the route still answers `200`:

- the R2 object size is at most 2 MiB, checked before the body is read or parsed, and the body is valid JSON;
- exactly the keys above at the top level and in `source`; `schemaVersion`, `kind` and `normalization` have exactly the values above, and `rule` is `strict_original_exact_year` (legacy) or `strict_original_exact_year_v2`; any other tag is invalid; `source.type` is `letterboxd_export` with lowercase 64-hex `archiveSha256` and `baselinePlanSha256`;
- `exportedAt` and `builtAt` are ISO dates, `exportedAt` is not after `builtAt`, and `builtAt` is not more than five minutes in the future;
- `counts` holds non-negative integers (any names) and `counts.entries` equals the number of entries; at most 20,000 entries;
- every entry has exactly `title` and `year`; `title` is a non-empty string of at most 300 characters that is already normalized; `year` is an integer from 1870 to 2100; entries are strictly ascending by `title`, then `year`, so a duplicate is invalid;
- `contentSha256` is the SHA-256 of `JSON.stringify(entries)`.

There is no age limit: a list older than the latest export only misses films watched since, which Finds would show anyway.

**Normalization.** `normTitle_v1`: NFKC, lower case, `ё` as `е`, every run of characters that are not letters or digits as one space, trimmed. It is `normTitle` of `src/letterboxd-match.js`; the Worker carries an identical copy, and a test keeps them equal.

**The rule.** Evaluated on every request against the pinned generation's catalog copy, after rules 1–6, so only films the response would otherwise offer are counted. A verified record is hidden when all hold:

1. it has an integer `year`, and its normalized **original** title and that year equal an entry exactly; the localized title and aliases never match;
2. catalog uniqueness, which depends on the list's `rule` tag:
   - `strict_original_exact_year`: no verified record of another TMDB film in the same catalog copy has that normalized key as its original title, localized title or alias, in any year;
   - `strict_original_exact_year_v2`: no verified record of another TMDB film has the key as its original or localized title, in any year; and every other TMDB film that carries the key only as an alias (no record of it has the key as its original or localized title) has, on every verified record, an integer `year` at least two years from the record's year. An alias-only namesake without a year or within one year blocks, because the export name may be that film's English title;
3. its TMDB id has no stored Letterboxd id in `metadata.json`, `watchlist.json`, the programme or a verified catalog record keyed by a Letterboxd id; such a film is decided by identity alone.

Nothing is stored: a new generation is evaluated afresh, so a film can be hidden in one generation and shown in the next when a namesake enters or leaves the catalog. Entries are unique by title and year, and a record has one original title and year, so at most one entry matches a record.

## Response

```json
{
  "programmeRunId": "…",
  "pinned": true,
  "generatedAt": "2026-06-15T10:00:00.000Z",
  "window": {"from": "2026-06-12T10:00:00.000Z", "to": "2026-06-16T10:00:00.000Z"},
  "profile": {"version": 1},
  "total": 1,
  "posterCoverage": {"catalog": 1, "metadataCache": 0, "missing": 0},
  "watchedMarkEnabled": false,
  "displayExclusion": {"state": "applied", "excluded": 2},
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
| `posterCoverage` | Where the `poster` of each returned film came from, counted over `films` only: `catalog` (the record's own TMDB poster), `metadataCache` (the `metadata.json` fallback), `missing` (`poster` is `null`). The three add up to `total`. It lets a plain read show how many available films still have no stored asset; it is not a per-film field, and `films[]` is unchanged |
| `watchedMarkEnabled` | `true` only while both `FINDS_WATCHED_MARK` and `LETTERBOXD_FACTS` are exactly `on`, so the client knows the [owner watched mark](#owner-watched-mark) can be offered |
| `displayExclusion` | The [display-only title exclusion](#display-only-title-exclusion): `state` is `applied` (valid list used) or `unavailable` (list missing, unreadable or invalid; nothing hidden). The former `off` state is gone with the switch ([ADR 0041](../../adr/0041-retire-finds-title-exclusion-switch.md)); `excluded` counts the canonical identities hidden from `films` by it. It never carries a title, id, code or any hash of the list or its source |
| `programmeRunId`, `pinned` | The generation the response is derived from. `pinned: false` means no published pointer existed and the programme's own run id was used |
| `generatedAt`, `window` | The clock the statuses were derived with and the availability envelope `(now − 72h, now + 24h)` |
| `profile` | The profile version predictions were checked against, or `null` |
| `films[].poster` | The record's own TMDB poster URL when the discovery writer stored one, else the cached Letterboxd poster of the same stored id or TMDB identity, else `null`; always a stored `https://` URL, never constructed |
| `films[].shows[].status` | `archive` (started and ended, still inside the 72-hour catch-up), `on_air` (started, not ended), `future` (not started) |
| `films[].availableNow` | Some returned show has started |
| `films[].nextStart` | The earliest returned show that has not started, or `null` |
| `films[].availableUntil` | The latest returned start plus 72 hours, when the last catch-up ends |
| `films[].prediction` | The stored current prediction: rating, probability of 4+, confidence, match signals, main risk and the canonical mood ids |
| `films[].fingerprint` | The fingerprint facet (plot mechanics, mood ids, the general execution dimensions without `unknown` / `not_applicable`) when the stored fingerprint is the one the prediction was made from, otherwise `null` |
| `channels` | One row per channel id with the number of returned films that have a show on it, for channel and period filters on the client |

Not included on purpose: synopsis, aliases, the raw prediction and fingerprint objects, the mood vocabulary (served by `GET /api/enrichment/view`), and any ranking. Thresholds, ordering for display and franchise de-duplication are consumer decisions.

## Consumers

The watchlist page's **«Находки»** section (`public/app.js`, `#finds`) is the first consumer. It reads this route on page load and with the other live refreshes and never adds a show or a prediction of its own. A cached answer is shown only while the loaded programme's run id equals the answer's `programmeRunId`: when the programme moves to a new generation the section is hidden until this route answers for that generation (a `409` during publication keeps it hidden), and an answer for a generation the programme has not reached yet waits for the programme; a failed refresh on the same generation keeps the last answer. On every render it re-checks each returned film against the loaded programme and view index (a film that has since entered the watchlist or received an actual rating disappears), re-derives the shows inside `(now − 72h, now + 24h)` with the browser clock (an expired catch-up hides the film without a new request), and keeps only a current prediction with `predictedRating ≥ 4.0`, `probability4Plus ≥ 0.70` and a known `confidence` other than `low`. The remaining films are ordered by `predictedRating`, then `probability4Plus`, then the nearest end of availability; one entry per canonical identity; an adjacent franchise part (same title stem after a trailing sequel number or «часть N») with identical rating and probability is skipped; at most five are shown and the list is never padded with weaker films. The section is hidden entirely when nothing qualifies. Each card carries the `NEW` badge at the top left of the poster, meaning a film outside the watchlist, not a new release; the usual title, year, poster and prediction; up to two mechanic or mood labels from `fingerprint` and `prediction.moodIds`; and the relevant airing (on air now, the next start, or the catch-up deadline). The title links to `url` on TMDB because the film has no page in the watchlist route. Filters narrow and re-rank the section on the client ([Filter context](#filter-context)); they do not change this route.

**«Смотрел».** While `watchedMarkEnabled` is `true`, each card has a «Смотрел» button.
- **Mark.** It posts the card's TMDB id to [`POST /api/catalog/watched`](#owner-watched-mark). While the request runs, the button is disabled and reads «Сохраняю…».
- **Success.** The card leaves the section at once, before the next catalog answer. A notice above the cards says the film is marked and offers «Отменить», which posts `watched: false` and brings the card back.
- **Failure.** The card stays with an inline alert, and the button can be pressed again. A `film_not_in_catalog` answer also reloads the section.
- **Disabled.** Without `watchedMarkEnabled` no button is shown.

**Channel and period scope.** While the page's channel filter is active, the watchlist grid and the finds become two sections of the same channel and period scope. The grid gets the heading «Из watchlist» and the section is titled «Находки на выбранном канале» (or «…на выбранных каналах»). Only shows on a selected channel count, several channels combine with OR, and the selected period tab is a hard constraint: `archive` keeps shows inside the 72-hour catch-up, `future` keeps upcoming shows, `all` keeps both, each inside the programme's effective viewing window, so the black zone has no finds. A film whose only shows in that scope are on another channel or in another period is not a find. The same thresholds, ordering (with the end of availability taken from the scoped shows), de-duplication and limit apply, and the airing line names a show on the selected channel. An empty section is not shown; the shared «Таких фильмов не найдено» state appears only when both sections are empty. Clearing the channel filter restores the plain section. A period tab other than «Все показы» without a channel scopes the shows the same way (the title stays «Находки» and the caption names the period). The URL keeps its existing `channel` and `period` parameters; nothing new is requested from this route.

<a id="filter-context"></a>**Filter context.** The section answers the page's other filters from the fields this route returns, on the catalog answer already loaded: a filter change, a restored URL or Back/Forward re-ranks it without a request. Every selected filter is a hard constraint, with the same rules as the watchlist grid: AND across filters, OR within a multi-select.

| Filter | Read from |
| --- | --- |
| Search, «Названия» | `title` and `original`; the route returns no aliases |
| Search, «Сюжет» | `genres` and the mechanic and mood labels below; the route returns no synopsis, so a word that only the synopsis contains finds nothing here |
| Search, «Люди» | Not evaluated: a credit name never makes a find. A query that only a person's name answers leaves the section empty |
| Genres | `genres`, compared by canonical genre, not by label: the watchlist carries the Letterboxd labels («Криминал», «Фантастика», «Исторический»), the catalog the TMDB `ru-RU` names («криминал», «фантастика», «история»), and both sides are folded through the same dictionary as [prediction compatibility](../domain/prediction-compatibility.md) (`PROFILE_GENRE_ALIASES`; the page keeps an identical copy, `FINDS_GENRE_KEYS`, checked by a test). A name outside the dictionary matches only the same name, case-folded, never a different genre. The selected label, the URL parameter and the card's genre tags stay as stored |
| Years, runtime limit | `year`, `runtime` (an unknown year passes only the full year range, an unknown runtime no limit) |
| Mechanics, moods, execution | `fingerprint.plotMechanics`, `fingerprint.moodIds` together with `prediction.moodIds`, `fingerprint.execution`; a record with `fingerprint: null` matches no mechanic or execution value |
| Prediction and 4.0+ chance thresholds | `prediction`; they add to the section's own minimum, never lower it |
| «Последний шанс» | The end of availability of the scoped shows is less than eight hours away |
| Channel, period | The scope above |
| Director, actor, «Только начатые», «Пересмотр» | Not answerable from a catalog record (person identity, watchlist-only facts): while one is selected the section is empty. «Новые» keeps every find, since none is rated |

Without any of these filters the section is exactly the plain one. With a selected genre, mechanic or mood, the finds that match more selected mechanics and moods come first, then those that match more selected genres, then the usual `predictedRating`, `probability4Plus` and nearest end of availability; the five-film limit, de-duplication and the absence of filler are unchanged. A card then says «Совпадает с фильтрами:» with the selected mechanics, moods and genres it matches, nothing else; a matched genre is named by the selected label and counted once per canonical genre, whatever the catalog spelling. The caption adds «по выбранным фильтрам». With an active filter the grid gets the «Из watchlist» heading and the shared empty state appears only when both sections are empty, as with a channel scope. Eligibility, the watched and rated exclusions, the «Смотрел» mark, the display-only exclusion and the generation pin are unchanged.

## Owner watched mark

`POST /api/catalog/watched` records the owner's statement that they have watched, or have not watched, one verified catalog film ([ADR-0032](../../adr/0032-owner-watched-mark-by-tmdb-identity.md)). It writes only the owner's `watched` fact through the [user facts](../integrations/letterboxd-user-facts.md#owner-watched-mark) and its projection. It never writes a rating, the watchlist, a prediction, the catalog or a Film/Person record. It does not link a Letterboxd id and never reads a title or year.

```json
{"tmdbId": "603", "watched": true}
```

**Guards**, checked in this order. A refused request writes nothing:

| Check | Refusal |
| --- | --- |
| Method is `POST` | `405` |
| `FINDS_WATCHED_MARK` is exactly `on` | `409`, `code: mark_disabled` |
| `LETTERBOXD_FACTS` is exactly `on` (the fact records are the only store) | `409`, `code: facts_disabled` |
| `Origin` header present and equal to the Worker's origin (stricter than the shared check, which lets a request without `Origin` through) | `403` |
| `Content-Type` is `application/json` | `415` |
| Body is at most 512 characters of JSON, an object with exactly `tmdbId` (a string of digits) and `watched` (a boolean) | `400`, `code: invalid_request` for a wrong shape |
| The published generation's catalog copy holds a record with that `tmdbId` and `canonicalIdentity` exactly `tmdb:<tmdbId>` (no published generation, an observation key or a conflicting identity is refused) | `409`, `code: film_not_in_catalog` |

**Response** `200`: `{"outcome": "saved" | "unchanged" | "older", "watched": <current value>}`, and nothing else from the record.
- `unchanged`: the value already was the current effective value, and nothing was written.
- `older`: a concurrent, later observation is current.

A write that keeps losing compare-and-swap answers `409` with the facts error code. The route is behind the Worker's owner-only Access application, is not an MCP tool and is not called by any Scheduled Task.

## Errors

| Status | Body | When |
| --- | --- | --- |
| `503` | `{"error":"No published programme"}` | No programme has been published yet |
| `409` | `{"error":"Programme generation is not in place"}` | The pointer names a generation whose programme copy is absent or carries another run id (publication still copying); call again later rather than serving the previous generation or the shared public key |
| `409` | `{"error":"Catalog generation copy is not in place"}` | The pointer names a generation whose catalog copy is absent; the shared public catalog is not used as a substitute |

Without a published pointer the shared public keys are read and `pinned` is `false`. A missing view index or profile is not an error: the list is empty; a missing catalog is empty only when unpinned.

## Size and freshness

The response holds every eligible film of the pinned generation, so its size is bounded by the hot part of the catalog. Statuses and `availableUntil` are computed at request time; a client that caches the response must re-derive them from `shows[].start`/`end` with its own clock or request again. A new profile version empties the list until predictions are refreshed, which is the intended fail-closed behaviour: a stale prediction is never offered as current.

## Poster hydration

Catalog records keep the poster the discovery writer stored when it inserted them from TMDB movie detail (`https://image.tmdb.org/t/p/w342…`). Records written before that field existed, or by an older resolver, carry `poster: null`; every later catalog write preserves the field, so such a record stays without a poster, and the `metadata.json` fallback above only covers films that were on the watchlist. `POST /api/enrichment/catalog/posters` fills that field and nothing else. It is a separate, owner-triggered write route; `GET /api/catalog/available` stays read-only. The decision and its boundaries are [ADR 0020](../../adr/0020-owner-triggered-catalog-poster-hydration.md).

| Request | Effect |
| --- | --- |
| `{}` or `{"dryRun": true}` | Read-only with any flag value: counts over the live catalog and the published generation's copy (`catalogRecords`, `missingPoster`, `verifiedMissing`, `unverifiedMissing`), the published `programmeRunId`, `enabled`, and the first 50 verified ids without a poster in `ids`. No TMDB request and no write. A value that is not an `https://` URL counts as missing |
| `{"dryRun": false, "limit": n, "cursor": "<id>"}` | Execution, only with `CATALOG_POSTER_HYDRATION` set to exactly `on` (otherwise `409`, nothing fetched). `limit` is 1–20 (default 10); `cursor` continues after the given record id in id order; an absent or empty cursor starts at the first record |

Execution takes the resolver lease (`409` while a discovery chunk or an EPG publication holds it, nothing fetched) and handles at most `limit` records in id order. Only a record whose `canonicalIdentity` is exactly `tmdb:<tmdbId>` is requested; an unverified record is never touched. For each one it requests `movie/<tmdbId>?language=ru-RU` through the resolver's TMDB client and pacing, with one retry on a failure and none on a `429`, which stops the batch.

**Outcomes.** Terminal: `hydrated` (the poster is now in every copy in scope; `poster` is returned), `already_present` (another writer stored one first), `no_poster_on_tmdb` (TMDB has no `poster_path`; record untouched), `tmdb_id_mismatch`. Retryable: `tmdb_failed` (with the error), `rate_limited` and `not_attempted` (after a `429`, with `retryAt`), `skipped_changed` (the record disappeared or is no longer the same verified id), `generation_changed`, `lease_lost`, `catalog_changed` (two lost compare-and-swaps). A retryable outcome after a partial write carries `writtenTo` with the copies that already hold the poster.

**Cursor and completion.** `nextCursor` moves only past records whose outcome is terminal; it stops before the first retryable one, so the next call retries it first. `done` is `true`, and `nextCursor` is `null`, only when the batch reached the end of the queue after the cursor and every outcome in it is terminal. A sweep that has to start again at the first record gets the empty cursor `""`, never `null`. `retryable` lists the ids that are still open, and `remainingAfterCursor` counts the records after `nextCursor`. Following `nextCursor` from no cursor until `done` therefore leaves every verified record without a poster either hydrated or terminally settled; a record that keeps failing keeps the sweep open, and the [runbook](../../runbooks/catalog-poster-hydration.md) bounds the attempts.

**Writes.** After all requests the call writes the published generation's copy, then the live catalog. They are two separate R2 objects and are not atomic together. Each copy is re-read; the poster is set only where the record is still the same verified TMDB id and still has no poster; immediately before every write attempt, including the retry after a lost compare-and-swap, the call checks that the published generation is still the one it started from and renews the lease, and then writes with a compare-and-swap on the ETag. A lost compare-and-swap re-reads and retries once; a second loss leaves that copy unwritten. A failed generation or lease check stops every later write: before the first write nothing is written; between the two writes the generation copy keeps the poster and the live catalog does not, and `writes` and the per-record `writtenTo` say so. That poster is a correct TMDB asset of the verified id and harmless in the copy that holds it; the next call re-reads both copies and completes the missing one or reports it again. `generationChanged` and `leaseLost` summarise the stop; a lost lease answers `409`. Identity, aliases, shows, decisions, the generation pointer and every other key are not written. The [poster hydration runbook](../../runbooks/catalog-poster-hydration.md) is the approved procedure; the route does not run on a schedule.
