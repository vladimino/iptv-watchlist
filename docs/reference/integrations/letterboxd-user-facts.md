# Letterboxd user facts — storage contract (design, not implemented)

This page specifies how watched, rating and watchlist facts are stored and merged under [ADR-0023](../../adr/0023-letterboxd-user-facts.md). **Nothing here is implemented yet**: no route, key or writer described below exists until the importer and writer changes land, and the production baseline import is a separately approved operation. Current behaviour is in [Letterboxd ratings](letterboxd-ratings.md) and the [enrichment API](../api/enrichment.md); export parsing and matching are in the [export contract](letterboxd-export.md).

## Fact record and its key

One object per film: `letterboxd/facts/films/<factKey>.json`.

- **Key choice is deterministic and made once, at creation:** `tmdb-<n>` when the film has a trusted TMDB id (the export contract's `tmdb_verified`, or a stored `tmdbId` on the accepted Letterboxd id); otherwise `lb-<lid>`. A key is never reused for another film.
- **Link index:** `letterboxd/facts/links.json` maps every trusted alias to exactly one fact key: `{"letterboxd:<lid>": "<factKey>", "tmdb:<n>": "<factKey>"}`. An alias appears once. It is the only lookup path: a reader holding `<lid>`, `tmdb_<n>` or `film:tmdb:<n>` makes one read of the index and one of the record, never a scan of `letterboxd/facts/films/`. Every change to the index is a compare-and-swap; a write that would point an existing alias at another key is refused (`alias_conflict`) and goes to the identity review, never merged automatically.

```json
{
  "schemaVersion": 1,
  "factKey": "tmdb-603",
  "links": {"letterboxd": "<lid>", "tmdb": "603"},
  "redirectTo": null,
  "watched":   {"value": true, "effectiveOn": "2024-05-01", "observedAt": "2026-10-26T13:48:00.000Z", "source": "letterboxd_export", "sourceRef": "<export sha256>", "observationId": "<sha256>", "replaced": null},
  "rating":    {"value": 4.5,  "effectiveOn": "2024-05-02", "observedAt": "...", "source": "letterboxd_films_list", "sourceRef": "<generation id>", "observationId": "<sha256>",
                "replaced": {"value": 4, "observedAt": "...", "source": "letterboxd_export", "sourceRef": "<export sha256>", "observationId": "<sha256>"}},
  "watchlist": {"value": false, "observedAt": "...", "source": "letterboxd_watchlist", "sourceRef": "<programme run id>", "observationId": "<sha256>", "replaced": {"value": true, "...": "..."}}
}
```

- Each fact is absent until first observed. `rating.value` is a half star 0.5–5 or `null`, meaning "seen and explicitly not rated" — a timestamped state, never "unknown". `watchlist.value: false` is a timestamped removal.
- `observationId` is the SHA-256 of `filmKey|fact|value|observedAt|source|sourceRef`; it identifies an observation for idempotence and ties.
- `replaced` is the exact value this one replaced, written in the same compare-and-swap. It is the before-image for rollback (below). It holds one level; older values are not needed for exact reversal of the newest write.
- Unresolved export rows (statuses `candidate`, `ambiguous`, `unmatched`) never become records; the importer lists them in its private report only.

## Ordering of observations

Observations of one fact are totally ordered by the tuple **(`observedAt`, source rank, `observationId`)**, compared left to right. Source rank, highest first: `owner` 4, `letterboxd_films_list` 3, `letterboxd_film_page` 2, `letterboxd_watchlist` 2, `letterboxd_export` 1. An incoming observation replaces the stored value only if it is **greater** in that order; an equal `observationId` is the same observation (no-op, `unchanged`). Two different values with the same `observedAt` are therefore decided deterministically, and every such tie is counted as `tie` in the writer's report so it can be reviewed.

### Observation time per source

`observedAt` must be a time at which the source was known to show the value, taken from a clock the system controls or from a timestamp the source itself publishes. File modification times are never used.

| Source | `observedAt` |
| --- | --- |
| `owner` | Worker time when the owner's request was accepted |
| `letterboxd_films_list` | Worker time when the **first** page of the complete scan was requested. A page can only show a state at least that new, so the scan never claims a time later than what it saw, and an owner edit made while the scan runs (a later time) is never overwritten by it |
| `letterboxd_film_page` | Worker time of the request |
| `letterboxd_watchlist` | Worker time when the first page of the complete watchlist was requested |
| `letterboxd_export` | The export's generation time from Letterboxd's archive name `letterboxd-<user>-YYYY-MM-DD-HH-MM-utc`, which Letterboxd sets when it builds the export. The importer refuses an archive without that name, and a time later than the import's start |

`effectiveOn` (the export's `Date` / `Watched Date`) is informative and never used for ordering.

## Merge table

| Incoming | Effect (each fact merged by the order above) |
| --- | --- |
| Complete films list, film present with a rating | `watched: true`, `rating: <value>` |
| Complete films list, film present without a rating | `watched: true`, `rating: null` |
| Complete films list, film absent | nothing (absence is not an observation) |
| Films list HTTP 403, incomplete scan, interrupted projection | nothing |
| Per-film page: rating found / no rating / 404 | `watched: true` and `rating: <value>` / nothing / nothing |
| Complete watchlist | `watchlist: true` for listed films; `watchlist: false` only for films whose stored `watchlist.value` is `true` and that this complete list does not show |
| Owner edit | the edited fact |
| Export baseline | `watched: true`; `rating: <value>` for rated rows, `rating: null` for watched-unrated rows; `watchlist: true` for watchlist rows |

`watched` is set to `false` only by an owner edit. Clearing a rating never clears `watched`.

## Writes and convergence

- Every record write is a compare-and-swap on its ETag with bounded retries; each retry re-reads and re-applies the order, so a writer that read earlier never restores an older value.
- A writer that finds `redirectTo` set follows it once and writes to the target; a chain longer than one hop is an error.
- **Converging two records** happens only when an `lb-<lid>` record gains a trusted TMDB id whose `tmdb-<n>` record already exists (or the reverse is discovered by the identity review). It is a recoverable sequence, each step idempotent and checked before it is taken:
  1. CAS the target `tmdb-<n>` record: merge each fact of the source record by the order above, and add the `letterboxd` link.
  2. CAS the link index: point `letterboxd:<lid>` at `tmdb-<n>`.
  3. CAS the source record to `{redirectTo: "tmdb-<n>"}` with its facts cleared.

  A process that stops between steps leaves either both records reachable with the index still on the source (step 1 merged facts idempotently, a rerun repeats it as a no-op) or the index already moved (step 3 still pending; readers reach the target, writers that hit the source write the old record, and the rerun of step 1 carries those writes over before step 3). A reconciler finds unfinished convergences from the index: any record whose `links` alias the index points elsewhere.
- No generic key-write endpoint is added. The per-film lookup addresses Letterboxd by the film's slug from metadata, never by treating a `lid` as a slug.

## Projections

- `enrichment/view-index.json` keeps `actualRating` and gains `watched: true|false`, written under **every** alias in `links` (the `lid` and the `tmdb_<n>` catalog id). It is rebuilt from fact records; the index is never the source of a fact.
- Finds exclude a film whose record has `watched: true` or a rating, whatever id the catalog uses, and show an actual rating instead of a prediction.

## Baseline import protocol

Owner-only and typed; inputs are the export directory, a verified snapshot for identity, and an output directory.

1. **Validate** (no write): parse with the export contract, match against the snapshot, plan the observations of every `accepted` film, and report counts by fact and by outcome (`new`, `replaces`, `older`, `tie`, `unchanged`) and the unresolved list. The report is aggregate; per-film rows stay private.
2. **Commit** in chunks of at most 200 films. Before a chunk, write `letterboxd/imports/<exportSha256>/chunks/<n>.intent.json` listing its film keys. Each film is one CAS that applies the order and stores `replaced`. After every film of the chunk reads back, write `<n>.receipt.json` with each film's outcome.
3. **Crash recovery.** A chunk with an intent and no receipt is reconciled, not blindly re-sent: each listed record is read; a fact whose `observationId` equals this import's observation was applied (its `replaced` is the before-image), anything else is re-applied by the order. The receipt is then written from what the records show. Re-running the same export writes nothing.
4. **Rollback of one export** restores, per fact, the `replaced` before-image **only if the current value is still this export's observation** (same `observationId`), by CAS. A fact a later writer has replaced is left alone and reported `superseded`. Rollbacks are last-in-first-out per fact: rolling back an export whose value was itself replaced by a later import requires rolling that one back first. The projection is rebuilt afterwards.

## D1 mapping (future migration)

The D1 home must keep the same states and order, including `rating: null` and `watchlist: false`:

| D1 table | Content |
| --- | --- |
| `film_user_fact(film_id, fact, value_json, effective_on, observed_at, source, source_rank, source_ref, observation_id, PRIMARY KEY(film_id, fact))` | the current state of each fact, `value_json` being `true`/`false`, a number or `null` |
| `film_user_fact_history(film_id, fact, observation_id, value_json, observed_at, source, source_ref, replaced_at)` | every replaced value, append-only |
| `actual_rating` | a projection: rows only for `rating` facts with a number |
| `watchlist_film` | a projection: rows only for `watchlist` facts with `true` |

The backfill and every delta merge by the same order; a row is never replaced by an observation that is not greater. The migration and the backfill of these tables need their own approvals (ADR-0019).
