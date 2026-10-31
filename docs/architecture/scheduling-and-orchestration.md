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

A scheduled trigger does not imply successful completion. `already_running`, `busy`, lease ownership and deferred backoff may prevent new work. The prediction Task, the EPG Task's commit and the discovery chunks can overlap. All three write the prediction queue, and each write is conditional and rebuilds on conflict ([ADR 0061](../adr/0061-prediction-queue-conditional-writes.md), Proposed), so the overlap does not lose a retry or a batch summary. Discovery uses **one chunk per explicit request**; it does not recursively self-fetch through an Access bypass or an internal continuation service. The [MCP security boundary](authentication-and-mcp.md) verifies signed identity and restricts tool arguments.

The timetable and enabled status belong to the external automation registry. The Worker states only the expected hourly trigger (`:20` Europe/Madrid) for display and keeps it apart from its own discovery wait gate; see [Scheduled Task timing](../reference/scheduled-tasks.md#timing-nominal-trigger-versus-server-gate). Historical records of successful scheduling are not a live status check; production task changes or manual invocations require separate owner approval. A GitHub deployment does not trigger any of these workflows.
