# AIR-554: batch_v2 auxiliary state cutover, read-only preflight and proposed L3 plan

Date: 22 Nov 2026, production reads taken between 08:51 and 08:56 UTC (09:51 to 09:56 Madrid, UTC+01:00). Scope: [AIR-554](https://trello.com/c/UrS1gflv), planning only: the owner-reviewable L3 plan that [ADR 0194](../../adr/0194-prediction-auxiliary-state-d1-checkpoint-and-outbox.md) (Accepted) and the [handoff runbook](../../runbooks/prediction-aux-state-cutover.md) require. Code under review: `main` at `e5acb2a` ([AIR-553](https://trello.com/c/ouMIBO00), PR 885, dormant). **This page authorizes nothing.** No migration, import, marker flip, flag, binding, Scheduled Task, Workflow, manual batch or other write was made or is implied. Documentation impact: this file, the evidence index and the handoff runbook link.

## 1. What was read, and how (all read-only)

| Source | Call | Writes |
| --- | --- | --- |
| Production D1 `iptv`, Cloudflare D1 query connector | `SELECT` only: `schema_contract`, `sqlite_master` names, `prediction_domain_authority`, `prediction_lease`, `prediction_run` | none (`changed_db: false`, `rows_written: 0` in every reply) |
| Owner MCP, pure reads | `prediction_queue_overview`, `feature_flags` (`sideEffects: none`, `storage: not_accessed`) | none |
| Trello and GitHub | card, comments, checklist; `main` | none |

## 2. Observed production state

| Fact | Value |
| --- | --- |
| `schema_contract.version` | **33** (`letterboxd sync control plane (ADR 0186, inert)`). Migration `0034` requires exactly 33, so its guard is satisfied today |
| Tables of `0034` | **absent**: none of `prediction_aux_authority`, `prediction_batch_stage*`, `prediction_run_source_*`, `prediction_run_manifest*`, `prediction_event_outbox*` exists. The aux marker therefore does not exist yet; the deployed Worker runs the R2 aux code |
| `prediction_domain_authority` | `mode d1`, generation 36261, queue generation 3127, profile generation 0, **`writes: held`** at 08:5x UTC. The cause was not established (see finding F1) |
| `prediction_lease` | `runner`: run `17f9e1bd-44d5-4ebe-ae08-8696c8e8805d`, epoch 495, last heartbeat 08:36:35Z, `expires_at` 08:51:35Z (expired when read). `writer`: `expires_at` 0 (free) |
| `prediction_run` | 713 rows, 489 of them `batch_v2`: the upper bound of the run-bound history to import (source revision 1, manifest and stop row per run, fewer where a run left no source or manifest) |
| Queue | state `eligible`, 6,997 pending (3,505 hot, all eligible now; 3,492 cold), 0 deferred, 0 retry-exhausted; coverage 5,264 of 12,259 (42.9%); `consistent: true` |
| Flags | 3 set (`MONITOR=on`, `MONITOR_TRANSPORT=telegram`, `EPG_CHANNEL_POLICY=on`); no prediction flag exists, 22 absent |
| Entry points of the four families | Only the batch_v2 runner calls (`prediction_batch_start`, `hold`, `submit`, `complete`, `heartbeat`, manifest parts) and the `PredictionStartWorkflow` they create. Code read: `deliverPendingEvents` runs only inside an authorized start (`src/enrichment.js:3242`); `recordSkippedStart` only from the start paths (`2826`, `2907`, `3162`); the Workflow is created only from a keyed start (`3010`). **No cron tick writes these families** |

**Not read, and therefore not claimed:** the R2 inventory of the four families (counts, bytes, orphan sources, pending and quarantined outbox rows: needs the owner's read-only export credential, section 4 step P2); the Task registry (is_enabled, prompt hashes); non-terminal `iptv-prediction-start` Workflow instances; the content of the held stage; the Events backlog; the natural baseline numbers of section 6.

## 3. Findings that decide the plan

- **F1. `writes: held` on the prediction domain marker is unexplained.** It may be a transient hold taken by a writer of the prediction domain or a leftover of another operation. The cutover cannot start, and a baseline cannot be called "natural", while a hold of unknown origin is in place. Precondition P1: read it again, identify who holds it and why, and have it released or explained before any GO. This plan does not release it.
- **F2. There is no production operator for any step.** `scripts/prediction-aux-d1-import.mjs` only prints SQL and reads an offline export; it opens no database. The repository holds no owner-only operator for the `0034` apply with inventory preflight, the guarded import with verify, the activation (marker flip) and the post-flip proof. The AIR-551 and AIR-571 cutovers used one (a read-only `status` default, a `--confirm` token per command, a readback after each write). Building it is code and tests: one reviewed dormant PR after the owner accepts this plan (decision D2). Nothing runs against production before it is merged and reviewed.
- **F3. The import is one non-resumable batch and its size is unmeasured.** `sql` prints ONE guarded file whose first statement refuses non-empty tables and whose history tables refuse update and delete: a partial apply cannot be resumed or undone by SQL. A 489-run history carries 489 manifests (the 21 Nov `:30` manifest was 39,372 bytes) plus sources and pieces; every statement is held to 100 KiB, so the file is thousands of statements. Whether D1 takes it as one atomic batch, or it must be chunked (an importer change, because the fence would then need a resumable form), is decided by a real-export rehearsal on a **scratch** D1 (as AIR-551's H-0a did), not assumed (decision D3).
- **F4. A code rollback after the flip is a split-authority hazard.** The R2 aux objects are a frozen copy; the marker refuses `d1`→`r2`. But a Worker version older than `e5acb2a` knows nothing about the marker and would write the R2 aux objects again while the marker says `d1`. The rollback procedure ([Worker rollback](../../runbooks/recovery/cloudflare-worker-rollback.md)) must name `e5acb2a` as the floor after the flip, before holdpoint H5 is approved.
- **F5. Applying `0034` outside a closed window has a partial-table exposure.** With `PREDICTION_DB_REQUIRED=on`, a partial table set reads `prediction_aux_unavailable` (HTTP 502 on the runner routes), never `r2`. If the one-batch apply were interrupted midway, running Tasks would see 502. Applying it inside the closed window (step H2) removes that exposure.
- **F6. The four Tasks fire at `:00/:15/:30/:45`, so there is no natural gap.** A quiet window must be created by owner action on the Tasks (section 5), and must stay clear of the daily EPG publication at 17:00 Madrid and its Discovery catch-up.

## 4. Proposed L3 plan (a table of holdpoints; nothing here is approved)

Each row needs its own explicit owner GO and is not started until the previous one is read back. P rows are not production writes.

| # | Holdpoint | Actor and exact action | Readback and receipt | Stop condition | Rollback |
| --- | --- | --- | --- | --- | --- |
| P1 | **Hold and lease state** | L0: read `prediction_domain_authority.writes`, both leases, the Task registry and non-terminal `iptv-prediction-start` instances. Identify the holder of `held` (F1) | one dated read of each; the holder named | `held` unexplained; a live runner lease at the time of the GO | none (read) |
| P2 | **Offline inventory** | Owner-run read-only R2 export of the four families with the existing [snapshot export](../../runbooks/r2-snapshot-export.md) (GET/HEAD only, fenced opening and closing listing). Then `report`, `digest`, `preflight` of `prediction-aux-d1-import.mjs`. The `preflight` SELECTs run against D1 read-only | counts, bytes, per-state outbox counts, digests, orphan source ids classified as history or blocker | a `report` blocker (exit 2); an unreadable pending index; any statement over 100 KiB; an orphan classified as a blocker | none (read) |
| P3 | **Scratch rehearsal** | On a scratch D1 (never `iptv`): apply `0034`, the real `sql` file, `verify`, then the paused-R2-write scenario of step H4 against the real Worker code. Measure the import's size, batch behavior and time (F3) | statement count, bytes, duration, `verify` pass; decision D3 settled | a `verify` difference; the file does not fit one batch and chunking is not implemented | none (scratch) |
| P4 | **Baseline** | L0: capture the natural baseline of section 6 from `prediction_step_timing` and the run rows, from the end of the AIR-560 rollback (21 Nov) until the close at H1 | sample sizes and the confounder list recorded in a dated evidence file | fewer natural runs than the sample the owner fixes (D4); a configuration change inside the window | none (read) |
| H0 | **Operator and plan accepted** | The reviewed operator (F2), the runbook/rollback floor (F4) and this plan are merged; owner gives the cutover GO with a date and time | merged PR, exact `main` SHA, owner GO | any of P1-P4 open | not applicable |
| H1 | **Close admission** | Owner action: disable the four Tasks `IPTV Predictions v2 00/15/30/45` in the registry (the only callers; section 2). No new control plane. Then wait until the runner lease is expired or released, no `iptv-prediction-start` instance is non-terminal, and one further full lease period (`RUNNER_LEASE_TTL`, 15 min) has passed so no lease-free request admitted earlier can still be running. Two R2 listings of the four families five minutes apart must be identical, and the same Etag set must be the one exported in P2 or re-exported | the registry readback (`is_enabled` false on all four), the lease and Workflow readbacks, the two identical listings with time | a live lease or a non-terminal instance past the wait; any object whose Etag or `LastModified` changed after the close | re-enable the Tasks (owner action); nothing else was written |
| H2 | **Schema 0034** | Owner-run operator: `status`, then `apply --confirm` of `migrations/0034_prediction_aux_authority.sql` as one batch, inside the closed window (F5) | `schema_contract.version` 34; the table, index and trigger inventory of the file; marker `r2`, generation 0; every other authority marker table digest unchanged; a Time Travel bookmark before the batch is recorded | a refused guard; any readback difference; a marker table digest change (as the 0033 apply showed, a live counter may move: classify, never retry blindly) | the tables are additive and inert; a schema apply is not reverted, it stays dormant. A restore is the owner's [Time Travel recovery](../../runbooks/recovery/d1-authority-and-time-travel.md) |
| H3 | **Fenced import and verification** | Operator: apply `aux-import.sql` (the first statement asserts marker `r2`, generation 0 and empty tables), then `aux-verify.sql`, then the `report` digests against the rows read through the Worker's own readers (stage, source head and pieces, manifest parts, outbox status), then the orphan classification of P2 | `verify` passes with zero difference and zero extra row; counts and digests equal the P2 export; pending and quarantined outbox rows all present with their attempts and `since`; reader parity (`source_without_run` classified) | any difference; a row the Worker's reader refuses and that is not a classified orphan | none by SQL (history tables refuse update/delete); restore to the H2 bookmark is an owner operation. The marker is still `r2`, so the Worker ignores the imported rows meanwhile |
| H4 | **Paused-write test, then flip** | Before the flip: the rehearsal of P3 already proved a write started before the close and completed after the flip neither changes the imported state nor is acknowledged as delivered. At the holdpoint the operator re-reads the closing R2 listing (unchanged since H1), then writes `mode='d1'`, `activated_at`, `generation+1` in one guarded batch | marker `d1`, generation 1, `activated_at` set; the third identical R2 listing; a Worker read of stage, manifest part and outbox status served from D1 only | the R2 listing changed after H1; a flip refused by its guard | none by SQL: the marker is one-way (`d1`→`r2` and deleting the row are refused); recovery is the owner's database restore, and F4 forbids a code rollback below `e5acb2a` |
| H5 | **Reopen admission** | Owner re-enables the four Tasks. Nothing is run by hand. The first natural start is watched read-only | registry readback; the first natural runs complete with a durable manifest, source head, stage and outbox rows; the R2 aux prefixes receive no new object (a fourth listing); no `prediction_aux_unavailable`, no `manifest_unavailable` | any new R2 aux object; any 502 of the runner routes; a lease or outbox error | re-closing admission (disable Tasks) stops new starts; data stay in D1 (one-way). Optimization or an owner decision on alternative B of the ADR follows a material finding; a TTL increase is not a remedy |
| H6 | **Retirement PR** | After H5 and a stable period the owner names: a separate reviewed PR deletes the legacy R2 aux branches (stage, sources, manifest, event records, outbox) and updates docs; merge, post-merge CI/deploy. The Events journal, assessment sidecars, deferred-start receipts and prediction bodies stay R2 (ADR 0194 decisions 8 and 9) | PR evidence, CI on exact HEAD, deploy success; the read-side-effect baseline test | a test or CI red; a path that still reads the frozen R2 aux objects | code revert; D1 data and the marker stay |
| H7 | **Performance acceptance** | L0 only: compare natural runs of the same Tasks, prompt, model and batch configuration with the P4 baseline (section 6). No new Task, no batch-size or prompt change, no manual model or Workflow run, no TTL change | dated evidence file with sample sizes, p50/p95, confounders and the verdict | a material, confirmed regression: optimization or architecture review with the owner before final acceptance | not applicable |

No two cutovers share the window: H1 to H5 do not overlap the 17:00 Madrid EPG publication with its Discovery catch-up, an EPG checkpoint step, a Ratings or Letterboxd operation, or any other authority change. The window length is about the wait of H1 (at least 15 minutes after the last lease) plus the apply, import and verification times measured in P3. Total window is expected to be well under two hours; this is an estimate until P3.

### What "close admission" means here, and its limits

The proposal is deliberately the shortest one that needs no new code or control plane: the old authority has exactly one family of callers (section 2), so closing admission means silencing that caller and proving the silence from the stores, not trusting a marker pre-read (ADR 0194 decision 1). It covers the runner, the deferred Workflow instances (created only by a start), lease-free skipped events, delivery and acknowledgement (all inside a start), and a request that read `r2` earlier (it completes within the extra lease period or is visible as a changed R2 listing). Its limits, stated plainly: it relies on the owner not calling these tools by hand during the window; disabling a Scheduled Task may not stop an instance that is already running, which is why the lease and Workflow readbacks and the extra period are conditions rather than courtesy; and an unknown outcome is read from the stores before anything is retried.

A code-level alternative (a short-lived admission gate in the Worker, deployed before the window) is possible but is new runtime surface to review and to remove afterwards; it is listed in D5 and not recommended unless the owner wants proof that does not depend on Task state.

## 5. The window and the Tasks

The four Tasks are external ChatGPT Scheduled Tasks. Disabling and re-enabling them (H1, H5) is an **owner-operation-specific authorization** under [authorization](../../process/authorization-and-escalation.md#chatgpt-scheduled-task-authorization): this plan only proposes it, creates no Task and changes none. The registry is read-only for the agent unless the owner explicitly authorizes the exact operation.

## 6. Baseline and acceptance metrics (AIR-554 performance acceptance)

Same configuration before and after (prompt, model, batch size, claim TTL 180 s unchanged). Cohorts kept separate: natural normal runs, incident, EPG-priority or catalog-hold, recovery, deferred or synchronous start. Reported with sample counts, comparability and confounders; offline timings are never production proof.

| Metric | Source |
| --- | --- |
| Receipt latency; deferred accept-to-ready and its stage breakdown (persist above all) and headroom against the 180 s claim TTL | `prediction_step_timing` and the AIR-553 instrumentation |
| Manifest part readback; hold, submit, complete; event delivery latency | `prediction_step_timing` |
| R2 operations and D1 calls, batches, rows read and written, bytes per cycle | the AIR-553 instrumentation; Cloudflare analytics for the D1 and R2 totals |
| Estimated storage cost per successful prediction | derived from the counts above and the published unit prices at the capture date |
| Successful films per hour; share completed, interrupted, skipped | run rows and the Events journal |

The recommended minimum sample (D4) is 48 hours of natural runs before the close, which is about 190 batch starts across the four Tasks; the owner may set another one. A material confirmed regression blocks final acceptance and is optimized or taken back to the owner; the claim TTL is not increased to hide it.

## 7. Decisions the owner is asked for

- **D1 (readiness).** Is the hold of F1 acceptable to leave until P1, or must it be explained first? Recommendation: explain first.
- **D2 (operator).** Approve one dormant, reviewed PR building the owner-only operator of H2 to H5 on the AIR-551 pattern (read-only `status` default, `--confirm`, readback, `write_uncertain` rule). Recommendation: yes, before any GO.
- **D3 (import size).** Approve the scratch-D1 rehearsal P3 on the real export, and, only if the file does not fit one batch, a resumable chunked import (importer and fence change, with its own tests). Recommendation: rehearse first.
- **D4 (baseline).** Fix the minimum natural sample and the cohorts. Recommendation: 48 hours, as in section 6.
- **D5 (admission).** Accept Task-silence plus store proof as the admission closure, or ask for a Worker-side gate. Recommendation: Task-silence plus proof, because the callers are the four Tasks and the proof does not depend on their state.
- **D6 (rollback floor).** Record `e5acb2a` as the Worker version floor after H4 in the rollback runbook (F4). Recommendation: yes, in the operator PR.

## 8. GO / no-GO

**No-GO for every production operation today.** Reasons: the hold of F1 is unexplained; no operator exists (F2); the import's size and batching are unmeasured (F3); the R2 inventory and the natural baseline are not yet taken; the Task close needs its own owner authorization. Nothing here is a regression of the current production state: the dormant code is deployed and the marker does not exist, so the Worker runs the R2 aux path exactly as before.

## 9. Uncertainty

Reads were single point-in-time observations at about 08:51 to 08:56 UTC; the runner lease and the queue move every minute, and the lease read had just expired. The 489 `batch_v2` rows are a ceiling for run-bound history, not the count of sources or manifests. The entry-point statement is a code reading of `main` at `e5acb2a` and names the lines read; a later change to those paths would void it. The window length is an estimate until the rehearsal. No R2 object and no Task registry was read.
