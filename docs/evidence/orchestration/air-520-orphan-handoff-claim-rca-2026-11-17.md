# AIR-520 RCA and offline evidence: orphaned EPG hand-off claim (17 November 2026, UTC)

Scope: code reading, the sanitized observations recorded on the AIR-520 card, and offline tests (`tests/epg-orchestration.mjs`, scripted pipeline and Workflow stand-ins). No production read or write, no Workflow instance created, terminated or retried, no Task, flag, cron, schema or D1/R2 change. This is not production proof: acceptance across several publication days stays with AIR-420.

## Observed (17 Nov 2026, from the card; no new production access)

- `epg_status`: run `ae4c4209-…`, `stage=seal`, `seal.phase=ledger`, control `phase=starting`, `handoff 0→1`, `instanceId=epg_20261117_1`, `liveness=absent`, failure counters 0, `published=null`, health `late`.
- Cloudflare Workflow: `epg_20261117_0` completed with `reason=not_owner`; its `act-2-1` attempt 1 failed with `WorkflowInternalError: Attempt failed due to internal workflows error`, attempt 2 succeeded and was followed by `stopped-3-1`; no `handoff-*` step. `epg_20261117_1`: GET 404, absent from the listing.
- Not established: the cause of the platform error (memory, isolate kill or other). Telemetry for `epg_act` / `epg_phase` / `epg_memory_boundary` was not read in this change, so no cause is claimed.

## Mechanism (established from code at `b393daf`)

1. `act` commits the claim by D1 compare-and-set (`series+1`, `phase=starting`, `instanceId=…_1`, `handoff.fromSeries=series`) and only then returns `kind: 'handoff'`.
2. The successor is created in a separate `step.do('handoff')`.
3. If the platform fails the `act-N` attempt after the CAS and before its result is durable, the retry runs `act` again as series N: `admit` finds the control record at series N+1 and answers `not_owner`; the instance stops (`stopped-*`) without ever reaching `handoff`.
4. The claim is then `starting` with no instance, no failure counted and no progress. Only the hourly `ensureWorkflow` could repair it (recognising `claim + absent`), up to one cron period later and, in the incident, after the 17:00 Madrid due time.

The 16 Nov case (a successor that was created and later terminated) is a different failure boundary and is unchanged.

## Change

`act` calls `recoverOrphanClaim` when `admit` reports `not_owner`. It re-reads the control record and returns the existing `handoff` result (so the idempotent `handoff` step creates or attaches the same id) only when every predicate holds: mode `cloudflare` and epoch (already checked by `admit`), authority ready, `runKey` equal, `control.series = series+1`, `handoff.fromSeries = series`, `handoff.toSeries = series+1`, `instanceId` equal to the claimed id, `phase=starting`, not done, not quarantined, no active cooldown, `sync.json` still at the claimed run's `stage: seal`, and the Cloudflare status of the claimed id `absent`. An alive child, a terminal child, `unknown` status or any other reading keeps the former `not_owner` stop. A status that cannot be read, and a `create()` whose outcome stays unproven, are recorded by `noteCreateUncertain` (existing `create_uncertain` failure budget, cooldown, `phase` kept `starting`), so the state is visible and the hourly `ensure` takes it from there; quarantine is reached through the existing budget. The recorded `stopReason` matches the guard `ensureWorkflow` honours: `status_unknown` for an unreadable status (early cooldown guard) and `create_uncertain` for an absent child (absent guard), so repeated ensures inside `cooldownUntil` spend no further budget (review P1). The recovery runs once per replay (no loop) and never writes `sync.json`, never starts a run and never takes the step lease; the successor takes it as before.

`readModel().handoff.successorPending` is true only while the claim is `starting`, not done and the claimed instance is verified `absent`; `alive`, `unknown` and `finished` stay false and are told apart by `owner.liveness` (review P2).

## Cases covered

| Case | Result |
|---|---|
| Failpoint: claim CAS committed, `act-N` result lost, old `act-N` retried | The retry returns `handoff`; exactly one create of `epg_<day>_1` with the claimed params; the successor finishes the seal; one `/api/sync/start`, one publication. |
| Same retry after midnight | Claimed day keeps priority; the claimed id is created once. |
| `create()` succeeded, reply lost | Status read back, attached, no second create. |
| Duplicate retry plus hourly `ensure` calls | One create of the claimed id, no second series. |
| Child alive | Former `not_owner` stop, nothing created. |
| Child `terminated` / `errored` / `complete` | Former stop, nothing created by the old instance (the cron handles these as before). |
| Status unreadable | Fail closed: no create, `create_uncertain` failure with `stopReason=status_unknown` and cooldown, `successorPending` false (`liveness=unknown`); repeated ensures inside the cooldown change no budget; after the platform recovers the hourly `ensure` creates the claimed id once. |
| Predicates: `sync.json` not at `seal`, done, quarantined, cooling down, phase moved, claim for another run or series, id mismatch, epoch moved | Nothing created, former stop. |
| Create unproven, child absent | `stopReason=create_uncertain`; repeated ensures inside the cooldown answer `cooldown` and change no budget. |
| Read model | `successorPending` true only for `absent`; false for `alive`, `unknown`, `finished`. |
| Pre-change fixture (AIR-484 mixed-version test) | Unchanged. |

Cost of recovery: one extra control read, one `sync.json` read and one Workflow status read in the replayed `act-N`, then the single create of the existing `handoff` step; no extra publication or D1 ledger calls.

## Remaining risks

- The platform failure itself is not prevented; this change bounds its consequence. A second loss of the replayed result falls back to the hourly `ensure`.
- If the platform kills the old instance outright (no retry at all), recovery still waits for the hourly `ensure`.
- Whether the memory boundary is the root cause remains open.

Related: AIR-420 (publication SLA), AIR-484 (hand-off), ADR 0144 (unchanged; no new material decision).
