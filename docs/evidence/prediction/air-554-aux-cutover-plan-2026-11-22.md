# AIR-554: batch_v2 auxiliary state cutover, read-only preflight and proposed L3 plan

Date: 22 Nov 2026, production reads taken between 08:51 and 08:56 UTC (09:51 to 09:56 Madrid, UTC+01:00). Scope: [AIR-554](https://trello.com/c/UrS1gflv), planning only: the owner-reviewable L3 plan that [ADR 0194](../../adr/0194-prediction-auxiliary-state-d1-checkpoint-and-outbox.md) (Accepted) and the [handoff runbook](../../runbooks/prediction-aux-state-cutover.md) require. Code under review: `main` at `e5acb2a` ([AIR-553](https://trello.com/c/ouMIBO00), PR 885, dormant). **This page authorizes nothing.** No migration, import, marker flip, flag, binding, Scheduled Task, Workflow, manual batch or other write was made or is implied. Documentation impact: this file, the evidence index and the handoff runbook link.

**Revision of 22 Nov 2026 (after the [independent review](https://github.com/vladimino/iptv-watchlist/pull/889#pullrequestreview-6011421777) of HEAD `04d0b2c`).** Finding F1 (`writes: held` as a blocker) is withdrawn. Two real gaps are now findings: the private exporter output cannot feed the importer (F2) and Task silence plus listings is not an admission boundary (F5). The approvals are collapsed to one bounded L3 decision with a separate flip release, the digest rule no longer treats generation drift as a stop, and the natural performance acceptance of the D1 branch now comes before the retirement PR. The plan stays No-GO.

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
| `prediction_domain_authority` | `mode d1`, generation 36261, queue generation 3127, profile generation 0, `writes: held`. This is the **normal D1-active state**: [ADR 0162](../../adr/0162-d1-only-authority-retire-rollback-toolchain.md) decision 1 says `writes` was the import fence of the retired `r2` mode and `activatePredictionDomain` leaves it `held`. It is not a live writer hold, and nothing here releases it. The live fences are the lease rows below |
| `prediction_lease` | `runner`: run `17f9e1bd-44d5-4ebe-ae08-8696c8e8805d`, epoch 495, last heartbeat 08:36:35Z, `expires_at` 08:51:35Z (expired when read). `writer`: `expires_at` 0 (free) |
| `prediction_run` | 713 rows, 489 of them `batch_v2`: the upper bound of the run-bound history to import (source revision 1, manifest and stop row per run, fewer where a run left no source or manifest) |
| Queue | state `eligible`, 6,997 pending (3,505 hot, all eligible now; 3,492 cold), 0 deferred, 0 retry-exhausted; coverage 5,264 of 12,259 (42.9%); `consistent: true` |
| Flags | 3 set (`MONITOR=on`, `MONITOR_TRANSPORT=telegram`, `EPG_CHANNEL_POLICY=on`); no prediction flag exists, 22 absent |
| Entry points of the four families | Only the batch_v2 runner calls (`prediction_batch_start`, `hold`, `submit`, `complete`, `heartbeat`, manifest parts) and the `PredictionStartWorkflow` they create. Code read: `deliverPendingEvents` runs only inside an authorized start (`src/enrichment.js:3242`); `recordSkippedStart` only from the start paths (`2826`, `2907`, `3162`); the Workflow is created only from a keyed start (`3010`). **No cron tick writes these families** |

**Not read, and therefore not claimed:** the R2 inventory of the four families (counts, bytes, orphan sources, pending and quarantined outbox rows: needs the owner's read-only export credential, section 4 step A3); the Task registry (is_enabled, prompt hashes); non-terminal `iptv-prediction-start` Workflow instances; the content of the held stage; the Events backlog; the natural baseline numbers of section 6 (step A5).

## 3. Findings that decide the plan

- **F1. There is no production operator for any step.** `scripts/prediction-aux-d1-import.mjs` only prints SQL from an offline export; it opens no database. The repository holds no owner-only operator for the `0034` apply, the guarded import with verify, the activation and the post-flip proof. AIR-551 and AIR-571 used one (read-only `status` default, a `--confirm` token per write, a readback after each write). Building it is code and tests: one reviewed dormant PR after the owner accepts this plan (D2).
- **F2. The private exporter cannot feed the importer, and there is no scoped export.** `scripts/r2-snapshot-export.mjs` snapshots the **whole bucket** into `objects/<sha256-of-key>.bin` plus `manifest.json` (entries with `key`, `file`, `size`, `sha256`, `metadata.etag`); it has no prefix filter. `readExport()` in the importer accepts only a directory that mirrors the original R2 keys as `.json` files, or one JSON map of key to document. No bridge exists and nothing shows the exporter's output passing `report`, `sql` and `verify`. Needed before any rehearsal: a small tested converter that consumes a **verified** `consistent_fenced` manifest (`verifySnapshot`), keeps key, ETag and bytes, writes a key-mirrored tree **outside the repository** for exactly the four families and the pending-index objects, and refuses any other status; plus an offline demonstration on synthetic objects through `report`, `sql`, `verify` and `preflight`. Private R2 bodies are never uploaded to GitHub, logs or an artifact; the evidence file carries counts, sizes and digests only. Alternative: change the importer's input contract to read the manifest directly. Recommendation: the converter, because the importer's contract and its tests stay unchanged (D3).
- **F3. The import is one non-resumable batch and its size is unmeasured.** `sql` prints ONE guarded file whose first statement refuses non-empty tables and whose history tables refuse update and delete: a partial apply cannot be resumed or undone by SQL. A history of up to 489 `batch_v2` runs carries up to 489 manifests (the 21 Nov `:30` manifest was 39,372 bytes) plus sources and pieces, each statement held to 100 KiB, so the file is thousands of statements. Whether D1 takes it as one atomic batch, or it must be chunked (an importer and fence change), is decided by a rehearsal on a **scratch** D1 over the real export, not assumed (D3).
- **F4. A code rollback after the flip is a split-authority hazard.** The R2 aux objects become a frozen copy and the marker refuses `d1`→`r2`; but a Worker version older than `e5acb2a` knows nothing of the marker and would write the R2 aux objects again. The [Worker rollback runbook](../../runbooks/recovery/cloudflare-worker-rollback.md) must name `e5acb2a` as the floor after the flip before the flip is released.
- **F5. Task silence plus matching listings is not an admission boundary.** Disabling the four Tasks does not stop a manual MCP or HTTP call, and two identical R2 listings prove the past, not that no write will land later. ADR 0194 decision 1 asks for the boundary that refuses **every** new old-authority request, including the lease-free skipped, delivery and acknowledgement paths, and detects or drains the ones already admitted. Section 5 states what that boundary can and cannot prove.
- **F6. `0034` is atomic, so it needs no closed window by itself.** The apply is one D1 batch (as `0033` was), so a partial table set is not reachable by an interrupted file. It can be applied before the window with its own readback, without taking the Tasks offline. Withdrawn: the earlier claim that the apply must sit inside the closed window.
- **F7. Digest checks must compare invariants, not whole marker tables.** The `0033` apply ended `write_uncertain` because a live counter in `discovery_authority` moved. Readbacks here compare only the mode, cutover and invariant fields of the markers this plan touches or depends on (aux marker and its tables; `prediction_domain_authority.mode`; the published EPG, Film/Person and Discovery `mode`/`cutover`), and **classify** an observed generation or counter drift instead of treating it as an uncertain write.

## 4. Proposed L3 plan: one bounded decision (nothing here is approved)

**Phase A (preparation) needs no owner approval beyond the credential for the R2 export.** Reads, the converter, the offline demonstration, the scratch rehearsal and the baseline capture are L0/L1 and scratch work. **Phase B is one explicit owner authorization** for the exact, ordered sequence below, with the Task disable and re-enable named, abort rules per step, and **one separate release before the irreversible flip** (H4). No per-row re-approval of an already authorized step.

### Phase A: preparation (read-only, scratch, or a reviewed PR)

| # | Step | Result needed | Stop |
| --- | --- | --- | --- |
| A1 | Read the leases (`runner`, `writer`), the Task registry and non-terminal `iptv-prediction-start` instances; confirm `prediction_domain_authority.mode=d1` | dated reads; no live runner lease at the start of Phase B | a live lease at the GO |
| A2 | Operator PR (F1), converter PR (F2) and the rollback floor (F4), reviewed and merged | merged, CI green on exact HEAD | review not clean |
| A3 | Scoped export with the existing [snapshot export](../../runbooks/r2-snapshot-export.md) (GET/HEAD only, fenced), converter, then `report`, `digest`, `preflight` | counts, bytes, per-state outbox counts, digests, orphan ids classified as history or blocker | a `report` blocker (exit 2); an unreadable pending index; a statement over 100 KiB |
| A4 | Scratch D1 rehearsal over the real export: `0034`, `sql`, `verify`, and the paused-write test of section 5 against the real Worker code | statement count, bytes, duration (F3); `verify` zero difference; the exclusion test passes | a difference; the file does not fit one batch and chunking is not built |
| A5 | Natural baseline of section 6, captured from the end of the AIR-560 rollback (21 Nov) | sample sizes, cohorts and confounders in a dated evidence file | a configuration change inside the window |

### Phase B: the single authorized sequence

| # | Step | Actor and action | Readback | Abort | Rollback |
| --- | --- | --- | --- | --- | --- |
| B1 | **Schema 0034** | operator `status`, then `apply --confirm` as one D1 batch, before the window | version 34; the file's table, index and trigger inventory; marker `r2`, generation 0 (F7: invariants only); Time Travel bookmark recorded | a refused guard; an invariant difference | additive and inert; stays dormant |
| B2 | **Close admission** | owner disables `IPTV Predictions v2 00/15/30/45`; the operator sets the closed state of section 5 | registry readback; closed state read by the Worker; every aux route answers the closed refusal; no live lease; no non-terminal instance; drain wait elapsed | a live lease or instance past the wait; any R2 aux object whose Etag or time changed after the close | owner re-enables the Tasks; reopen the closed state; nothing else written |
| B3 | **Fenced import and verify** | operator applies `aux-import.sql` (first statement asserts marker `r2`/closed-compatible state, generation 0, empty tables), then `aux-verify.sql`, then reads rows through the Worker's own readers, then the orphan classification | `verify` zero difference and zero extra row; digests equal A3; pending and quarantined rows present with attempts and `since`; reader parity | any difference or unclassified orphan | none by SQL (history tables refuse update/delete); restore to the B1 bookmark is an owner operation; marker still not `d1`, so the Worker ignores the rows |
| B4 | **Flip release (separate owner release)** | the owner releases the flip after reading B2 and B3. The operator re-reads the R2 aux listing (stable since B2), then writes `d1`, `activated_at`, `generation+1` in one guarded batch | marker `d1`, generation 1; stage, manifest part and outbox status served from D1 only | the listing changed since B2; the guard refuses | none by SQL (one-way marker). Recovery is an owner database restore. F4 forbids a code rollback below `e5acb2a` |
| B5 | **Reopen admission** | owner re-enables the four Tasks; nothing is run by hand | registry readback; first natural runs finish with a durable manifest, source head, stage and outbox rows; no new object in the R2 aux prefixes; no `prediction_aux_unavailable` or `manifest_unavailable` | any new R2 aux object; any 502 of the runner routes; a lease or outbox error | re-close admission (disable Tasks); data stay in D1 |

### After the window (separate steps, not part of the Phase B authorization)

| # | Step | Gate |
| --- | --- | --- |
| C1 | **Natural performance and functional acceptance of the D1 branch** (section 6), **before** any code deletion. Healthy cohorts first; incident, EPG-priority, catalog-hold and recovery cohorts separate | owner-approved criteria applied to the cohorts that actually occur; a material confirmed regression is optimized or taken back to the owner |
| C2 | **Retirement PR** deleting the legacy R2 aux branches (stage, sources, manifest, event records, outbox) and updating docs; merge, post-merge CI/deploy. The Events journal, assessment sidecars, deferred-start receipts and prediction bodies stay R2 | only after C1 is accepted; CI on exact HEAD; the read-side-effect baseline test |

No window overlaps the 17:00 Madrid EPG publication with its Discovery catch-up, an EPG checkpoint step, a Ratings or Letterboxd operation, or another authority change. Window length is the drain wait plus the import and verify times measured in A4; an estimate until then.

## 5. The admission boundary (F5): what it must prove, the proposal, and its limits

**Requirement (ADR 0194 decision 1).** Before the flip: no new old-authority request is admitted, in-flight ones are drained or shown unable to land, and a paused R2 write across the handover neither changes the imported state nor is acknowledged as delivered. A marker pre-read is not a cross-store fence and D1 cannot fence an R2 object.

**What the facts already give.** After the flip every acknowledgement and delivered state lives in D1 (`prediction_event_outbox`), so a late R2 PUT from an old request **cannot** mark anything delivered; it can only land in the frozen R2 copy that no reader consults, and the lost effect (for example a skipped or stop event record) is detectable by comparing the R2 aux listing after the flip with the one at the close. The harm to prevent is therefore a late write that the import missed, not a wrong acknowledgement.

**Proposal (recommended; needs an owner decision and an ADR 0194 amendment, D5).** A third marker state `closed` between `r2` and `d1` in the still-unapplied `0034` file (`r2`→`closed`→`d1`, `closed`→`r2` allowed as the reopen, `d1` one-way as today). While `closed`, the R2-path aux writers and every aux-dependent runner route refuse with a typed `prediction_aux_closed` before any R2 PUT, for **all** callers, the Tasks and manual MCP or HTTP calls alike, including the lease-free skipped, delivery and acknowledgement paths; reads and status keep working. This replaces "the Tasks are silent" by "the Worker refuses", with the Tasks disabled as a second, independent layer. It is new runtime surface, reviewed and tested before use, and removed with the legacy R2 branches in C2.

**What the boundary cannot prove, stated plainly.** A request that read `r2` before the close and sits between its marker read and its R2 PUT is invisible to every store. It is bounded by a drain wait, not eliminated. The wait is the platform's ceiling for such a request and is to be read from the Cloudflare limits documentation in A4, not assumed; the lease expiry (15 minutes) bounds only lease holders. The flip is then refused unless: the closed state was read by the Worker after the wait; no live lease and no non-terminal Workflow instance; the R2 aux listing at the flip equals the one at the close; and the same listing is taken again after the flip. A late object found later is a stop and is reconciled by an owner-reviewed supplemental import (the importer refuses non-empty tables today, so a delta mode is part of the operator PR scope, or the case is declared out of scope by the owner).

**Scratch test (A4) checks the actual exclusion**, not only that a delayed write can land: (1) after `closed`, a new request and a new Workflow step on every aux path (including skipped, delivery, acknowledgement) are refused before any PUT, and the fake R2 records zero writes; (2) a request paused after its marker read and resumed after the close lands its PUT, the listing comparison detects it, and the flip is refused; (3) after the flip a paused old write changes no D1 row and cannot set `delivered`; (4) the Worker with the closed state reads the same rows the importer wrote.

**Alternative (not recommended).** Blocking `/mcp` at the Cloudflare Access policy for the window excludes manual callers at the edge without code, but it is an Access change (L3), it does not drain in-flight requests, and it must never weaken Access; the Worker-side state has better evidence and no Access change.

## 6. Baseline and acceptance metrics (AIR-554 performance acceptance)

Same configuration before and after (prompt, model, batch size, claim TTL 180 s unchanged). Cohorts kept separate: natural normal runs, incident, EPG-priority or catalog-hold, recovery, deferred or synchronous start. Reported with sample counts, comparability and confounders; offline timings are never production proof.

| Metric | Source |
| --- | --- |
| Receipt latency; deferred accept-to-ready and its stage breakdown (persist above all) and headroom against the 180 s claim TTL | `prediction_step_timing` and the AIR-553 instrumentation |
| Manifest part readback; hold, submit, complete; event delivery latency | `prediction_step_timing` |
| R2 operations and D1 calls, batches, rows read and written, bytes per cycle | the AIR-553 instrumentation; Cloudflare analytics for the D1 and R2 totals |
| Estimated storage cost per successful prediction | derived from the counts above and the published unit prices at the capture date |
| Successful films per hour; share completed, interrupted, skipped | run rows and the Events journal |

There is **no fixed calendar threshold**. The sample is what the owner approves once the normal and incident cohorts are known; a first suggestion is about two days of natural runs (about 190 batch starts across the four Tasks) as a starting sample, not a gate. A material confirmed regression blocks final acceptance and is optimized or taken back to the owner; the claim TTL is not increased to hide it.

## 7. Decisions the owner is asked for

- **D1 (one bounded decision).** Approve Phase B as one authorization (sequence, abort rules, exact Task disable and re-enable) with the flip released separately at B4, once Phase A is complete. Recommendation: yes, after A2 to A5.
- **D2 (operator).** Approve one dormant, reviewed PR building the owner-only operator for B1 to B5 on the AIR-551 pattern, comparing invariants only (F7). Recommendation: yes.
- **D3 (export bridge and import size).** Approve the scoped converter of F2 (recommended over changing the importer input) and the scratch rehearsal of A4, and, only if the file does not fit one batch, a resumable chunked import with its own tests.
- **D4 (acceptance criteria).** Set the performance criteria and sample after the cohorts are visible (section 6), not a fixed 48 hours.
- **D5 (admission boundary).** Choose the Worker-side `closed` state (recommended) with an ADR 0194 amendment, the Access block, or another proof that meets the paused-write invariant; and whether a late-landing object is reconciled by a delta import or declared out of scope.
- **D6 (rollback floor).** Record `e5acb2a` as the Worker version floor after the flip in the rollback runbook. Recommendation: yes, in the operator PR.

## 8. GO / no-GO

**No-GO for every production operation today.** Reasons: no operator (F1); no executable export-to-import path (F2); the import's size and batching are unmeasured (F3); the admission boundary is not yet proven (F5, D5); the R2 inventory and the natural baseline are not yet taken. The current state is unchanged: the dormant code is deployed, the marker does not exist and the Worker runs the R2 aux path as before.

## 9. Uncertainty

Reads were single point-in-time observations at about 08:51 to 08:56 UTC; the runner lease and the queue move every minute, and the lease read had just expired. The 489 `batch_v2` rows are a ceiling for run-bound history, not a count of sources or manifests. The entry-point statement is a code reading of `main` at `e5acb2a` and names the lines read. The exporter and importer contracts in F2 are read from `scripts/r2-snapshot-export.mjs` and `scripts/prediction-aux-d1-import.mjs` at that commit. The drain wait bound is not measured. No R2 object and no Task registry was read.
