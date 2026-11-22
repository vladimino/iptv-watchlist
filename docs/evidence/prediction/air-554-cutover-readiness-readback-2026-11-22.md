# AIR-554: cutover readiness readback, 22 Nov 2026 (read-only)

Observation 18:11-18:35 UTC, 22 Nov 2026 (19:11-19:35 Madrid). Read-only: D1 `SELECT`, the Cloudflare API connector (`GET` of Workflows, Worker schedules and deployments, one analytics read of D1), and repository inspection. No R2 export, no production credential, no `0034`, no marker, Task, flag, Access, Workflow, model run, sync or lease change. Counts, statuses, times and query shapes only; no keys of private data, manifests, bodies or tokens.

This page records a verdict for owner review. It authorizes nothing.

## Code and deployment

- `main` `05f2ebb8` (AIR-571 E, [#911](https://github.com/vladimino/iptv-watchlist/pull/911): activates the Letterboxd Workflow binding and a `:30` cron). The Worker `iptv` was deployed from it at 18:16:19 UTC as version `d7af3a26` (100%), annotated with that commit.
- The operator, exporter, converter, importer, the `closed` gate and `migrations/0034` are the merged state of [#893](https://github.com/vladimino/iptv-watchlist/pull/893), [#896](https://github.com/vladimino/iptv-watchlist/pull/896), [#897](https://github.com/vladimino/iptv-watchlist/pull/897) and [#908](https://github.com/vladimino/iptv-watchlist/pull/908). The F1/F2 findings of the older plan page are fixed in the operator; that page is history, not the live state.
- Worker cron schedules now read back: `0 * * * *`, `1-59/2 * * * *`, `24 3 * * *`, `30 * * * *`.

## Production state

| Item | Observation |
| --- | --- |
| D1 schema | 33; no `prediction_aux_*` object, so `0034` is not applied and the auxiliary authority is R2 |
| `prediction_domain_authority` | mode `d1`, writes `held` |
| Runner lease | live at 18:11 UTC (a run was in progress, epoch 519); a moment snapshot, not a drained proof |
| Writer lease | released |
| Workflow `iptv-prediction-start` | queued 0, running 0, paused 0, waiting 0 (9 complete); also no queued, running or paused instance in the Workflows `iptv-epg`, `iptv-ratings`, `iptv-discovery`, `iptv-letterboxd`; `iptv-producer` has 147 errored instances and none live |
| Scheduled Tasks | per the coordinator registry readback: the four `00/15/30/45` Tasks enabled hourly, `48` disabled; a Task slot has started about 5 minutes before its nominal time |

`TASKS_PAUSED` is not `WRITERS_DRAINED`: the registry shows Tasks only. Drained requires terminal runs, non-live leases, no live Workflow instances and a closed marker (ADR 0196); none of these is established by a registry snapshot.

## D1 health (analytics, 15-minute buckets, UTC)

| Bucket | Queries | Rows read | Rows written | Total query ms |
| --- | --- | --- | --- | --- |
| 14:15 to 15:45 (6 buckets) | 500 to 2,082 | 0.14 M to 6.1 M | 83 to 743 | 590 to 9,058 |
| 16:00 | 46,401 | 25.3 M | 197,057 | 43,804 |
| 16:15, 16:30, 16:45 | about 21,000 | 23.8 M, 29.0 M, 36.6 M | 6,376 to 11,052 | 53,125 to 79,312 |
| 17:00 | 8,595 | **193.0 M** | 2,514 | 35,394 |
| 17:15, 17:30, 17:45 | 16,800 to 19,600 | 19.6 M to 24.3 M | 5,101 to 5,990 | 47,983 to 49,946 |
| 18:00 | 21,067 | 22.1 M | 8,425 | 103,480 |
| 18:15 (partial) | 4,563 | 12.5 M | 536 | 20,346 |

From 16:00 UTC the database ran at about ten times the previous query rate and an order of magnitude or more of the previous rows read (12 M to 36 M per bucket against at most 6.1 M, and one bucket at 193 M), sustained for at least two hours, with a p99 query time of 10 to 114 ms against 4 to 101 ms before. The largest consumers in the last 2.5 hours, by rows read: one execution of the EPG channel-policy query over `epg_channel_category` read 176 M rows in 17.5 s (the 17:00 bucket); 341 `discovery_observation` archive counts read 45 M; 1,543 and 1,750 `film_external_id` lookups read 23 M and 13 M; 1,039 `published_epg_show` deletes read 20.5 M; 671 `discovery_admission` reads 16 M; and 16,481 `sqlite_master` schema probes read 12 M. None of these is a Predictions auxiliary path.

Two Task runs ended with D1 errors reported by the coordinator: a heartbeat `D1 DB exceeded its CPU time limit and was reset` (slot `:30`, finished 17:34:57 UTC) and `D1 DB is overloaded` (slot `:15`, 18:10:06 to 18:11:07 UTC). Both fall inside the elevated period. This is consistent with contention but is **not proven causal**. The analytics error dimension recorded only `no such column` SQLite errors (29 at 16:00 and 12 at 18:00 UTC), whose cause was not investigated; overload and CPU-limit resets are not listed there.

**Verdict: operational NO-GO for any cutover step while this load persists.** Proposed gate for the owner to accept: it rests on observed errors and headroom and on the measured import workload (no run ending with a D1 overload or CPU-limit error in the 60 minutes before a window, the current analytics headroom, and the measured rows read and written and the duration of the import batch accepted against it). The pre-16:00 traffic is a reference observation; it has not been established as a permanent safe operating threshold, and the figures above are a measurement, not a threshold set here. The import itself adds a heavy batch (up to 2,000 statements, 8 MiB) whose D1 cost is unmeasured.

## Competing writers of the bucket

A full-bucket fenced cut fails with `inventory_changed` when any key changes between its two listings. Writers that remain active when the four Predictions Tasks are frozen: the hourly Worker tick at `:00` (the monitor state object, the EPG mirror reconciliation, the Workflow ensure calls), the Discovery-only cron every two minutes (the Discovery Workflow writes immutable observation segments to R2), the new Letterboxd `:30` cron (diary, events and facts objects), the daily EPG run at 03:24 UTC, and any ratings activity. Freezing Predictions does not make the bucket quiet. Two distinct consistent cuts, the second at most 15 minutes old, with an import and a verification between them, are therefore unlikely to complete inside one half hour without a change.

## Readiness for one real snapshot

- Ready without code change: the exporter, `--verify`, converter, importer reports, the operator `status` and the derived-SQL sizing, all tested offline.
- Unknown until an approved export: the current bucket size and object count, the size of the four families, the real import SQL against the batch limits (2,000 statements, 8 MiB, 100 KiB per statement), and the duration of one cut.
- **Blocker B1:** the cut is whole-bucket (see above). A scoped export would remove the dependence on unrelated writers only if its consistency proof is redesigned with it (the exporter, converter, operator and runbooks change together and the EPG and Discovery fence keys leave the proof; see the scope contract in the run sheet); filtering the listing alone keeps the original NO-GO. It is not built, needs a reviewed code change, and is an owner decision. Until then every cut may be NO-GO regardless of the Task freeze.
- **Blocker B2:** the sustained D1 load above.
- **Open (accepted risk):** a PUT that passed its marker read and lands after the final capture (ADR 0196); the bound of a legitimate in-flight legacy request is known only for the Workflow `prepare` step (timeout 4 minutes), not for a Task-side HTTP call.
- **Open (recovery):** after an import exists, `closed` to `r2` is refused by design; the abort path then is Tasks stay off, marker stays `closed`, owner decision. A restore from the snapshot is not designed and would be a separate approved operation.

## Baseline (natural runs, no reconfiguration)

D1 `prediction_run`, status and stop reason per UTC day: 19 Nov complete 69, `lease_expired` 10, partial `api_error` 1; 20 Nov 59 and 11; 21 Nov 52 and 28; 22 Nov until 16:49 UTC 17 and 21. Confounders to carry into any comparison: the rising share of `lease_expired`, the two D1 error events, and the recovery cohort `pr_c1f34f1e8b8390fd3df89228` (4 of 10 recomputed, 6 left, expiring 25 Nov 18:40 Madrid). `prediction_step_timing` percentiles were not collected in this pass; they need the Worker log read and are listed in the run sheet as a pre-window step.
