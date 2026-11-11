# EPG horizons: 7-day retention versus 24-hour hot processing

Contract introduced by [AIR-188](https://trello.com/c/XQQVS3KG). It separates two horizons that earlier code expressed as one `now + 24h` cutoff.

| Horizon | Value | What it governs |
|---|---|---|
| Retention / display | `EPG_RETAIN_FUTURE_MS` = 168 hours ahead, and the unchanged 72-hour archive behind | Shows stored in the published programme generation and shown to the reader |
| Hot processing | `EPG_HOT_FUTURE_MS` = 24 hours ahead | Discovery candidates, uncertain matches, raw candidate counts, catalog-only availability, resolver and prediction priority |
| IPTV catch-up | 72 hours | Unchanged, counted from the show start; in the catalog API `availableUntil` is the end of the window of the latest ready show, or `null` when no recording is ready ([film availability](film-availability.md), ADR 0114) |

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

## What the reader sees

The reader window stays the rolling `[now - 72h, now + 24h)`, clipped to the saved window: `effectiveWindow` keeps the saved `window` as `retained` (storage and coverage metadata) and uses `{from: window.from, to: min(window.to, now + 24h)}` as the display envelope. A retained show beyond 24 hours ahead is **hidden** from the period sections, the «Дальше» group and the period counters, and appears when the clock reaches 24 hours before it, with or without a fresh EPG sync (a skipped sync therefore keeps revealing the saved week as time passes). Legacy snapshots, whose window already ends at `cutoff + 24h`, read unchanged.

## Reader states

The programme status (`programmeStatus` in `public/app.js`) distinguishes:

| State | Condition | Text |
|---|---|---|
| Fresh | Snapshot age at most 36 hours, future known | «Программа актуальна», known end and data age |
| Stale | Snapshot older than 36 hours while shows are still ahead | «Данные устарели», data age and the remaining known coverage; the saved schedule of the last whole generation, with a note that later changes are not included |
| No known future | The feed's last show (`stats.epgEnd`) has already started, even if the saved window still runs ahead | «Будущей программы нет»: the archive stays, the data age is kept, and the text says the schedule ahead is unknown. Nothing is extended to the retention edge |
| Future ended | Window has no shows ahead, archive remains | «Будущее закончилось» |
| None | Saved window over | «Нет актуального окна» |

The known end is the feed's last show (from `retained`), never the display edge, so an older programme is not passed off as fresh and no show is invented.

## Film availability on these horizons

The product reads two of the horizons above: the 72-hour catch-up and a rolling next 24 hours (the hot edge). The 168-hour retention is storage and is never a product horizon. The film-level lifecycle on them (`available`, `soon`, `unavailable`; an archive outranks live and future; `soon` is ready at the end of the show) is the [film availability lifecycle](film-availability.md) ([ADR 0114](../../adr/0114-film-availability-lifecycle.md)). It changes none of the horizons above.

## Consumers that stay on 24 hours

`src/discovery.js`, `src/enrichment.js` (`filmIsHot`) and the catalog reader (`CATALOG_FUTURE_MS`, see [catalog API](../api/catalog.md)) keep their explicit 24-hour future bound. Changing the XMLTV source URL is not required by this contract and remains a separate owner-gated production action.

Dated measurements: [evidence](../../evidence/epg-extended-future-air-188-2026-11-05.md).
