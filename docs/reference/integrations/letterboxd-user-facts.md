# Letterboxd user facts — storage contract

This page specifies how watched, rating and watchlist facts are stored and merged under [ADR-0023](../../adr/0023-letterboxd-user-facts.md). **Implementation status:** the fact records, link index, scan summaries, merge order, projection and the routine writers (films-list scan in the EPG commit and in the ratings-generation projection, per-film lookup, owner rating edit, completed watchlist sync) are implemented in [`src/letterboxd-facts.js`](../../../src/letterboxd-facts.js) and are the only writers: the former `LETTERBOXD_FACTS` gate is retired and inert ([ADR 0055](../../adr/0055-retire-letterboxd-facts-switch.md), [feature flags](../feature-flags.md)), and no value of it brings back the legacy writers. The baseline importer is implemented in [`scripts/letterboxd-baseline-import.mjs`](../../../scripts/letterboxd-baseline-import.mjs) (offline plan and the remote steps) and the owner-only maintenance route `POST /api/letterboxd/baseline/{validate,commit,rollback}`, which has no switch ([ADR 0053](../../adr/0053-permanent-letterboxd-baseline-import-route.md)); procedure in the [baseline import runbook](../../runbooks/letterboxd-baseline-import.md). Finds read the projection by identity ([catalog API](../api/catalog.md#watched-and-rated-films)). Not implemented yet: the convergence migration.

**Identity boundary while convergence is not implemented.** Every writer except one knows the film's Letterboxd id and never creates a record without one. The exception is the owner's [watched mark](#owner-watched-mark) ([ADR-0032](../../adr/0032-owner-watched-mark-by-tmdb-identity.md)), which may create a record with only a trusted TMDB alias. Two records of one film can still only meet as an `alias_conflict` (a Letterboxd id or TMDB id that would join a record holding another id of the same kind). Such a write is not made: the scan or lookup counts it, the owner edit answers `Identity conflict; recorded for review`, and the pair is listed in `letterboxd/facts/conflicts.json` (`links`, `reason`, first and last seen, count) for the identity review. Projections only ever come from records, so a conflicting film keeps its previous view values. The production baseline import is a separately approved operation. Current behaviour is in [Letterboxd ratings](letterboxd-ratings.md) and the [enrichment API](../api/enrichment.md); export parsing and matching are in the [export contract](letterboxd-export.md).

## Fact record and its key

One object per film: `letterboxd/facts/films/<factKey>.json`.

- **Key choice is deterministic and made once, at creation:** `tmdb-<n>` when the film has a trusted TMDB id (the export contract's `tmdb_verified`, or a stored `tmdbId` on the accepted Letterboxd id); otherwise `lb-<lid>`. A key is never reused for another film.
- **Link index:** `letterboxd/facts/links.json` maps every trusted alias to exactly one fact key: `{"letterboxd:<lid>": "<factKey>", "tmdb:<n>": "<factKey>"}`. An alias appears once. It is the only lookup path: a reader holding `<lid>`, `tmdb_<n>` or `film:tmdb:<n>` makes one read of the index and one of the record, never a scan of `letterboxd/facts/films/`. Every change to the index is a compare-and-swap. A write that would point an existing alias at another key is refused (`alias_conflict`) and goes to the identity review, **except** the alias move of an authorized convergence (below), which is allowed only while the source record carries the matching migration fence.

```json
{
  "schemaVersion": 1,
  "factKey": "tmdb-603",
  "links": {"letterboxd": "<lid>", "tmdb": "603"},
  "redirectTo": null,
  "migrating": null,
  "watched":   {"value": true, "effectiveOn": "2024-05-01", "observedAt": "2026-10-26T13:48:00.000Z", "source": "letterboxd_export", "sourceRef": "<export sha256>", "observationId": "<sha256>", "replaced": null},
  "rating":    {"value": 4.5,  "effectiveOn": "2024-05-02", "observedAt": "...", "source": "letterboxd_films_list", "sourceRef": "<generation id>", "observationId": "<sha256>",
                "replaced": {"value": 4, "observedAt": "...", "source": "letterboxd_export", "sourceRef": "<export sha256>", "observationId": "<sha256>"}},
  "watchlist": {"value": false, "observedAt": "...", "source": "letterboxd_watchlist", "sourceRef": "<programme run id>", "observationId": "<sha256>", "replaced": {"value": true, "...": "..."}},
  "ratingHistory": [
    {"kind": "first_observed", "recordedAt": "...", "value": 4, "observedAt": "...", "source": "letterboxd_export", "sourceRef": "<export sha256>", "observationId": "<sha256>", "previous": null},
    {"kind": "changed", "recordedAt": "...", "value": 4.5, "observedAt": "...", "source": "letterboxd_films_list", "sourceRef": "<scan id>", "observationId": "<sha256>", "previous": {"value": 4, "observedAt": "...", "source": "letterboxd_export", "observationId": "<sha256>"}}
  ]
}
```

- Each fact is absent until first observed. `rating.value` is a half star 0.5–5 or `null`, meaning "seen and explicitly not rated" — a timestamped state, never "unknown". `watchlist.value: false` is a timestamped removal.
- `observationId` is the SHA-256 of `filmKey|fact|value|observedAt|source|sourceRef`; it identifies an observation for idempotence and ties.
- `replaced` is the exact value this one replaced, written in the same compare-and-swap. It is the before-image for rollback (below). It holds one level; older values are not needed for exact reversal of the newest write.
- `ratingHistory` is the append-only list of rating changes of this film, written in the same compare-and-swap as `rating`, so it is never ahead of or behind the current value ([ADR 0038](../../adr/0038-durable-rating-and-prediction-lineage.md)). An entry is added only when the **effective** rating (the greater of the stored value and the scan summary's observation) changes: `first_observed` when no rating was known — the value existed before it was observed, so its `observedAt` is not a rating or watch date and says nothing about when the owner rated the film — and `changed` with `previous` otherwise; `value: null` is "seen, not rated". A newer observation of the same value is a confirmation and adds nothing; a repeated observation, an older one, an absence from a list, a watched or watchlist observation add nothing. A rollback of the baseline import appends `{kind: "rolled_back", observationId, at, restored}` after the entry it reversed; the same observation applied again later is recorded again. Each entry has `recordedAt`, the Worker time it was written. Entries are never removed or rewritten.
- **Identity of an entry** within its record: the observation id, whether the entry applies or reverses it, and how many times that observation was applied or reversed before in the same list. A rollback and a later re-application of one observation are therefore distinct events.
- `ratingHistory` starts when its writer was deployed. A record written earlier has no history; its current `rating` (and the one-level `replaced`) is the only knowledge of what came before. There is no backfill from `replaced`, the scan summaries or `enrichment/diagnostics/rating-observations.json`.
- Unresolved export rows (statuses `candidate`, `ambiguous`, `unmatched`) never become records; the importer lists them in its private report only.

## Ordering of observations

Observations of one fact are totally ordered by the tuple **(`observedAt`, source rank, `observationId`)**, compared left to right. Source rank, highest first: `owner` 4, `letterboxd_films_list` 3, `letterboxd_film_page` 2, `letterboxd_watchlist` 2, `letterboxd_export` 1, `letterboxd_diary` 1. A diary observation is dated at the entry's watched date, so any newer observation wins over it ([ADR 0054](../../adr/0054-diary-first-epg-ratings.md), [diary rating facts](letterboxd-diary-history.md#rating-facts)). An incoming observation replaces the stored value only if it is **greater** in that order; an equal `observationId` is the same observation (no-op, `unchanged`). Two different values with the same `observedAt` are therefore decided deterministically, and every such tie is counted as `tie` in the writer's report so it can be reviewed.

### Observation time per source

`observedAt` must be a time at which the source was known to show the value, taken from a clock the system controls or from a timestamp the source itself publishes. File modification times are never used.

| Source | `observedAt` |
| --- | --- |
| `owner` | Worker time when the owner's request was accepted |
| `letterboxd_films_list` | Worker time when the **first** page of the complete scan was requested. A page can only show a state at least that new, so the scan never claims a time later than what it saw, and an owner edit made while the scan runs (a later time) is never overwritten by it |
| `letterboxd_film_page` | Worker time of the request |
| `letterboxd_watchlist` | Worker time when the first page of the complete watchlist was requested |
| `letterboxd_export` | The export's generation time, bound to the archive as described in [Export origin](#export-origin) |

`effectiveOn` (the export's `Date` / `Watched Date`) is informative and never used for ordering.

### Export origin

The importer takes the **ZIP archive itself**, not an extracted directory, so the time, the checksum and the rows come from one input:

1. It computes the SHA-256 of the archive bytes; that checksum is the export's `sourceRef` and the import's identity.
2. It reads the generation time from the archive's file name, `letterboxd-<user>-YYYY-MM-DD-HH-MM-utc.zip`, the name Letterboxd gives the export when it builds it.
3. It reads `watched.csv`, `ratings.csv`, `watchlist.csv` and `diary.csv` from inside that same archive, in memory, and records each file's SHA-256 next to the archive checksum in a private origin manifest in the output directory (`origin.json`: archive name, archive SHA-256, generation time, per-file SHA-256). Validate and commit both re-read the archive and refuse to continue if any checksum differs from `origin.json`.
4. **A renamed or nonstandard archive is refused.** The owner may instead pass `--generated-at <UTC time>` explicitly; the time is recorded in `origin.json` as `owner_declared`, and validation reports it prominently.
5. In both cases a generation time later than the import's start is refused, and the validation report shows, before any commit, how many facts the baseline would replace (`replaces`) and how many newer stored values it leaves alone (`older`).

The offline reconciliation command, which only reports and never writes, may keep reading an extracted directory.

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
| Owner watched mark | `watched: true` or `false` only; a value equal to the current effective value writes nothing |
| Export baseline | `watched: true`; `rating: <value>` for rated rows, `rating: null` for watched-unrated rows; `watchlist: true` for watchlist rows |

`watched` is set to `false` only by an owner edit. Clearing a rating never clears `watched`.

## Owner watched mark

The owner marks a verified catalog film as watched, or revokes the mark, from a Finds card ([catalog API](../api/catalog.md#owner-watched-mark), [ADR-0032](../../adr/0032-owner-watched-mark-by-tmdb-identity.md)). The film is named by its TMDB id only. A title, year or Letterboxd id is never used.

- **Record.** The writer reads the link index alias `tmdb:<n>`. If the alias points at a record (`tmdb-<n>`, or an `lb-<lid>` record that carries this TMDB link), the mark goes there, following one redirect or fence. Otherwise the writer adds `tmdb:<n>` → `tmdb-<n>` to the index and creates that record with `links: {"letterboxd": null, "tmdb": "<n>"}`. It never merges records and never adds a Letterboxd alias.
- **Fact.** Only `watched` is written, with `source: owner` and `observedAt` set to Worker time. Rating and watchlist are untouched. A value equal to the current effective value is `unchanged` and writes nothing. The effective value is the greater of the stored value and, for a record with a Letterboxd id, the films-list scan summary.
- **Projection.** As for every writer: `watched` under every alias id of the record.
- **Later links.** A writer that later holds both `letterboxd:<lid>` and the same trusted `tmdb:<n>` adds the Letterboxd alias to that record through the normal link rules. If that `lid` already has its own record, the pair is an `alias_conflict` for review. Scans address records by Letterboxd id only, so they never write a TMDB-only record.

## Scan summaries

A complete films list or watchlist is one observation of every film it shows. It is stored once, not copied into every record ([ADR-0024](../../adr/0024-letterboxd-scan-summary.md)):

- `letterboxd/facts/scans/films-list.json` = `{schemaVersion, scanId, observedAt, total, films: {<lid>: <rating or null>}}` and `letterboxd/facts/scans/watchlist.json` = `{schemaVersion, scanId, observedAt, films: [<lid>, …]}`. Each is replaced by compare-and-swap only by a complete scan with a greater `observedAt`; an incomplete scan or HTTP 403 writes nothing.
- **Effective observation.** For a film whose `links.letterboxd` is `<lid>`, the scan summary is an observation of its facts at the summary's `observedAt` (films list: `watched: true` and `rating`; watchlist: `watchlist: true` if listed). Every merge compares an incoming observation with the **greater** of the stored record value and the summary's observation; readers keep reading records.
- **Records are rewritten only when a value changes.** After a new summary is stored, the scan writes the records whose stored value differs from what the scan saw, by the merge rule; a record whose value already equals the scan's keeps its older `observedAt`, because the summary now carries the newer observation of the same value. It writes records only for films that already have a record or are in the current watchlist; any other `lid` stays an observation in the summary until a record is created (by the importer or the identity review), which then starts from the summary's value.
- **Staged publication.** A new summary is first written with the summary it will replace and the context its scan saw (the watchlist with its trusted TMDB links) to `<summary>.pending.json`; a resumed stage is always applied with its own context, never with a newer scan's; the scan then writes the changed records and the projection, and only then publishes the summary and closes the stage (`done: true`). Every step is idempotent: a retry of the same scan resumes the open stage, and a newer scan first finishes an unfinished older stage. Until the summary is published, merges keep using the previous one, so an interrupted scan never hides an observation.
- **Replacing a summary.** Before a summary is replaced, every film the old summary lists and the new one does not keeps its observation: its record (if any) is written with the old summary's observation when that is greater than the record's. Absence from the new scan is still not an observation.
- `watchlist: false` is written to a record when a complete watchlist does not show a film whose effective `watchlist` value is `true`.

## Writes and convergence

- Every record write is a compare-and-swap on its ETag with bounded retries; each retry re-reads and re-applies the order, so a writer that read earlier never restores an older value.
- A writer that finds `redirectTo` set follows it once and writes to the target; a chain longer than one hop is an error.
- **Converging two records** happens only when the identity review has verified that an `lb-<lid>` record and an existing `tmdb-<n>` record are the same film (a trusted TMDB link for that `lid`). It is a fenced, journaled migration; every step is a compare-and-swap and is idempotent:
  0. **Journal.** Create `letterboxd/facts/migrations/<sourceKey>.json` = `{source, target, token, state: "started"}` (create-only). Each later step advances `state` by compare-and-swap after its own postcondition holds: `fenced`, `merged`, `aliased`, `retired`, `done`. The migrations prefix is small and is the reconciler's discovery path, so a migration is found even after the source is no longer in the link index.
  1. **Fence the source.** CAS the source record to set `migrating: {to: target, token}`, without touching its facts. From this version on no writer changes the source's facts: a writer that reads a source with `migrating` set writes its observation to the target instead, and a writer that read the source before the fence fails its CAS (the ETag changed), re-reads, sees the fence and goes to the target. Call the fenced version `F`.
  2. **Merge.** CAS the target: merge every fact of source version `F` by the order above, merge `ratingHistory` as the union of both lists by entry identity, every distinct event once, ordered by `recordedAt` and then by identity (`mergeRatingHistories`; idempotent, so a repeated merge changes nothing), and add the `letterboxd` link. Repeating it is a no-op (same observation ids). Its postcondition, recorded as `merged`, is that the target durably holds every fact of `F` or a greater observation of it.
  3. **Move the alias.** CAS the link index: point `letterboxd:<lid>` at the target. This is the authorized exception to `alias_conflict`: it is accepted only if the source record currently carries `migrating.to = target` with the journal's `token`.
  4. **Retire the source.** Only when the journal is `merged` or later: CAS the source **conditioned on ETag `F`** to `{redirectTo: target, migrating: null}` with its facts cleared. Because the fence stops fact writes, `F` is still current; if the CAS fails anyway, re-read, merge the newer source version into the target again (step 2) and retry, so a write the target has not seen is never cleared.
  5. **Close.** Set the journal's `state: "done"`.

  The reconciler lists `letterboxd/facts/migrations/` and resumes every journal not `done` from the first step whose postcondition does not hold.

  **Reads during a migration.** Writes move to the target at the fence; reads do not. While the source carries `migrating` (steps 1–3, whether the reader reached it directly or through the moved alias via the journal), a reader returns the **overlay** of the source and the target: each fact merged by the order above, exactly as step 2 would merge it. The overlay never hides a source-only fact before the merge and never shows a value the merge would not keep. The **read cutover** is step 4: once the source carries `redirectTo`, which step 4 writes only after `merged`, readers follow it (one hop) and read the target alone. A reader that finds the alias already on the target while the journal is not yet `retired` also reads the overlay, using the journal's `source`. The overlay merges `ratingHistory` by the same rule as step 2.
- No generic key-write endpoint is added. The per-film lookup addresses Letterboxd by the film's slug from metadata, never by treating a `lid` as a slug.

## Projections

- `enrichment/view-index.json` keeps `actualRating` and gains `watched: true|false`, written under **every** alias in `links` (the `lid` and the `tmdb_<n>` catalog id). It is rebuilt from fact records; the index is never the source of a fact.
- Finds exclude a film whose record has `watched: true` or a rating, whatever id the catalog uses, so a prediction is never shown in place of an actual rating. They read this projection, not the records: an entry under `tmdb_<n>` names its TMDB film directly, and an entry under a Letterboxd id reaches the catalog's `tmdb_<n>` record through the TMDB id stored for that Letterboxd id, which also covers a record without a TMDB link. Titles are never used ([catalog API](../api/catalog.md#watched-and-rated-films)).

## Baseline import protocol

Owner-only and typed: a permanent maintenance route behind the Worker's owner-only Cloudflare Access, with no switch of its own ([ADR 0053](../../adr/0053-permanent-letterboxd-baseline-import-route.md)); every production `validate`, `commit` and `rollback` is a separate owner-approved operation. The offline `plan` step reads the export ZIP (see [Export origin](#export-origin)) and a verified `consistent_fenced` production R2 snapshot for identity ([snapshot export](../../runbooks/r2-snapshot-export.md)) and writes `origin.json`, `plan.jsonl` (private, one line per `accepted` film) and an aggregate `report.json`. `origin.json` schema 2 records the plan's `chunkSize` (1–100 films, default 50); schema 1 has none and means the earlier fixed 200 films. Each plan line carries its chunk number, which must equal its position divided by that size, so one plan never mixes chunk sizes. An accepted film's facts: `watched: true` for a watched or rated row, `rating: <value>` for a rated row, `rating: null` for a watched row without a rating, `watchlist: true` for a watchlist row; nothing else. Each remote step re-reads the archive and refuses to continue if the archive, any CSV in it or the plan differs from `origin.json`.

Every request carries `origin` (`archiveSha256`, `generatedAt`, `generatedAtSource`), a `chunk` number and, except rollback, at most 200 `items` (`lid`, optional trusted `tmdb`, `facts`, optional `effectiveOn`); schema 1 plans use that limit in full, schema 2 plans stay at or below 100. Requests outside these rules are refused with HTTP 400 before any read. The former `LETTERBOXD_BASELINE_IMPORT` and `LETTERBOXD_FACTS` are retired and no value of either opens or closes the route; the routine writers always record facts, so the next sync cannot clear imported ratings by absence. The observations are `source: letterboxd_export`, `sourceRef` = archive SHA-256, `observedAt` = `generatedAt`, and merge by the order above with the scan summaries as floor.

1. **Validate** (`/validate`, no write): for each item, the outcomes a commit would have now (`new`, `replaces`, `older`, `unchanged`, `tie`) and the films whose ids conflict.
2. **Commit** (`/commit`): first a create-only intent `letterboxd/imports/<archiveSha256>/chunks/<n>.intent.json` with the items' hash, the film ids and the view-index before-image of every id the chunk projects; then one CAS per film that applies the order and stores `replaced`; the projection; a read-back that every fact the chunk made current is current or replaced by a greater observation; finally the receipt `<n>.receipt.json` with each film's record key, observation ids and outcomes. A chunk number reused with other items is `chunk_conflict` (HTTP 409).
3. **Crash recovery.** A repeated commit of a chunk with a receipt is a `replay` and writes nothing. A chunk with an intent and no receipt is completed by re-applying its items: merges by observation id are idempotent, and the receipt keeps the intent's view before-image, not the state after the interrupted attempt.
4. **Rollback of one chunk** (`/rollback`) first writes a create-only rollback intent listing, per fact, the record key and the export's observation id, and the view before-image from the receipt. It then restores, per fact, the `replaced` before-image **only if the current value is still this export's observation** (same `observationId`), by CAS; a fact a later writer has replaced is left alone and counted `superseded`. A fact the import created is removed, and the view field it projected returns to the intent's before-image. Every step converges to the intent and is safe to repeat: a fact rolled back by an earlier attempt carries a marker (`rolledBackFrom` on a restored value, `rolledBack` on the record for a removed one) and counts as restored again, a value a later writer set is `superseded` and kept, and the view field of a removed fact returns to its before-image only while the record does not hold that fact again. The result is written once to `<n>.rollback.json` after all of this; a repeated rollback is a replay. Rollbacks are last-in-first-out per fact, and the CLI walks chunks in reverse.

The browser apply on `/admin/letterboxd` does not replace this protocol ([admin API](../api/admin.md#letterboxd-archive-apply), [ADR 0067](../../adr/0067-letterboxd-archive-confirmed-apply.md)). Confirm and commit each re-read the ZIP in that request, check the archive SHA-256 and the export time against the issued confirmation, and the commit calls `commitBaselineChunk` for one chunk of at most 50 films the preview compared. A `ratings.csv` row is `watched: true` and a rating even when `diary.csv` has no row for that film. The ZIP, the CSV texts, film names and rating values are not stored in the action record. Rollback is a separate confirmation and calls `rollbackBaselineChunk` with the origin taken from the stored receipt. A production call remains a separately approved operation.

## D1 mapping (future migration)

The D1 home must keep the same states and order, including `rating: null` and `watchlist: false`:

| D1 table | Content |
| --- | --- |
| `film_user_fact(film_id, fact, value_json, effective_on, observed_at, source, source_rank, source_ref, observation_id, PRIMARY KEY(film_id, fact))` | the current state of each fact, `value_json` being `true`/`false`, a number or `null` |
| `film_user_fact_history(film_id, fact, observation_id, value_json, observed_at, source, source_ref, replaced_at)` | every replaced value, append-only; for `rating` the backfill reads `ratingHistory` (one row per entry) |
| `actual_rating` | a projection: rows only for `rating` facts with a number |
| `watchlist_film` | a projection: rows only for `watchlist` facts with `true` |

The backfill and every delta merge by the same order; a row is never replaced by an observation that is not greater. The migration and the backfill of these tables need their own approvals (ADR-0019).
