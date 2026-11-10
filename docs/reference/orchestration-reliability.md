# Orchestration reliability contract for Cloudflare-executed pipelines

This is the field-level contract that every Cloudflare executor for EPG publication, Discovery and Ratings must implement. The decision and its rationale are [ADR 0089](../adr/0089-shared-orchestration-reliability-contract.md) (Accepted; not activated). The target topology and lifecycle are drawn in [scheduling and orchestration](../architecture/scheduling-and-orchestration.md#proposed-cloudflare-executors-and-shared-recovery).

**Implementation status (2026-11-08).** This page is the field-level target contract; each domain implements the part its own ADR sets out, and no domain is claimed to implement every field. **Ratings** runs on the Cloudflare executor of [ADR 0090](../adr/0090-ratings-cloudflare-workflow-executor.md) (mode `cloudflare`, switched by the owner; the external Task is disabled). **Discovery** runs on the Cloudflare Discovery Workflow ([ADR 0083](../adr/0083-inert-discovery-workflow.md), [ADR 0093](../adr/0093-discovery-workflow-cron-reconcile.md), `DISCOVERY_EXECUTOR=workflow`), which implements an earlier subset (capped recovery, quarantine, rollover, owner record, cron reconcile, intent reconstruction) and recovers a recognised transient step failure inside the instance (arm once, durable sleep until `dueAt`, successor through `ensureDiscoveryWorkflow`, [ADR 0098](../adr/0098-discovery-workflow-step-failure-recovery.md), Accepted); the hourly reconcile stays the fallback for a platform kill and a failing arm. **EPG** is still driven by the external ChatGPT Scheduled Task ([contract](scheduled-tasks.md)): its Cloudflare executor ([ADR 0100](../adr/0100-epg-cloudflare-workflow-executor.md), Accepted, AIR-348) is deployed and its table (migration `0017`) is applied and empty, but it is **not switched**: its mode is `external` and no instance exists. **Predictions** stay on ChatGPT and are outside this contract. This page authorizes no operation.

## Shared vocabulary

### Failure classes

| Class | Typical codes | Executor action | Budget effect |
| --- | --- | --- | --- |
| `transient` | `network_error`, `timeout`, `rate_limited` (HTTP 429), `upstream_blocked` (Letterboxd 403 `cf-mitigated`; no in-run retry), `upstream_5xx`, `exceeded_memory`, `exceeded_cpu`, `worker_1102`, `wakeup_lost`, `instance_terminated`, `instance_errored`, `create_uncertain`, `owner_unknown`, `d1_unavailable` (D1 read or write failed or the authority is unreadable), `step_failed` (a Workflow action threw before classification) | Read back, then retry after cooldown | `consecutive` and `total` +1 |
| `permanent` | `credentials_missing`, `credentials_rejected`, `contract_unsupported`, `config_invalid` | Stop; re-check the precondition cheaply on each due wakeup; resume when it holds | Not counted; health `failed_permanent` |
| `unsafe` | `evidence_unreadable`, `evidence_contradictory`, `checkpoint_malformed`, `lease_malformed`, `stale_generation_write`, `owner_conflict`, `epoch_mismatch` (a commit from a stale epoch or mode is refused), `authority_held`, `authority_loading` | Quarantine the domain immediately; no retry | Quarantine reason is the code |

**The EPG step guard (AIR-348).** The guard that every EPG mutation boundary calls (`assertStep`) refuses the mutation in two different ways. A mode revision that moved, a lease that was taken over, released or expired is `epg_step_fenced` and is the stale-epoch stop (`epoch_mismatch`). A D1 read of the mode revision and the lease that fails is `epg_step_unreadable`: the mutation is still refused (fail closed), but it is the transient `d1_unavailable`, so the executor cools down and retries inside the instance instead of stopping it. On 2026-11-08 the first natural run was stopped after 61 steps by a D1 read failure that the guard had reported as a fence, with no epoch change ([evidence](../evidence/orchestration/epg-first-natural-run-air-348-2026-11-08.md)).

Not failures: `stale_generation` (a newer published generation took over), `rollover` (a healthy successor instance), `backlog_empty`, `complete`, a domain pause that the upstream asked for, and a lost CAS against a live owner (`busy`).

A domain maps its own outcomes onto these codes. A code not in this table must be added here before it is used. Thrown messages are classified, never copied into a record.

### Control record

One record per domain, in that domain's authoritative store (D1 for an activated domain). Field names are logical; the storage shape is the delivery's choice.

| Field | Meaning |
| --- | --- |
| `domain` | `epg`, `discovery` or `ratings` |
| `mode` | `external` (ChatGPT Task path, executor inert), `cloudflare`, or `switching` (admission closed, draining) |
| `target`, `drain` | While `switching`: the mode being entered, and the drain state (`lease_live`, `instance_live`, `verified`) |
| `epoch` | Integer, increased by every mode change. Every executor write compares it |
| `runKey` | EPG / Ratings: Madrid date `YYYY-MM-DD`. Discovery: `programmeRunId` + series |
| `phase`, `checkpoint` | Domain phase and the last read-back checkpoint |
| `owner` | `{kind, instanceId, leaseUntil}`; one active step per domain |
| `budget` | `{consecutive, total, fingerprint, lastFailureAt}` |
| `cooldownUntil` | Earliest next attempt after a transient failure |
| `quarantine` | `{scope: run \| domain, reason, at}` or null |
| `lastDurableProgressAt` | Time of the last checkpoint that advanced (below) |
| `nextWakeAt` | The executor's own next planned wakeup, when one is set |

The `fingerprint` is the tuple class, code, phase and checkpoint. It shows whether the same fault repeats at the same point.

### Default policy

Defaults apply unless a domain row below sets a stricter value. Loosening a default needs a new ADR.

| Policy | Default |
| --- | --- |
| Cooldown after the n-th consecutive transient failure | 1 min, 5 min, 15 min, 1 h (the fifth failure quarantines instead) |
| Jitter | Multiply by a uniform factor in [0.8, 1.2]; tests inject the random source |
| Upstream `Retry-After` or domain pause | The later of that time and the cooldown |
| `consecutive` cap | 5: the fifth consecutive transient failure without durable progress quarantines the run key with `budget_exhausted` |
| `total` cap per run key | 12 transient failures |
| `budget_exhausted` scope | The run key; the next run key starts with a fresh budget |
| `unsafe` scope | The domain, until an explicit owner-approved clear |
| Reset of `consecutive` | Only on durable progress for the same run key and epoch |
| Reset of `total` | Only with a new run key |
| `ensure` cost | At most a few reads per domain per firing; at most one `create`. The EPG `ensure` also reconciles R2 compatibility mirrors of the published D1 generation (idempotent; no write when aligned, held, switching, or a step lease is live) |

With the defaults, a fault that never clears quarantines after cooldowns of about 1 h 21 min plus four attempts.

## Ownership elements per domain

| Element | EPG | Discovery | Ratings |
| --- | --- | --- | --- |
| Authority | D1 published EPG (`published_epg_authority` `d1` / `open`) | D1 discovery ledger once its marker is `d1` / `open`; executor not activated before | D1 ratings documents (`ratings_domain_authority` `d1` / `open`); removal events in R2 |
| Run key | Madrid date, logical 17:00 | Published `programmeRunId` + series | Madrid date, logical 17:00 ([ADR 0101](../adr/0101-ratings-logical-due-time-1700.md); 17:30 in ADR 0090 until then) |
| Checkpoint / receipt | Staged-step record of the run; the published pointer | Continuation checkpoint of the hop | Run record checkpoint, cursor, queue reference state |
| Lease / CAS | Executor owner on the control record; the existing publication fence | Executor owner plus the existing resolver lease and continuation CAS | The run record lease (one running run, one active step) |
| Allowed write order | Stage data, then switch the D1 pointer, then mirrors and tail | Decisions and catalogue updates, then the checkpoint | D1 documents, event by CAS, then the queue reference resolved |
| Read-after-unknown | Read the published pointer and the run record | Read the hop status, the diagnostics ring and the continuation | Read the run record, cursor and queue entry |
| Durable progress | A later stage checkpoint, or the pointer naming this run | A stored checkpoint for the same generation | A forward checkpoint with a higher authority generation, a forward cursor, or a resolved reference |
| Fenced external path (after the drain is verified) | `epg_sync_start`, `epg_sync_step` | `epg_sync_step` discovery chunk, resolve, interrupted confirm | `ratings_sync_start`, `ratings_sync_step` |

A fenced call answers `external_writer_fenced` and writes nothing. While the mode is `switching`, both paths answer `switch_in_progress` and write nothing. Read-only status tools stay available in every mode.

## Domain rules

### EPG

- Steps: metadata, watchlist, programme download and parse, scan, publication, tail. The XML is streamed in bounded steps and never held whole.
- Publication is the atomic D1 switch of `programmeRunId`. A failure before it leaves the earlier generation published. After it, reading the pointer decides: if it names this run, the run is published and only the tail remains.
- Mirror repair writes R2 compatibility mirrors only from the currently published D1 generation. A failed mirror is retried as a tail step and never unpublishes.
- At most one successful publication per Madrid date. Publication queues the Discovery intent and does not wait for Discovery.
- **Implementation (AIR-348, [ADR 0100](../adr/0100-epg-cloudflare-workflow-executor.md), inert).** `EpgOrchestration` (`src/epg-orchestration.js`): the logical due time is `EPG_SCHEDULE` 17:00 Europe/Madrid; the run key is the Madrid date; the Workflow instance id is `epg_<YYYYMMDD>_<series>`; one action is one existing `/api/sync/start` or `/api/sync/metadata|epg` step called in-process; durable progress is a sync-run checkpoint that moved forward in the same run (stage, metadata cursor, seal phase) or a completed run; a seal `busy` answer sleeps until its own `nextCatchUpAt`; a run of the same date that already completed is the success whoever drove it. The mode and control documents are the `mode` and `control` rows of `epg_orchestration_document`; every published-EPG pointer or replacement batch asserts the `mode` revision it was admitted with (`epgFence`). The external path answers HTTP 409 `switch_in_progress` or `external_writer_fenced`. Read model: the `orchestration` object of `GET /api/status` (MCP `epg_status`). Failure mapping: a `409` run-id conflict is `owner_conflict`, a generation changed under the run is `stale_generation_write`, an unfinished D1 seal that `sync.json` does not name is `evidence_contradictory` (all unsafe, a domain quarantine until the owner clears it); a source, timeout or 5xx failure is transient and resumes the same run after the cooldown.

### Discovery

- One chunk per durable step; 20 chunks per instance, then a successor instance. A due `chunk_budget` renews by CAS when the saved status shows remaining work.
- The instance is pinned to the published generation. A newer generation stops it as `stale_generation`.
- TMDB 429 and the stored `retryAt` or backoff become `cooldownUntil`.
- Decisions, including `cheap_pass` and partial ones, are idempotent per key.
- An interrupted hop is recovered by the executor only when its proof holds: same published generation, the hop's own unfinished status, no diagnostic claiming its checkpoint, authority open. Otherwise the outcome is `evidence_contradictory` or `evidence_unreadable` (`unsafe`).
- In external mode the manual interrupted confirm keeps its own contract ([ADR 0088](../adr/0088-guarded-interrupted-discovery-recovery.md)).

### Ratings

- Diary page 1 only, and at most 5 removal lookups per step.
- Letterboxd HTTP 403 with `cf-mitigated` is never bypassed and not retried inside the run; the run ends with its existing outcome and the next Madrid date is the retry. HTTP 429 sets the six-hour pause as `cooldownUntil`.
- A removal event is written by CAS before its queue reference is resolved; a repeat writes the same event and does not add a viewing or a second removal.
- The existing `unknown` close is a counted `owner_unknown` transient failure. The existing `isolated` state is an `unsafe` domain quarantine, cleared only by an explicit owner-approved action that does not itself run a step.

### Predictions

Outside this contract. The hourly ChatGPT task keeps the leased queue, `prediction_validate` and `prediction_submit`. A model quota of zero leaves items pending; no Cloudflare executor generates predictions.

## Mode switch and write fencing

The switch is three steps, each an owner-approved action ([ADR 0089 decision 2a](../adr/0089-shared-orchestration-reliability-contract.md#2a-mode-switch-protocol-and-what-the-fence-can-and-cannot-guarantee)):

1. **Close admission:** one CAS sets `mode: switching`, `target` and `epoch+1`. No new step of either writer is admitted (`switch_in_progress`).
2. **Verified drain:** the old owner's lease is absent or expired with margin greater than the longest step wall time, the previous Workflow instance is finished or absent, and the domain lease or run-record lease is released or expired. An unverifiable drain stays open and is `unsafe` evidence.
3. **Complete:** a second CAS sets `mode` to the target; only then does the target writer start and the other path answer `external_writer_fenced`.

Every authoritative D1 commit carries the epoch and mode it was admitted under and is applied only if the control record still equals them, in the same batch as the data. Fencing by write kind:

| Write | Fence | Domain examples |
| --- | --- | --- |
| D1 authoritative commit | Transactional: epoch and mode compared in the same batch | EPG pointer and generation; Ratings documents and run record; Discovery ledger and control record; every checkpoint |
| R2 write with etag CAS | Conditional, plus admission recheck immediately before | Objects the domain already writes by CAS |
| R2 write without a transactional fence | Admission recheck, lease TTL bound, idempotent by construction; never the evidence of progress | Ratings removal events (event key); EPG raw XML (content digest) and R2 mirrors (derived only from the currently published D1 generation); Discovery archive or side objects |

An unknown outcome of an R2 write is read back by key and compared (byte length and SHA-256, or event key) before anything is repeated; unreadable is `evidence_unreadable`. The contract does not claim immediate exclusivity at the epoch increment: exclusivity holds once the drain is verified.

## Discovery intent after an EPG publication

The published D1 pointer is the source of truth for whether Discovery owes work. Admission reads that pointer from `PublishedEpg.currentGeneration()` and requires the Discovery `published_programme_run_id` to match it; a missing pointer, a null pin, or an A→B lag is a bounded wait (`generation_unpublished` / `generation_handoff`) and does not reconstruct from `programme_run_id` or R2. After that match, `ensure Discovery` compares the published `programmeRunId` with the Discovery control record and, when the record does not name it and the generation has no terminal outcome, creates the intent by one CAS (run key `programmeRunId` + series 0, generation pin, Discovery authority fence). The receipt is the control record read back naming `programmeRunId` with the owner epoch. A held or `loading` marker writes nothing (`unsafe`). The EPG publication's own queue write is a fast path using the same CAS; its failure never fails or unpublishes the EPG run. The worst-case delay of a missing intent is one cron period. While Discovery is not activated, the existing generation handoff applies.

## Time rules

- A daily domain is due when the Europe/Madrid local time is at or after its scheduled time and that Madrid date has no successful run. Conversion uses the IANA zone.
- Cron expressions are UTC. They must fire at least once after the scheduled local time in both CET (UTC+1) and CEST (UTC+2), and again later the same local date for catch-up.
- The run is created by CAS on the day key; duplicate firings attach to it.
- A missed date is not backfilled once the next date is due.

## Read model

Each domain's existing status route returns an `orchestration` object with these fields. The read is bounded and writes nothing.

| Field | Meaning |
| --- | --- |
| `mode`, `epoch` | Executor mode and epoch |
| `runKey`, `published` | Current run key; published run or generation |
| `phase` | Current phase |
| `owner` | Kind, instance id and liveness (`alive`, `finished`, `absent`, `unknown`) |
| `lastDurableProgressAt` | Last advanced checkpoint |
| `oldestPendingAt` | Age of the oldest due work item, when the domain has a backlog |
| `dueAt`, `nextWakeAt` | When work is due; the next planned wakeup |
| `failure` | `{class, code, fingerprint, consecutive, total, caps}` |
| `cooldownUntil`, `quarantine` | As in the control record |
| `lastStep` | Latency, retries and request counts of the last step |
| `seal` (EPG) | While the run is in stage `seal`: `phase`, `ledgerPhase`, `cursorItems`, `itemTotal`, `stagedAt`, `updatedAt`. The cursor is what the last finished ledger step wrote; fields a run does not carry are `null`. No job id, storage key, Film or observation id |
| `publication` (EPG) | `dueAt`, `publishedAt`, `latencyMs` (due to done), `overdueMs` (while not done), `targetMs` |
| `health` | Derived, below |

| `health` | Condition |
| --- | --- |
| `idle` | Nothing due |
| `healthy` | Durable progress within the domain threshold |
| `waiting` | Due work, a known future wake from `retryAt`, `Retry-After`, a pause or a lease |
| `cooldown` | A counted retry is scheduled at `cooldownUntil` |
| `late` (EPG) | Due work not done for longer than the publication target (15 min after the due time), with no cooldown and no planned wake that explains it, whether or not checkpoints still advance |
| `stalled` | Due work, no durable progress within the threshold, no future wake, not quarantined |
| `quarantined` | `quarantine` is set |
| `failed_permanent` | A permanent failure blocks work |

Default stall thresholds: EPG 2 h after its due time without a published date; Ratings 2 h after its due time without a completed run; Discovery 30 min without durable progress while work is due. An external alert fires on `stalled`, `quarantined`, `failed_permanent`, or a Madrid date that ends without a successful EPG publication or Ratings run. `waiting` and `cooldown` do not alert. `late` is a read-model state ([AIR-420](https://trello.com/c/J0dit94i)): it stops a slow but moving publication from reading `healthy`; the monitor does not alert on it yet.

The EPG progress count includes the ledger cursor of the seal (as a share of the item total inside the `ledger` phase), so `lastDurableProgressAt` moves while a seal writes observations and stops when it does not. A ledger step logs `batches`, `writeMs`, `items`, `archives` and `archiveMs` in its `epg_phase` exit event; `writeMs / batches` is the D1 round trip of that Workflow instance ([evidence](../evidence/d1-migration/air-420-seal-ledger-round-trips-2026-11-10.md)).

## Deterministic negative test catalogue

Every domain delivery implements the rows that apply to it, against an injected clock, random source and storage double, with no network. Each test asserts the class, the budget change, the writes made (or none) and the read model.

| Id | Scenario | Expected |
| --- | --- | --- |
| T01 | Error before the domain write | `transient`; no write; cooldown set; `consecutive` +1 |
| T02 | Error after the domain write, before the checkpoint | Read-after-unknown finds the write; checkpoint completed without repeating the write |
| T03 | Unknown response (timeout) on a write | Next attempt reads first; no blind repeat; if unreadable, `evidence_unreadable` quarantine |
| T04 | Partial write of a multi-item step | Repeat is idempotent per item; no duplicate decision, viewing or removal |
| T05 | Instance resumes on an older generation or run key | `stale_generation` stop or `stale_generation_write` refused; no write to the newer state |
| T06 | Duplicate cron firing and concurrent `ensure` | One run per key; second create attaches; one active step |
| T07 | HTTP 429 with and without `Retry-After` | Cooldown is the later of the two; counted transient |
| T08 | Letterboxd 403 `cf-mitigated` | No bypass and no in-run retry; run ends with its outcome; next Madrid date retries |
| T09 | Platform memory or CPU kill at the same checkpoint, repeated | Cooldown grows; fifth consecutive kill quarantines the run key |
| T10 | Lease or owner record missing or malformed | `lease_malformed` or `owner_conflict`; quarantine; no lease reset |
| T11 | Authority held, `loading`, or D1 unavailable | Held or loading: `unsafe` quarantine. D1 outage: `transient` with cooldown; no fallback store |
| T12 | Discovery paused or interrupted hop | Workflow recovers only with proof; contradictory proof quarantines; external mode stays a stop |
| T13 | Discovery 20-step rollover and lost successor create | Rollover is not a failure; lost create is `create_uncertain`, reconciled by `ensure` without a new id |
| T14 | Budget exhaustion | `budget_exhausted` on the run key; next run key fresh; read model `quarantined` |
| T15 | Durable progress after failures | `consecutive` resets; `total` does not |
| T16 | HTTP 200 or Workflow create without a checkpoint | No budget reset |
| T17 | DST change days (last Sundays of March and October) and late catch-up | Exactly one run per Madrid date; no run for a date already superseded |
| T18 | External writer after cutover | `external_writer_fenced`; no write |
| T19 | Mode revert while an instance runs | Epoch mismatch stops it at the next ownership check; no write after the switch |
| T20 | Prediction model quota zero | Queue items stay pending; no Cloudflare retry or failure count |
| T21 | Status read during any of the above | No write, no create; correct `health` |
| T22 | Old writer checked the epoch, the owner closes admission, the old writer then commits to D1 | Commit refused as `epoch_mismatch` in the same batch; nothing written; the stale instance stops without retry |
| T23 | Old writer passed its admission check, the switch begins, the old writer then writes an R2 object (event, mirror, raw payload) | Write may land inside the lease window; it is idempotent (same key or digest, or a mirror of the published generation); the new owner's rewrite converges; no duplicate viewing, removal or older-generation mirror survives repair; no D1 checkpoint is written by the old writer |
| T24 | Reverse: rollback to `external` while the Cloudflare instance is mid-step | Admission closes first; the instance's D1 commits are refused after the epoch increment; the external path stays `switch_in_progress` until the drain is verified, then the ChatGPT task path is allowed |
| T25 | Completing the switch with a live lease, a live Workflow instance, an unreadable lease, or a margin shorter than the longest step wall time | Second CAS refused; `drain` stays open; `unsafe` evidence; target writer not started |
| T26 | R2 write with unknown outcome during or after a switch | Read back by key and compare; equal: complete the checkpoint; absent or different: only the current owner repeats; unreadable: quarantine |
| T27 | EPG pointer switched, Discovery intent never written (crash between) | EPG date stays published; `ensure` waits as `generation_handoff` until the Discovery published pin matches that pointer, then reconstructs the intent by CAS; receipt read back; read model shows `due` then `healthy` |
| T28 | Intent write with unknown outcome, then duplicate recovery by `ensure` and by the EPG fast path | Read-back finds the receipt; the second creator loses the CAS and attaches; exactly one series 0 for `programmeRunId`; no second chunk run |
| T29 | Intent reconstruction with a held, `loading` or unreadable Discovery marker | Nothing written; `authority_held` or `authority_loading` quarantine; EPG unaffected |
| T30 | Published generation already processed to a terminal outcome | `ensure` does not re-queue it |

## Rollout and rollback

Each domain moves alone: inert code with mode `external`; an owner-approved three-step mode switch to `cloudflare` (close admission, verified drain, complete); real production acceptance from the read model; then, separately, disabling that domain's ChatGPT task path. Rollback is the same three-step switch in the other direction (close admission, verified drain, second CAS), then re-enabling the task path. A code rollback changes neither data, mode, cron nor the task registry. Operator steps: [deployment runbook](../runbooks/deployment.md#moving-a-pipeline-to-a-cloudflare-executor).

## Ratings implementation status (AIR-347)

Implemented and **inert**: `src/domain/orchestration-policy.js` (pure policy), `src/ratings-orchestration.js` (`RATINGS_WORKFLOW`, `RatingsOrchestration.ensure`, owner route `POST /api/letterboxd/ratings/executor`), the D1 epoch fence in `src/ratings-d1.js`, the external-writer gate in `src/letterboxd-ratings.js` and the `orchestration` object of `ratings_sync_status`. See [ADR 0090](../adr/0090-ratings-cloudflare-workflow-executor.md). Nothing runs until the owner switches the mode.
