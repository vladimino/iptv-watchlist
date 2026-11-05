# AIR-357 production recovery: read-only preflight

**Captured:** 2026-11-05, about 20:35–20:50 UTC, read-only. **Method:** Cloudflare API `SELECT` statements on D1 `iptv`, the Workers deployments list, and the IPTV `epg_status` read tool. No write, no migration, no `epg_sync_start` or `epg_sync_step`, no lease or transfer change, no Discovery or TMDB call. `epg_pipeline_status` answered `discovery_incomplete` (the state below) and was not retried.

## Observed state

| Item | Value |
| --- | --- |
| Deployed Worker | deployment `f234916c-efae-4a0b-a6f5-c12b6ccda307` at 20:31 UTC, message "AIR-356: resumable bounded ledger seal for EPG commit (ADR 0092 Accepted)" (100% of traffic) |
| `schema_contract` | version 11; `discovery_seal` does not exist (migration `0012` not applied) |
| `discovery_authority` | `mode=d1`, `cutover=open`, programme and published run `7c1eaadb-08a6-40a1-b793-a345068144a5`, generation 452 |
| `discovery_transfer` | `loading`, programme run `5744aef7-990d-4751-bb46-d979d9c5a2cc`, 37,000 batches |
| `discovery_observation` | 328 `active` (run `5744aef7…`), 36,671 `retiring` (run `7c1eaadb…`); unchanged since the incident reading |
| `discovery_lease` | expired (`expires_at` 16:09:23 UTC, about 4.5 h before this read) |
| `epg_status` | run `5744aef7…`, `stage=epg`, `error=discovery_incomplete`, last update 16:08:56 UTC |

## Reading

- Nothing moved since the incident reading: no live writer, no new lease.
- The stopped run is in stage `epg`, not `seal`. It is a **legacy inline-seal** partial state with no seal job, so it is not resumable as a `seal` run. After `0012` is applied, the next EPG commit on this run re-fetches the source, stages the generation and `sealBegin` takes over the `loading` transfer: it flips active to `retiring` once together with the job row (the 328 rows are written again by the new job and take their rows over). This path is proven only by the offline tests (`tests/discovery-seal-resume.mjs`, `tests/discovery-seal-publish.mjs`, `tests/discovery-seal-restart.mjs`); it has not been run against real D1 or real R2 range reads.
- A retry of the commit **before** `0012` would run the old inline seal and is not safe.

## Proposed order (each step needs its own owner approval; this record authorizes none)

1. Apply exactly `migrations/0012_discovery_seal.sql` to production D1; read back `schema_contract` 12, an idle `discovery_seal` row and unchanged authority, transfer, observation, decision, admission and lease rows.
2. Repeat this preflight read-only, then one EPG commit on run `5744aef7…` (`epg_sync_step`), expecting stage `seal` and `nextAction=continue`; read back the `discovery_seal` cursor and the observation counts before every further step.
3. `epg_sync_step` while `nextAction` is `continue`; on an unknown outcome read back first, never a blind retry. Stop on a live competing lease, a divergent marker, a mismatch in counts or a timeout that does not make progress.
4. Acceptance readback: the published generation changed exactly once, transfer `committed`, seal `done`, no active/retiring duplicates, decisions, admissions and history unchanged in count, programme and watchlist readers and the Predictions snapshot consistent.

Unmeasured: the real D1 batch latency and the Worker CPU of a step. Code rollback does not revert D1 or R2.

## Step 2 attempt: migration `0012` not applied (owner GO given, write refused)

At about 20:55 UTC, after the owner's GO for exactly `migrations/0012_discovery_seal.sql`, the Cloudflare API connector re-read `schema_contract` (11) and the absence of `discovery_seal`, then sent the migration as one D1 `{sql}` body. Cloudflare refused it: HTTP 400, error 7500 "You do not have permission to perform this operation" (the connector's D1 permission is read-only). A readback right after showed `schema_contract` still 11 and no `discovery_seal` table: **nothing was applied**. The authority, transfer, observation and lease rows were not touched.

No other credential was tried. The operator entry `scripts/discovery-production.mjs --apply` sends only `0011`, and the `D1_BACKFILL_*` token is scoped to the backfill scripts. Applying `0012` needs either an operator apply path for `0012` (a reviewed script change) or a D1 write permission the owner grants for this one statement set.
