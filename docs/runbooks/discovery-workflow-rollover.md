# Controlled Discovery Workflow rollover

**Authorization:** `dry_run` is a verified safe observation (L0). Every `apply` in production is an owner-gated operation: it needs a separate, explicit owner GO naming the target (`expectedProgrammeRunId`, `expectedInstanceId`, `expectedSeries`) and the preconditions below. A merge, a deploy or this page is not a GO. Decision: [ADR 0162](../adr/0162-controlled-discovery-workflow-rollover.md). Diagram: [scheduling and orchestration](../architecture/scheduling-and-orchestration.md#controlled-discovery-workflow-rollover-adr-0162-proposed). Tool contract: [MCP reference](../reference/api/mcp.md).

## What it does

A running Discovery Workflow instance keeps the Worker version it was created on until its natural handover (20 chunks or the invocation budget). The MCP tool `discovery_workflow_rollover` moves Discovery onto the deployed version earlier. It swaps the executor record to the deterministic successor (`series + 1`) of the same published generation, creates that successor and reads it back. It changes nothing else:

- no continuation, ledger, decision, catalog, published EPG or R2 write;
- no lease reset;
- no flag, cron, schedule or Scheduled Task;
- no platform `terminate` or `restart`.

The old instance stops by itself when it next wakes.

## Preconditions

All of these must hold. The preflight checks them and refuses otherwise:

- Discovery authority `d1`/`open`, transfer not `loading`, and the Discovery pin equal to the published EPG generation.
- The executor record names a well-formed instance in phase `waiting`, sleeping for more than 120 s from now, with no exhausted recovery.
- Cloudflare reports that instance `running` or `waiting`.
- No live Discovery lease.
- A continuation of the same generation that is not `running` (its checkpoint is saved).
- No active projector window. No EPG-priority pause.
- The owner has not recorded the deployed version (otherwise `already_current`).

## Preflight

1. Call `discovery_workflow_rollover` with `{"mode":"dry_run"}`. It writes nothing.
2. Read `decision`:
   - `eligible`: copy `expect` (`programmeRunId`, `instanceId`, `series`) into the GO request to the owner, together with `preflight.owner.waitingUntil`, `preflight.owner.versionId`, `preflight.deployedVersionId`, `preflight.continuation` (`hopId`, `revision`, `replayAfter`) and `preflight.report`.
   - `already_current`: nothing to do.
   - `unsafe`: `blockers` names each failed precondition. Wait and read again. `instance_active` and `wake_imminent` mean the owner is working or about to wake; `lease_live` and `checkpoint_unsaved` mean a chunk is in flight; `projector_window` and `epg_priority` mean a soft gate is closed; `handoff_pending` means a create is still unconfirmed (the reconcile handles it); `no_active_instance` means no owner is running (the reconcile starts the next instance on the deployed version anyway); `instance_not_alive` and `recovery_exhausted` belong to the existing recovery, not to this tool.
   - `unknown`: `unknowns` names the fact that could not be read. Do not apply.

## Apply (owner GO only)

Call `{"mode":"apply","confirmGo":true,"requestId":"<8–64 of A-Z a-z 0-9 _ ->","expectedProgrammeRunId":"…","expectedInstanceId":"…","expectedSeries":N}` with exactly the approved values. Use a fresh `requestId` per GO and keep it.

| Answer | Meaning | Next step |
| --- | --- | --- |
| 200, `outcome: handed_over` | The successor owns the record, is alive, the checkpoint is preserved and the successor recorded the deployed version. | Done. A `dry_run` reads `already_current`. |
| 200, `outcome: handed_over_version_pending` | Accepted; the successor has not run its first step yet. | Read `dry_run` again after a minute: expect `already_current`. |
| 202, `outcome: successor_uncertain` | The swap is done, but the create could not be confirmed. The record is `uncertain` with a recovery due time. | Do nothing. The hourly reconcile recreates the same id when due. Repeat the same request later to read back. |
| 202, `outcome: readback_unproven` | The swap and the create answered, but the readback did not prove the owner, its liveness or the checkpoint. | Repeat the same request (same `requestId`, same pins). It never swaps twice. If it stays unproven, stop and escalate with the receipt. |
| 409, `writes: 0` | Refused: `confirm_required`, `pin_mismatch`, `unsafe`, `unknown`, `already_current`, `write_conflict`, `projector_window`, `epg_priority` or `request_id_reused`. Nothing was written. | Read `dry_run` again; a new GO is needed for new pins. |

A timeout or a lost answer: repeat the **same** request. With the same `requestId` the tool recognises its own swap. It then creates the successor if the record still says `starting`, or reads back; `superseded` means a later natural successor already replaced it, which is a success.

## Verification after apply

- `dry_run` reads `already_current`, and `preflight.owner.instanceId` is the receipt's `to.instanceId`.
- `preflight.continuation.programmeRunId` is unchanged and `revision` is not lower than in the receipt.
- `preflight.report` still holds the period counters, and `lastRollover.requestId` is the request id.
- The hourly `discovery` Events Log entries continue.
- The Worker log has one `discovery_workflow_rollover` line with the outcome; it holds no secrets.

## Stop and rollback

- The swap is not reversed: the successor is the same generation's legitimate executor. A code revert removes the tool but leaves the record readable.
- If the successor fails, the existing recovery applies (step-failure recovery, `uncertain`/`stopped` reconcile, quarantine after four attempts). Do not reset the lease, edit the record or create an instance by hand; those need their own owner-approved procedure.
- An EPG publication after the swap makes the successor stop with `stale_generation`; the reconcile starts the new generation as usual.
