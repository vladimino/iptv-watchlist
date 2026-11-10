# L3 runbook (DRAFT, not executed): activating the D1 projector exclusive window

**Status:** draft prepared for [AIR-383](https://trello.com/c/Hnuf2tB0) after the owner's go-ahead to prepare Stage C of [ADR 0103](../adr/0103-projector-exclusive-window.md) on 2026-11-08. **Operation C below (migration `0018`) was run on 2026-11-08 under the owner's GO ([apply record](../evidence/d1-migration/air-383-0018-apply-2026-11-08.md)); operations A, B and D have not been, and this page authorizes nothing further.** The four operations below each need the owner's operation-specific GO, named by tool, target, value and time window, under the [authorization policy](../process/authorization-and-escalation.md). The window code is in the repository and dormant: the table of migration `0018` is applied and holds one `idle` row, and the flag `D1_ENRICHMENT_WINDOW` is off. Times are UTC unless Europe/Madrid is stated.

**Fresh state this plan starts from:** [Stage C preflight evidence](../evidence/d1-migration/air-383-stage-c-preflight-2026-11-08.md) (re-read it before any step; every value there is a dated observation). Measured and unmeasured values: [Stage B report](../evidence/d1-migration/air-383-stage-b-dry-measurement-2026-11-08.md), read together with the correction in the preflight page.

## Stop conditions (checked before every operation, read-only)

Stop, change nothing and report if any of these holds:

- the EPG executor control phase is `running`, `switching` or has a live step lease, or `sync.json` is in the `metadata` or `epg` stage: a publication is in flight;
- `discovery_transfer.state` is `loading`, or `discovery_lease` is set and live (`expires_at` in the future);
- `schema_contract.version` is not what the step expects, or the discovery authority is not `d1` / `open`, or its marker is held;
- `feature_flags` shows an invalid flag, `D1_ENRICHMENT_WRITE` not `on`, or a flag value different from the one the GO names;
- another change to `src/d1-enrichment.js`, `src/discovery*.js`, `migrations/` or `wrangler.jsonc` is open;
- a readback of the previous step is missing or does not match, or the outcome of a write is unknown (read back first, never repeat blindly);
- the owner withdraws the GO.

Read only with proven read-only sources: D1 `SELECT`s, the `feature_flags` readback, repository files. Do not call `epg_sync_step` as a probe, and do not use `epg_pipeline_status` as a probe while a fence can be held. Programme and watchlist GET are query-only of the published generation; they are still too coarse to use as a projector-window probe.

## Decision table

| | Operation | Preconditions | Risks | Verification | Rollback | Required GO |
| --- | --- | --- | --- | --- | --- | --- |
| A | EPG compatibility | The in-process executor of [ADR 0100](../adr/0100-epg-cloudflare-workflow-executor.md) is the daily publisher (mode `cloudflare`, epoch 1) and its first natural publication is accepted. The offline proof below is merged | A `projector_window` busy lasting up to 300 s during a publication; the legacy Task, if still enabled, is fenced by the server (`external_writer_fenced`) and cannot publish | The executor sleeps to the window deadline without charging its budget and finishes the same run (offline, below); one natural publication readback on a tick with no window | None needed: no operation | None for the executor route. A Task prompt edit is needed only if a return to external mode is planned (see "Task text if external mode returns") |
| B | Cron `15 * * * *` | The audit below; the executor and monitor thresholds read; a separate small pull request for `wrangler.jsonc` and the docs naming the minute | Moves every consumer of the shared hook by 15 minutes; a request made later than `:15` can still overlap the `:20` hourly Task; does not prove the absence of an overlap | Next ticks run at `:15` (the monitor tick, the ratings and EPG `ensure`, the Discovery reconcile, the projector) with no new alert | Revert the one line and deploy | Owner GO for the merge and the deploy of that pull request; nothing is done by this draft |
| C | Apply migration `0018` | Schema 17, the six prerequisite tables, `projector_window` absent, no stop condition, no EPG run in flight | An unknown outcome of the DDL; a file applied twice (it refuses a second apply by design) | Hash, then the readback below | The table is additive and inert while the flag is off: leave it. The version never goes down (trigger). Dropping the table is a separate GO | Owner GO naming the file hash, the database and the window |
| D | `D1_ENRICHMENT_WINDOW=on` | A done, C applied and read back, B decided, no stop condition, `D1_ENRICHMENT_WRITE=on`, an idle EPG executor with its next run not near | Discovery paused up to 300 s a tick; a window request that collides with a delayed EPG run; a coverage gap in the Discovery writers (the R2 evidence is a whole-bundle site inventory, a best-effort graph and two instrumented runs, not a proof for every dynamic path) | The acceptance plan below | Unset the flag: the next tick requests no window and an open window expires by its own deadline | Owner GO naming the variable, the value and the time window |

## A. EPG compatibility: what is proven offline, what is not

Proven (tests in the repository, no production call):

- every publication path that took the Discovery lease raises one typed busy for a requested or a held window and keeps the old error for any other missing lease, and each takes the lease again once the window is released (`tests/projector-window-epg.mjs`, sections 1, 2 and 8);
- the sync step answers a structured non-failure busy before any heavy work, with the window deadline plus 3 s, persists nothing on the run, and goes on to the EPG work for the same run after the release (sections 3 and 8);
- the seal answers the same busy with the phase unchanged and is not a window answer after the release (sections 4 and 8);
- the executor's wait branch reads that answer, and a run with a 300 s window answered at the EPG stage or at the seal sleeps to each deadline, starts no second run, charges no failure and publishes once (`tests/epg-orchestration.mjs`, section 7b).

Not proven: a request that arrives at the exact moment of a publication commit on production, and the executor under a real held window. Both need the window, so they belong to the acceptance of D, not to a preparation step.

### Task text if external mode returns

Only if the executor is rolled back to `external`. The contract bullet of [Production ChatGPT Scheduled Tasks](../reference/scheduled-tasks.md) "Seal `busy` (AIR-362)" waits once, for `lease_held`, up to about 93 s. A minimal replacement, to be applied to the Task prompt only after a separate owner GO and after the owner confirms that a Task run can wait about five minutes between two tool calls (not verified here):

> A `stage: seal` or `stage: epg` answer with `discovery.state=busy` and `busyKind` `lease_held` (a `nextCatchUpAt` no later than about 93 s away) or `projector_window` (a `nextCatchUpAt` no later than about 330 s away) is a bounded wait: wait until `nextCatchUpAt`, then call `epg_sync_step` once more for the same `runId` and follow the fresh answer. Wait at most three consecutive busy answers per step and at most 15 minutes in all; a further `busy`, `lost_race`, an error, a mismatch or an unknown result stops the invocation. No lease reset, no new run.

## B. Cron `15 * * * *`: audit of the consumers of the shared hook

| Consumer | Rule in the repository | Effect of `:15` |
| --- | --- | --- |
| EPG executor `ensure` | Due 17:00 Europe/Madrid (`EPG_SCHEDULE`), decided from the Madrid date; the Madrid offset is a whole hour, so an hourly UTC cron has a tick at the due time in CET and CEST | First tick after the due moves from 17:00 to 17:15 Madrid |
| Ratings `ensure` | Due 17:00 Madrid in `RATINGS_SCHEDULE` (the code constant; ADR 0090's text still says 17:30) | First tick after the due moves to 17:15 Madrid |
| Discovery reconcile | Not time-keyed; hourly fallback | 15 minutes later |
| Projector | Hourly; 60 s write budget | The tick of the day moves from 16:00 to 16:15 UTC (15:15 in summer), which falls inside an EPG run that started at the due tick |
| Monitor | Thresholds in hours: EPG delayed after 2 h, degraded after 5 h; Discovery waiting 90 min, degraded 3 h; Predictions delayed 3 h | A 15 minute shift crosses none of them; the monitor tick itself moves with the hook |
| Hourly ChatGPT Task (Predictions, `:20` Madrid, external) | Nominal, may run late | A window requested at `:15` expires at `:20` at the latest (300 s from a `:15:00` request); a later request, or a late Task, overlaps. Under `DISCOVERY_EXECUTOR=workflow` the Task runs Predictions, and a Discovery busy does not stop that |
| Documentation | The cron text and diagram of the scheduling page, ADR 0090 and ADR 0100 name the minute | Updated in the same pull request that changes the line |

`:15` lowers the likelihood of an overlap and proves nothing about a delayed or in-flight publication; it does not replace A.

## C. Migration `0018`: plan

Sequence (each with its own readback, never two operations in one GO):

1. Fresh read-only preflight: `schema_contract` is exactly one row with version 17; the six tables the file's guard counts (`discovery_authority`, `discovery_lease`, `discovery_seal`, `projection_run`, `projection_fence`, `epg_orchestration_document`) are present; `projector_window` is absent; `schema_contract_no_downgrade` is present; no stop condition; no other D1 migration in flight (no open pull request touches `migrations/`).
2. Hash gate: the SHA-256 of the file text on `main` (2,733 bytes) equals `167dcfe4f9310f4e3e2fcc50d5b2154f896a29bce908dcc7f3f5b115be663054` and the text sent to D1 hashes to the same value. A mismatch stops the step.
3. Apply: one D1 query of the exact file through the same connector used for `0013` to `0017` (the [`0017` apply record](../evidence/d1-migration/air-348-0017-apply-2026-11-08.md) is the pattern, including a refused first attempt that changed nothing).
4. Readback (`SELECT` only): `schema_contract` version 18 with the v18 note; `projector_window` exists as a `STRICT` table with the CHECK that bounds `expires_at - requested_at` to 300000; exactly one row, `id=1`, `state='idle'`, `owner` NULL, `expires_at=0`; the trigger is still present; the discovery authority, transfer, lease, projection run and the EPG control rows are unchanged.

Idempotency and unknown outcome: the file refuses a second apply (its first statement inserts a second `schema_contract` row after version 17 has passed, which aborts the file and leaves nothing behind) and creates the table without `IF NOT EXISTS`. If the response is lost or an error is returned, read the readback items first. Version 18 with the table and one idle row is done. Version 17 with the table absent is not applied (a fresh preflight may repeat the apply under the same GO). Any other combination is stopped, reported, and repaired only by a forward fix under its own GO; never repeat the DDL blindly.

## D. The flag: bounded natural acceptance and stop plan

Order: after C is read back, set the Worker variable `D1_ENRICHMENT_WINDOW=on` (owner action, one GO), read it back with `feature_flags`, then observe the normal hourly ticks only, with D1 `SELECT`s of `projection_run` and `projector_window` and no manual run.

For each tick record, without payload: `window.outcome` (`granted`, `window_busy`, `not_granted`, `lost`, `too_late`), `waitMs`, `heldMs`, `generationAtGrant` against `generationAtFirstBatch` (equal for a fenced run), `writtenPeople`, `writtenFilms`, `remaining`, the deferred reason, `leaseLost`, the age of the last write, and afterwards the discovery generation moving again. Since AIR-392 also `timing` and `phases` of the run ([monitoring runbook](monitoring.md#d1-projector-run-phase-timing-air-392)).

Accepted when, over at least three consecutive ticks that fall in a busy Discovery stretch, the runs write Persons or Films with a falling or explained `remaining`, no `leaseLost`, no `window_lost`, the window is idle again after each run, and Discovery resumes within its deadline.

Stop and unset the flag if: any `leaseLost` or a write batch outside a held window; a `window_lost` or an unreleased window that outlives its deadline; two consecutive ticks with no grant that are not explained by a live writer; Discovery's generation not moving after a release; a charge on the EPG executor's failure or retry budget caused by a window; a monitor alert linked to the pause; or the owner withdraws the GO.

## Rollback, in separate steps

- Flag: unset `D1_ENRICHMENT_WINDOW` (one GO). The next tick requests no window; an open window expires by its absolute deadline. Never reset the lease to hurry it.
- Cron and Task: a revert of the cron line and any Task prompt change are their own GOs; a code rollback never reverts D1 or R2 data, the authority markers, the schedules or the table.
- Schema: the table stays; it is inert with the flag off. A drop is a separate GO.
- An unknown result of a write: stop, read back, report; no blind retry.

## R2 side effects: the proof and its limits

Three tests cover the R2 objects the projector reads, from the Discovery chunk, the Workflow loop, the admin recovery routes and the EPG publication paths:

- `tests/projector-window-r2-writes.mjs` classifies the 35 write sites of the three Discovery files and their guards;
- `tests/projector-window-r2-inventory.mjs` has two independent parts. Part 1 is a whole-bundle inventory of R2 write sites by text, with no call graph: it freezes the number of write primitives and wrapper calls per file (182 sites in 18 files at the time of writing), requires every receiver of `.put(` to be the R2 binding and every `.delete(` receiver to be the binding or a known in-memory Map or Set (an alias or a new receiver fails), and freezes the complete list of sites whose key names a projector input that is not Discovery's (15 sites, each with its owning domain; none in a Discovery file). A new writer in any file that uses these primitives, however it is reached, fails until it is classified; a mutation that adds a helper-object writer, a variable-key writer or an alias to a chunk function fails it. Part 2 is a best-effort call graph over the bundle's named functions from the chunk, admin and publication entry points; it finds the 43 writer functions on those named paths and fails on an unclassified or stale one, and it shows that the lease-free path found on them that writes a key the projector reads is the read-repair of the R2 mirrors of the D1-owned published documents (`loadJSON`, `repairMirrors`, `writeMirrors`, `putStable`), which the projector does not read under a D1 published snapshot, that each publication entry takes the Discovery lease before its first write, and that the admin functions that put the shared decisions renew the lease right before it;
- `tests/projector-window-r2-instrumented.mjs` runs the real chunk (direct `advanceDiscovery` calls) and, separately, the real Workflow loop against a recording R2 bucket with no D1 authority armed, so every key a mode could route to D1 is written to R2 and seen. Each run has its own receipt, each must write and complete its ledger, and each is classified on its own: every key is a known Discovery key and none is a non-Discovery projector input. A mutation that adds a write only to the Workflow path fails the Workflow receipt.

What these do not show: the call graph does not resolve object or class methods, aliases, callbacks or dynamic dispatch and lists no unresolved callee, so its closure is a map of the named paths and not a superset of what can run; the inventory sees only the primitives it lists and a key built at run time only as a dynamic site; the instrumented runs cover the chunk and the Workflow loop, not the admin routes or the seal; and none of it observes production. Whether the inventory and the runs are enough for activation is the owner's call.

## What this plan does not claim

The window under a busy Discovery is not yet seen; lease hold time, the wait to a grant and a run under a wait are unmeasured until D has run.
