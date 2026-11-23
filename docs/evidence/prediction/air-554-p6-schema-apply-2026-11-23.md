# AIR-554 P6: production apply of migrations 0034 and 0035 (Predictions auxiliary schema), 23 Nov 2026

[AIR-554](https://trello.com/c/UrS1gflv) · 23 November 2026, 13:12-13:40 UTC. One owner-authorized, schema-only apply to the production D1 `iptv` by the operator `scripts/prediction-aux-cutover-production.mjs --apply`, under the owner's [conditional P6 GO](https://trello.com/c/UrS1gflv#comment-6b043a6bb70566036a50b828) and its [handoff](https://trello.com/c/UrS1gflv#comment-6b043aaa1cef14fc23dca85d). **This is not a cutover**: no import, no close, no seal, no flip, no export, no Task, flag, Access, Worker binding, lease or Workflow change, and `0036` was not applied. R2 stays the authority of the auxiliary state. Counts, hashes, times and statuses only; no payloads, secrets or tokens.

## Preflight (all read-only, PASS)

| Item | Observation |
| --- | --- |
| Code | `main` `750babee744bc9f934db91568cca04def9e1d75f`; its CI and deploy [run 45178973223](https://github.com/vladimino/iptv-watchlist/actions/runs/45178973223) succeeded; the production Worker deployment `85049f2d-394b-4ac1-a611-b4d98cab7ecb` (12:58:53 UTC) carries that commit, so the `r2`, `closed` and `d1` gate and the receipts code of [ADR 0196](../../adr/0196-prediction-aux-admission-closed-state.md) and [ADR 0202](../../adr/0202-prediction-aux-resumable-import-with-receipts.md) are live |
| SQL digests (SHA-256) | `0034_prediction_aux_authority.sql` `fedc11bb3df979248526120b6f8094b36628fcd22afbca4ce1d65909058c316f` (last changed in the reviewed PR 893, unchanged since); `0035_prediction_aux_import_receipts.sql` `92c2312bbb30264e6cb6ae4f18a2e8c8fc605ecac6ae9beae2340d2eb3fe2d8d` (introduced and reviewed in PR 930, unchanged since); operator `a643fffb043a5cac59d63a82e6803ac7c541eeb920a28660231812cf92cb91db`; no edit of the SQL, no manual application |
| Target | Cloudflare account `8d9331889a693d328ef306692adf9d24`, D1 `iptv`, uuid `3fba0e0a-44e9-4a3a-a7ba-edaee6bcafcb`, region WEUR, 145 tables, 2,457,006,080 bytes, read back by the API independently of the operator; the account holds only this database |
| Operator `--status` (13:16 and 13:24 UTC) | schema 33, auxiliary tables 0/13, receipt tables 0/3, marker absent, `decisions.apply` `apply`, `prediction_domain_authority` `d1`, migration pin `73bcca91df362a05e4a48a44614cf06bfb6174e756f8ff377de76c7cfddb343a` (digest of both files, printed by this same status) |
| Other authority markers (baseline) | Discovery, Film/Person, published EPG and ratings `d1` / `open`; EPG checkpoint, filter preset, metadata cache, owner review, prediction domain, started marks and Watchlist `d1`; unchanged by the apply |
| D1 health | no `D1 DB is overloaded` and no CPU-limit event in the previous 60 minutes of the Worker logs; D1 analytics, 15-minute buckets 10:15-13:15 UTC: at most 7.16 M rows read, 4,019 read queries and 737 rows written per bucket, p99 query time 84 to 110 ms (22 Nov anomaly for comparison: 12 to 36 M rows read per bucket, one bucket 193 M); no other migration in flight (schema 33, `0036` absent) |
| Timing | a natural run was live from 13:15 UTC; the apply waited for it to end (complete 13:21:33 UTC, runner and writer lease released) so that the next natural run is a clean observation. Waiting is not a condition of the GO |

## The apply (one command, not repeated)

`node scripts/prediction-aux-cutover-production.mjs --target iptv --apply --confirm apply --migration-sha256 73bcca91…b343a`, started 13:24:12 UTC, finished 13:24:24 UTC (12 s), exit 0, `writeState` `committed`, no retry. One atomic guarded batch of the two migrations (schema 33, 34, 35). D1 time-travel bookmarks reported by the operator: before `00000c0c-000000d8-0000512c-0211a84827aa4f368bee558507a979d4`, after `00000c0c-000000da-0000512c-b7267c0ab3ca898a5cae6e66496210a5`. The database grew by 200,704 bytes (schema only).

## Independent readback (13:24:33 UTC) and acceptance

| Check | Result |
| --- | --- |
| `schema_contract.version` | 35 |
| Operator `--status` | `decisions.apply` `already_applied`, `close` available, `reopen` `marker_is_r2`; auxiliary tables 13/13, receipt tables 3/3, same migration pin |
| Marker `prediction_aux_authority` | mode `r2`, generation 0, `activated_at` empty |
| Data | stage, source heads, revisions, pieces, manifests, outbox, import receipts, seal and verification receipts: 0 rows in each |
| Triggers and indexes | 33 `prediction_aux_sealed_*` triggers present; no `0036` index present |
| Other domains | the `otherDomains` section of the operator status is identical before and after |

## First natural run after the apply (no manual run, no Task change)

Run started 13:27:54 UTC and completed 13:35:20 UTC (`complete`, stop reason `manifest_spent`). Worker logs 13:24:24 to 13:40:04 UTC: **0** events of `prediction_aux_unavailable`, `prediction_aux_closed` and `prediction_aux_corrupt`, 0 `D1 DB is overloaded`, 0 CPU-limit events; marker still `r2`, auxiliary tables still empty. Step wall times (ms) against the 23 Nov baseline of 06:06-12:06 UTC ([P3 measurement](air-554-cold-tcut-measurement-2026-11-23.md) used the same logs): `batch_start` 74,673 (n 1; baseline p50 83,670), `batch_submit` p50 46,978 and max 50,512 (n 5; baseline p50 43,610, p95 67,879), `batch_complete` 51,724 (n 1; p50 44,405), `batch_hold` p50 6,667 (n 2; p50 6,065), `batch_manifest` p50 1,061, p95 1,284 and max 1,284 (n 13; baseline p50 672, p95 930, max 1,717). The manifest p50 is higher than the baseline p50 and inside the baseline range; the sample is one run and cannot separate noise from an effect of the schema. No `batch_heartbeat` line was returned in this window; it is not interpreted. **One run is not a regression test.**

## Limits and residuals

- One natural run is observed; the next ones should be read the same way before the window. D1 call counts per step were not measured (only wall time).
- The schema is forward-only; a code rollback does not revert it. Recovery of anything unexpected is an owner decision, not an automatic step.
- P3 (worst-case per-unit durations on production D1, the real `A`, drain, owner acceptance of the window), P5 (the 60-minute health gate immediately before a window), P7 (this page adds one comparison point to the baseline) stay open; P4 and P8 were decided by the owner on 23 Nov ([decision](https://trello.com/c/UrS1gflv#comment-6b043a6bb70566036a50b828), recorded in the [run sheet](../../runbooks/prediction-aux-cutover-run-sheet.md)). Task disable, `--close`, import, seal, verification, flip and `0036` each need their own owner GO. Production cutover stays NO-GO.
