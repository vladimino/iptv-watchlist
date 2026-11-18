# Scheduling and orchestration

Scheduling is split. The only **external ChatGPT Scheduled Task** that produces anything is the hourly Predictions Task (the read-only drift monitor in the same registry is not a producer; the legacy Daily EPG and Ratings Tasks are retired and disabled). **Cloudflare** runs EPG (a Workflow, mode `cloudflare` since the AIR-348 cutover accepted on 8 November 2026), Ratings (a Workflow, mode `cloudflare`), Discovery (a Workflow, permanent since AIR-325; the `DISCOVERY_EXECUTOR` selector is retired and ignored), and the monitor, all started from the Worker's one cron trigger (`0 * * * *`, hourly at minute 0 UTC; it was `37 * * * *` until AIR-348). The D1 enrichment projector is not on that tick ([ADR 0155](../adr/0155-retire-enrichment-projector-cron.md)). Each tick calls, independently of the others, the Ratings `ensure` ([ADR 0090](../adr/0090-ratings-cloudflare-workflow-executor.md); once the daily run is due it creates one Workflow instance per Madrid date), the EPG `ensure` ([ADR 0100](../adr/0100-epg-cloudflare-workflow-executor.md); it creates the daily Workflow instance once the run is due, and nothing while its mode is `external`), `reconcileDiscoveryWorkflow` ([ADR 0093](../adr/0093-discovery-workflow-cron-reconcile.md), Accepted) and the monitor ([ADR 0095](../adr/0095-cloudflare-native-production-monitor.md)). `D1_ENRICHMENT_WRITE` is retired and does not start a projector run. The Discovery reconcile creates nothing without the Workflow binding and D1 admission. HTTP and MCP only delegate to or are refused by the Workflow; the Workflow owns chunk execution, budget renewal and recovery. The Worker exposes owner-only MCP tools that perform work only when invoked. Expected task behavior: [Scheduled Task contract](../reference/scheduled-tasks.md). Sources: [scheduling ADR](../adr/0005-external-chatgpt-tasks.md), [one-chunk ADR](../adr/0006-one-chunk-discovery.md), [MCP contract](../reference/api/mcp.md) and [prediction operations](../runbooks/prediction-operations.md).

**Research within the hourly Predictions Task.** Before generating a prediction, the Task attempts to read original author reviews, distinguishes genuinely read full text from partial text and search snippets, and records per-film access outcomes and fallback reasons in its saved Task report. This work is internal to the external Task: it does not add an orchestration edge, Worker API call, storage table, Cron trigger or `assessment` field. The existing Task-to-MCP validation and submission flow, followed by D1/R2 persistence, remains as diagrammed. Consult the [maintained prompt](../reference/scheduled-task-prompts/hourly-predictions-batch-v2.md) and [research verification procedure](../runbooks/prediction-operations.md); the live registry alone determines whether the Task is currently enabled.

The sequences below are **independent scheduled or externally driven flows**, not a single sequential execution. They are split for legibility; each uses the same existing Worker, Access, R2 and D1 boundaries. The cron expression is `0 * * * *` (AIR-348). The Predictions diagram shows the live hourly Task. The sequences headed *Daily EPG and hourly discovery continuation* and the Ratings sequence that draws a `Daily EPG Task` show the **retired** ChatGPT Daily EPG Task and the former Stage A discovery catch-up: production EPG, Discovery and Ratings are Cloudflare Workflows now. They are kept as the rollback and history flow; redrawing them is a separate change that needs a real render review and the owner's approval. The publication path currently uses D1 because `published_epg_authority.mode=d1` and `cutover=open` ([ADR 0079](../adr/0079-d1-authoritative-published-epg.md), Accepted). R2 holds compatibility mirrors. *Historical (3 November 2026):* the first post-cutover D1 publication succeeded on a daily-task-created run completed by one explicitly owner-authorized manual `epg_sync_step`, and unattended completion and direct R2/D1 parity were then unverified. *Since then:* the first natural Cloudflare EPG run was accepted on 8 November 2026 with the R2 compatibility mirrors checked against the D1 generation ([AIR-348 evidence](../evidence/orchestration/epg-first-natural-run-air-348-2026-11-08.md)). Discovery continuation state is D1-owned ([ADR 0085](../adr/0085-d1-authoritative-discovery.md)). The changed label was [visually approved by the owner on 2026-11-01](https://trello.com/c/pQL8NUTC#comment-6ae7b1d91923578e9aaaca44). *Historical (2 November 2026):* the workflow `opt` in the daily and hourly sequence was accepted but inactive ([ADR 0083](../adr/0083-inert-discovery-workflow.md), Accepted), its diagrams were visually approved by the owner on 2 November 2026, and while `DISCOVERY_EXECUTOR` was absent the sequence stayed the external tasks. *Since then:* `DISCOVERY_EXECUTOR` read `workflow` (`feature_flags`, 10 November 2026), the Cloudflare Discovery Workflow became the executor ([AIR-324](https://trello.com/c/kNtaEbm8), accepted 7 November 2026), so that `opt` branch is the live one and the external-task branches are the retired flow. *Historical, external executor:* an interrupted discovery series is not one of the safe paused continuations in the hourly alt below: the hourly task does not call `epg_sync_step` for `reason: interrupted`. After a gated confirm has stored an ordinary checkpoint for the same published generation ([ADR 0088](../adr/0088-guarded-interrupted-discovery-recovery.md), Proposed), the next hourly invocation follows the existing stage A rule. The diagram is unchanged.

### Daily EPG and hourly discovery continuation (retired external flow)

This is the flow of the retired ChatGPT Daily EPG Task and of the hourly Stage A that it drew. It no longer runs: the Daily Task is disabled, the hourly prompt is Stage B only, and the Worker refuses `epg_sync_start` and `epg_sync_step` with `external_writer_fenced` while the EPG mode is `cloudflare`. The diagram is retained for a separately approved reverse cutover.

