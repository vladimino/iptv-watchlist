# EPG horizons: 7-day retention versus 24-hour hot processing

Contract introduced by [AIR-188](https://trello.com/c/XQQVS3KG). It separates two horizons that earlier code expressed as one `now + 24h` cutoff.

| Horizon | Value | What it governs |
|---|---|---|
| Retention / display | `EPG_RETAIN_FUTURE_MS` = 168 hours ahead, and the unchanged 72-hour archive behind | Shows stored in the published programme generation and shown to the reader |
| Hot processing | `EPG_HOT_FUTURE_MS` = 24 hours ahead | Discovery candidates, uncertain matches, raw candidate counts, catalog-only availability, resolver and prediction priority |
| IPTV catch-up | 72 hours | Unchanged; `availableUntil` is still the last start plus 72 hours |

## What the scan keeps

`scanEPG` keeps a show whose start is in `[now - 72h, now + 168h)` **only** when it is a reliable, non-catalog watchlist match. Beyond 24 hours ahead:

- an unmatched, ambiguous or catalog-only programme is dropped before it reaches discovery, the uncertain list or `rawCandidates`;
- no weekly queue of discovery, resolver or prediction work is created, and `stats.discoveryCandidates` does not grow with the week.

Only shows that really exist in the XMLTV feed are stored. Nothing is generated or extrapolated. Channels whose feed is shallower simply have fewer future shows; the published `stats.epgEnd` is the feed's last show start.

## Published generation

Unchanged: the pointer moves only after a complete generation exists; a successful publication **replaces** every show list (no append or merge of older shows, so a cancelled or rescheduled airing disappears); a failed or incomplete sync leaves the previous generation and its pointer untouched.

Fields added to the programme report:

| Field | Meaning |
|---|---|
| `window.to` | `cutoff + 168h`, the retention edge (was `cutoff + 24h`) |
| `window.hotTo` | `cutoff + 24h`, the hot processing edge |
| `coverage.retainHours`, `coverage.hotHours` | 168 and 24 |
| `coverage.feedEndsAt` | The feed's last show start, or null |
| `coverage.futureKnownUntil` | `min(feedEndsAt, window.to)`, or null |
| `coverage.weekChannels` | Channels whose last show is within 24 hours of the 168-hour edge |

Older snapshots without `window.hotTo` or `coverage` read as before (a 96-hour window).

## Reader states

The programme status (`programmeStatus` in `public/app.js`) distinguishes:

| State | Condition | Text |
|---|---|---|
| Fresh | Snapshot age at most 36 hours, future known | «Программа актуальна», known end and data age |
| Stale | Snapshot older than 36 hours while shows are still ahead | «Данные устарели», data age and the remaining known coverage; the saved schedule of the last whole generation, with a note that later changes are not included |
| Future ended | Window has no shows ahead, archive remains | «Будущее закончилось» |
| None | Saved window over | «Нет актуального окна» |

The known end is the feed's last show, never the window edge, so an older programme is not passed off as fresh and no show is invented.

## Consumers that stay on 24 hours

`src/discovery.js`, `src/enrichment.js` (`filmIsHot`) and the catalog reader (`CATALOG_FUTURE_MS`, see [catalog API](../api/catalog.md)) keep their explicit 24-hour future bound. Changing the XMLTV source URL is not required by this contract and remains a separate owner-gated production action.

Dated measurements: [evidence](../../evidence/epg-extended-future-air-188-2026-11-05.md).
