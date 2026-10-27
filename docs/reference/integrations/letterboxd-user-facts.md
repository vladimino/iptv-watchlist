# Letterboxd user facts — storage contract (design, not implemented)

This page specifies how watched, rating and watchlist facts are stored and merged under [ADR-0023](../../adr/0023-letterboxd-user-facts.md). **Nothing here is implemented yet**: no route, key or writer described below exists until the importer and writer changes land, and the production baseline import is a separately approved operation. Current behaviour is in [Letterboxd ratings](letterboxd-ratings.md) and the [enrichment API](../api/enrichment.md); export parsing and matching are in the [export contract](letterboxd-export.md).

## Fact record

One object per canonical film: `letterboxd/facts/films/<canonicalFilmId>.json`, where `<canonicalFilmId>` is `film:<lid>` or `film:tmdb:<n>` (ADR-0009) encoded as a single key segment.

```json
{
  "schemaVersion": 1,
  "filmId": "film:<lid>",
  "links": {"letterboxd": "<lid>", "tmdb": "<n> or null"},
  "watched": {"value": true, "effectiveOn": "2024-05-01", "observedAt": "2026-10-26T13:48:00.000Z", "source": "letterboxd_export", "sourceRef": "<export sha256>"},
  "rating": {"value": 4.5, "effectiveOn": "2024-05-02", "observedAt": "2026-10-26T13:48:00.000Z", "source": "letterboxd_export", "sourceRef": "<export sha256>"},
  "watchlist": {"value": false, "observedAt": "...", "source": "letterboxd_films_list", "sourceRef": "<generation id>"},
  "history": [{"fact": "rating", "before": 4, "after": 4.5, "observedAt": "...", "source": "...", "sourceRef": "..."}]
}
```

- Each of `watched`, `rating`, `watchlist` is absent until first observed. `rating.value` is a half star 0.5–5 or `null` meaning "seen and explicitly not rated" (never "unknown").
- `links` lists only trusted ids. A film reached by two ids has one record; a second record for the same TMDB id is a conflict for the identity task, not a merge.
- `history` keeps the last 20 replaced values for audit; it is not used for reads.
- Unresolved export rows (statuses `candidate`, `ambiguous`, `unmatched`) are not fact records. The importer lists them in its private report only.

## Merge rule

For each fact independently, an incoming observation `o` replaces the stored value `s` only if `o.observedAt > s.observedAt`, or `s` is absent. Otherwise the write is a no-op and is counted as `older_observation`.

| Incoming | Effect |
| --- | --- |
| Complete films list, film present with a rating | `watched: true`, `rating: <value>` |
| Complete films list, film present without a rating | `watched: true`, `rating: null` |
| Complete films list, film absent | nothing (absence is not an observation) |
| Films list HTTP 403, incomplete scan, interrupted projection | nothing |
| Per-film page, rating found / no rating / 404 | `rating: <value>` and `watched: true` / nothing / nothing |
| Watchlist page | `watchlist: true` for listed films; `watchlist: false` only for films the previous complete watchlist listed and this complete one does not |
| Owner edit | the edited fact, `source: owner`, `observedAt` = request time |
| Export baseline | `watched`, `rating` (rated rows) or `rating: null` (watched-unrated rows), `watchlist`; `observedAt` = export timestamp from the ZIP name or file metadata |

`watched` is never set to `false` by any source except an owner edit. Clearing a rating never clears `watched`.

## Writes

- Every write is a compare-and-swap on the record's ETag with bounded retries, re-reading and re-applying the merge rule on each retry; a writer that read an older record never restores an older value.
- Writers: the films-list scan (EPG commit and ratings refresh), the per-film lookup, the owner edit, the baseline importer. No generic key-write endpoint is added.
- The per-film lookup addresses Letterboxd by the film's slug from metadata, never by treating a `lid` as a slug, and writes under the canonical record.

## Projections

- `enrichment/view-index.json` keeps `actualRating` and gains `watched: true|false`, written under **every** id that resolves to the film (its `lid` and its `tmdb_<n>` catalog id). They are rebuilt from the fact records; the index is never the source of a fact.
- Readers that need a fact by catalog id resolve `tmdb_<n>` → canonical record through `links`.
- Finds exclude a film whose record has `watched: true` or a rating, whatever id the catalog uses; an actual rating is shown instead of a prediction.

## Baseline import protocol

Owner-only and typed; parameters are the export directory, the AIR-175-style snapshot used for identity and an output directory.

1. **Validate** (no write): parse with the export contract, match against the snapshot, plan one fact write per `accepted` film, report counts by fact, by merge outcome (`new`, `replaces`, `older_observation`, `unchanged`) and the unresolved list. The report is aggregate; per-film rows stay private.
2. **Commit** in chunks of at most 200 films. Each film write is a CAS under the merge rule; after it reads back equal, a receipt `letterboxd/imports/<exportSha256>/receipts/<chunk>.json` lists the film ids and outcomes. A run resumes after the last receipt.
3. **Read back** every planned record and the projection. Re-running the same export writes nothing (`unchanged`).
4. **Rollback** of one export: for each record whose fact still has `sourceRef = <exportSha256>`, remove that fact (restore the latest `history` entry with an older source, if any), then rebuild the projection. Facts replaced by newer observations are left alone.

## D1 mapping (future migration)

| Fact | D1 home |
| --- | --- |
| rating with a value | `actual_rating(film_id, rating, source, recorded_at)`, `recorded_at` = `observedAt` |
| rating `null` | no `actual_rating` row; the watched row records it |
| watched | new `film_watched(film_id, watched, effective_on, observed_at, source, source_ref)` |
| watchlist | `watchlist_film` |

The backfill and delta use the merge rule above. The migration and the backfill of these tables need their own approvals (ADR-0019).
