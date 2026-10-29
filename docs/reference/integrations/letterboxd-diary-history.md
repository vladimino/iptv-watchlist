# Letterboxd Diary viewing history — contract

[AIR-51](https://trello.com/c/33d4hKJ3), [ADR 0048](../../adr/0048-letterboxd-diary-viewing-history.md). Code: [`src/letterboxd-diary.js`](../../../src/letterboxd-diary.js). Gate: `LETTERBOXD_DIARY_HISTORY`, off by default ([feature flags](../feature-flags.md)).

The owner's public Letterboxd Diary is read into a viewing history: one record per diary row, re-watches included. It is kept apart from the current rating. It never writes a rating, watched or watchlist fact, never changes `actualRating`, and absence from the diary means nothing.

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
| `key`, `keyBasis` | `viewing:<id>` (`viewing_id`) when the row carries a viewing id. Otherwise `derived:<lid:…\|slug:…>\|<watchedDate>\|<n>` (`derived`), where `n` is the occurrence of that identity and date in the read, so two viewings on one day stay two |
| `source` | `letterboxd_diary` |
| `identity` | `{type: 'letterboxd_lid', value}`, or `null` (unresolved: never linked to a film) |
| `aliases` | `[{type: 'letterboxd_slug', value}]`, an observation of that row only. Cross-source Film aliases are [AIR-276](https://trello.com/c/PeWwEti8) |
| `viewingId` | The viewing id, or `null` |
| `watchedDate` | `YYYY-MM-DD` from the diary. It is not `observedAt` |
| `ratingAtEntry` | The rating shown on that entry (`null` when unrated). It is not the current rating |
| `rewatch` | `true`, `false` or `unknown` |
| `firstObservedAt`, `observedAt`, `page` | First and latest read, and the page it was seen on |
| `changes` | Up to ten `{field, from, to, observedAt}`, recorded when the entry's rating or re-watch marker changed |

**Merge rules:**
- **A new key** is added.
- **A known key** keeps its identity. A row with another lid or date under the same key is counted as a `conflict` and changes nothing.
- **Edits.** A different rating, or a known re-watch value, is recorded as a change. A slug is added as an alias.
- **Never deleted.** Entries are not removed: a row missing from a page proves nothing.
- **Rows without a key** are not stored, but are counted in `undated` or `unresolved`. These are rows without a date, or without both lid and slug.

## Run state — `letterboxd/diary/state.json`

| Field | Meaning |
| --- | --- |
| `lastAttemptAt`, `lastSuccessAt`, `lastFailureAt` | A failed, blocked or rate-limited run moves only `lastFailureAt` |
| `lastOutcome` | `complete` (the last page has been reached at some point and nothing is pending), `partial` (pages remain), `blocked` (403 or challenge), `rate_limited` (429), `failed` (other HTTP, fetch error, unrecognized page) |
| `stopReason` | `http_<status>_page_<n>`, `challenge_page_<n>`, `fetch:<message>`, `unrecognized_page_<n>`, `page_budget`, `overlap`, `page_limit` |
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

With the gate on, `completeWithRatings` runs the stage in phase `diary` (see [ratings attempt](letterboxd-ratings.md#ratings-attempt)) after the removal lookup and before the films list.

- **Summary.** It is stored in `sync.json` as `diaryHistory` (`outcome`, `stopReason`, `counts`, `resumePage`, `at`) and returned by the sync status.
- **Never fatal.** The stage never fails the commit.
- **Shared page 1.** Its page-1 rows feed the diary repair after a failed films list, so a commit reads Diary page 1 once. If the stage could not read page 1, the repair reports that and does not request it again.
- **Gate off.** Nothing is read or written by the stage, and the repair keeps its own single page-1 request.

## Read API

`GET /api/letterboxd/diary[?filmId=<lid>]` reads only: no Letterboxd request, no write.

It returns:
- `enabled`, `state`, `entries`, `unresolvedEntries`, and `films` (how many films have entries);
- with `filmId`: `film {viewingCount, lastWatchedAt, rewatches, entries[]}`, newest first.

An invalid `filmId` answers 400. Timeline, Finds and predictions do not consume it yet.

## Storage authority and D1

R2 is the authority for these objects. A D1 projection follows the storage-neutral record above when [AIR-275](https://trello.com/c/4x7hH0gI) adds one; this contract does not create a D1 table or change authority.

## Rollback

- **Gate off:** no further reads or writes.
- **Stored history:** kept.
- **Revert:** removes the stage, the reader and the route. The objects stay and are ignored. Deleting them is a separate owner-approved storage operation.
