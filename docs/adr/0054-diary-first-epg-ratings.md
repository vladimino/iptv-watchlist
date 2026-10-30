# ADR 0054: EPG ratings are Diary-first: diary evidence becomes facts, the films list is no longer scanned

**Status:** Accepted  
**Original decision date:** 2026-10-30  
**Recorded at:** 2026-10-30  
**Approval source:** Owner explicitly Accepted ADR 0054 and visually approved both changed Mermaid diagrams on 2026-10-30 after a positive independent review of [PR #247](https://github.com/vladimino/iptv-watchlist/pull/247#pullrequestreview-5712268139) at `fd074c5` and successful CI. [AIR-287 owner-gate decision](https://trello.com/c/kOZlT8UE#comment-6ae49031a74e2ded1b2f15a3). Architecture acceptance and visual approval authorize ordinary PR delivery only; no production flag, Scheduled Task, EPG or writer operation was authorized.  
**Related work:** [AIR-287](https://trello.com/c/kOZlT8UE); [AIR-288](https://trello.com/c/bpXgN1nV) (production activation); [AIR-51](https://trello.com/c/33d4hKJ3); [AIR-276](https://trello.com/c/PeWwEti8); [AIR-272](https://trello.com/c/Oezn5dLP); [AIR-267 evidence](../evidence/letterboxd/air-267-recent-ratings-diagnostics-2026-10-29.md); [ADR 0023](0023-letterboxd-user-facts.md); [ADR 0024](0024-letterboxd-scan-summary.md); [ADR 0043](0043-removal-rating-lookup-queue.md); [ADR 0049](0049-letterboxd-diary-viewing-history.md); [ADR 0052](0052-letterboxd-slug-film-alias.md)  
**Supersedes:** [ADR 0049](0049-letterboxd-diary-viewing-history.md) in part: decision 1's "never a rating, watched or watchlist fact" and decision 2's diary repair; [ADR 0043](0043-removal-rating-lookup-queue.md) in part: decision 1's order (the lookup now runs after the diary, for films the diary gave no rating)  
**Superseded by:** [ADR 0055](0055-retire-letterboxd-facts-switch.md) (Proposed) in part: decision 7 as far as `LETTERBOXD_FACTS` decides whether diary facts are written; diary facts are always written, and every other decision stays

## Context

After an EPG commit the Worker scanned the 31-page public films list. Page 2 has answered 403 since AIR-267, so the scan failed every time. Only the bounded removal lookup and a page-1 diary repair, which confirmed each rating on the film's own page, produced ratings.

The diary history of ADR 0049 already reads up to three diary pages per commit. It stores every row with its lid, watched date and rating at entry, but it wrote no fact.

## Decision

1. **The diary is the routine source.**
   - With `LETTERBOXD_DIARY_HISTORY` on, the commit reads the diary history (ADR 0049).
   - After each page's history commit and before the next request, every film on that page is turned into facts. There is no cap on rows, and `LetterboxdFacts.applyDiaryEvidence` writes one batch per page.
   - A failed facts write stops the run at that page, so the next run reads it again. The writer is idempotent.
2. **What the diary proves, by lid only.** `LetterboxdDiary.ratingEvidence` decides it from the stored history:
   - **Watched:** any entry of the lid proves watched.
   - **Rating:** the rating at the film's latest watched date, only when every row of that date is known and they agree. Each row is a viewing-id entry or a counted row of a day entry, and the day count must be proved by one page.
   - **Page fence:** the latest date must also lie inside the page just read. The film has a row of that date on it, and the date touches no open page edge: the top of a page after the first, or the bottom of a page with a next one. This holds for viewing-id rows too, so half of a day split across pages, read or blocked, never publishes a rating.
   - **No rating:** an unrated latest date, disagreeing ratings or a day cut by a page boundary prove no rating. An older entry never stands in for the latest one.
   - **Unresolved entries:** entries without a lid link nothing. A slug never links (ADR 0052).
3. **Observed at the watched date.**
   - Both facts are observations with `source: letterboxd_diary` (rank 1) and `observedAt` set to the watched date at 00:00 UTC. The source reference is the diary entry keys.
   - A reread is therefore the same observation: no write, no history.
   - Any newer observation wins, including a film page, the owner, the films-list floor or a newer diary date. The rating is never rolled back to an older diary value, and no change date is invented.
   - `ratingHistory` records `first_observed` or `changed` only when the effective value changes.
   - A film whose view index already shows the same watched and rating is not written.
4. **The films list is not scanned after a commit.**
   - `refreshRatingsFromFilms`, its three 403 tries and the films-list diary and baseline repairs leave the EPG path.
   - A stored films-list summary stays the floor of later observations.
5. **Fallback after the diary.**
   - Removal events get the ratings the diary proved, as the film's effective rating. A stored rating without diary proof neither spares the lookup nor counts as proof.
   - The removal lookup (ADR 0043) then runs only for removed films the diary gave no rating, within its existing bounds: five requests per call, three attempts per film, and a pause on 403 or 429.
   - A blocked diary leaves every removed film to the lookup.
6. **Honest status.** `sync.json` records:
   - `diaryHistory` with outcome, stop reason, counts, coverage, resume point and the facts summary (rated, unrated, ambiguous, partial, written, unchanged, older, skipped, conflicts);
   - `ratingAttempt` ending `finished` with `source: letterboxd_diary`, or `error` with cause `blocked`, `rate_limited` or `failed`. With the diary gate off it ends `finished` with cause `diary_off`.

   A killed stage is closed as `unknown` in phase `diary`, and the diary is not read again.
7. **Gates.** `LETTERBOXD_DIARY_HISTORY` decides whether the diary is read, and `LETTERBOXD_FACTS` whether facts are written. With facts off, the diary is still read and its proved ratings still reach removal events.

Not decided here:
- production activation ([AIR-288](https://trello.com/c/bpXgN1nV));
- the fate of `REMOVAL_RATING_LOOKUP` ([AIR-272](https://trello.com/c/Oezn5dLP));
- ratings given without any diary entry;
- a rating edited on an old, backdated diary entry, which stays older than a newer stored observation.

## Alternatives considered

- **Keep the films-list scan**: it fails at page 2 with 403 on every commit (AIR-267).
- **Diary rating observed at read time**: an old entry read now would override a newer rating from another source. Rejected.
- **Confirm each diary rating on the film's own page** (the old repair): up to fifty extra requests per commit, which the 403 pause makes unreliable. Rejected.
- **Use the latest rated entry when the latest one is unrated**: it would present an older viewing's rating as current. Rejected.

## Consequences

- **What works.** Ratings and watched facts arrive from the source that answers the Worker (page 1 confirmed on 2026-10-29), with no extra per-film requests.
- **What is missed.** A rating set without a diary entry, or edited on an old entry, is not seen until another source observes it. A day split by a page boundary gets its rating once a later read holds it within one page.
- **Load.** Facts writes are bounded by the pages read: at most 150 films per commit, mostly skipped once projected. A synthetic worst case (150 films never seen, three pages) takes 489 R2 operations and about 40 ms locally (`tests/diary-first-ratings.mjs`). Production CPU and wall time are not measured.

## Recovery and migration boundary

The change is code only. With `LETTERBOXD_DIARY_HISTORY` off (production today), the commit requests nothing from Letterboxd except the removal lookup.

A revert restores the films-list scan. Facts written from the diary stay; they are ordinary observations that newer ones replace.

Setting either switch in production is a separate owner-approved change ([AIR-288](https://trello.com/c/bpXgN1nV)). This record authorizes no production request.

## Evidence

- **Original decision:** [AIR-287](https://trello.com/c/kOZlT8UE); Accepted by the owner on 2026-10-30 after [independent positive re-review](https://github.com/vladimino/iptv-watchlist/pull/247#pullrequestreview-5712268139) and explicit [owner-gate confirmation](https://trello.com/c/kOZlT8UE#comment-6ae49031a74e2ded1b2f15a3), including visual approval of both Mermaid diagrams.
- **Implementation:**
  - `src/worker.js` (`diaryRatingsStage`, `completeWithRatings`);
  - `src/letterboxd-diary.js` (`ratingEvidence`, the `afterPage` hook);
  - `src/letterboxd-facts.js` (`applyDiaryEvidence`, source `letterboxd_diary`);
  - `tests/diary-first-ratings.mjs` and the updated ratings tests.
- **Dated verification:** not recorded; no production diary read for facts has run.
- **Uncertainty:**
  - whether diary page 2 answers the Worker;
  - how often the owner rates without a diary entry.
