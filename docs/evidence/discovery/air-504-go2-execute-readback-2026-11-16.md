# AIR-504: GO-2 execute and D1 readback

**Captured:** 2026-11-16 12:56–14:18 UTC (13:56–15:18 Europe/Madrid). Access `catalog_policy_exclude@1` then Cloudflare D1 `SELECT` on `iptv` `3fba0e0a-44e9-4a3a-a7ba-edaee6bcafcb`.
**Used by:** [AIR-504](https://trello.com/c/jUaNE1Rs). Writer on `main` `0a6b8378` (PR #683 synopsis→overview) after GO-1 [readback](air-504-go1-execute-readback-2026-11-16.md).
**Authorization:** owner `GO-2` for remaining current admissions that classify as ADR 0150 `documentary` or `concert`. No Discovery/EPG/Predictions/TMDB/flags/Tasks start.

## Write set

Live D1 scan of 9 995 then 9 855 current movie admissions. Classifier: same `admissionPolicy` mapping as the Worker (synopsis fills empty overview). GO-1 six ids already superseded and were not POSTed again.

| Class | Count | Action |
| --- | --- | --- |
| Remaining `documentary` | 123 | POST each after GET eligible |
| Remaining `concert` | 17 | POST each after GET eligible |
| Music-only `ambiguous` | 4 | **not POSTed** |

Ambiguous left current: `tmdb_223936` Megadeth Live; `tmdb_249407` Roxette Live; `tmdb_46077` Billy Idol Live; `tmdb_63371` a-ha Final Concert.

## Execute

Worker `https://iptv.vladimino.workers.dev`. One GET preview then one POST per film. Keys `air504-go2-tmdb-<id>-20261116`. Tokens not recorded.

Pass 1 (12:56:51–14:15:11 UTC): 134 `written`; 6 HTTP 409 (`lease_held` or `in_progress`) without a durable client body.

Retry same keys (14:15:25–14:18:50 UTC): all six `written`, `queue=removed`:

- `tmdb_1094451` Red Hot Chili Peppers - Live at Tokyo Dome (`concert`)
- `tmdb_123431` Перевоплощённый (`documentary`)
- `tmdb_656690` Социальная дилемма (`documentary`)
- `tmdb_662244` Фантастические Твари: Природоведение (`documentary`)
- `tmdb_685530` Rihanna: Live at Made In America (`concert`)
- `tmdb_797594` Бритни против Спирса (`documentary`)

No preview skip among the 140. No GO-1 replay.

## After-image (D1 SELECT, 14:19 UTC)

| Marker | After |
| --- | --- |
| `discovery_authority` | `d1` / `open`, generation **154869**, run `3b7c7152-eb54-45f7-8985-92c377b57181` |
| `published_epg_authority` | `d1` / `open`, generation **510**, same run (sealed; not rewritten) |
| GO-2 140 `film_id` | **140** `superseded` |
| GO-1 six | still `superseded` |
| Four ambiguous | still `current` |
| Current movie admissions | **9 855** (was 9 995 before GO-2; 9 995 − 140 = 9 855) |

## Not proven

Natural Discovery chunk will not re-admit the 140 TMDB ids. Natural hourly Predictions will not enqueue them. Programme GET overlay not probed. Ambiguous four still need a human concert decision.

## Out of scope

Those four ambiguous titles. AIR-498 `tmdb_9278`. Film/Person R2. Ratings events. Prediction bodies. EPG republish.
