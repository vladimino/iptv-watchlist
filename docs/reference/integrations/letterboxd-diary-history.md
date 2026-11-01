# Letterboxd Diary viewing history — contract

[AIR-51](https://trello.com/c/33d4hKJ3), [ADR 0049](../../adr/0049-letterboxd-diary-viewing-history.md). The routine read is the first page only ([ADR 0067](../../adr/0067-diary-recent-window.md)). Code: [`src/letterboxd-diary.js`](../../../src/letterboxd-diary.js). Gate: `LETTERBOXD_DIARY_HISTORY`, off by default ([feature flags](../feature-flags.md)).

The owner's public Letterboxd Diary is read into a viewing history. A row with a viewing id is its own entry; rows without one become one entry per film and day that counts its viewings, a lower bound unless one page held the whole day. Without a viewing id the per-viewing granularity is lost: two viewings of a film on one day keep only their count, their ratings in page order and how many rows were marked re-watch, not which viewing was which. The history is kept apart from the current rating. The ratings run turns what page 1 proves into watched and rating facts ([ADR 0054](../../adr/0054-diary-first-epg-ratings.md), [ADR 0074](../../adr/0074-retire-ratings-pipeline-switch.md), [below](#rating-facts)). The EPG commit does not. Absence from the diary means nothing.

## Source

- **Pages read.** Exactly one request per run: `https://letterboxd.com/<user>/diary/`, from the Worker, with the production headers. No `/diary/page/<n>/`, no retry, no redirect followed, no challenge handling. A stored `resumePage`, an HTML next link, a page of entirely new rows and a previous error do not select another URL.
- **Row parsing.** A row is a `tr.diary-entry-row`:
  - **lid:** from the poster's `data-postered-identifier` JSON;
  - **film slug:** from a same-origin `/<user>/film/<slug>/` link;
  - **watched date:** from a same-origin `/<user>/diary/films/for/YYYY/MM/DD/` link, kept only if it is a real calendar date;
  - **rating at that entry:** `rated-N`, as N/2 stars, or `null`.
- **Confirmed on production.** On 2026-10-29 the production Worker read page 1 with HTTP 200 and no challenge: 50 rows, 50 lids, 50 dates, 50 ratings ([AIR-273](https://trello.com/c/TVB01Xm0)).
- **Read only when explicitly present (not confirmed):**
  - a viewing id (`data-viewing-id`, or `data-object-id="viewing:<n>"`);
  - a re-watch marker (`data-rewatch`, or a `td-rewatch` cell with `icon-rewatch` / `icon-status-off`).

  Otherwise the re-watch value is `unknown`.
- **Page 2.** On 2026-10-31 a separate ratings run received HTTP 403 on page 2 after a useful page 1 ([evidence](../../evidence/letterboxd/air-304-diary-page-2-blocked-2026-10-31.md)). The routine reader does not request that page.

## Records — `letterboxd/diary/history.json`

`{schemaVersion: 1, entries: {<key>: entry}}`. Writes are compare-and-swap, one page at a time.

| Field | Meaning |
| --- | --- |
| `key`, `keyBasis` | `viewing:<id>` (`viewing_id`) when the row carries a viewing id: one entry per viewing. Otherwise `day:<lid:…\|slug:…>\|<watchedDate>` (`identity_date`): one entry per film and day that counts its viewings, because without an id two viewings of one film on one day cannot be told apart |
| `source` | `letterboxd_diary` |
| `identity` | `{type: 'letterboxd_lid', value}`, or `null` (unresolved: never linked to a film) |
| `aliases` | `[{type: 'letterboxd_slug', value, firstObservedAt}]`, an observation of that row only. `firstObservedAt` is the read that first saw this slug on the entry; an alias written before it was added has none. The lifecycle reader turns a slug of an entry with a lid into an `observed` `letterboxd_slug` alias of that Film ([ADR 0052](../../adr/0052-letterboxd-slug-film-alias.md)) |
| `viewingId` | The viewing id, or `null` |
| `watchedDate` | `YYYY-MM-DD` from the diary. It is not `observedAt` |
| `viewings`, `viewingsCertain` | How many diary rows the entry stands for (1 for a viewing-id entry). Counted within one page only, because pages are separate requests and a row can repeat on, or vanish from, the next page. `viewingsCertain` is true once one page held the whole day: page 1 or a first row with another date, and the last diary page or a last row with another date. Otherwise the count is a lower bound |
| `ratingAtEntry`, `ratingsAtEntry` | The rating on the entry (`null` when unrated, and `null` for a day entry with more than one viewing), and the ratings of the day's rows in diary order. Neither is the current rating |
| `rewatch` | `true` (any counted row marked re-watch), `false` (all marked not) or `unknown` |
| `rewatchRows`, `rewatchUnknownRows` | Day entries: how many counted rows were marked re-watch, and how many had no marker. From the latest certain read; an uncertain read only raises `rewatchRows`, a lower bound |
| `firstObservedAt`, `observedAt`, `page` | First and latest read, and the page it was seen on |
| `changes` | Up to ten `{field, from, to, observedAt}`, recorded when the entry's rating or re-watch marker changed |

**Merge rules:**
- **A new key** is added.
- **A known viewing id** keeps its identity. A row with another lid or date under the same id is counted as a `conflict` and changes nothing.
- **A day entry's count only grows.** A cut read (lower bound) never lowers it. A page shift or a row repeated by a diary change between two page requests never adds a viewing, because a day is counted within one page, never summed across pages. A count grown by an uncertain read sets `viewingsCertain` back to false. A certain count below the stored count, certain or not, is a `conflict` and changes nothing, so a stored lower bound is never turned into a false exact count. Ratings and re-watch rows follow the latest certain read.
- **Edits.** A different rating, or a known re-watch value, is recorded as a change. A slug is added as an alias.
- **Never deleted.** Entries are not removed: a row missing from a page proves nothing.
- **Rows without a key** are not stored, but are counted in `undated` or `unresolved`. These are rows without a date, or without both lid and slug.

## Run state — `letterboxd/diary/state.json`

| Field | Meaning |
| --- | --- |
| `lastAttemptAt`, `lastSuccessAt`, `lastFailureAt` | A failed, blocked or rate-limited run moves only `lastFailureAt` |
| `lastOutcome` | `recent_window` (page 1 was read; the daily window, not a complete diary), `partial` (the page was not read), `blocked` (403 or challenge), `rate_limited` (429), `failed` (other HTTP, a fetch or body-read error, a facts-write error, or a page without diary rows). A page without rows is never read as an empty diary: no empty-diary layout is known, so it fails and keeps the coverage. A stored `complete` from an older reader is left as stored and does not plan a read |
| `stopReason` | `recent_window_only`, `step_budget` (the lease was too short to start the request), `lease_lost`, `http_<status>_page_1`, `challenge_page_1`, `fetch:<message>`, `read:<message>_page_1`, `unrecognized_page_1`, `after_page:<message>_page_1`. A stored cursor may still say `page_budget`, `overlap` or `page_limit`; those do not select a URL |
| `counts` | `pages`, `rows`, `added`, `unchanged`, `updated`, `conflicts`, `unresolved`, `undated` of the run, and `overflowSuspected`: true only when the page linked a next page, held at least 50 keyed rows, and every one of those keys was new. It is not a count of missed rows |
| `coverage` | `newestWatchedDate`, `oldestWatchedDate`, `reachedEnd` (this reader never sets it), `window` (`recent` after a write of this reader) |
| `resumePage` | Kept as stored, including a page number written by the older reader. This reader never advances it and never fetches it. `null` when none is stored |

**Run order, one page:**
1. Read `https://letterboxd.com/<user>/diary/`, unless `beforePage` returns false: then `partial` / `step_budget`, and `next` asks the caller to try this same page again.
2. Commit the history, then the facts, then the cursor. `onPage` returning false after that read ends `lease_lost` and does not request another page.
3. A page that was read is `recent_window` / `recent_window_only`. `lastSuccessAt` moves only then. `historicalCoverage` is `incomplete` when `coverage.window` is `recent`, and `unknown` when a cursor has no `window`.

**Crash and failure behavior:**
- The page is committed before the state write. A killed run repeats that same page and adds nothing already stored.
- A failure stops the run at once. It keeps the history and `lastSuccessAt`. It does not request page 2.

**Conditional writes and the merge form.** Every `state.json` write is a compare-and-swap on the version read, retried on a conflict.
- **Version 1** (no `writer`): the run's state replaces the stored one, last writer wins, as before the merge form existed.
- **Merge form** (`schemaVersion: 2` with `writer {runId, step}`): only `ratings_storage_migrate` creates it, progress and diagnostics unchanged. From then on the ratings run merges its state into the stored one. The inline EPG stage that wrote `step: inline` is removed ([ADR 0074](../../adr/0074-retire-ratings-pipeline-switch.md)). The merge is:
  - **Progress is a join.** `newestWatchedDate` the later, `oldestWatchedDate` the earlier, `reachedEnd` either, `resumePage` the larger (an absent page counts as page 2) and `null` once `reachedEnd`. `coverage.window: recent` is kept once either side has it, and omitted when both sides lack it. No late or repeated write moves `reachedEnd` or `resumePage` back. Neither one is a fetch plan ([ADR 0067](../../adr/0067-diary-recent-window.md)).
  - **Diagnostics are one record.** `lastOutcome`, `stopReason`, `counts` and `writer` come from the write ordered last by (`lastAttemptAt`, `writer.runId`, `writer.step`, content); `lastAttemptAt`, `lastSuccessAt` and `lastFailureAt` are each the later. Diagnostics never plan a read.
  - **Canonical bytes.** The merge is commutative, associative and idempotent, and keys are sorted, so equal states are equal bytes.
  - **Per-page joins.** The separate run joins progress after each page; such a join carries no `lastAttemptAt` and never wins the diagnostics. On a version 1 cursor it writes nothing.
- **No write turns a merge-form cursor back into version 1.** A cursor found at version 1 after the migration recorded it is reported `migration: regressed` by `ratings_sync_status`.

**Coverage limit.** A backdated entry is found when it lands on page 1. Page 1 holds at most 50 rows, so more than 50 new viewings between successful runs can miss this window. Those rows belong to a separate archive import, which this path does not start. `overflowSuspected` is the only automatic signal, and only in the case in the table above. A periodic full rescan is not part of this contract, and `reachedEnd` is not a claim that one happened.

## In the ratings run

The EPG commit does not run this stage ([ADR 0074](../../adr/0074-retire-ratings-pipeline-switch.md)). The [ratings run](letterboxd-ratings.md#separate-ratings-pipeline) reads Diary page 1 once when migration is complete, whatever the retired `RATINGS_PIPELINE` binding holds. The public films list is not requested ([ADR 0054](../../adr/0054-diary-first-epg-ratings.md)). A step that already checkpointed that page does not fetch again. `more` retries the same page only when it was not started. After the page it joins its progress into the cursor, so a killed step loses at most the page in flight. A `recent_window` is a finished diary phase, not an error. When migration is not complete the commit publishes and does not read Diary.

- **Summary.** It is on the ratings run record, not in `sync.json`. It holds `outcome`, `stopReason`, `counts`, `resumePage`, `coverage` and `at`, plus `facts`:
  - `rated`, `unrated`, and `ambiguous` / `partial` (both stay 0: this reader does not produce those states);
  - `films`, `written`, `unchanged`, `older`, `skipped`, `conflicts`: the write outcomes;
  - `enabled`: always `true`; the former `LETTERBOXD_FACTS` switch is retired ([ADR 0055](../../adr/0055-retire-letterboxd-facts-switch.md)) and kept in the summary for its readers.
  - `historicalCoverage: incomplete` on a finished recent window.
- **Never fatal to EPG.** The stage is not part of the commit. A blocked, rate-limited or failed Diary ends the ratings run as `error` with that cause, and keeps every stored fact.
- **Gate off.** Nothing is read or written by the stage. The ratings run ends `finished` with cause `diary_off`.

## Rating facts

After the page's history commit, the films on that page become facts. `LetterboxdDiary.ratingEvidence` reads the page rows in display order, by lid only. The stored history is not the evidence.

| Evidence | Condition | Fact |
| --- | --- | --- |
| `rated` | The film's latest watched date on the page has a row with a rating. The value is the first such row, top to bottom. A later row of that day, a next link, an open edge or an inexact viewing count does not hide it | `watched: true` and `rating` |
| `unrated` | That date's rows on the page show no rating | `watched: true` only |

`ambiguous` and `partial` are not produced. The summary counters stay and stay 0. A same-day disagreement is not a conflict and not a reason to skip the rating. Both viewing-id rows stay in the history. `viewingCountExact: false` is reported on its own and does not cancel the rating.

- **Never an older day.** An older day on the page never stands in for the latest one.
- **Unresolved entries.** An entry without a lid links nothing, and a slug never links ([ADR 0052](../../adr/0052-letterboxd-slug-film-alias.md)).
- **Observation.** Both facts are observations with `source: letterboxd_diary`, `observedAt` set to the watched date at `00:00:00.000Z`, and `sourceRef: diary:<entry keys>`. The rating observation also carries `ingestedAt`, the attempt's start.
  - A reread of the same value and source reference is the same observation (`ingestedAt` is not part of the observation id), so nothing is written.
  - A later read of a different rating on that same watched date replaces the earlier diary rating, including when the second read is days afterwards and the Diary row still shows the original watched date. A late write of an earlier read does not. A diary rating stored without `ingestedAt` loses to one that has it. The same value read again is the same observation.
  - Any newer observation from another source wins: a film page, the owner, a films-list summary floor, or a newer diary date. The rating is never rolled back to an older diary value, and it is never dated at the sync time.
  - `ratingHistory` gets `first_observed` or `changed` only when the effective rating changes. A later read that returns to a rating already in the list appends another `changed`. An identical reread of the value that is already current, a compare-and-swap retry of the transition just written, and a late write of an earlier read append nothing.
- **Batch writer.** `LetterboxdFacts.applyDiaryEvidence` writes one batch per page:
  - one links compare-and-swap;
  - one record compare-and-swap per film whose view index does not already show the same watched and rating;
  - one view-index projection.
- **Failure.** A failed write stops the run (`stopReason: after_page:<message>_page_1`), so the next run reads page 1 again.
- **Removal events.** They get the proved ratings first, as the film's effective rating. The removal lookup then runs only for removed films without one. A stored rating without diary proof does not spare the lookup.

## Read API

`GET /api/letterboxd/diary[?filmId=<lid>]` reads only: no Letterboxd request, no write.

It returns:
- `enabled`, `state`, `entries`, `unresolvedEntries`, and `films` (how many films have entries);
- with `filmId`: `film {viewingCount, viewingCountExact, lastWatchedAt, rewatches, rewatchesExact, entries[]}`, newest first. `viewingCount` sums the entries' `viewings`; `viewingCountExact` is false while any of them is a lower bound. `rewatches` counts rows marked re-watch (`rewatchRows` of day entries, `rewatch: true` of viewing-id entries); `rewatchesExact` is false while any count is a lower bound or any counted row has an unknown marker.

An invalid `filmId` answers 400.

The [film history API](../api/film-history.md) reads the same history: entries whose `identity` lid is the film's, as `diary_viewing` events in its chronology. Entries without a lid are never attributed to a film there, and a slug alias never links one. The film page shows that chronology; Finds and predictions do not consume the Diary history.

## Storage authority and D1

R2 is the authority for these objects. A D1 projection follows the storage-neutral record above when [AIR-275](https://trello.com/c/4x7hH0gI) adds one; this contract does not create a D1 table or change authority.

## Rollback

- **Gate off:** no further reads or writes; the commit then requests nothing from Letterboxd except the removal lookup.
- **Facts written from the diary:** kept. They are ordinary observations that newer ones replace.
- **Stored history:** kept.
- **Revert:** removes the stage, the reader and the route. The objects stay and are ignored. Deleting them is a separate owner-approved storage operation.
