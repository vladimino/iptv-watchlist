# AIR-320 discovery load, import and activation, 4 November 2026

**Captured:** 2026-11-04 16:46 UTC (load) through 22:27:36 UTC (marker read-back). Production D1 database `iptv`. R2 bucket `iptv` was read and not written by these commands. Each write used `--target iptv` and its own `--confirm`. Import, hold and activate also used `--producers-drained`. Revert is not implemented and was not run.

**Scope:** copy the published discovery ledger, then the mutable catalog, decisions, status, scores, continuation and workflow, then set `mode` `d1` and open `cutover` at generation 1. This is the authority flip for those objects. Immutable observation segments stay in R2. Films and Persons stay on their own authority.

## Timeline

| UTC | Command | Result |
| --- | --- | --- |
| 15:19 | `--load` (first attempt) | EXIT 3 `ledger_refused`, `writes` false. Two observations had 178 and 101 shows. No transfer opened. |
| 16:46 | `--load` (lossless operator) | Process exited 4 `readback_mismatch` / `writeState` `unknown` after the commit had already landed. Status then: `already_loaded`, `r2` / `open`, generation 1, programme `7c1eaadb-08a6-40a1-b793-a345068144a5`, 36999 observations, 37211 shows, empty checkpoint. |
| 18:14 | `--import` | EXIT 3 `import_refused` before a write. 1100 decisions had a drifted evidence key. |
| 18:54–19:31 | `--import` | Catalog 2634 and 10000 of 10832 decisions written; hop stayed `import`; then `source_changed` when the hourly prediction task moved neighbour markers and `epg/resolver-continuation.json`. |
| 20:00 | `--reset-import` | EXIT 0. Admissions, decisions, import history and scores cleared. 36999 observations left. hop null. |
| 20:00–20:39 | `--import` | EXIT 0. 2634 films, 10833 decisions, 1100 `staleEvidence`, 0 score rows (foreign preview kept in the pin). hop `imported`. The source then moved: an HTTP `POST /api/enrichment/discovery/resolve` wrote one recovery chunk at 20:36–20:37. |
| 21:01 | `--reset-import` | EXIT 0. hop null. 36999 observations left. |
| 21:02–21:37 | `--import` | EXIT 3 `writer_active` when the enrichment cron held a projection lease 21:37:30–21:37:54. hop `import`, 2635 films, 10750 decisions. Source objects had not moved from the 21:07 baseline. |
| 22:02–22:11 | `--import` (resume) | EXIT 0. 2635 films, 10834 decisions, 1 score, 1100 `staleEvidence`, `resumed` true. |
| 22:12–22:19 | `--hold` | EXIT 0. `mode` `d1`, `cutover` `held`, generation 1. Pin kept. |
| 22:19–22:27 | `--activate` | EXIT 0. `cutover` `open`. Pin cleared. |

## Read-back

A separate read-only query at 22:27:36 UTC. That query sent no write.

| Check | Result |
| --- | --- |
| Marker | `mode` `d1`, `cutover` `open`, generation 1, programme `7c1eaadb-08a6-40a1-b793-a345068144a5` |
| Checkpoint | `hop_id` null, pin payload null |
| `discovery_admission` | 2635 |
| `discovery_decision` | 10834 |
| `discovery_score` | 1 |
| Active observations | 36999 |
| Discovery lease | empty |

## Verdict

**Activation holds for the marker.** Readers and writers of the discovery ledger, decisions, catalog admission, status, scores, continuation, workflow record and lease use D1 while `mode` is `d1` and `cutover` is `open`. They do not fall back to R2.

**Not done by this activation.** A GET of `/api/enrichment/pipeline/status` after the flip still reported `ledgerTotal` 0 on a Worker that loaded the whole D1 ledger only below 20,000 rows. That is a reader defect, not missing rows. Finds, Admin limbo and one natural D1 discovery writer were not exercised. There is no command that returns `d1` to `r2`.

**Limits.** Operator stdout and D1 inspect queries. No Time Travel restore. Bookmark prefixes stay truncated. Full etags and SHA-256 are not published here.
