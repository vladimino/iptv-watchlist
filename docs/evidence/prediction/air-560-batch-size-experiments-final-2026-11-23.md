# AIR-560: final comparison of the Predictions v2 `manifestSize` experiments (S5, S7, S8, S10)

**Capture:** 20-23 November 2026. Times are UTC unless a local time is shown as "Madrid" (Europe/Madrid, UTC+1 on these dates).  
**Work item:** [AIR-560](https://trello.com/c/NZ70Dzom), follow-up to [AIR-461](https://trello.com/c/a9TdXgNM).  
**Outcome:** **S7 retained** on the four enabled hourly Tasks. The batch-size experiment series inside AIR-560 is **stopped**. Further optimization is not forbidden, but it continues in other Trello cards under separate owner decisions.

This report supersedes nothing: the iteration-1 report [air-560-s10-two-hour-trial-2026-11-21.md](air-560-s10-two-hour-trial-2026-11-21.md) (PR #831 candidate, PR #833 evidence) stays the historical record of the first S5-to-S10 trial. This report adds the iteration that started after [AIR-573](https://trello.com/c/4pD66DLd) and [ADR 0195](../../adr/0195-scheduled-task-id-as-run-owner-label.md): S7, a second S10 trial, S8, and the rollback to S7.

## Experiments, authorization and delivery

Each of the S7, S8 and S10 candidates is one variable relative to its predecessor: the three occurrences of `manifestSize` in the Task prompt (S5 is the earlier canonical prompt generation, a different text, and is not part of that one-variable chain). `taskId` (one fixed label per Task, ADR 0195), `generationSize=1`, `submitBatchSize=5`, research and source gates, scoring, heartbeat, Worker, schedules, lease TTL and enabled states were unchanged. The `:48` Task stayed disabled throughout. Prompts were changed only by owner-authorized `Automations.update(prompt)` on the four existing Tasks, with per-Task and whole-registry readback.

| Config | Candidate delivery | Live window start (UTC) | Owner authorization (Madrid time, owner's words abbreviated) | Ended |
| --- | --- | --- | --- | --- |
| S5 | canonical prompt, [hourly-predictions-batch-v2.md](../../reference/scheduled-task-prompts/hourly-predictions-batch-v2.md) | baseline | none needed | replaced by S7 23 Nov 08:33 |
| S7 | [PR #898](https://github.com/vladimino/iptv-watchlist/pull/898), `air-560-s7-taskid-*` | 23 Nov 08:33-08:34 (09:33 Madrid) | "отлично. тогда давай менять" | replaced by S10 |
| S10 (2nd) | [PR #940](https://github.com/vladimino/iptv-watchlist/pull/940), merge `e0145efa63f5ff82afb829849c65f6fea96488d8`, post-merge CI/CD run 45176224827 success | 23 Nov 12:54-12:55 (13:55 Madrid) | "разрешаю. как раз с .00 начнем!" | replaced by S8 |
| S8 | [PR #949](https://github.com/vladimino/iptv-watchlist/pull/949), merge `f052bcf6b1194bff9dde2f667293732cee9f3788`, post-merge CI/CD run 45221676407 success | 23 Nov 16:58-16:59 (17:59 Madrid) | "да" | rolled back to S7 |
| S7 (final) | restored from #898 | 23 Nov 19:14-19:15 (20:14-20:15 Madrid) | "надо откатываться на S7" | **current accepted configuration** |

Candidate PRs #898, #940 and #949 are offline-only: snapshots plus integrity tests. The historical S10 of PR #831 predates ADR 0195 and was never used as a source. The coordinator and the executors initiated no `run_now`, manual producer, recovery, lease reset, retry, flag, Worker, Access, R2 or D1 write for any trial. The one manual action was the **owner's manual rerun of the `task00` Scheduled Task** after the first S8 slot left an orphan start claim (see below); it ended `start_pending` then `unknown_run` and committed nothing.

## Data sources and measurement method

- **Counts** come from authoritative read-only D1 `prediction_run` SELECTs (`rows_written=0`) and per-film persisted receipts: each `filmId` counted **once** when it was durably committed, including successful submits inside runs that were later interrupted. Selections that were never submitted, deferred or replayed submits and recovery re-selections are not counted as commits. "Created" and "recalculated" are the Worker's `added` and `updated` counters; a commit is either.
- **Windows** are eight consecutive nominal hourly slots (2 h) per configuration, taken **by scheduled slot, not by completion time**, because actual starts drift by minutes. A run that starts late or early stays in its nominal slot. The S10 extension covers twelve nominal slots (3 h) and is reported separately.
- **Research source levels** (full / partial / snippet / metadata-only) are **caller-reported** values stored in the per-film assessment. The Saved Task research audit (queries, URLs, authors, `gateStatus`, `executionFinding`) was available only as "latest run" for a few Tasks, never as history, and was sampled, not exhaustive.
- **Not observable:** the order of per-film Events is not the manifest order and was not used for position claims, except the explicit position split of completed S10 manifests in the owner's D1 report. No hidden personal ratings or MAE/bias were used; no accuracy claim is made.

## Comparable two-hour windows

| Metric (2 h, 8 nominal slots) | S5 baseline | S7 | S8 | S10 |
| --- | ---: | ---: | ---: | ---: |
| Nominal slots window (Madrid) | 23 Nov 06:30-08:15 | 23 Nov 09:45-11:30 | 23 Nov 18:00-19:45 | 23 Nov 14:00-15:45 |
| Productive slots / 8 | 7 | **8** | 6 | 5 complete, 2 interrupted, 1 no run |
| Distinct committed films | 33 | **54** | 42 | **57** |
| Committed per hour | 16.5 | **27.0** | 21.0 | **28.5** |
| Created / recalculated | 20 / 13 | 38 / 16 | 26 / 16 | not split for the 2 h window; see the 3 h table |
| Per-film failures per selected | 2/35 (5.7%) | 2/56 (3.6%) | 6/56 (10.7%), all `parse_error` | not recorded separately for the 2 h window |
| Reported full / partial / snippet / metadata-only | 20 / 3 / not recorded here | 32 / 11 / 3 / 8 | 4 / 15 / 8 / 15 | 6 / 18 / 18 / 15 |
| **Reported full + partial** | 23/33 (69.7%) | **43/54 (79.6%)** | **19/42 (45.2%)** | **24/57 (42.1%)** |
| Reported full only | 60.6% | 59.3% | 9.5% | 10.5% |
| Completed Worker run duration | not compared | 4.5-8.8 min, median ~5.7 | 4.2-6.9 min, median ~6.0 | 6.6-14.2 min, median ~7.8 |
| Other stops | 1 non-productive slot | none | one `api_error` run (no commits), one start left an orphan claim | 2 `lease_expired` interrupts (5 and 4 persisted), 1 slot with no run |

Notes on the table:

- **S5 split.** The S5 baseline here (23 Nov, D1 receipts: 20 full, 3 partial) is a different natural window from the S5 baseline of iteration 1 (20 Nov, Events projection: 14 full, 9 partial, same 33 committed and same 23 full+partial). The totals coincide; the full/partial split does not, and the two sources were not reconciled. Do not mix the two S5 windows.
- **S8 slots (committed):** 18:00 task00 **0** (no durable run, see below); 18:15 8/8; 18:30 8/8; 18:45 **0/8** (`api_error`); 19:00 7/8; 19:15 3/8 (five `parse_error`); 19:30 8/8; 19:45 8/8. The 20:00 run is outside the window and was not counted.
- **S8 first slot.** An orphaned start claim (epoch 609, `phase=claim`) predated the owner's manual retry by about 81 seconds and left no durable run or manifest. The retry received `start_pending`, then `unknown_run` after the claim expired. The cause (lost response or timeout before durable persistence) was **not verified**; it is not proven to be an effect of `manifestSize=8`.
- **S10 two-hour windows** differ from iteration 1 (Madrid 14:00-16:00 on 23 Nov here, versus 20 Nov 22:38-00:38 in the older report); the older 53 committed versus 33 and 13.2% full text are kept in the historical report and not repeated in this table.

## S10 three-hour extension (separate)

| Metric | S10, 12 nominal slots (14:00-16:45 Madrid) | S7 control (2 h) |
| --- | ---: | ---: |
| Distinct committed films | **96** (32.0/h) | 54 (27.0/h) |
| Created / recalculated | 58 / 38 (19.3 / 12.7 per hour) | 38 / 16 (19.0 / 8.0 per hour) |
| Complete runs / interrupted / no run | 9 / 2 (`lease_expired`) / 1 | 8 / 0 / 0 |
| Explicit per-film `parse_error` | 3 (plus 11 selected films never submitted by interrupted runs and about 10 positions in the missed slot) | 2 |
| Reported full / partial / snippet / metadata-only | 10 / 28 / 30 / 28 | 32 / 11 / 3 / 8 |
| **Reported full + partial** | **38/96 (39.6%)**, full 10.4% | 43/54 (79.6%) |
| Created cohort F+P | 21/58 (36.2%) | 28/38 (73.7%) |
| Recalculated cohort F+P | 17/38 (44.7%) | 15/16 (93.8%) |

Within completed S10 manifests (first five versus last five positions): F+P 20/44 (45.5%) versus 15/43 (34.9%); metadata-only 8/44 (18.2%) versus 20/43 (46.5%). Research is worse late in a long batch, but the first half was already far below S7. The 14:45 `task45` run stopped heartbeating after 15:01:12 Madrid and expired; `task15` and `task30` recovered the leftovers. The client-side cause of the expiries could not be proven from persisted D1 alone.

## Admission and recovery quota (ADR 0197)

[ADR 0197](../../adr/0197-recovery-slots-in-the-ordinary-batch-manifest.md) reserves part of every manifest for recovery. At the observed sizes that is 5 ordinary plus 2 recovery for S7, 5 plus 3 for S8 and 6 plus 4 for S10. Consequences: S8 adds **no** ordinary capacity over S7, and S10's nominal gain in new predictions is small. Observed created per hour: S7 19.0, S8 13.0, S10 19.3. S10's extra throughput came almost entirely from recalculation (12.7 per hour versus 8.0). The quality drop appears in both cohorts, so it is not explained by the recovery share alone.

## Quality limits that apply to every row above

- F/P/S are **recorded claims by the generating model**, not independently confirmed article reads. A known S7 case: `tmdb_417644` (CHiPs, 2017) is stored as `full_text` while the Task's own research audit says only a search snippet was read. Correcting that one case gives at most 42/54 (77.8%) full+partial for S7. Two other S7 citations were manually checked and were real, substantive original reviews (Slant for *Mirrors*, Bloody Disgusting for *The Ugly Stepsister*).
- Saved Task audit samples from the late S10 runs show many `limited`, snippet-only and metadata-only entries even for notable films. The drop in S10 and S8 reported access is therefore not just an accounting artefact.
- Comparison is **not randomized**: configurations ran at different times of day on different film mixes, once each, with no repeats and no confidence intervals. Scheduler drift, overlapping Tasks on one lease, and EPG or Discovery activity differ between windows. The data supports "observed in these windows", not a causal estimate of `manifestSize` alone.
- The working targets were hypotheses, not hard gates: at least 20 committed per hour, at least 65% honestly reported full+partial, at most 10% per-film failures, no visible degradation of substantive findings. S7 met all three numeric targets (with the misattribution caveat); S8 and S10 missed the quality target, and S8 also missed the throughput and failure targets.

## Owner verdict

- **S7 retained.** S7 was the best stable configuration observed under this exact prompt, source gates, recovery quota, four-Task scheduler and film mix. It is **not** claimed to be a fundamental or mathematical upper bound.
- **S8: fail** on quality, stability and throughput (owner: visible regression in both research quality and stability). No further S8 natural trial.
- **S10: not accepted.** Higher throughput, but reported F+P about 40% and two lease interruptions plus one missed slot.
- **The batch-size series is stopped inside AIR-560.** S9, S15 and further `manifestSize` increases are not planned in this card. New hypotheses (scheduling, research gating, queue allocation, latency, per-run resource budget) belong in **other Trello cards** under separate owner decisions. This is not a prohibition of optimization.

## Production state after the rollback

**Rollback (owner-approved, prompt-only):** four `Automations.update(prompt)` calls in order `task00`, `task15`, `task30`, `task45`, finished 23 Nov 19:14:55-19:15:19 UTC (20:14:55-20:15:19 Madrid), restoring the exact S7 texts of PR #898 (three `manifestSize=7`, unique `taskId`, schedules, timezone, timing mode and enabled states unchanged). The whole-registry readback reported four enabled S7 Tasks and `:48` still disabled; that readback was taken by the coordinator and recorded in the AIR-560 Trello comment of 23 Nov 20:17 Madrid (19:17 UTC). It is a **secondary source** for this report: the session that wrote this document has no access to the Automations registry and did not re-read it.

**Read-only post-rollback check by this session** (MCP `enrichment_status`, a read-only tool; read at about 20:15 UTC on 23 Nov, `state=completed`, `currentRun=null`): the three natural runs after the rollback each selected seven films, as expected for `manifestSize=7`.

| Run start (UTC) | Nominal slot (Madrid) | Selected | Committed (created + recalculated) | Per-film failures | Stop |
| --- | --- | ---: | ---: | ---: | --- |
| 19:30:37 | 20:30 | 7 | 7 (5 + 2) | 0 | `manifest_spent` |
| 19:41:26 | 20:45 (started early) | 7 | 5 (3 + 2) | 2 `parse_error` | `manifest_spent` |
| 20:00:26 | 21:00 | 7 | 5 (3 + 2) | 2 `parse_error` | `manifest_spent` |

There was no recorded run for the 20:15 Madrid slot; the rollback landed inside that slot, so it is ambiguous and must not be read as an S7 regression. Totals for the three runs are 17 committed of 21 selected, four per-film failures (19%, above the 10% working target, on a three-run sample). Per-film F/P/S for these runs was not collected, so **post-rollback research quality is not verified**. The three runs show that S7 manifests of seven are selected and complete normally; they do not by themselves prove sustained S7 quality. Independent verification of the registry and of further natural S7 runs remains with the coordinator before AIR-560 is marked complete.

## Known unknowns

- Cause of the S8 orphan start claim at the first slot, of the two S10 `lease_expired` interruptions and of the S8 `api_error`: not provable from persisted D1 alone.
- Per-film original-article reads for any configuration: not independently verified.
- Historical S5 latency and per-position data: not recorded here.
- Post-rollback S7 quality over a full two-hour window: not yet collected.

## Related

[AIR-560](https://trello.com/c/NZ70Dzom), [AIR-461](https://trello.com/c/a9TdXgNM), [AIR-573](https://trello.com/c/4pD66DLd), [ADR 0195](../../adr/0195-scheduled-task-id-as-run-owner-label.md), [ADR 0197](../../adr/0197-recovery-slots-in-the-ordinary-batch-manifest.md), [PR #833](https://github.com/vladimino/iptv-watchlist/pull/833), [PR #898](https://github.com/vladimino/iptv-watchlist/pull/898), [PR #940](https://github.com/vladimino/iptv-watchlist/pull/940), [PR #949](https://github.com/vladimino/iptv-watchlist/pull/949), [iteration-1 report](air-560-s10-two-hour-trial-2026-11-21.md). Private per-film reports, the owner taste profile, model prompts and raw Task reports are deliberately not included.
