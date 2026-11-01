# ADR 0067: The routine Diary read is the first page only, and a rating visible on that page is the rating

**Status:** Accepted (owner decision 2026-10-31)  
**Original decision date:** 2026-10-31  
**Recorded at:** 2026-10-31  
**Approval source:** Owner explicitly Accepted ADR 0067 and visually approved the rendered Mermaid in `docs/architecture/letterboxd-ingestion.md` and both diagrams in `docs/architecture/scheduling-and-orchestration.md` on 2026-10-31 (Europe/Madrid), after the independent PASS review of PR #285 reviewed HEAD `94c8a63922387cb1a882f659b202544c972dce38` and successful CI. [Owner-gate record](https://trello.com/c/5M7hmLfM#comment-6ae5f8b4edcdfed02b9d1aea); [PASS review](https://github.com/vladimino/iptv-watchlist/pull/285#pullrequestreview-5723132080). This approval permits only routine PR delivery, not additional production runs or changes to data, flags, Tasks or migrations.  
**Related work:** [AIR-304](https://trello.com/c/5M7hmLfM); the production run recorded in [the 2026-10-31 evidence](../evidence/letterboxd/air-304-diary-page-2-blocked-2026-10-31.md); [AIR-295](https://trello.com/c/VtFZ6cci) (live cutover, not closed by this record); [AIR-294](https://trello.com/c/IzWiVABa); [AIR-287](https://trello.com/c/kOZlT8UE); [ADR 0049](0049-letterboxd-diary-viewing-history.md); [ADR 0054](0054-diary-first-epg-ratings.md); [ADR 0060](0060-independent-letterboxd-ratings-pipeline.md)  
**Supersedes:** In part: [ADR 0049](0049-letterboxd-diary-viewing-history.md) decision 3 (three pages, the next page while a page is new, backfill overlap) and decision 5 (`complete` / `partial` as the success of a routine read); [ADR 0054](0054-diary-first-epg-ratings.md) decision 2 (a rating only when the day's rows are all known and agree, and the page fence); [ADR 0060](0060-independent-letterboxd-ratings-pipeline.md) the Diary-phase page budget (three pages a step, nine a run) and the use of `resumePage` as the next unread page; [ADR 0023](0023-letterboxd-user-facts.md) decision 4 only for two `letterboxd_diary` observations at the same `observedAt`; [ADR 0038](0038-durable-rating-and-prediction-lineage.md) decision 1 only for the claim that the observation id alone makes a history write idempotent. Every other decision of those records stays.  
**Superseded by:** [ADR 0075](0075-retire-letterboxd-diary-history-switch.md) (Accepted 2026-11-01) in part: the clause that a diary gate that is off does not fetch. The page-1 budget stays.

## Context

- **The separate ratings run reads past page 1.** ADR 0049 reads up to three diary pages per commit, then backfills from `resumePage`. ADR 0060 keeps that order inside the leased ratings run: three pages a step, nine a run.
- **Page 2 does not answer.** On 2026-10-31 the first separate run, `66d57611-c2de-4245-8618-1fa71dee167c`, wrote page 1 and its facts, then HTTP 403 on page 2 ended the run `blocked` / `error` with `lastSuccessAt` null and `resumePage` 2. The next daily run would request page 2 again. Counts only, no diary rows: [evidence](../evidence/letterboxd/air-304-diary-page-2-blocked-2026-10-31.md).
- **A cut day was not allowed to carry a rating.** ADR 0054 hides the rating when the latest day is cut by a page edge, when the day's rows disagree, or when the viewing count is a lower bound.
- **The owner decided otherwise on 2026-10-31.** If a rating is visible on Diary page 1, it is the rating. The reader does not require the rest of that day and does not look at a later page. Several rows of the same film on the same watched date: the first row in Diary display order that shows a rating. No extra tie-break, no key sort, and no conflict merely because another rating is also visible. Every visible rating stays in the viewing history when the row has an identifier. A watched fact comes from each valid row. An inexact viewing count and incomplete historical coverage are tracked separately and do not cancel the visible rating. Newer observations from another source or the owner still win. No further owner decision is required before the code; this record and the rendered diagrams still need their own acceptance.

## Decision

### 1. One request, the first page

A Diary run, inline in the EPG commit and in the separate ratings run, makes exactly one HTTP GET: `https://letterboxd.com/<user>/diary/`. It never requests `/diary/page/2/` or any other diary page. An HTML next link, a page of entirely new rows, a stored `resumePage` (including 2), a version-2 cursor and a previous error do not select another URL. There is no automatic backfill and no retry of a later page. The per-film removal lookup stays its own queue, with its existing limits and its own 403/429 pause.

A ratings step that already checkpointed `diaryPagesRead >= 1`, or a diary gate that is off, does not fetch. A step that could not read the page (`beforePage` false, `stopReason: step_budget`) returns `next: {page: 1, mode: 'recent'}` so the same run retries that same page. A lease lost after the page was read does not fetch another page.

### 2. The rating is the first visible one on the latest day of that page

`ratingEvidence` reads the page rows in display order. The history object is not the evidence; the history merge has already stored the rows.

- The candidate day is the film's latest watched date on that page.
- The rating is the first row of that day with `ratingAtEntry != null`, top to bottom. A later row of the same day, an open page edge, a next link or `viewingCountExact: false` does not hide it and is not a `partial` or an `ambiguous`.
- A day with no visible rating proves a viewing only.
- An older day on the page does not stand in.
- The observation time stays the watched date, so a newer observation from any other source, including the owner, still wins.
- Two diary ratings of that same watched date are ordered by the page-read time (`ingestedAt` on the rating observation), after source rank and before `observationId`. A revision days after the viewing keeps the original watched date; the later read replaces the earlier diary rating. The time is the attempt's start, fixed before the fact write, so a late write of an earlier read does not replace a later read. `ingestedAt` is not part of `observationId`: the same value and source reference stay the same observation. A diary rating stored without `ingestedAt` loses to one that has it; two without it stay on `observationId`. An owner observation, a film-page observation and any later `observedAt` are compared before this and still win on the existing rules.
- `ratingHistory` appends `changed` for every effective change, including a later return to a value whose observation id is already in the list. The idempotent write is that transition at the tail of the list: a compare-and-swap retry of it, and a reread of the value that is already current, add nothing. A late write of an earlier read adds nothing. The entry identity is unchanged: the observation id, whether the entry applies or reverses it, and how many times that happened before in the list, so two applications of one observation stay two events in a convergence merge.
- Each row with a viewing id stays its own history entry. Rows without one still collapse to one day entry, and that entry keeps `ratingsAtEntry` in page order. An identity conflict (the same viewing id, a different lid) stays a conflict.
- `viewingCountExact` stays the lower-bound from day groups. It does not cancel the rating.

### 3. A successful page is a recent window, not a complete diary

A page that was read finishes `lastOutcome: recent_window`, `stopReason: recent_window_only`. `lastSuccessAt` moves to that attempt's start. `coverage.window` is `recent`. The run does not set `coverage.reachedEnd` and does not advance `resumePage`. The ratings status reports `historicalCoverage: incomplete` when `coverage.window` is `recent`, and `unknown` when it is absent (a cursor this reader has not written). A dedicated ratings run whose diary phase ended `recent_window` finishes `state: finished` after the removal phase. It does not promise `reachedEnd: true` or a full archive.

`counts.overflowSuspected` is true only when the page linked a next page, held at least 50 keyed rows, and every one of those keys was new. It is not a count of missed rows. Any other suspicion is not recorded.

A cursor join keeps `window: recent` once either side has it, and omits it when both sides lack it, so two old cursors stay byte-identical. `reachedEnd` and `resumePage` stay the monotone join of ADR 0060 and are not a fetch plan. No write turns a merge-form cursor back into version 1. Stored history is not migrated.

### 4. Page 1 still fails closed

HTTP 403, a challenge page, HTTP 429 and an unrecognized or empty page are `blocked`, `rate_limited` or `failed`. They do not move `lastSuccessAt` and they do not invent a success. The last good history and facts stay. The Ratings Task and the EPG commit do not start an archive import.

### 5. The fifty-row boundary

Diary page 1 holds up to 50 rows. More than 50 new viewings between successful runs can miss this window. Those rows are the job of a separate archive import, which this path does not start and which this record does not specify. The reader does not claim the import, or the window, is complete.

## Alternatives considered

- **Keep the backfill and stop when page 2 returns 403.** The stored `resumePage` would send the next run to page 2 again. That is the production failure this record closes. Rejected.
- **Hide a rating that sits on an open page edge, or when two rows of the day disagree, until a later page proves the day.** The owner rejected this on 2026-10-31: a visible rating is used, and the missing count is reported separately. Rejected.
- **Choose the rating by sorting entry keys, or require a proof of order beyond Diary display order.** The owner rejected an extra tie-break. Rejected.
- **Date the diary fact at the time of the sync, so a changed rating sorts as newer.** That would beat an owner or film-page observation made after the watched date and before the sync. The watched date stays the observation time. Rejected.

## Consequences

- A daily run can finish when page 1 answers, including when the diary links onward.
- Historical coverage stays incomplete on purpose. Film history keeps the `diary_coverage_partial` note for a recent window. A stored older cursor with `lastOutcome: complete`, `reachedEnd` and no `resumePage` still omits that note.
- A burst of more than 50 new viewings can skip rows until a separate archive import. `overflowSuspected` is the only automatic signal, and only in the case above.
- The inline EPG diary stage is page 1 as well. Its stored bytes are not a copy of the multi-page reader.
- Offline, one commit of 50 films never seen before took 171 R2 operations and about 6 ms locally (`tests/diary-first-ratings.mjs`). That is not a Worker memory measurement.

## Recovery and migration boundary

This record is the code and its documents. It does not authorize a live ratings or EPG run, a flag change, a Task edit, a migration, or an R2 or D1 write. The existing Ratings Task stays as it is. AIR-295 is not closed here.

`resumePage` and `reachedEnd` already stored, including `resumePage: 2`, are left in place and are not fetched. After the version-2 migration, reverting to code from before ADR 0060 is not a safe rollback of the stored queue and cursor (ADR 0060).

## Evidence

- **Original decision:** [AIR-304](https://trello.com/c/5M7hmLfM), owner rule of 2026-10-31 in the card description. Owner Accepted this ADR on 2026-10-31; see the owner-gate record above.
- **Production failure that motivated it:** [page 2 blocked on 2026-10-31](../evidence/letterboxd/air-304-diary-page-2-blocked-2026-10-31.md), run `66d57611-c2de-4245-8618-1fa71dee167c`. No diary rows are in that report.
- **Implementation:** the pull request that adds this record. Not yet merged.
- **Uncertainty:** this record does not retest whether a later diary page would answer after a delay. The reader does not ask.

## Follow-ups

A read-only production check that the daily run finishes on page 1 belongs to [AIR-295](https://trello.com/c/VtFZ6cci), after this code is deployed, and needs its own acceptance. An archive import is a separate card. [AIR-303](https://trello.com/c/mCvySjUN) is not part of this record.
