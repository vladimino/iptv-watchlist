# Extended future EPG: offline fixture measurements (AIR-188)

Captured 2026-11-05 (UTC) with a synthetic, deterministic feed in a local Node process. **No production scan, feed fetch, Cloudflare setting or storage write was made.**

Fixture: 120 channels, programmes from 80 hours back to 170 hours ahead, 300 watchlist films, about 1.2 percent of programmes matching a watchlist film, the rest unmatched. Same feed for both rows; the 24-hour row clips the feed to the previous horizon.

| Measure | 24 h horizon (previous) | 7-day retention (this change) |
|---|---|---|
| Feed size | 0.79 MB | 1.89 MB |
| Programmes scanned | 6,612 | 15,817 |
| Matched watchlist films with shows | 47 | 64 |
| Matched shows retained | 64 | 145 |
| Serialized matched films | 16.0 kB | 30.5 kB |
| Discovery candidates | 5,970 | 5,970 |
| Raw candidates | 6,016 | 6,016 |
| Scan time (one run, local) | 220 ms | 445 ms |
| Heap growth (one run, local) | 7 MB | 12 MB |

Reading: the hot discovery work is identical, so days 2-7 add no discovery, resolver or prediction load. Retained shows grow with the number of reliable watchlist matches only. Scan time and heap track the feed size, which the source already delivers; the extra programmes are parsed and then dropped unless they match a watchlist film.

Tests: `tests/epg-extended-future.mjs` (scan horizons and a two-generation cancel/reschedule fixture), `tests/programme-freshness.mjs` (reader states), `tests/programme-display-window.mjs` (rolling 72 h / 24 h reader window).

Local browser QA at 1280 px and 390 px with a mocked programme snapshot: a film airing 5 days ahead is not listed on a fresh snapshot (2 h old) or a snapshot 40 h old, and is listed once the clock is 20 h before it (snapshot 4 days old, still marked «Данные устарели»); a snapshot whose feed ended 1 h after it was taken, read 3 h later, shows «Будущей программы нет» with the archive still listed; no horizontal overflow at either width; an 8-day-old snapshot shows «Будущее закончилось» with no films.

Limitations: one synthetic feed on a development container; no production Worker CPU or memory was observed.
