# Selective prediction compatibility: impact facet backfill (stage S1, pilot and remaining pages)

**Executed:** 2026-10-27, by the owner in a browser session behind Cloudflare Access (DevTools console, same-origin `fetch`): pilot page 23:22:30.576–23:22:33.163 UTC; remaining pages until 23:29:41.737 UTC
**Verified:** 2026-10-27, about 23:23 UTC (after the pilot) and about 23:30 UTC (after the remaining pages), owner-only IPTV MCP read tools only (`enrichment_queue`, `prediction_queue_overview`, `prediction_film_diagnostics`)
**Code:** `main` `da71772`
**Approval:** owner's explicit approval of exactly one pilot page, recorded on [AIR-206](https://trello.com/c/87mg3VNi) on 28 October 2026 (board time), then a separate owner approval of the remaining pages at 23:26:08 UTC in the AIR-206 Claude Code session, quoted and dated in [this AIR-206 card comment](https://trello.com/c/87mg3VNi#comment-6ae13666e2ae6db35c33ef06); no flags, Tasks, profile publication, model or sync
**Verdict:** pilot **GO**, then the owner approved the remaining pages in the AIR-206 conversation and ran them. **S1 complete:** the backfill reached the end of the id list (`nextCursor: null`), and every observable control value is unchanged. See [Remaining pages](#remaining-pages)

## The call

| Item | Value |
| --- | --- |
| Request | `POST /api/enrichment/fingerprint-view/backfill`, body `{"limit": 80}`, no cursor (first page) |
| Response | HTTP 200, `{"checked": 80, "added": 0, "updated": 80, "nextCursor": "1Y52"}` |
| Repetitions | none (one call, guarded against a repeat in the tab) |

The route walks the view-index and catalog ids in sorted order. For each id whose full fingerprint is current, it writes the display facet, the fingerprint hash and `impactFeatures`, unless the entry already has them for the same hash. `updated: 80` means all 80 entries had a fingerprint facet and none had a bound impact facet. `added: 0` means no entry was new. The route also runs the ratings seed of the view index (`ensureInitialRatings`), so the write is not limited to `impactFeatures`. Only `enrichment/view-index.json` is written, by compare-and-swap on its ETag; no prediction, fingerprint, profile or other object.

## Controls after the call

| Control | S0 (23:00–23:07) | After the pilot (~23:23) |
| --- | --- | --- |
| `compatibility.mode` | `strict` | `strict` |
| `strict` current / stale | 2,333 / 0 | 2,333 / 0 |
| `selective` current / compatible / stale | 2,333 / 0 / 0 | 2,333 / 0 / 0 |
| `wouldKeep` / `wouldRequeue` / `strictDisagreements` | 0 / 0 / 0 | 0 / 0 / 0 |
| Pending | 0 (drained) | 0 (drained) |
| Overview `consistent`, reasons | true, none | true, none |
| Coverage current / total | 2,333 / 2,333 | 2,333 / 2,333 |
| Window coverage | 1,892 / 1,892 | 1,888 / 1,888 |

- The queue block itself was not recomputed: its `refreshedAt` is still 2026-10-27T22:23:10.942Z, because nothing has refreshed the queue since. It will reflect the facets at its next refresh.
- The window coverage moved from 1,892 to 1,888 because the viewing window moved with the clock; the share stays 100 %.
- Film diagnostics for three ids inside the processed range (`10oS`, `15LW`, `17Vk`) and one outside it (`2Eao`) are unchanged: fingerprint current, prediction current, `mode: strict`, index `agreed`.

## Findings (pilot)

1. **The write is safe under strict.** No decision, counter or diagnostic changed.
2. **Facet coverage before the call was zero in this page.** That is consistent with every index entry written before the queue change lacking `impactFeatures`. About 2,333 queue films (plus any other index ids) remain, i.e. roughly 29 more pages of 80 by `nextCursor`, starting from `1Y52`.
3. **Read-only tools still cannot show facet coverage.** The effect becomes measurable only through the queue counters once a profile version is published under the change-impact contract and `selective` is evaluated (stage S4), or after the next queue refresh with a changed profile.

## Limits

Pilot: one page; the response is the owner's console output (screenshot), not a server log. The Worker version and flag bindings were not read.

## Remaining pages

After the pilot report the agent asked whether to continue and stated it would not go further without approval. At 2026-10-27 23:26:08 UTC the owner answered «продолжаем, дай мне скрипт» ("continue, give me the script"). That approval covers only the remaining backfill pages from cursor `1Y52`. Both messages are quoted verbatim and dated in [the AIR-206 card comment](https://trello.com/c/87mg3VNi#comment-6ae13666e2ae6db35c33ef06). The source is the Claude Code session of this delivery: https://claude.ai/code/session_014nGEiXFN7SxS4BwSJdwo6V. The owner then ran the pages in the same browser session. A console script walked `nextCursor` from `1Y52`, one page of `limit` 80 at a time with a one-second pause. It would stop at the first non-200, non-JSON or non-advancing response, with a 40-page guard.

| Item | Value |
| --- | --- |
| Finished | 2026-10-27T23:29:41.737Z |
| Stop reason | `done (nextCursor null)`; no error, no guard hit |
| Pages / checked / added / updated | 34 / 2,688 / 0 / 2,268 |
| Pilot plus remaining pages | 35 pages, 2,768 ids checked, 2,348 entries updated |

- **Ids checked but not updated: 420.** These are ids without a current fingerprint (for example rating-only index entries or catalog films not yet fingerprinted). The route skips them by design.
- **2,348 updated entries exceed the 2,333 queue films.** The id list also contains index entries outside the current queue.
- **Pages: 35, against an estimate of about 30.** The id list is the union of index and catalog ids, not only queue films.

Controls read about 23:30 UTC with the same read-only IPTV MCP tools:

| Control | Value |
| --- | --- |
| Queue `refreshedAt` | 2026-10-27T23:26:24.932Z (a scheduled no-op run, while the backfill was running) |
| `compatibility` | mode `strict`, 2,333 films, all `exact`; `wouldKeep` / `wouldRequeue` / `strictDisagreements` 0 / 0 / 0; missing 0 |
| Queue | drained, consistent, no reasons; coverage 2,333 / 2,333, window 1,888 / 1,888 |
| Film diagnostics `2Eao`, `w0e6`, `d2hI` | fingerprint current, prediction current, `mode: strict`, index `agreed` |

The scheduled run at 23:26 refreshed the queue between pages without any error or contention reported by the script. Facet coverage itself still cannot be read with read-only tools while every prediction is exact. The next measurable point is the first selective evaluation after a change-impact publication (S4).

Remaining pages: the totals are the owner's console summary; per-page lines and server logs were not captured.
