# ADR 0049: The Letterboxd Diary is read into a separate viewing history, incrementally and behind a gate

**Status:** Accepted  
**Original decision date:** 2026-10-29  
**Recorded at:** 2026-10-29  
**Approval source:** Owner explicitly accepted ADR 0049 on 2026-10-30 after independent positive review of [PR #239](https://github.com/vladimino/iptv-watchlist/pull/239); decision recorded in the [AIR-51 Trello owner-gates comment](https://trello.com/c/33d4hKJ3#comment-6ae44476be47e8c154b51049). The owner separately visually approved the rendered Mermaid diagram in `docs/architecture/letterboxd-ingestion.md`. No production activation was authorized.  
**Related work:** [AIR-51](https://trello.com/c/33d4hKJ3); [AIR-273](https://trello.com/c/TVB01Xm0) (production Worker read Diary page 1: HTTP 200, 50 rows, 50 lids, dates and ratings); [AIR-274](https://trello.com/c/CxiAfmZJ) (diagnostic removed); [AIR-272](https://trello.com/c/Oezn5dLP); [AIR-275](https://trello.com/c/4x7hH0gI) (D1); [AIR-276](https://trello.com/c/PeWwEti8) (slug aliases); [ADR 0023](0023-letterboxd-user-facts.md); [ADR 0024](0024-letterboxd-scan-summary.md); [ADR 0038](0038-durable-rating-and-prediction-lineage.md); [contract](../reference/integrations/letterboxd-diary-history.md)  
**Supersedes:** None  
**Superseded by:** [ADR 0054](0054-diary-first-epg-ratings.md) (Accepted 2026-10-30) in part: the diary becomes the routine source of watched and rating facts, and the diary repair leaves the EPG path

## Context

The owner's watching history exists only on Letterboxd. The public films list is 31 pages in release-date order and is challenged from page 2. `rated-date` is challenged. A per-film member page exists only for diary entries. AIR-273 showed that the production Worker reads Diary page 1 cleanly: HTTP 200, no challenge, 50 rows, each with a lid, a watched date and a rating.

The current code already reads Diary page 1, but only inside the films-list repair, and only its rated rows. Viewing events, re-watches and dates are discarded, and nothing records which history has been seen.

## Decision

1. **A separate viewing history.**
   - Kept in `letterboxd/diary/history.json`. A diary row with a viewing id is its own record. Rows without one are kept as one record per film and day that counts its viewings (§4).
   - Each record holds the watched date, the rating at each counted row, re-watch information (the marker `true`, `false` or `unknown`, and for a day record how many rows were marked re-watch and how many were unknown), the typed identity (`letterboxd_lid`) and slug alias, and when it was first and last observed, with `source: letterboxd_diary`.
   - **Granularity lost without a viewing id.** Two viewings of one film on one day are not separate records: their order, which of them was the re-watch and which carried which rating are not kept as per-viewing facts, only as the day's count, its list of ratings in page order and its re-watch row count. Whether the real diary page carries a viewing id is not confirmed, so this may be the common case.
   - It is never a rating, watched or watchlist fact and never changes `actualRating`.
2. **One reader, one read per commit.**
   - `LetterboxdDiary.parsePage` is the only diary parser. The films-list repair uses it too.
   - When the history stage runs, the repair reuses its page-1 rows and makes no request of its own, even when the stage could not read the page.
3. **Incremental and bounded.**
   - At most three pages per EPG commit, same origin, no retry, no redirect followed, no challenge handling.
   - Page 1 always. The next page only while a page is entirely new.
   - A pending backfill resumes one page before where it stopped, as overlap, and continues from there.
   - Each page is committed by compare-and-swap before the next request. The run state, `letterboxd/diary/state.json`, is written last.
4. **Keys that neither merge nor invent viewings.**
   - A row with a viewing id is its own entry.
   - Without an id, two viewings of one film on one day cannot be told apart, so the entry is per film and day and counts its viewings.
   - Pages are separate requests, not one snapshot: a row added between two requests repeats on the next page, and a removed one is skipped. So a day is counted within one page only, never summed across pages. The count is certain only when one page holds the whole day; a day cut by a page boundary keeps the larger single-page count as a lower bound.
   - The count only grows: a cut read never lowers it, and a page shift or a repeated row never adds a viewing. A count grown by an uncertain read is a lower bound again.
   - A stored viewing id keeps its identity. A disagreeing row, or a certain count below any stored count, is a conflict and changes nothing: a stored lower bound is never made exact by a smaller proved count. Rating and re-watch edits are recorded as changes.
   - **Honest bounds.** Per film, `viewingCount` and `rewatches` are exact only when every entry is certain and every counted row had a known re-watch marker; otherwise `viewingCountExact` or `rewatchesExact` is false and the number is a lower bound. A day split across a page boundary stays a lower bound until a later read finds it within one page.
5. **Honest coverage.**
   - Outcomes are `complete`, `partial`, `blocked`, `rate_limited` or `failed`, with a stop reason and the per-run counts.
   - The coverage is the newest and oldest dates seen and whether the last page was ever reached.
   - Absence from the diary proves nothing. A failure, including an unreadable body or a page without diary rows (never taken for an empty diary), keeps the last good history, the coverage and the resume point.
6. **Identity only by lid.** A row without a lid is stored but marked unresolved. A slug alone never links a film.
7. **Gated.**
   - Behind `LETTERBOXD_DIARY_HISTORY`, off by default. With it off, the stage neither reads nor writes, and the repair keeps its own single page-1 request.
   - A read-only `GET /api/letterboxd/diary` exposes the state, per-film aggregates (`viewingCount`, `viewingCountExact`, `lastWatchedAt`, `rewatches`, `rewatchesExact`) and one film's entries. Nothing else consumes the history yet.

Not decided here:
- production activation;
- consumers (Timeline, Finds, predictions);
- a D1 table (AIR-275);
- cross-source Film aliases (AIR-276);
- the fate of the removal lookup (AIR-272);
- a periodic full rescan for entries backdated deep into the diary;
- the Letterboxd export as a source for ratings without diary entries.

## Alternatives considered

- **`/films/by/rated-date/` page 1** (AIR-273): challenged from a server runtime.
- **The full films list**: release-date order, 31 pages, page 2 challenged.
- **A positive-only `/films/` page-one fallback for removed films** (AIR-273 option B): proposed, then superseded by this source.
- **Storing diary rows as rating facts**: rejected. A diary entry's rating is the rating at that viewing, not the current rating, and ratings without a diary entry would still be missing.

## Consequences

- Viewing events, re-watches and their dates become durable, idempotent data, separate from current ratings.
- The diary repair stops making its own request when the stage runs, so a commit reads Diary page 1 at most once.
- Coverage is limited to what pages 1–3 per commit reach. Whether page 2 answers the Worker is not known. Entries backdated beyond the overlap page are found only if a later backfill reaches them.
- Two new R2 objects. `history.json` grows with the diary, roughly 300 bytes per entry.

## Recovery and migration boundary

The change is code only, behind an off-by-default switch. Switching it off stops the requests and writes on the next commit, and the stored history stays. A revert removes the stage, the reader and the read route. The objects under `letterboxd/diary/` stay and are ignored. Setting the switch in production is a separate owner-approved writer change. This record authorizes no production request.

## Evidence

- **Original decision:** this record, proposed with AIR-51 and explicitly Accepted by the owner on 2026-10-30 (see Approval source).
- **Source facts:** AIR-273 production diagnostic of Diary page 1 (Trello AIR-273), removed by AIR-274.
- **Implementation:** `src/letterboxd-diary.js`, `src/worker.js` (stage, read route), `src/enrichment.js` (repair on the shared parser), `src/feature-flags.js`, `tests/letterboxd-diary.mjs`.
- **Uncertainty:**
  - the viewing-id attribute and the re-watch markup are not confirmed on the real page; the parser reads them only when explicitly present, and treats them as `unknown` or derives the key otherwise;
  - page 2 availability is unknown.