```mermaid
sequenceDiagram
    actor Daily as Daily EPG Task
    actor Hourly as Hourly Task
    participant MCP as Worker MCP
    participant EPG as EPG pipeline
    participant D1 as D1 authority
    participant R2 as R2 storage
    participant WF as Discovery Workflow
    Daily->>MCP: epg_sync_start
    loop Until EPG publication completes or pauses
        Daily->>MCP: epg_sync_step
        MCP->>EPG: Advance one bounded step
        EPG->>D1: Read or publish fenced generation
        EPG->>R2: Store checkpoint and mirrors
        MCP-->>Daily: stage and nextAction
    end
    alt External Discovery executor
        Hourly->>MCP: Read published continuation
        opt Eligible and safe to resume
            Hourly->>MCP: epg_sync_step
            MCP->>EPG: At most one Discovery chunk per call
            EPG->>D1: Fenced Discovery writes
            MCP-->>Hourly: continue, wait or stop
        end
    else Discovery Workflow executor
        Note over MCP,WF: Old task requests are delegated, not executed
        EPG->>WF: Enqueue intent for published generation
        opt Existing Worker cron detects missing wakeup
            MCP->>WF: Reconcile intent and create at most one instance
        end
        WF->>EPG: One Discovery chunk per durable step
        EPG->>D1: Fenced Discovery writes
    end
```

The hourly Predictions Task does not wait for the EPG Workflow to finish a seal. An unsealed generation leaves the stored prediction queue runnable ([ADR 0154](../adr/0154-prediction-eligibility-independent-of-epg.md)).

### Hourly prediction pipeline

The producer of personal predictions is the external batch v2 Scheduled Tasks described in the next section; batch v2 is the only prediction protocol, and the one-film v5 path (`prediction_start`, `prediction_next`, `prediction_validate`, `prediction_submit`) is retired ([ADR 0167](../adr/0167-retire-prediction-runner-v5.md)). Verify the enabled Tasks, schedules and prompts in the live registry; the dated readback is in the [Scheduled Tasks reference](../reference/scheduled-tasks.md).

Migration `0007` is applied and the prediction marker is `d1`, so the runner writes D1 mutable state with immutable R2 bodies ([ADR 0078](../adr/0078-d1-authoritative-prediction-domain.md)). The batch runner refuses to start while the marker is `r2` (`batch_runner_requires_d1`); D1 stays the prediction authority and no rollback to `r2` is planned. A new `fingerprint_and_prediction` item carries `fingerprint.evidence`, and the film's metadata is passed to `prediction_batch_validate` when an item cites a metadata token. Worker fingerprint versions stay at 1.

### Four independent hourly Predictions v2 Tasks

