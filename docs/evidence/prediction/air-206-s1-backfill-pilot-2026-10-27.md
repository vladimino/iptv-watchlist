# Selective prediction compatibility: impact facet backfill pilot (stage S1, one page)

**Executed:** 2026-10-27, 23:22:30.576–23:22:33.163 UTC, by the owner in a browser session behind Cloudflare Access (DevTools console, same-origin `fetch`)
**Verified:** 2026-10-27, about 23:23 UTC, owner-only IPTV MCP read tools only (`enrichment_queue`, `prediction_queue_overview`, `prediction_film_diagnostics`)
**Code:** `main` `da71772`
**Approval:** owner's explicit approval of exactly one pilot page, recorded on [AIR-206](https://trello.com/c/87mg3VNi) on 28 October 2026 (board time); no further pages, flags, Tasks, profile publication, model or sync
**Verdict:** **GO for the owner decision on the remaining pages.** The single call succeeded, every observable control value is unchanged, and the result shows that impact facets were absent from every entry of the page before the call

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

## Findings

1. **The write is safe under strict.** No decision, counter or diagnostic changed.
2. **Facet coverage before the call was zero in this page.** That is consistent with every index entry written before the queue change lacking `impactFeatures`. About 2,333 queue films (plus any other index ids) remain, i.e. roughly 29 more pages of 80 by `nextCursor`, starting from `1Y52`.
3. **Read-only tools still cannot show facet coverage.** The effect becomes measurable only through the queue counters once a profile version is published under the change-impact contract and `selective` is evaluated (stage S4), or after the next queue refresh with a changed profile.

## Limits

One page; the response is the owner's console output (screenshot), not a server log. The Worker version and flag bindings were not read.
