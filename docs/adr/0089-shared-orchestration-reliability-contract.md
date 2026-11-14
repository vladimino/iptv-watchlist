# ADR 0089: Cloudflare-executed pipelines share one bounded, checkpoint-first reliability contract

**Status:** Accepted  
**Original decision date:** 2026-11-04 (owner planning decision on the AIR-345 card)  
**Recorded at:** 2026-11-04  
**Approval source:** explicit owner decision, 2026-11-04 (AIR-345): ADR 0089 Accepted, both Mermaid diagrams visually approved, and partial supersession of ADR 0083 decisions 7 and 8 approved, following [independent PASS review of PR #371 HEAD 3ed77fb](https://github.com/vladimino/iptv-watchlist/pull/371#pullrequestreview-5776893532) and [green CI](https://github.com/vladimino/iptv-watchlist/actions/runs/41925637139); architecture only, no production GO  
**Related work:** [AIR-345](https://trello.com/c/rKtXn5tl); delivery cards [AIR-347 Ratings](https://trello.com/c/j2Ua76yv), [AIR-324 Discovery](https://trello.com/c/kNtaEbm8), [AIR-348 EPG](https://trello.com/c/PUrlzMuH), [AIR-349 monitoring](https://trello.com/c/VUyampoh); background [AIR-323](https://trello.com/c/SrWM43h0), [AIR-341](https://trello.com/c/r8tfPFjt), [AIR-342](https://trello.com/c/sFNZn818), [AIR-318](https://trello.com/c/slj7UjN5), [AIR-319](https://trello.com/c/pQL8NUTC), [AIR-320](https://trello.com/c/4cA5GlJn), [AIR-344](https://trello.com/c/8TV5soDb)  
**Supersedes:** [ADR 0083](0083-inert-discovery-workflow.md) decisions 7 and 8 in part for the future Cloudflare Discovery executor, per explicit owner approval on 2026-11-04. The currently inert/external implementation is unchanged. [ADR 0005](0005-external-chatgpt-tasks.md) is superseded in part per domain only at a separately approved cutover.  
**Superseded by:** None

## Context

On 1 November 2026 the owner planned that **Cloudflare runs every deterministic pipeline** (EPG publication, Discovery, Ratings) and **ChatGPT runs only personal Predictions**. On 4 November the owner chose maximal autonomous self-recovery with **finite, bounded retries**, the same reliability principles for the three Cloudflare pipelines, and a separate domain recovery policy and writer for each. This record is that shared contract. It is not a code platform and it activates nothing.

The baseline at the time of writing, from accepted records and dated evidence (not re-read in production for this record):

- **EPG** is driven by the external daily ChatGPT task at 17:00 Europe/Madrid through `epg_sync_start` / `epg_sync_step` ([ADR 0005](0005-external-chatgpt-tasks.md)). The published generation is D1-authoritative with `published_epg_authority` `d1` / `open` ([ADR 0079](0079-d1-authoritative-published-epg.md)); R2 holds compatibility mirrors and raw inputs. Commits were killed by the memory limit before and after publication ([commit interruption](../evidence/epg-commit-interrupted-2026-10-27.md), [Diary-stage kill](../evidence/epg-diary-oom-profile-2026-10-30.md)).
- **Discovery** is driven one chunk per explicit request ([ADR 0006](0006-one-chunk-discovery.md)) by the daily and hourly tasks. An inert Cloudflare Workflow exists with a capped recovery (1, 5, 15, 60 minutes, then quarantine), a 20-chunk rollover and an unscheduled reconciler ([ADR 0083](0083-inert-discovery-workflow.md)). An interrupted series is a stop that only a gated manual confirm resumes ([ADR 0088](0088-guarded-interrupted-discovery-recovery.md)). Chunks were repeatedly killed by the memory limit ([AIR-342 evidence](../evidence/discovery/air-342-chunk-memory-2026-11-04.md)); one owner-approved confirm after that fix stored a durable checkpoint on 4 November. One chunk does not prove the full backlog is stable. Discovery stays R2 until its marker is activated ([ADR 0085](0085-d1-authoritative-discovery.md)).
- **Ratings** are driven by the external Ratings Task at 17:30 Europe/Madrid ([ADR 0060](0060-independent-letterboxd-ratings-pipeline.md), [ADR 0074](0074-retire-ratings-pipeline-switch.md)). Mutable ratings documents and the run record are D1 at `d1` / `open` ([ADR 0084](0084-d1-authoritative-ratings.md)); removal events stay in R2. A stale run closes `unknown`; a second interruption at the same phase and checkpoint isolates the pipeline until an owner-approved manual start clears it. Letterboxd answers HTTP 403 (`cf-mitigated`) and 429 at times ([ADR 0018](0018-letterboxd-last-good-ratings.md)).
- **Predictions** run in the hourly ChatGPT task through the leased queue and `prediction_validate` / `prediction_submit` ([ADR 0015](0015-queued-prediction-recovery.md), [ADR 0078](0078-d1-authoritative-prediction-domain.md)).
- External tasks were found disabled without an attributed cause ([repeat disable RCA](../evidence/scheduled-task-repeat-disable-2026-11-01.md)). The hourly trigger and the server gate drift apart ([timing RCA](../evidence/scheduled-tasks-hourly-timing-rca-2026-10-28.md)). A ChatGPT task is therefore not a reliable wakeup for unattended deterministic work.

Each pipeline already has some of the pieces (leases, compare-and-swap, checkpoints, fail-closed stops), named differently and with different budgets. Without one contract, each migration would invent its own retry and recovery rules, and an unbounded retry or a second writer could poison shared state.

## Decision

The contract below is normative for the three Cloudflare executors. The maintained field-level contract, reason codes, default numbers and test catalogue are in the [orchestration reliability reference](../reference/orchestration-reliability.md); the target topology and lifecycle are drawn in [scheduling and orchestration](../architecture/scheduling-and-orchestration.md#proposed-cloudflare-executors-and-shared-recovery).

### 1. Shared invariants, separate executors

1. EPG, Discovery and Ratings each get **their own executor, control record, owner, budget and recovery policy**. There is no single Workflow for all domains, no cross-domain lease, no global queue and no new competing store.
2. What is shared is a **vocabulary and a set of invariants**: failure classes, reason codes, the budget record shape, the durable-progress rule, the read-after-unknown rule, the read model and the test catalogue. Implementations may share pure helper code (classification, backoff calculation, Madrid day key, health derivation). Shared code never holds state of its own.
3. A domain's control record lives **in the store that is authoritative for that domain's state**, next to what it fences. EPG and Ratings are D1 (`d1` / `open`). Discovery's executor is activated only after its own marker is `d1` / `open` ([ADR 0085](0085-d1-authoritative-discovery.md)); its executor record then lives in D1 in that domain. No R2 bridge record is added for an activated domain. Raw EPG XML, archives, removal events and other large payloads stay in R2.
4. Until a domain is cut over (decision 10), its server-side runner is **inert**: the code is deployed but nothing schedules or creates it, exactly as [ADR 0083](0083-inert-discovery-workflow.md) does for Discovery.

### 2. Ownership, generation fencing and truth

For every domain the implementation defines and tests the same nine elements (the per-domain table is in the reference):

| Element | Contract |
| --- | --- |
| Durable control state | One record per domain in its authoritative store: mode, epoch, current run key, phase, checkpoint, owner, budget, cooldown, quarantine. |
| Owner epoch | An integer that increases at the start of every executor-mode change. Every D1 commit by the executor compares it inside the same atomic batch (see [Mode switch](#2a-mode-switch-protocol-and-what-the-fence-can-and-cannot-guarantee)). A writer whose epoch is older has its commit refused and stops. |
| Run / day key | EPG and Ratings: the Europe/Madrid local date of the logical schedule. Discovery: the published `programmeRunId` plus series number. |
| Checkpoint / receipt | The durable record that proves a step's effect, read back after the write. |
| Lease / CAS | One active step per domain, taken by compare-and-swap on the control record (or the existing domain lease). A duplicate trigger loses the swap and does nothing. |
| Allowed write order | Domain writes first, then the checkpoint that proves them. A checkpoint never claims a write that was not made. |
| Read-after-unknown | After a timeout, lost response or killed step, the next attempt **reads** the checkpoint and authority before deciding. It never repeats a write blind. |
| Durable progress proof | The domain-specific evidence that real work advanced (decision 3.4). |
| Fenced external writers | After the switch has **completed** (drain verified), the server refuses the other mode's writer path for that domain with `external_writer_fenced`, whatever an old Task prompt sends. Until then the rules in decision 2a apply. Two independent writers never run after the drain; the interval before it is bounded and described, not denied. |

#### 2a. Mode switch protocol, and what the fence can and cannot guarantee

An epoch compare in D1 is atomic only with other D1 writes. It cannot atomically fence an R2 write, and it cannot stop a writer that checked the epoch before the switch and commits after it. The contract therefore makes no claim of *immediate* exclusivity at the epoch increment. **Exclusivity is established when the drain below is verified, not when the epoch increases.**

**Protocol (both directions: external → Cloudflare and rollback).** Every step is a separate owner-approved action or a read:

1. **Close admission.** The owner-approved switch writes `mode: switching`, `target`, and `epoch+1` in one CAS on the control record. From this commit, no new step of either writer is admitted: the Cloudflare executor and the external tool path both answer `switch_in_progress` and write nothing. The new executor is not started.
2. **Drain.** Wait until every in-flight step of the old writer has ended. This is **verified**, not assumed: the old owner's lease is absent or expired with margin greater than the longest allowed step wall time, the previous Workflow instance (if any) reports finished or absent, and the domain's lease record (resolver lease, run record lease) is released or expired. The read model reports `switching` with the drain state while this is open. A drain that cannot be verified (unreadable lease, a live instance) does not complete; it is `unsafe` evidence and the switch stays open.
3. **Complete.** Only after the drain is verified, a second CAS sets `mode` to the target. Only now may the target writer start, and only now does the other path answer `external_writer_fenced`. A rollback performs the same three steps in the other direction.

**Commit-time recheck.** Every authoritative D1 commit of an executor step (checkpoint, run record, budget, pointer, document merge) carries the epoch and `mode` it was admitted under and is applied only if the control record still equals them, inside the same D1 batch or CAS as the data. A stale writer's commit is refused as `epoch_mismatch` (`unsafe`, stops the stale instance without a retry).

**Which writes are fenced how.**

| Write kind | Fence | If a stale writer gets one in |
| --- | --- | --- |
| D1 authoritative commits (EPG pointer and generation, Ratings documents and run record, Discovery ledger and control record, any checkpoint) | **Transactional**: epoch and mode compared in the same batch | Refused; nothing is written |
| R2 writes that have a conditional write (etag CAS) | Conditional on the object's etag, plus an admission recheck of the epoch immediately before | Loses the CAS or is idempotent |
| R2 writes without a transactional fence: Ratings removal events, EPG raw XML and R2 compatibility mirrors, Discovery archive or side objects | **Not transactionally fenced.** Admission recheck immediately before the write, bounded by the lease TTL, and idempotent by construction (event key, content digest, mirror derived only from the currently published D1 generation) | The write can land in the window between the switch and the end of the old lease. It converges: the new owner rewrites the same key or digest, and a mirror write from a no-longer-current generation is overwritten by the next mirror repair. The write is never the evidence of progress; only the D1 checkpoint is |

**Unknown outcome of an R2 write.** Never retried blind: read the object by key and compare the byte length and SHA-256 (or the event key) against the expected value. Equal: treat as written and complete the D1 checkpoint (which itself rechecks the epoch). Absent or different: the write is repeated only by the current owner. Unreadable: `evidence_unreadable`, quarantine.

**What this means for exclusivity.** Between the epoch increment and the drain, at most one old step may still be running. It cannot commit to D1, and its R2 writes are bounded and idempotent. After the drain, no old step exists. The contract does not allow the new writer to start before the drain is verified, so two writers never run concurrently. All mode changes stay owner-gated, including the second CAS.

### 3. Bounded autonomous retry

1. **Every failure has exactly one class.** `transient` (network error, timeout, HTTP 429, upstream 5xx, platform `exceededMemory` / `exceededCpu` / error 1102, lost wakeup, Workflow instance terminated or errored, lost create response): retried by the executor with cooldown. `permanent` (missing or rejected credentials, a contract or schema version the code does not support, a configuration value outside its allowed set): no retry; the domain waits for a changed precondition, re-checked cheaply on each due wakeup. `unsafe` (unreadable or contradictory evidence, a stale generation write attempt, a corrupt or malformed checkpoint or lease, a conflicting owner, a held or `loading` migration marker, an epoch mismatch on a record this executor believes it owns): no retry; immediate quarantine. Domain-specific refusals (Letterboxd `cf-mitigated` 403) are mapped to one of the three classes in the domain matrix.
2. **Budgets persist.** The control record keeps `consecutive` (failures since the last durable progress), `total` (failures for the current run key) and a failure **fingerprint** (class, code, phase, checkpoint). A restart, a deploy, a new Workflow instance or a successful HTTP response does not reset them.
3. **Cooldown grows, attempts stay finite.** Each transient failure sets `cooldownUntil` from an exponential schedule with jitter (defaults in the reference: 1 min, 5 min, 15 min, 1 h, with ±20% jitter). An upstream `Retry-After` or a domain pause wins when it is later. A repeated platform kill without progress takes the next, longer cooldown. When `consecutive` reaches its cap (default 5) or `total` reaches its cap (default 12 per run key), the domain is **quarantined** with `budget_exhausted`. Nothing retries forever.
4. **Only durable progress resets `consecutive`.** Durable progress is a read-back checkpoint that moved forward for the same run key and epoch: EPG — a later staged step or the published pointer naming this run; Discovery — a stored continuation checkpoint for the same generation; Ratings — a run checkpoint that advanced with the ratings authority generation, a forward cursor, or a resolved queue reference. A Workflow `create`, an HTTP 200, a lease acquisition or a "started" log line is not progress. `total` resets only with a new run key.
5. **No automatic force, no lease reset.** The executor never calls a forced resolve, never breaks a live lease, never clears its own quarantine and never retries a write whose outcome is unknown before reading it back.
6. **Quarantine scope.** `budget_exhausted` quarantines the current run key: a later run key (next Madrid date, next published generation) starts with a fresh budget, and the read model keeps reporting the earlier exhaustion. `unsafe` quarantines the **domain** until an owner-approved, explicit clear, because the evidence that made it unsafe does not go away with a new day.

### 4. Durable wakeups and reconciliation

1. **One clock, per-domain decisions.** The Worker cron is the only scheduler. Each firing calls a lightweight `ensure` for each activated domain. `ensure` reads that domain's control record and, at most, creates or attaches **one** Workflow instance with a deterministic id derived from the run key. It runs no chunk, no download and no lookup itself. A Workflow `schedules` entry is not used, because it creates instances on deploy ([ADR 0083](0083-inert-discovery-workflow.md)).
2. **Reconcile from checkpoints, not from memory.** `ensure` is also the reconciler: an orphaned, terminated or errored instance with work remaining, an uncertain `create`, and a lost `sleep` wakeup are all recovered by reading the checkpoint first, then the platform instance status, then acting through the owner compare-and-swap. A recovery is a counted transient failure.
3. **Rate-limited and idempotent.** `ensure` performs a bounded number of reads, does nothing while `cooldownUntil` is in the future or the domain is quarantined, and is safe under duplicate and overlapping cron firings: the deterministic instance id and the CAS make a second create attach to the first.
4. **Server-side orphan recovery is not the manual confirm.** The owner confirm of [ADR 0088](0088-guarded-interrupted-discovery-recovery.md) remains an external-mode tool. A cut-over domain refuses it; its recovery is `ensure`.

#### 4a. The published generation is the source of the Discovery intent

The EPG pointer switch and Discovery's intent are two writes in two control records, so a crash can leave the pointer switched and the intent missing (today the external path repairs this with the generation handoff, [ADR 0030](0030-discovery-queued-at-publication.md)). Under this contract:

1. **The authoritative source is the published generation.** The published D1 pointer names `programmeRunId`. Whether Discovery owes work for it is derived from that pointer, not from the queued intent.
2. **Discovery's `ensure` reconstructs the intent.** On each firing, `ensure Discovery` reads the published `programmeRunId` and the Discovery control record. If the control record does not name that generation and the generation has not been processed to a terminal outcome, `ensure` creates the intent itself: one compare-and-swap on the Discovery control record with run key `programmeRunId` + series 0, the generation pin and the Discovery authority fence (marker `d1` / `open`; a held or `loading` marker is `unsafe`, nothing is written). A published generation that Discovery has already processed is not re-queued.
3. **Read-back receipt.** The receipt of the intent is the control record read back naming `programmeRunId` with the owner epoch. A lost response, a timeout or a killed `ensure` is settled by that read-back before any retry. The write is idempotent: a second creator loses the CAS and attaches, a repeat after an unknown write finds the receipt and writes nothing.
4. **The EPG publication still queues the intent**, as the fast path, using the same CAS and the same key; the two are interchangeable. A failure of that write is recorded for diagnostics and does not fail or unpublish the EPG run. The EPG date is successfully published whether or not the intent exists.
5. **Latency bound.** A missing intent is reconstructed at the next cron firing after the publication, so the worst-case delay is one cron period (the current cron is hourly). It is not a stall: the read model reports Discovery `due` for that generation (`oldestPendingAt`) and `stalled` only after its threshold.
6. **While Discovery is not activated** (mode `external`, or the marker not open), the existing path is unchanged: the commit's queue and the generation handoff of [ADR 0030](0030-discovery-queued-at-publication.md) apply.

### 5. Domain recovery matrix

| Domain | Run key and schedule | Domain-specific rules |
| --- | --- | --- |
| **EPG** | Madrid date; logical 17:00 Europe/Madrid | Metadata, watchlist, programme download and scan run as bounded steps; large XML is streamed and never held whole. Publication is the existing atomic D1 switch of `programmeRunId` ([ADR 0079](0079-d1-authoritative-published-epg.md)). A crash **before** the switch leaves the earlier generation published; the run resumes from its staged checkpoint or restarts under the same day key. A crash **after** the switch is detected by reading the published pointer: if it names this run, the run is published and continues with its tail. R2 mirror repair rewrites mirrors only from the currently published D1 generation and never an older one; a mirror failure does not unpublish. At most one successful publication per Madrid date. EPG success does not wait for Discovery. Publication may also queue Discovery's fenced intent ([ADR 0030](0030-discovery-queued-at-publication.md)) as a latency optimization, but that write is a separate step after the pointer switch, **not one atomic transaction with it**, and is never the source of truth (decision 4a). |
| **Discovery** | Published `programmeRunId` + series; continuous while work is due | One chunk per durable step and the 20-chunk rollover ([ADR 0083](0083-inert-discovery-workflow.md)). The instance is pinned to the published generation; a newer generation stops it as `stale_generation`, which is not a failure. TMDB 429 and the stored `retryAt` / backoff are honored as cooldown. A due `chunk_budget` renews by CAS without an hourly cap. `cheap_pass` and partial decisions are idempotent per key, so a repeated hop re-derives the same decisions. **Workflow-owned recovery of an interrupted hop** applies the same proof as the manual confirm (same generation, the hop's own unfinished status, no diagnostic claiming its checkpoint, authority open) automatically and within the budget; missing or contradictory proof is `unsafe`. External mode keeps [ADR 0088](0088-guarded-interrupted-discovery-recovery.md) unchanged. |
| **Ratings** | Madrid date; logical 17:30 Europe/Madrid | Diary page 1 only ([ADR 0067](0067-diary-recent-window.md), [ADR 0075](0075-retire-letterboxd-diary-history-switch.md)) and the bounded per-film removal lookups (at most 5 per step). The run record and documents stay D1 under the ratings marker ([ADR 0084](0084-d1-authoritative-ratings.md)). Letterboxd 403 `cf-mitigated` is **never bypassed** and not retried inside the run: the run ends with its existing outcome and the next Madrid date is the retry (class `transient`, code `upstream_blocked`, no in-run attempt). 429 sets the existing six-hour pause as cooldown. Event writes stay idempotent: the event is written by CAS before its queue reference is resolved, so a repeat does not duplicate a viewing or a removal. The existing `unknown` close is a counted transient failure; the existing `isolated` state is this contract's `unsafe` quarantine. |
| **Predictions** | Not a Cloudflare domain | ChatGPT only. The durable queue survives a model quota of zero: items stay pending, leases expire, nothing is lost. A later backfill submits each film through `prediction_validate` / `prediction_submit`. Cloudflare gets no model executor and counts no prediction failures. |

### 6. Time and resource limits

1. **Logical schedule in Europe/Madrid, cron in UTC.** A daily domain is due when the Madrid local time is at or after its scheduled time and its Madrid date has no successful run. The cron must fire at least once after the scheduled local time in both CET and CEST, plus catch-up firings later the same local date. Conversion uses the IANA zone, never a fixed offset. A missed date is not backfilled once the next date's run is due; the next run covers it (Ratings by its recent Diary window, EPG by publishing the current programme).
2. **No duplicate, no missed day.** The run is created by CAS on the day key. Two firings, a retry and a late catch-up for the same date attach to one run. DST change days (last Sunday of March and of October) produce exactly one run.
3. **One bounded step per invocation.** Long pipelines advance in Workflow steps, each within CPU, memory and wall-time budgets measured for that step at implementation and recorded as evidence. Budgets for TMDB and Letterboxd requests are per step and per run key.
4. **No fixed hour cap when work is due and safe.** Waiting is driven only by `retryAt`, `Retry-After`, cooldown, lease expiry and domain pauses.
5. **Platform facts are verified at implementation.** Cloudflare Workflow step limits, instance retention, cron limits and pricing are read from current Cloudflare documentation and recorded in the delivery's evidence. Numbers from the 1 November concept are not live facts.

### 7. Observability and alerts

1. Each domain exposes the same minimal **read model** (fields in the reference): published run or generation, `lastDurableProgressAt`, oldest pending work, `dueAt`, `nextWakeAt`, failure class, code, fingerprint, `consecutive` / `total` against caps, owner and liveness, `cooldownUntil`, quarantine, last step latency and retries, and request cost counters.
2. A derived `health` distinguishes `idle`, `healthy`, `waiting` (a known future wake), `cooldown` (a counted retry is scheduled), `stalled` (work is due, no durable progress within the domain's threshold, and no future wake), `quarantined` and `failed_permanent`. Waiting and cooldown are not alerts; stalled, quarantined, permanent failure and a missed Madrid date are.
3. Status reads are bounded and **never write** (no create, no repair, no ring entry). The read model is served on the existing status routes. Alert delivery outside ChatGPT is a separate monitoring implementation that consumes this read model.

### 8. Rollout and rollback per domain

Each domain moves independently through the same gates, and each arrow is a separate owner GO:

1. **Inert code**: executor, `ensure`, read model and tests deployed with the mode `external`; CI and deploy green.
2. **Fence and activate**: owner GO to switch the domain mode to Cloudflare, performed as the three-step [protocol in decision 2a](#2a-mode-switch-protocol-and-what-the-fence-can-and-cannot-guarantee): close admission (epoch increment), verified drain, then complete the switch. The target executor starts, and the other path answers `external_writer_fenced`, only after the drain is verified.
3. **Real acceptance**: at least one complete production run (EPG: a published Madrid date; Ratings: a completed daily run; Discovery: a backlog drained or a sustained period of durable progress) observed from the read model.
4. **Disable the ChatGPT task path** for that domain only after acceptance (a separate owner GO on the task registry). The hourly task keeps Predictions.

**Rollback** is the same protocol in the other direction: owner GO to close admission (epoch increment), verified drain of the Cloudflare instance and its leases, then the second CAS back to `external`; only after that is the ChatGPT task re-enabled. A code rollback does not change data, the mode, the cron trigger or the task registry. Discovery stays D1-first; no R2 bridge is added for a revert.

### 9. What this record does not decide

It does not choose D1 table names, Workflow class names or exact cron expressions; those belong to each delivery and must satisfy this contract. It does not activate any executor, add a cron trigger, change a flag, edit a Scheduled Task, run EPG, Discovery, TMDB, Letterboxd or prediction work, write R2 or D1, reset a lease or switch an authority marker.

### Relationship to earlier decisions

- [ADR 0083](0083-inert-discovery-workflow.md) stays Accepted. Its recovery (1/5/15/60 minutes, quarantine on the fifth failure, a confirmed chunk clears the count) is a conforming instance of decision 3 for the external-to-workflow transition. This record **refines** it in three points that the Discovery delivery must implement: the executor record moves to D1 with the discovery marker (decision 1.3) instead of `epg/discovery-workflow.json`; the reconciler is called by the cron `ensure` (decision 4); an interrupted hop is recovered automatically by the workflow under proof (decision 5). The owner explicitly approved the partial supersession of ADR 0083 decisions 7 and 8 on 2026-11-04. This changes only the target executor contract; AIR-324 implements it after separate owner approvals. External mode and ADR 0088 stay unchanged.
- [ADR 0088](0088-guarded-interrupted-discovery-recovery.md) is unchanged: the external hourly step stays a stop and the manual confirm stays the external-mode recovery. Its existing refusal of the confirm under the workflow executor is the fence of decision 2.
- [ADR 0005](0005-external-chatgpt-tasks.md) would be superseded in part per domain, only at that domain's accepted cutover (decision 8), and only by an explicit owner decision recorded then.
- [ADR 0006](0006-one-chunk-discovery.md), [ADR 0079](0079-d1-authoritative-published-epg.md), [ADR 0084](0084-d1-authoritative-ratings.md), [ADR 0085](0085-d1-authoritative-discovery.md) and the prediction ADRs are unchanged.

## Alternatives considered

- **Infinite retry until success.** Rejected. A deterministic failure (a memory kill at one checkpoint, a revoked credential) would retry forever, spend TMDB and Letterboxd budgets and hide the fault behind "running". The owner asked for maximal autonomy with a finite cap.
- **Manual-only recovery.** Rejected as the default. It is the current external model ([ADR 0088](0088-guarded-interrupted-discovery-recovery.md)) and leaves the backlog stopped until the owner acts. It remains the path for `unsafe` quarantine.
- **One Workflow for all pipelines.** Rejected. One instance would couple EPG publication to Discovery and Ratings failures, need a cross-domain lease, and turn one domain's quarantine into an outage of the others.
- **A secondary R2 coordination store.** Rejected. A second store beside a D1-authoritative domain creates two truths that can disagree after a crash; it is the bridge the owner excluded.
- **Keep ChatGPT hourly, but force the step.** Rejected. Forcing bypasses the generation, status and authority gates ([ADR 0088](0088-guarded-interrupted-discovery-recovery.md)), and a ChatGPT task is not a reliable wakeup (disabled without attribution, timing drift).
- **A Workflow `schedules` entry as the clock.** Rejected, as in [ADR 0083](0083-inert-discovery-workflow.md): it creates instances on deploy.

## Consequences

- Each delivery card gets a ready contract: the nine ownership elements, the failure classes and budgets, the domain row and the test catalogue. It implements and proves them; it does not re-decide them.
- Unattended operation no longer depends on a ChatGPT task waking up for EPG, Discovery or Ratings. Predictions still do.
- A persistent fault ends in a visible quarantine within a bounded time (with the defaults, about 1 h 21 min of cooldowns before the fifth consecutive failure) instead of silent retry or silent stop.
- New complexity: a control record, epoch and budget per domain, a cron `ensure`, and a read model. Cron firings add a small, bounded number of reads per domain. Workflow usage has a cost that each delivery measures.
- Risk: classification mistakes. A fault classified `transient` that is really `unsafe` is retried up to the cap; the cap and the read-after-unknown rule bound the damage, and the test catalogue includes the misclassification-sensitive cases.

## Recovery and migration boundary

Accepting this record approves the architecture only. It does not authorize any production flag or mode change, cron change, Workflow create, Scheduled Task edit or disable, EPG / Discovery / TMDB / Letterboxd / prediction run, R2 or D1 write, migration, marker change, lease reset or quarantine clear. Each of those needs its own action-specific owner GO in its delivery card. Reverting this record before any delivery has no runtime effect. After a domain cutover, rollback follows decision 8; code rollback never restores data, mode, cron or task state.

## Evidence

- **Original decision:** [AIR-345](https://trello.com/c/rKtXn5tl) owner planning decision, 4 November 2026.
- **Implementation:** this record, the [reference contract](../reference/orchestration-reliability.md) and the [proposed diagrams](../architecture/scheduling-and-orchestration.md#proposed-cloudflare-executors-and-shared-recovery); no runtime code.
- **Dated verification:** [design inventory, 4 November 2026](../evidence/orchestration/shared-reliability-contract-2026-11-04.md): repository code and accepted records only; no production read or write.
- **Uncertainty:** platform limits and pricing are not established here. The default budgets are product choices to be confirmed by each delivery's evidence. Discovery's full-backlog stability under the Workflow is not proven. The production cause of earlier unattributed task disables is not established.

## Follow-ups

[AIR-347](https://trello.com/c/j2Ua76yv) (Ratings), [AIR-324](https://trello.com/c/kNtaEbm8) (Discovery), [AIR-348](https://trello.com/c/PUrlzMuH) (EPG) and [AIR-349](https://trello.com/c/VUyampoh) (monitoring) implement and accept this contract. Their status is in Trello. Accepted [ADR 0135](0135-epg-priority-discovery-pause.md) qualifies the sentence that EPG does not wait for Discovery: EPG still does not run a Discovery chunk, and it may soft-busy-wait for a live Discovery lease. That record is Accepted; its gate code is delivered inert (AIR-459) and not activated, and changes no runtime behaviour.
