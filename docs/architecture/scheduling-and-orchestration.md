# Scheduling and orchestration

Scheduling is performed by **external ChatGPT Scheduled Tasks**, not Worker Cron. The Worker's one cron trigger runs only the D1 enrichment projector ([ADR 0056](../adr/0056-d1-enrichment-write-through.md)), shown last in the diagram: it reads R2, writes only D1, and stays inert while `D1_ENRICHMENT_WRITE` is unset. The Worker exposes owner-only MCP tools that perform work only when invoked. Expected task behavior: [Scheduled Task contract](../reference/scheduled-tasks.md). Sources: [scheduling ADR](../adr/0005-external-chatgpt-tasks.md), [one-chunk ADR](../adr/0006-one-chunk-discovery.md), [MCP contract](../reference/api/mcp.md) and [prediction operations](../runbooks/prediction-operations.md).

```mermaid
sequenceDiagram
    actor Daily as Daily EPG Task (17:00)
    actor Hourly as Hourly Task (hourly)
    actor Monitor as Drift monitor (17:45, read-only)
    actor Owner as Owner
    participant Registry as Task registry
    participant Access as Cloudflare Access
    participant MCP as Worker MCP
    participant EPG as EPG and discovery
    participant Runner as Prediction runner
    participant R2 as Authoritative R2
    participant Cron as Worker cron trigger (37 * * * *)
    participant Projector as D1 enrichment projector
    participant D1 as D1 iptv
    Note over Daily,R2: External ChatGPT tasks, never Worker Cron
    Daily->>Access: Authorize daily EPG workflow
    Access->>MCP: JWT verified
    Daily->>MCP: Preflight EPG status
    Daily->>MCP: epg_sync_start once
    MCP->>EPG: Start owned EPG run
    loop Metadata, publication, and allowed discovery steps
        Daily->>MCP: epg_sync_step(runId)
        MCP->>EPG: One step or one chunk
        EPG->>R2: Checkpoint / publish generation
        MCP-->>Daily: stage and nextAction
    end
    Note over Daily,EPG: wait / stop / conflict ends current series
    Hourly->>Access: Authorize hourly workflow
    Access->>MCP: JWT verified
    Hourly->>MCP: epg_status and epg_pipeline_status
    MCP-->>Hourly: Published runId, continuation and health
    alt Safe paused continuation of published generation
        Hourly->>MCP: epg_sync_step(published runId)
        MCP->>EPG: One discovery chunk
        EPG->>R2: Fenced writes and checkpoint
        MCP-->>Hourly: nextAction / nextCatchUpAt
    else Running and Worker health proves orphaned
        Note over Hourly,MCP: Expired lease, same generation, valid budget, no wait
        Hourly->>MCP: epg_sync_step(published runId)
        MCP->>EPG: CAS settle or resume, then at most one chunk
        EPG->>R2: Fenced continuation and chunk writes
        MCP-->>Hourly: nextAction / nextCatchUpAt
    else Live, unknown or generation conflict
        Note over Hourly,EPG: Fail closed and do not start a new EPG run
    end
    opt Server explicitly returns continue, same generation and safe budget
        loop While safe nextAction is continue
            Hourly->>MCP: epg_sync_step(published runId)
            MCP->>EPG: One discovery chunk
            MCP-->>Hourly: continue / wait / stop
        end
    end
    Hourly->>MCP: Runner, schema, profile, queue preflight
    Hourly->>MCP: prediction_start(scheduled) once
    MCP->>Runner: Acquire owned run / check lease
    loop Eligible server-sized batches
        Hourly->>MCP: prediction_next
        MCP-->>Hourly: Item and fingerprint mode
        Hourly->>MCP: prediction_validate(exact objects)
        MCP-->>Hourly: Validity, contract version, checked flags
        alt Full preflight passes
            Hourly->>MCP: prediction_submit
            MCP->>Runner: Revalidate and persist
            Runner->>R2: Store outcome
        else Validation unavailable or invalid
            Note over Hourly,Runner: Correct / revalidate or fail closed
        end
    end
    Hourly->>MCP: prediction_complete on allowed owned stop
    Note over Monitor,Registry: Read-only monitor, never a producer or a task editor
    Monitor->>Registry: Read the EPG and hourly task entries
    Registry-->>Monitor: Enabled state, recurrence, prompt, latest run
    Monitor->>Access: Authorize read-only status
    Access->>MCP: JWT verified
    Monitor->>MCP: epg_status
    MCP-->>Monitor: stage, runId, updatedAt, ratings outcome
    Note over Monitor,Owner: Compare with the Scheduled Task contract on main
    opt Disabled task, failed run, drift, no live evidence or no EPG today
        Monitor->>Owner: Notification with the observed state
    end
    Note over Cron,D1: The one Worker cron trigger, inert while D1_ENRICHMENT_WRITE is unset (ADR 0056)
    Cron->>Projector: Scheduled event, hourly
    opt D1_ENRICHMENT_WRITE is dry or on
        Projector->>R2: Read the enrichment objects of the published generation
        Projector->>D1: Read change keys
    end
    opt D1_ENRICHMENT_WRITE is on and the inputs are complete
        Projector->>D1: Changed Films and Persons with their keys, one batch each
    end
```

