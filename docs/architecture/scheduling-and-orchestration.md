# Scheduling and orchestration

Scheduling is performed by **external ChatGPT Scheduled Tasks**, not Worker Cron. The Worker exposes owner-only MCP tools that perform work only when invoked. Expected task behavior: [Scheduled Task contract](../reference/scheduled-tasks.md). Sources: [scheduling ADR](../adr/0005-external-chatgpt-tasks.md), [one-chunk ADR](../adr/0006-one-chunk-discovery.md), [MCP contract](../reference/api/mcp.md) and [prediction operations](../runbooks/prediction-operations.md).

```mermaid
sequenceDiagram
    actor Daily as Daily EPG Task (17:00)
    actor Hourly as Hourly Task (hourly)
    participant Access as Cloudflare Access
    participant MCP as Worker MCP
    participant EPG as EPG and discovery
    participant Runner as Prediction runner
    participant R2 as Authoritative R2
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
        Note over Hourly,EPG: Fail closed; never start a new EPG run
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
```

A scheduled trigger does not imply successful completion. `already_running`, `busy`, lease ownership and deferred backoff may prevent new work. Discovery uses **one chunk per explicit request**; it does not recursively self-fetch through an Access bypass or an internal continuation service. The [MCP security boundary](authentication-and-mcp.md) verifies signed identity and restricts tool arguments.

The timetable and enabled status belong to the external automation registry. Historical records of successful scheduling are not a live status check; production task changes or manual invocations require separate owner approval. A GitHub deployment does not trigger any of these workflows.
