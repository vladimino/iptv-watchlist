# Scheduling and orchestration

Scheduling is performed by **external ChatGPT Scheduled Tasks**, not Worker Cron. The Worker's one cron trigger runs only the D1 enrichment projector ([ADR 0056](../adr/0056-d1-enrichment-write-through.md)), shown last in the diagram: it reads R2, writes only D1, and stays inert while `D1_ENRICHMENT_WRITE` is unset. The Worker exposes owner-only MCP tools that perform work only when invoked. Expected task behavior: [Scheduled Task contract](../reference/scheduled-tasks.md). Sources: [scheduling ADR](../adr/0005-external-chatgpt-tasks.md), [one-chunk ADR](../adr/0006-one-chunk-discovery.md), [MCP contract](../reference/api/mcp.md) and [prediction operations](../runbooks/prediction-operations.md).

```mermaid
sequenceDiagram
    actor Daily as Daily EPG Task (17:00)
    actor Hourly as Hourly Task (hourly)
    actor Audit as Daily read-only audit (17:45)
    actor Owner as Owner
    participant Access as Cloudflare Access
    participant MCP as Worker MCP
    participant Registry as ChatGPT Task registry
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
    Note over Audit,Registry: Separate daily monitor; no task mutations
    Audit->>Registry: Read two production task definitions and latest runs
    Audit->>Access: Authorize read-only EPG status
    Access->>MCP: JWT verified
    Audit->>MCP: epg_status (read-only)
    MCP-->>Audit: Published runId, stage, updatedAt
    Note over Audit,Registry: Compare expected prompts and schedules in main
    opt Disabled, drift, failed run or missing today's EPG
        Audit-->>Owner: Alert with observed status and uncertainty
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

The separate 17:45 Europe/Madrid audit is a read-only Scheduled Task that compares the two production tasks' live registry state with the maintained contract and checks EPG publication through owner-only MCP. It cannot edit task state or start an EPG run. The audit can itself silently stop or run late, so its notifications are not a guaranteed service-level alert (see [the monitoring runbook](../runbooks/scheduled-task-drift.md)).

A scheduled trigger does not imply successful completion. `already_running`, `busy`, lease ownership and deferred backoff may prevent new work. Discovery uses **one chunk per explicit request**; it does not recursively self-fetch through an Access bypass or an internal continuation service. The [MCP security boundary](authentication-and-mcp.md) verifies signed identity and restricts tool arguments.

The timetable and enabled status belong to the external automation registry. The Worker states only the expected hourly trigger (`:20` Europe/Madrid) for display and keeps it apart from its own discovery wait gate; see [Scheduled Task timing](../reference/scheduled-tasks.md#timing-nominal-trigger-versus-server-gate). Historical records of successful scheduling are not a live status check; production task changes or manual invocations require separate owner approval. A GitHub deployment does not trigger any of these workflows.