**Live producer.** Four batch v2 Tasks were created and enabled under separate owner GOs; the live registry, not this page, is the authority for their state. Nothing here creates, edits, enables or runs a Task ([authorization](../process/authorization-and-escalation.md#chatgpt-scheduled-task-authorization)). The contract is [ADR 0122](../adr/0122-prediction-batch-runner-v2-dual-protocol.md), [ADR 0136](../adr/0136-prediction-batch-manifest-size-and-spent-complete.md) and [ADR 0167](../adr/0167-retire-prediction-runner-v5.md).

Four hourly Tasks, offset by 15 minutes, each one bounded invocation: A `:00`, B `:15`, C `:30`, D `:45` (Europe/Madrid). They are four hourly recurrences, not one 15-minute recurrence. The Tasks share no memory and no orchestration; the only coordination is the one D1 queue and the one runner lease.

```mermaid
sequenceDiagram
    participant Sched as ChatGPT Scheduler, Tasks A to D
    participant Task as One v2 Task invocation
    participant MCP as Worker MCP
    participant D1 as D1 queue and lease
    Sched->>Task: Nominal slot, may be early or late
    Task->>MCP: prediction_batch_start with manifestSize 5
    MCP->>D1: Acquire the one runner lease or read the holder
    alt Another run holds the lease
        MCP-->>Task: already_running
        Note over Task: No adoption, no complete, the slot is lost
    else Nothing eligible or blocked
        MCP-->>Task: noop or blocked, no run and no Event
    else Run created
        MCP->>D1: Drain transferable stage onto this run when present
        MCP-->>Task: Manifest of up to 5 new films, runId, epoch, drained counts
        loop Until every selected film is settled
            Task->>Task: Research and predict one film into the buffer
            opt Buffer holds 5 items, next item would pass 56 KiB, or end of manifest
                Task->>MCP: prediction_batch_validate, prediction_batch_hold, then prediction_batch_submit
                MCP->>D1: Commit per film, settle queue, renew lease
                MCP-->>Task: Per-film results, replay same body after a lost answer
            end
        end
        alt All selected films settled
            Task->>MCP: prediction_complete with reason manifest_spent
            MCP->>D1: Normal complete Event once, release lease
        else Unsettled films, deferred_budget, profile or contract drift, or lease lost
            Note over Task,MCP: Existing fail-closed semantics, no manifest_spent, lease expires or systemic stop
        end
    end
    Note over Sched,D1: Overlap gives already_running for the later Task, retries stay in the queue, no manual make-up
```

Boundaries: the legacy v5 Task cannot run because its tools are retired; the Worker never reads the Task registry; `IPTV Scheduled Task Drift` is not changed by the Tasks; a fifth Task (`:00/:12/:24/:36/:48`) is out of scope until measured jitter and limits are reviewed and needs its own owner GO. The rollout ran as one one-off canary Task, then that same Task rescheduled to `:00`, then `:15/:30/:45`, each a separate owner GO ([runbook](../runbooks/prediction-operations.md#planned-rollout-of-four-hourly-v2-tasks-air-451)).

### Read-only Scheduled Task registry drift

The drift monitor now peeks **one** Task, the hourly Predictions Task. The *Peek Daily EPG Task by ID* step below belongs to the earlier two-Task scope (AIR-377): the Daily EPG Task is retired and disabled and is no longer audited. The updated scope is [AIR-406](https://trello.com/c/PPe2fFcu); the diagram is not redrawn here.

```mermaid
sequenceDiagram
    actor Monitor as ChatGPT registry drift (18:15)
    actor Owner as Owner
    participant Registry as ChatGPT Task registry
    participant Docs as GitHub main contract
    Note over Monitor,Registry: Registry-only without Worker or MCP status reads
    Monitor->>Registry: Peek Daily EPG Task by ID
    Registry-->>Monitor: Configuration and last run
    Monitor->>Registry: Peek Hourly Predictions Task by ID
    Registry-->>Monitor: Configuration and last run
    Monitor->>Docs: Read expected Task configuration
    Docs-->>Monitor: Semantic scope and permission boundaries
    opt Confirmed drift or failed run or unavailable registry
        Monitor->>Owner: Notify with Task ID and mismatch
    end
```

### Worker cron: enrichment projector retired (AIR-308)

```mermaid
sequenceDiagram
    participant Cron as Worker cron
    participant Discovery as Discovery reconcile
    participant Ratings as Ratings ensure
    participant Epg as EPG ensure
    participant Monitor as Monitor
    Cron->>Discovery: Scheduled event at minute 0, first
    Note over Cron,Discovery: No enrichment projector. D1_ENRICHMENT_WRITE is ignored
    par After reconcile settles or the 45 s head start
        Cron->>Ratings: ensure
    and
        Cron->>Epg: ensure
    and
        Cron->>Monitor: run
    end
```

The diagram above is the live tick. The historical R2-to-D1 projector sequence (ADR 0056, ADR 0103, ADR 0106) is no longer started by this cron.

The cron expression is `0 * * * *` (it was `37 * * * *` until AIR-348; Madrid is a whole-hour offset, so an hourly UTC cron has a tick at Madrid 17:00 in CET and CEST, and each daily `ensure` decides due itself from the Madrid date). Since AIR-482, as a best-effort mitigation only (not an isolation guarantee, the OOM allocator is unproven), the tick starts `reconcileDiscoveryWorkflow` (which closes the hourly Discovery report) first and starts Ratings `ensure`, EPG `ensure` and the monitor together when that reconcile settles or after a 45 s head start. A reconcile or report close still pending at 45 s overlaps the other members in the same invocation and stays exposed to the same memory kill. A rejected reconcile never blocks the other members. The ratings `ensure` creates one Workflow instance per Madrid date once the daily run is due. The EPG `ensure` creates the daily Workflow instance once the run is due. The Discovery reconcile acts on a missing intent or a dead instance. Each reconcile attempt is a Workers Log `discovery_workflow_reconcile`; a green cron is not a Discovery recovery. The enrichment projector is not a member of this tick ([ADR 0155](../adr/0155-retire-enrichment-projector-cron.md)). `D1_ENRICHMENT_WRITE` does not start a run. A `projector_window` row that is already held still refuses Discovery admission until it expires; this retirement does not ignore that fence.

**Discovery fast recovery tick (AIR-534, [ADR 0173](../adr/0173-discovery-only-fast-recovery-cron.md), Accepted).** The Worker has a second cron trigger, `1-59/2 * * * *` (every two minutes on odd minutes, never minute 0). It calls only `reconcileDiscoveryRecovery`: no chunk, no TMDB, no EPG, Ratings or Monitor, and no hourly report. It is a fallback for a killed, completed or errored instance, a lost or uncertain wake and an overdue recovery; the EPG-publication fast start and the durable `step.sleepUntil` of a live instance ([ADR 0098](../adr/0098-discovery-workflow-step-failure-recovery.md)) stay primary.

```mermaid
sequenceDiagram
    autonumber
    participant Fast as Fast cron, every 2 min
    participant W as reconcileDiscoveryRecovery
    participant D1 as D1 Workflow record
    participant CF as Cloudflare Workflows
    participant R as Existing reconcile (CAS, fencing, admission)
    Fast->>W: Scheduled event, no report, no chunk
    W->>D1: Read the record once
    alt No record, terminal stop, quarantine, or recovery not yet due
        W-->>Fast: No-op, nothing created or written
    else Record says an instance is alive
        W->>CF: Read instance status
        alt Running, waiting, queued or paused
            W-->>Fast: No-op, in progress
        else Complete, errored, terminated or absent
            W->>R: Hand over
        end
    else Stopped and due, or start uncertain and due
        W->>R: Hand over
    end
    R->>D1: Admission reads, then one CAS write
    alt Refused (authority, priority, window, mismatch)
        R-->>W: Typed reason, nothing created
        W-->>Fast: recovery_refused or recovery_overdue, with the reason
    else Accepted
        R->>CF: Create the deterministic id for series plus one
        R-->>W: Started or attached
        W-->>Fast: recovery_started with recoveryDelayMs
    end
```

The diagram shows the fast tick only; the hourly tick above is unchanged and may overlap with it. Overlap, a repeated cron and a durable wake create no second owner: the successor id is deterministic and the record write is an expected-etag CAS, both unchanged. An idle tick is one record read (plus one platform status call while an instance is alive) and no write.

**Historical: pre-AIR-308 projector.** Before ADR 0155 the same tick also called the projector. When the tick granted a projector window, a scheduled reconcile that was refused as `projector_window` waited for that window's one expiry in the same invocation (at most three attempts) and then created a due successor. With the flag unset, the projector performed no R2 reads or D1 writes. With `dry`, it read the source and change keys and never wrote. With `on` and the Film/Person marker below `open`, it wrote changed Films and Persons in existing fenced batches. At `open` those canonical writes were refused as compare-only; the fenced adapters own them. At schema v5, `film_sync_state` used that same writer: sync clocks for an already-changing Film shared its batch, while a clock-only change used its own fenced batch. That schema is applied. At schema v6, the same clocks were written, and when the metadata cache marker is `d1` the metadata records came from D1. Schema v7 and v8 kept those clocks and cache reads; the projector wrote neither the prediction nor the published EPG domain. A partial prediction domain, or a complete one without a valid marker, failed the run before a write. None of the prediction tables on a later contract does not: prediction stays on the objects. `PREDICTION_DB_REQUIRED=on` makes a missing `DB` binding, or a bound database without `schema_contract`, fail the same way. The variable is not a new cron and not a new operational flag. The projector did not write R2 or the cache. A code deploy does not apply migration `0006` or `0007`. Production has applied `0006` and that marker is `d1` ([ADR 0073](../adr/0073-metadata-cache-d1-authority.md), [cutover](../evidence/d1-migration/air-313-metadata-cache-cutover-2026-11-01.md)). Production applied `0007` and activated the prediction marker on 3 November 2026 ([ADR 0078](../adr/0078-d1-authoritative-prediction-domain.md)).

The drift monitor is a read-only automation in the same ChatGPT registry, enabled daily at 18:15 Europe/Madrid (DTSTART 2026-10-31). It reads only the live hourly Predictions Task entry (and, until AIR-406 is applied to the live Task, the retired Daily EPG entry as well) and the maintained GitHub contract, and reports confirmed drift or failed execution. It neither reads Worker/MCP status nor watches Ratings. The independent Cloudflare-native monitor owns EPG, Discovery, Ratings and Predictions progress and alerts ([monitor runbook](../runbooks/monitoring.md)). The drift audit shares the scheduler with the producers, so no notification does not prove availability.

A scheduled trigger does not imply successful completion. `already_running`, `busy`, lease ownership, deferred backoff and a previous run's retries that could not yet be written (`prediction_retry_heal_pending`) may prevent new work. The prediction Task, the EPG Task's commit and the discovery chunks can overlap. All three write the prediction queue, and each write is conditional and rebuilds on conflict ([ADR 0064](../adr/0064-prediction-queue-conditional-writes.md), Accepted 2026-10-31), so the overlap does not lose a retry or a batch summary. Discovery runs **one chunk per durable Workflow step** (no HTTP request runs a chunk since AIR-325); it does not recursively self-fetch through an Access bypass or an internal continuation service. The [MCP security boundary](authentication-and-mcp.md) verifies signed identity and restricts tool arguments.

### Projector exclusive window ([ADR 0103](../adr/0103-projector-exclusive-window.md); `D1_ENRICHMENT_WINDOW` read `on` on 10 November 2026)

**Live (ADR 0155).** The hourly cron does not acquire `projector_window`. `D1_ENRICHMENT_WINDOW` starts no production run. A row that is already `requested` or `held` still refuses Discovery admission until it expires.

**Historical: pre-AIR-308 projector.** The following paragraphs describe how a projector run acquired the window. They are not the current cron.

The projector's strict generation pin cannot pass while Discovery writes about seventeen times a minute, so a `D1_ENRICHMENT_WRITE=on` run may first take an exclusive window, behind `D1_ENRICHMENT_WINDOW` (off by default, [flag contract](../reference/feature-flags.md)) and the table `projector_window` of migration `0018` (applied to production on 2026-11-08, one `idle` row). The run asks for the single row; from then on every Discovery lease acquisition (a chunk, a seal, a publish handoff, an owner correction) is refused with the typed busy `projector_window` and its absolute deadline, and the in-flight chunk is not interrupted. When the lease row is free (and no ledger transfer is loading), one D1 batch gives it to the projector and marks the row `held`; the three generation writers that do not need the lease are refused by their own statement while it is held. The run then reads, diffs and writes under the unchanged generation pin, projector lease and batch fences, each batch also asserting that the run still owns an unexpired `held` row, and releases both rows at the end. One absolute deadline (a proposal of 300 s, with at least a minimum run time left at the grant) covers the request and the hold, is never extended, and an expired row is idle for every reader, so a crashed run frees Discovery by itself. The hourly cron, the Scheduled Tasks, the Ratings executor and the monitor do not read the row. An EPG publication that meets the window is answered with a structured `busy` until the deadline and is not failed; the external daily Task contract waits only for a `lease_held` seal busy within about 93 s, so that contract is the activation blocker named in the ADR. Nothing here is activated. The Discovery Workflow treats a refused state write as a soft wait: every caller (progress, wait, busy, start, rollover, final stop, recovery arming and its successor) turns the typed refusal into a value, sleeps to the window's one expiry, re-saves the record afterwards and charges neither the stall nor the recovery budget. A checkpoint (progress, final stop, recovery arming) counts as done only when it is confirmed persisted by the owner: a window refusal is retried after its expiry (at most 24 times, each a bounded sleep), a lost compare-and-swap up to three times, and the step cap bounds both. Exhausted retries are never reported as saved and never as lost ownership; the instance ends in an explicit `deferred` state (`window_checkpoint_unsaved`, `window_stop_unsaved`, `window_recovery_unarmed`, or the `*_write_conflict` forms), the record still names that instance, and the hourly reconcile recovers it. The coordination API itself refuses a window longer than 300 s, a zero or non-integer run time and a malformed clock before any statement runs, and the table repeats the bound as a CHECK.

**Marker fence on every batch ([ADR 0116](../adr/0116-projector-marker-and-generation-fence-on-every-batch.md)).** Every `on` run reads the `film_person_authority` marker first (not `r2`/`prepared`: deferred `authority_unavailable`), and every per-entity and grouped write batch asserts mode, `cutover='open'` and generation inside the batch, so a marker move fails the batch whole (`authority_moved`).

### EPG-priority Discovery pause ([ADR 0135](../adr/0135-epg-priority-discovery-pause.md), Accepted; inert code delivered by AIR-459, not activated)

The gate code is in the Worker but inert: the migration `0022` is not applied, so there is no pause row in production and every statement is today's. Nothing in this section runs until a later, separately authorized activation. The sequence is the shape recorded for the owner decision on [AIR-458](https://trello.com/c/RrtTkNg1): new Discovery admission closes at 16:55 Europe/Madrid by a predicate on the lease write, with no business TTL and no cron at that minute. `sealArchive` moves the Discovery pin first and does not lift the pause. `publishGeneration` later switches the pointer and writes `published_epg_authority.madrid_run_key` from `sync.json.runKey`, frozen when that sync run started. A later Workflow that resumes the seal does not relabel the day with its own `runKey`. The day is not `published_at` and not the live orchestration control. An in-flight chunk may finish. EPG does not run Discovery; it may wait, without a failure count, while a Discovery lease is live. The projector window is a separate hold and is not drawn here. GitHub's own SVG of this figure is a reviewer's check of the blob; a headless session does not run GitHub's Mermaid enricher.

```mermaid
sequenceDiagram
    participant Disc as Discovery admission
    participant D1 as D1
    participant EPG as EPG publication
    Note over Disc,EPG: Accepted, not live. No business TTL. No 16:55 cron.
    Disc->>D1: New acquire after 16:55, pointer unchanged
    D1-->>Disc: Lease unchanged. epg_priority, no failure
    Note over D1: Second statement sets paused while the predicate holds
    Note over Disc: In-flight renew skips the predicate
    EPG->>D1: Acquire while a holder is live
    D1-->>EPG: lease_held, no failure
    Note over EPG: Holder finishes or the 90 s lease expires
    EPG->>D1: Acquire, exempt from the pause
    Note over D1: sealArchive moves the pin. Pointer stays previous.
    EPG->>D1: publishGeneration moves the pointer and clears the row if the pin matches
    Disc->>D1: Previous programme id acquire
    D1-->>Disc: stale_generation, no lease
    Disc->>D1: Published programme id acquire
    D1-->>Disc: admitted
```

### Seal in a successor instance ([ADR 0144](../adr/0144-epg-seal-successor-workflow-instance.md), implemented by AIR-484; production acceptance awaits a natural run)

**State:** the diagram is implemented in `src/epg-orchestration.js`; it has not yet run in production. The successor is the next series id (a terminal Workflow id cannot be created again) and is **not** claimed to get a fresh isolate. After ADR 0145 the producing instance stores `epg/seal/<runId>/publication.json` (no catalog) with `run.seal.layout: 2` and `publicationEtag` beside the ledger `etag`, then saves `sync.json` at `stage: seal`. A leftover `payload.json` run is finished by the legacy reader. A pending claim, even of a previous Madrid day, takes priority over today's start.

```mermaid
sequenceDiagram
    participant P as Producing instance
    participant R2 as R2 publication.json
    participant C as D1 control document
    participant S as Successor instance
    participant H as Hourly ensure
    P->>R2: Store publication.json and save sync.json at stage seal
    P->>C: CAS claim, next series, no failure recorded
    P->>S: create() with the next series id
    Note over P: Ends normally. Takes no more step leases.
    S->>C: Admit against claim and mode revision
    S->>R2: Read publication.json as today
    S->>C: Seal phases ledger then publish, no catalog phase
    Note over H,S: Claim pending while sync.json still says seal
    H->>C: Read claim and successor status
    Note left of H: Absent or unknown, create the same id or attach
    Note left of H: Alive, wait
    H->>C: Errored or terminated, CAS to a new recovery series
    Note left of H: Complete while still seal, fail closed
```

## The separate ratings pipeline

**EPG executor (AIR-348, active).** [ADR 0100](../adr/0100-epg-cloudflare-workflow-executor.md) (Accepted) adds a Cloudflare EPG Workflow that drives the existing `/api/sync/*` steps in-process after an owner-approved three-step switch (`external`, `switching`, `cloudflare`; epoch fence asserted inside the D1 pointer batch). The switch is done: `epg_status` read `mode=cloudflare`, epoch 1, and the first natural run was accepted on 8 November 2026 ([evidence](../evidence/orchestration/epg-first-natural-run-air-348-2026-11-08.md)); the Daily Task is disabled. The diagram below shows the retired Daily Task and is retained as the rollback flow. The hourly cron calls an inert `EpgOrchestration.ensure` next to the projector, Ratings `ensure`, the Discovery reconcile and the monitor, each independent and none sharing a lease; the cron expression is `0 * * * *` since the separate owner-approved AIR-348 change (it was `37 * * * *`). The Ratings Cloudflare executor shares the 17:00 Europe/Madrid logical due time ([ADR 0101](../adr/0101-ratings-logical-due-time-1700.md), which supersedes the 17:30 of ADR 0090 in that one respect); the diagram below shows the legacy Ratings Task and is unchanged.

[ADR 0060](../adr/0060-independent-letterboxd-ratings-pipeline.md) moved Letterboxd ratings out of the EPG commit. [ADR 0074](../adr/0074-retire-ratings-pipeline-switch.md) (Accepted 2026-11-01) makes that the only path: the Worker does not read `RATINGS_PIPELINE`. On supported storage (the removal queue at schema version 2 and the Diary cursor in its merge form, [ADR 0161](../adr/0161-retire-ratings-storage-migration.md)) the commit only enqueues removed films, and the Ratings Task drives its own run with `ratings_sync_start` and `ratings_sync_step`. On any other stored state the commit publishes and does not read Diary, look up films or enqueue; that failure is not drawn here. A live read-only check on 2026-10-31 found the storage migrated, the binding `separate` and the Ratings Task enabled. The registry-only drift audit does not read Ratings status; the Cloudflare-native production monitor observes durable Ratings progress. Neither monitor invokes ratings writers. The one-time owner tool that converted the storage to version 2 no longer exists in the Worker; the commit never called it. The expected recurrence of the Ratings Task, after the owner-approved registry change on 2026-10-31, is daily at 17:30 Europe/Madrid with flexible timing and DTSTART 2026-11-01. A scheduled start is not refused for following the previous one ([ADR 0069](../adr/0069-no-scheduled-ratings-start-gap.md), Accepted). `busy` and `isolated` still end the invocation. The six-hour pause after a Letterboxd 403 or 429 on the removal queue stays. While a rated legacy entry still needs event references, a removal step first lists one page of existing removal events and links the exact film id, then settles stored ratings ([ADR 0071](../adr/0071-legacy-removal-event-link.md), Accepted 2026-10-31). A step with nothing left to link does not list. This page does not change a flag or a task, and it does not start that scan. Contracts: [ratings reference](../reference/integrations/letterboxd-ratings.md#separate-ratings-pipeline), [MCP reference](../reference/api/mcp.md), [Scheduled Tasks](../reference/scheduled-tasks.md#ratings-task); operation: [runbook](../runbooks/letterboxd-diary-history.md#separate-ratings-pipeline).

```mermaid
sequenceDiagram
    actor Daily as Daily EPG Task
    actor Ratings as Ratings Task (17:30, enabled)
    Note over Daily,Ratings: Permanent separate mode on supported storage. Unsupported storage is not drawn here
    participant MCP as Worker MCP
    participant Run as Run record in D1
    participant LB as Letterboxd
    participant D1 as D1 mutable ratings
    participant R2 as Event log in R2
    Note over MCP,D1: Marker d1/open. History, facts, cursor, queue and the run record are D1. Events stay in R2.
    Daily->>MCP: epg_sync_step(runId)
    MCP->>R2: Watchlist removal event
    MCP->>D1: One queue reference for that event
    Note over Daily,R2: The commit reads no Diary and runs no lookup
    Ratings->>MCP: ratings_sync_start(scheduled)
    MCP->>Run: Create run, or answer busy or isolated
    loop While nextAction is continue
        Ratings->>MCP: ratings_sync_step(runId)
        MCP->>Run: Lease the run document
        alt Diary phase
            MCP->>LB: Diary page 1 only
            MCP->>D1: History, facts, then cursor merge, forward only
            MCP->>D1: Queue entry the Diary rated becomes rated
        else Removal phase
            opt Rated legacy entry still needs its event scan
                MCP->>R2: One page of events/items, exact film id only
                MCP->>D1: Store that event key on the queue entry
            end
            MCP->>R2: Stored rating onto each referenced removal event
            MCP->>D1: Mark the queue reference resolved after the event shows it
            MCP->>LB: At most 5 member pages, claim on the queue first
            MCP->>D1: Outcome only under its own claim, then the fact
            MCP->>R2: That confirmed rating onto the removal event
        end
        MCP->>Run: Run counter, end the step
        MCP-->>Ratings: continue, wait or stop
    end
    Note over Ratings,Run: A stale run is closed unknown, never resumed
```

```mermaid
stateDiagram-v2
    [*] --> Diary: ratings_sync_start
    Diary --> Diary: the same page again, when it was not read
    Diary --> Removal: page 1 read
    Diary --> Removal: page 1 blocked, rate-limited or failed
    Removal --> Removal: one legacy-link page while needed, then settle, then up to 5 lookups
    Removal --> Finished: queue done or paused, diary recent window
    Removal --> Error: queue done or paused, diary blocked, rate-limited or failed
    Diary --> Unknown: step lease expired or idle 30 min
    Removal --> Unknown: step lease expired or idle 30 min
    Unknown --> Isolated: second interruption at same phase and checkpoint
    Finished --> [*]
    Error --> [*]
    Unknown --> [*]
    Isolated --> [*]: owner-approved manual start with clearIsolation
```

The run record is one D1 document. It admits one running run and one active step, and the lease is that document. Diary history, the diary cursor, facts and the removal queue are separate D1 documents. A compare-and-swap of one document is one fenced batch: a film record also writes its `ratings_view` rows in that batch, and the batch advances `ratings_domain_authority.generation`. A stale etag leaves the batch uncommitted. Those documents do not fall back to R2. Removal events stay in the R2 event log. There is no transaction across D1 and R2, so a settle writes the event by compare-and-swap and only then marks the queue reference resolved. A kill between the two repeats the event write. The cursor join only moves forward. Its last-attempt diagnostics are a deterministic last-writer-wins record that never plans a read. The queue accepts an outcome only under the step's own claim. History and facts take an idempotent merge, so a late write can add a newer observation and does not move an existing one backwards. A late event merge can add the rating and does not move the D1 fact. The cursor and the queue are authoritative; the run record's checkpoint is a per-run counter. Each removal event keeps its own reference in the queue, and an unresolved one is never pruned. The diagram shows that open marker. The event log still has no multi-key transaction, so a step that outlived its lease is not fenced out of an event object. A removal step lists one page of `events/items/` only while a rated legacy entry still needs that scan, then writes the ratings of rated entries to their removal events (at most 100 references per step), then runs the lookups. With nothing left to link, the list does not run. Deploying this page does not start a ratings run. The ratings run reads Diary page 1 only ([ADR 0067](../adr/0067-diary-recent-window.md)). That is not a byte copy of the earlier multi-page reader. The queue and the cursor forms are unchanged. The separate pipeline runs only on supported storage, the queue at schema version 2 and the cursor in its merge form, and the status reports that as `storage`; on any other stored state the commit fails closed. Nothing in the Worker converts the storage ([ADR 0161](../adr/0161-retire-ratings-storage-migration.md)). A stale run is closed by the next start or step, never by the status read. Ownership, contracts, races and rollback are in the ADR. The diagram is the production mode as of the 2026-10-31 live read (storage migrated, Ratings Task enabled). The Worker does not read `RATINGS_PIPELINE`, `LETTERBOXD_DIARY_HISTORY` ([ADR 0075](../adr/0075-retire-letterboxd-diary-history-switch.md), Accepted 2026-11-01) or `REMOVAL_RATING_LOOKUP` ([ADR 0077](../adr/0077-retire-removal-rating-lookup-switch.md), Proposed). The up-to-five lookups on the Removal loop are that permanent fallback: a film the Diary already rated, or absent from the current Diary page with a confirmed stored fact, is not requested, including after a new reference reopens its queue entry, and a paused queue is not requested. A film that page lists without a rating is still looked up. A null or absent rating is not watched. A step probes at most five stored ratings and does not request a film it has not probed. The state-diagram arrows are unchanged. The sequence diagram draws the open marker ([ADR 0084](../adr/0084-d1-authoritative-ratings.md), Accepted). History, facts, the cursor, the removal queue and the run record go to the D1 participant. Event writes and the event-list page stay on R2. While `0010` is absent, or the marker is `r2`, those documents stay in R2; that state is not drawn. `0010` is applied and the marker is `d1` / `open`. Activation left generation 1 ([activation record](../evidence/d1-migration/air-318-ratings-activate-2026-11-04.md)). A manual MCP run at 08:28 UTC left generation 12 ([manual run](../evidence/d1-migration/air-318-ratings-manual-run-2026-11-04.md)) and did not change the 17:30 Europe/Madrid Ratings Task. The owner visually approved an earlier note on 2026-11-04, while these arrows still pointed at R2. This participant change needs a fresh rendered owner visual approval, as does the persistence arrow. A removal does not become a viewing. Diary page 1, the removal-lookup budgets, and the fail-closed migration states are unchanged. A migrated run enters Diary. One arrow leaves Diary for Removal when page 1 was read. A second leaves Diary for Removal when that request was blocked, rate-limited or failed and the page was not read: the removal phase still runs, and the run ends `error` on the arrow from Removal to Error. There is no off-gate arrow. Neither this diagram nor a deploy changes a task or deletes a leftover binding.

## Historical design snapshot: proposed Cloudflare executors (ADR 0089, 4 Nov 2026)

**Historical (drawn 4 Nov 2026).** Both diagrams below show the then-future implementation of [ADR 0089](../adr/0089-shared-orchestration-reliability-contract.md) (Accepted; both diagrams visually approved by the owner on 2026-11-04). The accepted ADR is unchanged. At the time of that drawing, EPG, Discovery and Ratings were still driven by the external tasks above, the Discovery Workflow was inert, and the cron ran the enrichment projector plus inert ratings `ensure` and Discovery `reconcile`. **Current production (16 Nov 2026 UTC):** EPG and Ratings run as Cloudflare Workflow executors (`mode=cloudflare`); Discovery is executed by the Cloudflare Discovery Workflow; the hourly cron runs EPG `ensure`, Ratings `ensure`, Discovery reconcile and Producer reconcile. It does not run the enrichment projector (ADR 0155). The Daily EPG and Ratings Tasks are retired. Each domain moved to its executor through its own owner-approved switch; the field-level contract is the [orchestration reliability reference](../reference/orchestration-reliability.md).

```mermaid
flowchart TD
    cron["Worker cron: UTC firings,<br/>Madrid logical schedule"]
    subgraph epgDomain["EPG domain"]
        ensureEpg["ensure: reads, at most one create"]
        epgCtl[("D1 control record:<br/>mode, epoch, Madrid date, budget")]
        epgWf["Workflow instance:<br/>one bounded step each"]
        epgAuth[("D1 published generation;<br/>R2 raw XML and mirrors")]
        ensureEpg --> epgCtl --> epgWf -->|write, then checkpoint| epgAuth
    end
    subgraph discDomain["Discovery domain, after its D1 marker is open"]
        ensureDisc["ensure: reads, at most one create"]
        discCtl[("D1 control record:<br/>generation, series, budget")]
        discWf["Workflow instance:<br/>one chunk per step"]
        discAuth[("D1 discovery ledger")]
        ensureDisc --> discCtl --> discWf -->|write, then checkpoint| discAuth
    end
    subgraph ratDomain["Ratings domain"]
        ensureRat["ensure: reads, at most one create"]
        ratCtl[("D1 control record:<br/>Madrid date, budget")]
        ratWf["Workflow instance:<br/>one bounded step each"]
        ratAuth[("D1 ratings documents;<br/>R2 removal events")]
        ensureRat --> ratCtl --> ratWf -->|write, then checkpoint| ratAuth
    end
    status["Read-only status routes:<br/>orchestration read model"]
    monitor["External monitor and alert,<br/>outside ChatGPT"]
    hourly["Hourly ChatGPT Task:<br/>Predictions only"]
    cron --> ensureEpg & ensureDisc & ensureRat
    epgAuth -.->|fast path: queue fenced intent| discCtl
    epgAuth -.->|ensure reconstructs intent from published generation| ensureDisc
    epgAuth & discAuth & ratAuth -.->|read only| status
    status -.-> monitor
```

The three domains share no lease, queue, store or Workflow instance; the only shared element is the clock. Each domain commit to D1 compares the epoch and mode in the same batch; R2 side effects are idempotent and bounded by the lease, and a mode switch is close admission, verified drain, then complete ([reference](../reference/orchestration-reliability.md#mode-switch-and-write-fencing)). Each instance writes its domain data first and then its fenced checkpoint and budget into its own control record, compared against the epoch. Each `ensure` runs no chunk, download or lookup. It reads its own control record and creates or attaches at most one instance with an id derived from the run key, so a duplicate firing attaches to the same instance. EPG publication may queue Discovery's fenced intent as a fast path, not in one transaction with the pointer switch; `ensure Discovery` reconstructs the intent from the published generation if that write is missing, and EPG never waits for Discovery. The dotted arrows to the status routes are reads only; the read model reads each domain's control record and its authority.

```mermaid
stateDiagram-v2
    [*] --> Idle
    Idle --> Due: due
    Due --> Running: owner CAS won
    Running --> Due: checkpoint read back, more work
    Running --> Idle: checkpoint read back, run key done
    Running --> Unknown: outcome lost
    Unknown --> Due: write found
    Unknown --> Cooldown: no write
    Running --> Cooldown: transient
    Cooldown --> Due: cooldown over
    Running --> Quarantined: unsafe, or cap reached
    Unknown --> Quarantined: unreadable, or cap reached
    Running --> FailedPermanent: credentials or contract
    FailedPermanent --> Due: precondition holds
    Quarantined --> Due: next run key or owner clear
```

`Due` includes a known future wake (`retryAt`, `Retry-After`, a pause or a lease), which the read model reports as `waiting`. `Unknown` means a timeout, a lost response or a killed step, resolved only by reading back. A duplicate firing while a run is `Due` or `Running` attaches to it. `Quarantined` returns to `Due` on the next run key only after a budget exhaustion; after unsafe evidence only an owner-approved clear does. Only a read-back checkpoint that moved forward resets the consecutive failure count; a create, an HTTP 200 or a lease does not. The executor never forces a step, never resets a lease and never clears its own quarantine. Predictions are outside both diagrams and stay on the hourly ChatGPT task.

## Canonical Film/Person writer routing

The hourly cron does not run the D1 enrichment projector (ADR 0155). After the EPG mirror reconcile, `EpgOrchestration.ensure` also calls `reconcileProducerChain` ([ADR 0141](../adr/0141-producer-workflow-chain-protocol.md)). That call stays dormant unless the Film/Person marker is `d1`/`open` **and** the `PRODUCER_WORKFLOW` binding exists; it never throws into `ensure`. There is no new cron, flag or Scheduled Task. With the marker at `open` (generation 2 as of 16 Nov 2026 UTC) the fenced adapters are the only canonical Film/Person writers. The hourly projector no longer runs; its former compare-only behaviour at `open` is historical, and the Producer Workflow chain is the EPG-origin producer when the binding exists. A first natural chain run at `open` is unproven. A projector batch built before the move carries a fence assertion on the marker generation and fails whole, so the two writers never overlap. No timing of the existing cron changes. The enrichment-projection sequence on this page labels compare-only at `open`; it does not claim a completed Producer Workflow run.

## Timing and authority

The timetable and enabled status belong to the external automation registry. The Worker does not store that recurrence and does not display a next Task time; it keeps its own discovery wait gate apart from registry clocks; see [Scheduled Task timing](../reference/scheduled-tasks.md#timing-nominal-trigger-versus-server-gate). Historical records of successful scheduling are not a live status check; production task changes or manual invocations require separate owner approval. A GitHub deployment does not trigger any of these workflows.

## Ratings executor implementation (AIR-347)

The hourly cron calls `RatingsOrchestration.ensure` in the same `allSettled` as the EPG ensure and the monitor. It is inert unless the D1-owned mode document says `cloudflare`; then it claims the Madrid date by CAS and creates one `RatingsWorkflow` instance. The instance loops `start`/`step` with `sleepUntil` between actions and commits through the etag epoch fence. See [ADR 0090](../adr/0090-ratings-cloudflare-workflow-executor.md).

## Discovery Workflow handover ([ADR 0094](../adr/0094-discovery-workflow-invocation-budget.md), Accepted)

A Discovery Workflow instance hands over to a successor at 20 chunks or when the D1 statements it has issued reach 6,000, whichever comes first, so no instance runs into the level at which two instances failed on 6 November 2026. The durable steps, the owner fence and the recovery are those of [ADR 0083](../adr/0083-inert-discovery-workflow.md); no diagram changes.

## Controlled Discovery Workflow rollover ([ADR 0164](../adr/0164-controlled-discovery-workflow-rollover.md), Accepted)

An instance keeps the Worker version it was created on until its own handover. The owner can move Discovery onto the deployed version earlier with the owner-only MCP tool `discovery_workflow_rollover` ([runbook](../runbooks/discovery-workflow-rollover.md)). It is never called by the cron, a Workflow schedule or a Scheduled Task. The only ownership change is one compare-and-swap of the executor record, admitted only while the owner sleeps durably; the old instance then fails its own owner gate when it wakes. A create that cannot be confirmed is recovered by the hourly reconcile under the same deterministic id.

```mermaid
sequenceDiagram
    autonumber
    participant Owner as Owner via /mcp (Access JWT)
    participant Op as Rollover operator in the Worker
    participant D1 as D1 executor record and gates
    participant CF as Cloudflare Workflows
    participant Old as Old instance (asleep)
    participant New as Successor instance
    participant Cron as Hourly reconcile

    Owner->>Op: dry_run
    Op->>D1: Read authority, pin, record, checkpoint, lease, gates
    Op->>CF: Read owner instance status
    Op-->>Owner: eligible, already_current, unsafe or unknown, with expect pins
    Note over Op,D1: dry_run writes nothing
    Owner->>Op: apply with confirmGo, requestId and the expect pins
    Op->>D1: Same reads again, pins and eligibility re-checked
    alt Not eligible, stale pin, generation moved or refused write
        Op-->>Owner: Refusal, writes 0
    else Eligible
        Op->>D1: Pinned CAS: successor named, starting
        Note over Op,D1: Same statement checks the generation. Report, outbox, receipt carried
        Op->>CF: Create discovery_generation_series+1
        alt Created or already exists
            Op->>D1: Settle running while still starting for that id
        else Create uncertain or failed
            Op->>D1: Settle uncertain with the start recovery due time
            Cron->>D1: When due, read the record
            Cron->>CF: Create the same deterministic id
        end
        Op->>D1: Read back owner, checkpoint revision, recorded version
        Op->>CF: Read back successor status
        Op-->>Owner: Receipt: accepted, version confirmed or pending
        New->>D1: First step records its own Worker version
        Old->>D1: Wakes, owner gate reads another instance
        Old-->>Old: Stops without a write
    end
```

The sequence shows only the operator path. The natural handover, the step-failure recovery and the reconcile are unchanged. The diagram is not evidence that a live apply ran; each production `apply` needs its own owner approval.

## Discovery Workflow step-failure recovery ([ADR 0098](../adr/0098-discovery-workflow-step-failure-recovery.md), Accepted)

An instance whose step fails after the platform's retries, with a recognised transient failure (the `discovery_unavailable` code or a transient class), arms the existing recovery once, sleeps durably until `recovery.dueAt` (60 s for the first failure, then 5 min, 15 min, 1 h; four, then quarantine) and, after re-checking owner, authority, pinned generation and mode, opens the deterministic successor through `ensureDiscoveryWorkflow`. The hourly cron remains the fallback and covers what this cannot: an instance killed by the platform, a failure of the arming step, and a `stopped` record without a live owner. No trigger, binding or cron changes; no diagram changes.

## Monitor tick (AIR-349)

The hourly cron also calls `Monitor.run`, which does nothing unless `MONITOR` is `on` (`off` is a permanent emergency gate that also stops the dead-man heartbeat). It reads status records the domains keep, never calls `ensure`, `reconcile` or a resolver, and writes only `monitor/state.json`. Recovery stays with the domain executors ([ADR 0089](../adr/0089-shared-orchestration-reliability-contract.md)). See [ADR 0095](../adr/0095-cloudflare-native-production-monitor.md).

## EPG diagnostic canary (retired)

The canary flow (route, Workflow, diagnostic D1 and R2) is gone: [ADR 0159](../adr/0159-detach-epg-diagnostic-runtime.md) detached it and [ADR 0161](../adr/0160-delete-epg-diagnostic-canary-code.md) deleted the code. Its diagram was removed with it; the original design stays in ADR 0121/0124 as history.

