# AIR-374 H1: the loader's accepted retention count changes from 401 to 398

**Captured:** 2026-11-12 (UTC), offline change. Authority: owner decision (product owner) on [AIR-374](https://trello.com/c/ha7ais3w). **Nothing was run against production.** No D1, R2, Cloudflare, connector, MCP or Trello call was made by this change.

**Result in one sentence:** the H1 loader (`scripts/film-person-prepared-loader.mjs`) now pins its own `EXPECTED` counts at 708 / 398 / 4 (1,110 rows, 29 batches), and the verifier, tests and runbooks follow it.

## Decision

- A fresh production snapshot of 12 Nov 2026 (not committed anywhere) gave `film_rated_admission` 708, `film_retention` 398 and `tmdb_retirement_decision` 4: 1,110 rows, where the 11 Nov measurement had 1,113.
- The loader refused that source with `count_mismatch:retention:398`, because its caps were the 11 Nov counts (708 / 401 / 4).
- The owner accepted the risk and decided that the accepted retention count is 398. The retention count follows the view index, which the Predictions Task rewrites.
- **No analysis of the 3-film difference was done, by the owner's decision.** Which films left the view index, and why, is not known.

## Change

| Place | Old | New |
| --- | --- | --- |
| `EXPECTED` in the loader | derived from `ACCEPTED_DISCREPANCIES.caps` (708 / 401 / 4) | explicit constant 708 / 398 / 4 |
| Total rows | 1,113 | 1,110 |
| Batches (40 rows per batch: 18 + 11 + 1, now 18 + 10 + 1) | 30 | 29 |
| Run bounds (`BATCH_ROWS` 40, `RUN_BATCHES` 40, `RUN_STATEMENTS` 1,200) | unchanged | unchanged |

Every guard is kept: any count other than 708 / 398 / 4 is still refused (`count_mismatch:<class>:<n>`), and the verifier still refuses a plan whose `expected` is not the loader's own (`class_expected_not_loader`). The loader test no longer compares `EXPECTED` with `ACCEPTED_DISCREPANCIES.caps`; it pins the three numbers, and a mutant of the constant is killed.

## What is deliberately unchanged

`ACCEPTED_DISCREPANCIES.caps` (retention 401) in `src/film-person-cutover-accepted.js` is the cutover's accepted measurement of 10 and 11 Nov 2026; the accepted digest and the baseline reference are built on it, and it is not touched. The handoff readiness registry (`EMPTY_CLASSES` in `src/canonical-producers.js`) also still names 401, so the blocker string `empty_class_not_loaded:retention:0/401` is unchanged; aligning it is a separate decision. Dated evidence files stay as written.

## Not proved

That the real sources resolve to 708 / 398 / 4 at load time (the plan refuses if they do not), and anything about the 3-film difference.
