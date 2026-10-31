# Diary page 2 blocked the first separate ratings run — 2026-10-31

**Captured:** 2026-10-31, from the production ratings run named in [AIR-304](https://trello.com/c/5M7hmLfM). This report copies counts only. It contains no diary row, title, rating value or account payload.

**Code:** the multi-page Diary reader deployed before [ADR 0067](../../adr/0067-diary-recent-window.md). The run is not a measurement of the page-1 reader.

**Scope:** one Ratings Task `run_now` while `RATINGS_PIPELINE=separate`, after the version-2 storage migration. Worker run `66d57611-c2de-4245-8618-1fa71dee167c`.

## What the run recorded

| Step | Result |
| --- | --- |
| Diary page 1 | `rows=50`, `added=50` in `letterboxd/diary/history.json`. Facts: `films=50`, `written=26`, `skipped=24`. Evidence counters: `rated=47`, `partial=3`, `ambiguous=0`, `conflicts=0`. Removal queue: `removalResolved=1` |
| Diary page 2 | `stopReason=http_403_page_2`, `outcome=blocked` |
| Run | `state=error`. `lastSuccessAt` stayed null. `resumePage=2` |

The page-1 write was useful. The run still ended as an error, and the stored resume page would have sent the next daily run to page 2 again. The `partial=3` counter is the page-fence rule of ADR 0054 on that reader, not a claim about which films were unrated.

## Verdict

**Page 2 is not a routine read.** The owner decided on 2026-10-31 that the daily Diary sync is page 1 only, and that a rating visible on that page is used ([ADR 0067](../../adr/0067-diary-recent-window.md), Proposed). This report does not authorize a retry, a flag change, a Task edit, or another ratings run.

## Uncertainty

The counts are the ones recorded on the AIR-304 card from that run. This file was not produced by a new production read. Whether a later page would answer after a delay was not retested.
