# Projector exclusive window: read-only preflight for Stage C (2026-11-08)

**Purpose:** the fresh read-only state that the activation plan in [the runbook](../../runbooks/d1-projector-window-activation.md) starts from, and one correction to the Stage B report. **Nothing was written, applied, enabled or run.** Every production read was a D1 `SELECT` (`changed_db=false`, `rows_written=0`) or the `feature_flags` readback, taken between 16:00 and 16:20 UTC on 2026-11-08, aggregated, no payload. Times are UTC.

## Observed

| Item | Value |
| --- | --- |
| `schema_contract` | one row, version 17; `projector_window` absent; `schema_contract_no_downgrade` present |
| The six prerequisite tables of migration `0018` | all present |
| Discovery authority | `d1` / `open`, generation 34,664 at 15:48 and 34,898 at 16:13 (about 234 in 25 minutes, a busy stretch again) |
| Discovery transfer | `loading` at 16:13 and 16:16; the lease row set and live at 16:16 |
| Flags (`feature_flags`, 16:13) | `DISCOVERY_EXECUTOR=workflow`, `D1_ENRICHMENT_WRITE=on`, `MONITOR=on`, `MONITOR_TRANSPORT=telegram`; `D1_ENRICHMENT_WINDOW` absent (effective `off`); no invalid flag |
| EPG executor mode (`epg_orchestration_document`, key `mode`) | `cloudflare`, epoch 1, drain `verified`, changed 12:41:45 and completed 12:44:04 |
| EPG executor control | phase `running`, run key `2026-11-08`, instance `epg_20261108_0`, epoch 1, revision 20 last updated 16:15:53; not done, no failure code; the step lease held, revision 40 updated 16:15:55 |
| Last projector run | started 16:00:43, finished 16:01:13, outcome `deferred`, reason `writer_active`, 2 queries, 30.1 s (before it, the 15:00 run of 62 s progressed: 650 Persons) |
| Worker cron (repository, `wrangler.jsonc`) | `0 * * * *` |
| Open pull requests | none |
| Hash of `migrations/0018_projector_window.sql` on `main` | SHA-256 `167dcfe4f9310f4e3e2fcc50d5b2154f896a29bce908dcc7f3f5b115be663054`, 2,733 bytes |

What was not read: the live registry of the two ChatGPT Scheduled Tasks (this session has no tool for it). Their state is therefore not claimed.

## Correction to the Stage B report

The [Stage B report](air-383-stage-b-dry-measurement-2026-11-08.md) says the EPG executor of [ADR 0100](../../adr/0100-epg-cloudflare-workflow-executor.md) is "not yet the daily publisher" and treats the external daily Task as the publisher. **That was not current:** the executor mode has been `cloudflare` since 12:44 UTC today, and the run of 2026-11-08 (due 16:00 UTC) was in flight at 16:15 UTC. By ADR 0100 decision 5 the server answers the legacy `epg_sync_start` and `epg_sync_step` with `external_writer_fenced` in that mode, so an external Task cannot publish. Whether the legacy Task is also disabled in the registry is not verified here. The clash described in Stage B section 5 is therefore with the in-process executor, which sleeps to `nextCatchUpAt` without charging its budget (proved offline, see the runbook); the activation precondition of ADR 0103 decision 5 is met by that executor once its first natural publication is accepted. This page does not replace the Stage B report; read the two together.

## What the observation shows about the clash

At the 16:00 UTC tick the executor started the daily run and the projector, 43 seconds later, found a live writer and deferred (`writer_active`). So on the publication tick the projector is deferred by the EPG run today as well, window or no window: a window requested after the writer-idle checks cannot be granted while that run holds the lease, and it must not be requested while the run is in flight.
