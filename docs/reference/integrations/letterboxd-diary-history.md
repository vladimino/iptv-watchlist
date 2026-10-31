# Letterboxd Diary viewing history — contract

[AIR-51](https://trello.com/c/33d4hKJ3), [ADR 0049](../../adr/0049-letterboxd-diary-viewing-history.md). Code: [`src/letterboxd-diary.js`](../../../src/letterboxd-diary.js). Gate: `LETTERBOXD_DIARY_HISTORY`, off by default ([feature flags](../feature-flags.md)).

The owner's public Letterboxd Diary is read into a viewing history. A row with a viewing id is its own entry; rows without one become one entry per film and day that counts its viewings, a lower bound unless one page held the whole day. Without a viewing id the per-viewing granularity is lost: two viewings of a film on one day keep only their count, their ratings in page order and how many rows were marked re-watch, not which viewing was which. The history is kept apart from the current rating. Under [ADR 0054](../../adr/0054-diary-first-epg-ratings.md) the EPG commit turns what it proves into watched and rating facts ([below](#rating-facts)). Absence from the diary means nothing.

## Source

- **Pages read.** `https://letterboxd.com/<user>/diary/` and `…/diary/page/<n>/`, from the Worker, with the production headers. One request per page, no retry, no redirect followed, no challenge handling.
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
- **Not known:** whether page 2 answers the Worker.

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
| `lastOutcome` | `complete` (the last page has been reached at some point and nothing is pending), `partial` (pages remain), `blocked` (403 or challenge), `rate_limited` (429), `failed` (other HTTP, a fetch or body-read error, or a page without diary rows). A page without rows is never read as an empty diary: no empty-diary layout is known, so it fails and keeps the coverage and the resume point |
| `stopReason` | `http_<status>_page_<n>`, `challenge_page_<n>`, `fetch:<message>`, `read:<message>_page_<n>`, `unrecognized_page_<n>`, `page_budget`, `overlap`, `page_limit` |
| `counts` | `pages`, `rows`, `added`, `unchanged`, `updated`, `conflicts`, `unresolved`, `undated` of the run |
| `coverage` | `newestWatchedDate`, `oldestWatchedDate`, `reachedEnd` |
| `resumePage` | The first page not yet read by the backfill, or `null` |

**Run order, at most three pages:**
1. Page 1 is always read.
2. While a page is entirely new, the next page is read too, because the new entries continue there.
3. Once a page holds a known entry, a pending backfill resumes at `resumePage − 1`, one page of overlap, and reads on.
4. A history without `reachedEnd` and without a resume point starts its backfill at page 2.

**Crash and failure behavior:**
- Each page is committed before the next request, and the state is written last. A killed run only repeats reads.
- A failure stops the run at once. It keeps the history and `lastSuccessAt`, and records where to resume.

**Coverage limit.** A backdated entry is found when it lands on page 1, or on a page a later backfill reaches. A periodic full rescan is not part of this contract.

## In the EPG commit

With the gate on, `completeWithRatings` runs the stage in phase `diary` (see [ratings attempt](letterboxd-ratings.md#ratings-attempt)) right after the commit. The removal lookup follows it, and the public films list is not requested ([ADR 0054](../../adr/0054-diary-first-epg-ratings.md)).

- **Summary.** It is stored in `sync.json` as `diaryHistory` and returned by the sync status. It holds `outcome`, `stopReason`, `counts`, `resumePage`, `coverage` and `at`, plus `facts`:
  - `rated`, `unrated`, `ambiguous`, `partial`: the evidence states;
  - `films`, `written`, `unchanged`, `older`, `skipped`, `conflicts`: the write outcomes;
  - `enabled`: always `true`; the former `LETTERBOXD_FACTS` switch is retired ([ADR 0055](../../adr/0055-retire-letterboxd-facts-switch.md)) and kept in the summary for its readers.
- **Never fatal.** The stage never fails the commit. A blocked, rate-limited or failed run ends the ratings attempt as `error` with that cause, and keeps every stored fact.
- **Gate off.** Nothing is read or written by the stage. The ratings attempt ends `finished` with cause `diary_off`.

**Proposed, not deployed.** [ADR 0060](../../adr/0060-independent-letterboxd-ratings-pipeline.md) (`Proposed`) would move this stage out of the EPG commit into a separate ratings run with its own record `letterboxd/ratings/run.json`. The stage would keep its order, overlap and stop rules and its per-page facts, with these changes: at most three pages per step and nine per run; after each page, `state.json` written as a forward-only join under compare-and-swap, so no late write from any step can move the cursor back (a per-page checkpoint, instead of once at the end; it stays the authoritative Diary cursor, and the join applies only once a `separate` run has migrated it); the summary in the run record instead of `sync.json`. Until that record is accepted and delivered, the behavior above is the contract.

## Rating facts

After each page's history commit, and before the next page is requested, the films on that page become facts. `LetterboxdDiary.ratingEvidence` reads the stored history, by lid only.

| Evidence | Condition | Fact |
| --- | --- | --- |
| `rated` | The film's latest watched date has every row known and rated with one value: viewing-id entries, and day entries whose count is proved by one page | `watched: true` and `rating` |
| `unrated` | The latest date's rows have no rating | `watched: true` only |
| `ambiguous` | The latest date's rows disagree | `watched: true` only |
| `partial` | The latest date's day count is a lower bound, or the date is not inside the page just read: the film has no row of that date on it, or the date touches an open page edge (the top of a page after the first, the bottom of a page with a next one). Viewing-id rows are fenced the same way | `watched: true` only |

- **Never an older entry.** An older entry never stands in for the latest one.
- **Unresolved entries.** An entry without a lid links nothing, and a slug never links ([ADR 0052](../../adr/0052-letterboxd-slug-film-alias.md)).
- **Observation.** Both facts are observations with `source: letterboxd_diary`, `observedAt` set to the watched date at `00:00:00.000Z`, and `sourceRef: diary:<entry keys>`.
  - A reread is the same observation, so nothing is written.
  - Any newer observation wins: a film page, the owner, a films-list summary floor, or a newer diary date. The rating is never rolled back to an older diary value.
  - `ratingHistory` gets `first_observed` or `changed` only when the effective rating changes.
- **Batch writer.** `LetterboxdFacts.applyDiaryEvidence` writes one batch per page:
  - one links compare-and-swap;
  - one record compare-and-swap per film whose view index does not already show the same watched and rating;
  - one view-index projection.
- **Failure.** A failed write stops the run at that page (`stopReason: after_page:<message>_page_<n>`), so the next run reads the page again.
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
