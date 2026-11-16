# AIR-504: GO-3 execute and D1 readback (residual Music-only concerts)

**Captured:** 2026-11-16 21:08–21:14 UTC (22:08–22:14 Europe/Madrid). Access `catalog_policy_exclude@1` then Cloudflare D1 `SELECT` on `iptv` `3fba0e0a-44e9-4a3a-a7ba-edaee6bcafcb` (`rows_written=0` on the after-image query).
**Used by:** [AIR-504](https://trello.com/c/jUaNE1Rs). Writer on `main` `9208ad8d` (PR #698: Music-only `ambiguous` eligible). GO-1 [readback](air-504-go1-execute-readback-2026-11-16.md); GO-2 [readback](air-504-go2-execute-readback-2026-11-16.md).
**Authorization:** owner chat «дочисти» plus Trello comment 16.11 21:46 Europe/Madrid naming these four Film ids. No Discovery/EPG/Predictions/TMDB/flags/Tasks start. No SQL DELETE.

## Write set

The four Music-only Live/Concert admissions that GO-1/GO-2 left `current` because ADR 0150 still classifies them as `ambiguous`.

| film_id | Title | Observations |
| --- | --- | --- |
| `tmdb_223936` | Megadeth: Countdown to Extinction - Live (2013) | `megadeth countdown to extinction live\|2013` |
| `tmdb_249407` | Roxette: Live Travelling the World (2013) | `roxette live travelling the world\|`, `roxette live travelling the world\|2013` |
| `tmdb_46077` | Billy Idol: In Super Overdrive Live (2009) | `billy idol in super overdrive live\|2009` |
| `tmdb_63371` | a-ha - Ending on a High Note - The Final Concert (2011) | `a ha ending on a high note the final concert\|2011` |

## Execute

Worker `https://iptv.vladimino.workers.dev` after post-merge CI/CD [run 43956466168](https://github.com/vladimino/iptv-watchlist/actions/runs/43956466168) SUCCESS on `9208ad8d`. One GET preview then one POST per film. Keys `air504-go3-tmdb-<id>-20261116`. Tokens not recorded.

Preflight (after deploy, before POST): all four HTTP 200, `available=true`, `reason=eligible`, `policy=ambiguous`, `state=current`.

| film_id | Execute HTTP | Outcome | History `written_at` UTC |
| --- | --- | --- | --- |
| `tmdb_223936` | 200 | `written`, `durable`, `queue=removed`, `policy=ambiguous` | 21:09:05.301Z |
| `tmdb_249407` | 200 | same (two observation keys in one batch) | 21:10:00.744Z |
| `tmdb_46077` | 200 | same | 21:10:47.872Z |
| `tmdb_63371` | 200 | same | 21:11:57.855Z |

No timeout, 409, or replay. No other Film ids POSTed.

## After-image (D1 SELECT, 21:14 UTC)

| Marker | After |
| --- | --- |
| `schema_contract.version` | 23 |
| `discovery_authority` | `d1` / `open`, generation **155897**, run `47663279-3e6b-423d-b696-b22edfcead91` |
| `published_epg_authority` | `d1` / `open`, generation **511**, same run (sealed; not rewritten) |
| `prediction_domain_authority` | `d1`, generation 14129, `queue_generation` **1431** |
| Resolver lease | `expires_at` 0 |
| Four admissions | **4/4** `superseded` (generations 155869, 155870, 155872, 155897) |
| Five decisions | `needs_verification`, `tmdb_id`/`film_id` null, `rejectedTmdbIds[0]` the excluded id |
| Current-run `published_epg_show` by film_id | 0 |
| Current-run shows by observation key | 0 |
| `published_epg_member` | 0 |
| `prediction_queue` `instr` across seq 0–5 (generation 1431) | 0 for all four ids (`tmdb_46077` quoted) |
| `watchlist_film` / `actual_rating` | 0 |
| `prediction_fingerprint` / `prediction_pointer` | present for Megadeth and Roxette only (unchanged presence) |

## Not proven

- Next natural Discovery chunk will not re-admit these four TMDB ids (code + `rejectedTmdbIds`; no chunk started here).
- Next natural hourly Predictions tick will not enqueue them (queue refresh already ran as part of the writer; a later EPG-driven refresh is unobserved).
- Signed-in `GET /api/programme` overlay not probed.
- Independent reviewer D1 digest of this after-image.

## Out of scope

GO-1/GO-2 146 ids (already superseded). AIR-498 `tmdb_9278`. Film/Person R2. Ratings events. Prediction bodies. EPG republish. Direct SQL UPDATE/DELETE.
