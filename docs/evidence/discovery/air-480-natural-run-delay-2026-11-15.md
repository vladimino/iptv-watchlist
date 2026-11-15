# AIR-480: natural-run addressed-slot delay (15 November 2026)

Method: read-only production observation, 15 November 2026. Capture clock **13:47 Europe/Madrid** (`2026-11-15T12:47:51.139Z`). No EPG, Discovery, TMDB, prediction, ratings, R2, D1, flag or Scheduled Task write. No run was started for this measurement.

Trello: [AIR-480](https://trello.com/c/ZS0Xdrlq). Criterion: ADR 0142 R2 — time from EPG publication and from the priority-pause release to the first assigned Discovery row and to a complete replay of the current verified observations, plus catalog assignment coverage. Source of delay is Discovery chunk status records; `published_epg_show` has no `created_at`.

## Pinned sources

- Worker `iptv`. Production D1 `iptv` (`published_epg_authority.mode=d1`, `cutover=open`, generation 509).
- MCP `epg_status` and `epg_pipeline_status(view=operational)` at the capture time above.
- Cloudflare D1 `SELECT` aggregates on `published_epg_show`, `published_epg_generation`, `published_epg_member`, `discovery_authority`, `discovery_status` (payload keys and counts only; no film titles or ids copied out).
- Deployed `main` at capture included AIR-480 slot assignment (merged as PR #650, `47c54237`).

## Publication under observation

| Field | Value |
| --- | --- |
| `programme_run_id` | `0e4a5f90-8f50-4c6d-b749-80c7565194a2` |
| EPG Workflow | `epg_20261114_0`, phase `done`, health `idle` |
| `published_epg_generation.published_at` | `2026-11-14T16:05:56.999Z` (17:05 Europe/Madrid) |
| Orchestration `syncRun.updatedAt` (stage `complete`) | `2026-11-14T16:20:14.730Z` (17:20 Europe/Madrid) |
| Next natural due | `2026-11-15T16:00:00.000Z` (17:00 Europe/Madrid) — **not yet arrived** |
| Previous published run | `4562e2d8-14f7-4497-a4d7-270e0a975fe9` |

The two publication timestamps differ by about 14 minutes. Delay arithmetic below uses both; it does not pick one as “the” publication instant.

ADR 0135 priority pause lasts until publication; Discovery then continues on the pinned run. This capture does **not** re-read the 14 November pause-release instant from live Workflow history. The next Discovery catch-up observed **now** is `2026-11-15T13:00:00.000Z`, caused by `discovery_conflict`, not by the original post-publication pause.

## Assigned slots (counts, not delay)

Current published run, `published_epg_show` grouped by `basis`:

| `basis` | rows |
| --- | --- |
| `discovery` | 15 045 |
| `title_year` | 728 |
| `title_unique` | 548 |
| `title_duration` | 282 |

`basis='discovery'` on this run:

- 15 045 rows, 5 632 distinct `film_id`
- 15 043 rows / 5 631 films whose `film_id` starts with `tmdb_` (catalog)
- 2 rows / 1 film without that prefix
- 2 of those discovery rows join `published_epg_member` (`kind='programme'`); that table has 396 programme members on this run

Previous run `4562e2d8…` has **zero** `basis='discovery'` rows (only `title_*`). Assignment writers were not present on that publication.

`published_epg_show` has no row timestamp. These counts prove that Discovery has written addressed slots onto the 14 November generation. They do **not** prove when the first row appeared.

## Discovery replay (incomplete)

Operational snapshot at capture:

- Authority `d1` / `open`, generation **129478**, transfer `committed`
- Discovery `state=error`, `reason=discovery_conflict`, `nextAction=wait`, `remainingChunks=5`
- Last checkpoint `stage=error` `reason=discovery_conflict` at `2026-11-15T12:30:23.928Z`
- Last stored `discovery_status` payload: `schemaVersion=2`, `stage=partial`, `checkpoint=cheap_pass`, hop `f7b38d03-9ff4-41de-b37b-e7dc55075e92`, `startedAt=2026-11-15T12:29:53.361Z`, `at=2026-11-15T12:29:57.459Z`, `checked=1`, `tmdbCalls=0`, `reused=1`, `touched=1`, `added=0`. Keys do **not** include `assignment` or `revalidation`.
- Workflow instance `discovery_0e4a5f908f504c6db74980c7565194a2_82`, series 82, phase `waiting` until `2026-11-15T13:00:00.000Z`, `chunks=8` on that instance, `eligible=false`

A complete replay of current verified observations has **not** finished. “Observations not reached when the next publication arrived” is **not applicable yet**: the next EPG due is still in the future.

Revalidation / reconfirmation / exhausted / TMDB call totals for the generation are **not** in the overwritten last-chunk status and were not reconstructed from Worker logs in this capture.

## Delay fields required by R2

| Required field | Result |
| --- | --- |
| Time from publication to first assigned row | **Unknown** — no `created_at` on `published_epg_show`; last Discovery status is overwritten and has no assignment totals |
| Time from priority-pause release to first assigned row | **Unknown** — pause-release instant not in this snapshot; same missing row clock |
| Time to first complete replay | **Not yet** — `remainingChunks=5`, `discovery_conflict` |
| Catalog films / slots assigned | **Partial snapshot**: 5 631 catalog films, 15 043 catalog discovery rows (plus 1 non-catalog film, 2 rows) |
| Verified observations still unreached at next publication | **N/A** — next publication not due until 16:00 UTC |
| Revalidations / reconfirmations / failures / exhausted / TMDB | **Unknown** from the stored last-chunk payload |

## Verdict

**INCOMPLETE.** Addressed Discovery slots exist on the live 14 November publication (15 045 `basis='discovery'` rows; previous publication had none). That is not a complete R2 delay measurement: first-row wall time is unobserved, the current Discovery pass is still in `discovery_conflict` with five chunks remaining, and the next natural EPG has not rolled yet.

This report does **not** accept AIR-480 runtime, does **not** unblock AIR-374, and does **not** authorize starting an EPG or Discovery run. A later dated capture after a natural complete Discovery pass on this run, and/or after the 15 November 16:00 UTC publication, must fill the unknown delay fields.

## Limits

- Aggregates only; film identities are not listed.
- `discovery_status` is a single overwritten document (377 bytes at capture).
- Worker Observability was not used as a clock for first assignment (no assignment/replay event strings in a prior log probe).
- `GET /api/programme` and `GET /api/watchlist` were not called (hourly EPG `ensure` may reconcile R2 mirrors; those GETs are not in this L0 read set).
