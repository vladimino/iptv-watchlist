# Controlled EPG Workflow rollover

**Authorization:** `dry_run` is a verified safe observation (L0). Every `apply` in production is an owner-gated operation: it needs a separate, explicit owner GO naming the exact pins (`expectedRunKey`, `expectedEpoch`, `expectedSeries`, `expectedInstanceId`, `expectedRunId`, `expectedControlRevision`) and the preconditions below. A merge, a deploy or this tool listing is not a GO. Decision record: [ADR 0176](../adr/0176-controlled-epg-workflow-rollover.md).

## What it does

A running EPG Workflow instance keeps the Worker version it was created on until it hands over or ends. The MCP tool `epg_workflow_rollover` moves the run onto the deployed version earlier. It swaps the `control` record to the deterministic successor (`series + 1`, `epg_<runKey>_<series>`) of the same run key, epoch and run id by one compare-and-set, only while the owner is asleep outside a step, then creates the successor and reads back. It writes nothing else:

- no publication, no `sync.json` or R2 write, no Discovery write;
- no lease reset, no change of the failure budget, cooldown or quarantine;
- no flag, cron, schedule or Scheduled Task;
- no platform `terminate` or `restart`.

The old instance stops by itself when it next wakes (`not_owner`).

## Preconditions

The preflight checks them and refuses otherwise:

- Mode `cloudflare` at the record's epoch, published authority ready.
- The control record names an instance, has no `doneAt`, no quarantine and is not `starting`.
- Cloudflare reports the owner `running` or `waiting`.
- A durable sleep (`nextWakeAt`, or `cooldownUntil` for a cooldown) more than 120 s ahead.
- No live EPG step lease.
- The run key is today's Madrid day, or a seal claim of that run is still pending.
- `sync.json` at `stage: seal` is covered by the control's `handoff.sealRunId`, and belongs to the record's run.
- The instance has not recorded the deployed version (otherwise `already_current`).

## Preflight

1. Call `epg_workflow_rollover` with `{"mode":"dry_run"}`. It writes nothing.
2. Read `decision`:
   - `eligible`: copy `expect` into the GO request to the owner, with `facts.sleepsUntil`, `facts.control.versionId`, `facts.deployedVersionId`, the failure counters and `facts.syncRun`.
   - `already_current`: nothing to do.
   - `unsafe`: `blockers` names each failed precondition. `owner_not_sleeping`, `wake_too_soon` and `lease_live` mean a step runs or is about to; wait for the next durable sleep and read again. `quarantined`, `complete`, `authority_held`, `switch_in_progress`, `not_cloudflare`, `epoch_mismatch`, `seal_unclaimed`, `run_mismatch` and `day_rolled` are not cleared by this tool.
   - `unknown`: `unknowns` names the fact that could not be read (platform status, `sync.json`, mode, control, lease, deployed version). Do not apply.

## Apply (owner GO only)

Call `{"mode":"apply","confirmGo":true,"requestId":"<8–64 of A-Z a-z 0-9 _ ->","expectedRunKey":"…","expectedEpoch":N,"expectedSeries":N,"expectedInstanceId":"…","expectedRunId":"…","expectedControlRevision":N}` with exactly the approved values. Use a fresh `requestId` per GO and keep it.

| Answer | Meaning | Next step |
| --- | --- | --- |
| 200, `outcome: handed_over` | The successor owns the record, is alive, the run and checkpoint are preserved and the successor recorded the deployed version. | Done. A `dry_run` reads `already_current`. |
| 200, `outcome: handed_over_version_pending` | Accepted; the successor has not run its first step yet. | Read `dry_run` again after a minute: expect `already_current`. |
| 202, `outcome: successor_uncertain` | The swap is done, the create could not be confirmed; the record stays `starting`. | Repeat the same request, or wait for the hourly `ensure`: both create the same id and spend no budget. |
| 202, `outcome: swap_unknown` | The swap statement threw; its outcome is not known. | Repeat the same request with the same pins. |
| 202, `outcome: create_blocked` | A repeat found the create still owed, but a current fact is unsafe or unknown (authority held, epoch moved, mode switched, version, platform status or `sync.json` unreadable). Nothing was created. | Read `dry_run`; the blockers clear on their own or need their own procedure. Repeat the same request only when they have cleared. |
| 202, `outcome: readback_unproven` | The swap and the create answered, the readback did not prove owner, liveness, a readable `sync.json` of the same run, or the checkpoint. | Repeat the same request. If it stays unproven, stop and escalate with the receipt. |
| 409, `writes: 0` | Refused: `stale_pin` (with `stale` naming the fields), `unsafe`, `unknown`, `already_current`, `cas_lost`, `preflight_too_slow`, `request_id_reused`, `no_owner`; on a repeat, `request_id_reused` when any of the six pins differs from the original request. | Read a fresh `dry_run`. Never reuse a request id with other pins. |
| 400 | Invalid arguments or no `confirmGo`. | Nothing was written. |

A timeout or a lost answer: repeat the **same** request. It never swaps twice; it resumes an owed create or reads back, and `superseded` (a later natural successor replaced it) is a success.

## Verification after apply

- `dry_run` reads `already_current`, and `expect.instanceId` is the receipt's `toInstanceId`.
- `facts.control.consecutive` and `total` equal the values in the GO request; `facts.syncRun.key` is not behind the one pinned.
- The Worker log has one `epg_workflow_rollover` line with the outcome; it holds no secrets.
- The next natural `epg_act` lines come from the successor instance id.

## Stop and rollback

- The swap is not reversed: the successor is the same run's legitimate executor. A code revert removes the tool and the version write; the record stays readable.
- If the successor fails, the existing recovery applies (cooldown, budget, quarantine after the fifth failure). Do not reset the lease, edit the record, clear a quarantine or create an instance by hand; those need their own owner-approved procedure.
- If the preflight stays `unsafe` or `unknown` and the deployed version must reach the run, wait for the natural hand-off or the next series; do not bypass.
