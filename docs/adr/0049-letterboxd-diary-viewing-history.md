# ADR 0048: The Letterboxd Diary is read into a separate viewing history, incrementally and behind a gate

**Status:** Proposed  
**Original decision date:** 2026-10-29  
**Recorded at:** 2026-10-29  
**Approval source:** not yet decided; the card scope and the Diary source strategy were approved on [AIR-51](https://trello.com/c/33d4hKJ3) after [AIR-273](https://trello.com/c/TVB01Xm0)  
**Related work:** [AIR-51](https://trello.com/c/33d4hKJ3); [AIR-273](https://trello.com/c/TVB01Xm0) (production Worker read Diary page 1: HTTP 200, 50 rows, 50 lids, dates and ratings); [AIR-274](https://trello.com/c/CxiAfmZJ) (diagnostic removed); [AIR-272](https://trello.com/c/Oezn5dLP); [AIR-275](https://trello.com/c/4x7hH0gI) (D1); [AIR-276](https://trello.com/c/PeWwEti8) (slug aliases); [ADR 0023](0023-letterboxd-user-facts.md); [ADR 0024](0024-letterboxd-scan-summary.md); [ADR 0038](0038-durable-rating-and-prediction-lineage.md); [contract](../reference/integrations/letterboxd-diary-history.md)  
**Supersedes:** None  
**Superseded by:** None

## Context

The owner's watching history exists only on Letterboxd. The public films list is 31 pages in release-date order and is challenged from page 2. `rated-date` is challenged. A per-film member page exists only for diary entries. AIR-273 showed that the production Worker reads Diary page 1 cleanly: HTTP 200, no challenge, 50 rows, each with a lid, a watched date and a rating.

The current code already reads Diary page 1, but only inside the films-list repair, and only its rated rows. Viewing events, re-watches and dates are discarded, and nothing records which history has been seen.

## Decision

1. **A separate viewing history.**
   - One record per diary row, kept in `letterboxd/diary/history.json`. Re-watches are separate records.
   - Each record holds the watched date, the rating at that entry, a re-watch marker (`true`, `false` or `unknown`), the typed identity (`letterboxd_lid`) and slug alias, and when it was first and last observed, with `source: letterboxd_diary`.
   - It is never a rating, watched or watchlist fact and never changes `actualRating`.
2. **One reader, one read per commit.**
   - `LetterboxdDiary.parsePage` is the only diary parser. The films-list repair uses it too.
   - When the history stage runs, the repair reuses its page-1 rows and makes no request of its own, even when the stage could not read the page.
3. **Incremental and bounded.**
   - At most three pages per EPG commit, same origin, no retry, no redirect followed, no challenge handling.
   - Page 1 always. The next page only while a page is entirely new.
   - A pending backfill resumes one page before where it stopped, as overlap, and continues from there.
   - Each page is committed by compare-and-swap before the next request. The run state, `letterboxd/diary/state.json`, is written last.
4. **Keys that do not merge viewings.**
   - The viewing id is the key when the row carries one.
   - Otherwise the key is identity, watched date and the occurrence of that pair in the read, so two viewings on one day stay two.
   - A stored key keeps its identity. A row that disagrees is counted as a conflict and changes nothing. A rating or re-watch edit is recorded as a change on the entry.
5. **Honest coverage.**
   - Outcomes are `complete`, `partial`, `blocked`, `rate_limited` or `failed`, with a stop reason and the per-run counts.
   - The coverage is the newest and oldest dates seen and whether the last page was ever reached.
   - Absence from the diary proves nothing. A failure keeps the last good history.
6. **Identity only by lid.** A row without a lid is stored but marked unresolved. A slug alone never links a film.
7. **Gated.**
   - Behind `LETTERBOXD_DIARY_HISTORY`, off by default. With it off, the stage neither reads nor writes, and the repair keeps its own single page-1 request.
   - A read-only `GET /api/letterboxd/diary` exposes the state, per-film aggregates (`viewingCount`, `lastWatchedAt`, `rewatches`) and one film's entries. Nothing else consumes the history yet.

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

- **Original decision:** this record, proposed with AIR-51.
- **Source facts:** AIR-273 production diagnostic of Diary page 1 (Trello AIR-273), removed by AIR-274.
- **Implementation:** `src/letterboxd-diary.js`, `src/worker.js` (stage, read route), `src/enrichment.js` (repair on the shared parser), `src/feature-flags.js`, `tests/letterboxd-diary.mjs`.
- **Uncertainty:**
  - the viewing-id attribute and the re-watch markup are not confirmed on the real page; the parser reads them only when explicitly present, and treats them as `unknown` or derives the key otherwise;
  - page 2 availability is unknown.