The drift monitor is a third, read-only automation in the same registry. It compares the two producers' live entries with the [contract](../reference/scheduled-tasks.md#read-only-drift-monitor), reads `epg_status` through the same Access-protected MCP and only notifies the owner; it cannot edit a task or start a run, and it can itself stop or run late, so it is not a guaranteed alert. A staged Ratings Task also exists in the registry but is disabled and is not drawn: ratings still run inside the EPG commit that the daily task's `epg_sync_step` triggers.

A scheduled trigger does not imply successful completion. `already_running`, `busy`, lease ownership and deferred backoff may prevent new work. Discovery uses **one chunk per explicit request**; it does not recursively self-fetch through an Access bypass or an internal continuation service. The [MCP security boundary](authentication-and-mcp.md) verifies signed identity and restricts tool arguments.

## Proposed: a separate ratings pipeline (not implemented)

[ADR 0060](../adr/0060-independent-letterboxd-ratings-pipeline.md) proposes moving the Letterboxd ratings out of the EPG commit. Nothing below is deployed: today ratings run inside the commit as in the diagram above. In the proposal the commit only enqueues removed films, and the Ratings Task drives its own run through three dedicated tools.

```mermaid
sequenceDiagram
    actor Daily as Daily EPG Task
    actor Ratings as Ratings Task (proposed)
    participant MCP as Worker MCP
    participant Run as Ratings run record
    participant LB as Letterboxd
    participant R2 as Authoritative R2
    Daily->>MCP: epg_sync_step(runId)
    MCP->>R2: Watchlist events, then one queue reference per removal event
    Note over Daily,R2: The commit reads no Diary and runs no lookup
    Ratings->>MCP: ratings_sync_start(scheduled)
    MCP->>Run: Create run, or answer busy, too_soon or isolated
    loop While nextAction is continue
        Ratings->>MCP: ratings_sync_step(runId)
        MCP->>Run: Begin the step: lease by compare-and-swap
        alt Diary phase
            MCP->>LB: At most 3 Diary pages
            MCP->>R2: Per page: history, facts, then cursor merge, progress forward only
            MCP->>R2: Queued films the Diary rated: every referenced removal event
        else Removal phase
            MCP->>LB: At most 5 member pages, attempt claimed first
            MCP->>R2: Outcome only under its own claim token, then fact and events
        end
        MCP->>Run: Run counter, end the step
        MCP-->>Ratings: continue, wait or stop
    end
    Note over Ratings,Run: A stale run is closed unknown, never resumed
```

```mermaid
stateDiagram-v2
    [*] --> Diary: ratings_sync_start
    Diary --> Diary: step, up to 3 pages
    Diary --> Removal: diary ended or run budget used
    Removal --> Removal: step, up to 5 lookups
    Removal --> Finished: queue done or paused, diary complete or partial
    Removal --> Error: queue done or paused, diary blocked, rate-limited or failed
    Diary --> Unknown: step lease expired or idle 30 min
    Removal --> Unknown: step lease expired or idle 30 min
    Unknown --> Isolated: second interruption at same phase and checkpoint
    Finished --> [*]
    Error --> [*]
    Unknown --> [*]
    Isolated --> [*]: owner-approved manual start with clearIsolation
```

The run record `letterboxd/ratings/run.json` admits one running run and one active step at a time, and the lease owns only that object. R2 has no multi-key transaction, so a step that outlived its lease cannot be fenced out of other objects; instead every shared object changes by a monotone merge. The Diary cursor's progress in `letterboxd/diary/state.json` is a join that only moves forward (its last-attempt diagnostics are a deterministic last-writer-wins record that never plans a read), removal-queue entries move one way and accept an outcome only under the step's own claim, and the history, facts and removal events take idempotent merges, so a late write can add real progress and never move anything back. The cursor and the queue are authoritative; the run record's checkpoint is a per-run counter. Each removal event keeps its own reference in the queue, and an unresolved one is never pruned. The diagram shows `RATINGS_PIPELINE=separate` after the storage migration. Deploying the code changes nothing: under `inline` with unmigrated objects today's path stays unchanged. The queue and the cursor are migrated only by the owner-approved `ratings_storage_migrate` tool, run under `inline` before the switch, and `separate` takes effect only once that migration is complete. A stale run is closed by the next start or step, never by the status read. Ownership, contracts, races, migration and rollback are in the ADR; activation is a separate owner decision.

## Timing and authority

The timetable and enabled status belong to the external automation registry. The Worker states only the expected hourly trigger (`:20` Europe/Madrid) for display and keeps it apart from its own discovery wait gate; see [Scheduled Task timing](../reference/scheduled-tasks.md#timing-nominal-trigger-versus-server-gate). Historical records of successful scheduling are not a live status check; production task changes or manual invocations require separate owner approval. A GitHub deployment does not trigger any of these workflows.
