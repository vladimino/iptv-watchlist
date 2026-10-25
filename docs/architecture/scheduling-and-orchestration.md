# Scheduling and orchestration

Scheduling is performed by **external ChatGPT Scheduled Tasks**, not Worker Cron. The Worker exposes owner-only MCP tools that perform work only when invoked. Sources: [scheduling ADR](../adr/0005-external-chatgpt-tasks.md), [one-chunk ADR](../adr/0006-one-chunk-discovery.md), [MCP contract](../reference/api/mcp.md) and [prediction operations](../runbooks/prediction-operations.md).

```mermaid
sequenceDiagram
    actor Task as External ChatGPT Scheduled Task
    participant Access as Cloudflare Access
    participant MCP as Worker MCP endpoint
    participant EPG as EPG sync and discovery handlers
    participant Runner as Prediction queue runner
    participant R2 as R2 authoritative state
    Note over Task,R2: Scheduling state lives outside GitHub and Worker Cron
    Task->>Access: Owner-authorized MCP request
    Access->>MCP: Forward protected request with Access identity
    alt EPG scheduled workflow
        Task->>MCP: epg_sync_start
        MCP->>EPG: Start or inspect existing EPG run
        EPG->>R2: Save checkpoints and publication state
        loop Explicit next steps while allowed
            Task->>MCP: epg_sync_step with runId
            MCP->>EPG: Advance one step or discovery chunk
            EPG->>R2: Save results and retry state
            MCP-->>Task: stage and nextAction
        end
    else Prediction scheduled workflow
        Task->>MCP: prediction_start
        MCP->>Runner: Acquire or check lease
        loop Work while allowed
            Task->>MCP: prediction_next and prediction_submit
            MCP->>Runner: Validate and checkpoint one film
            Runner->>R2: Persist outcomes
        end
        Task->>MCP: prediction_complete on eligible stop
    end
```

A scheduled trigger does not imply successful completion. `already_running`, `busy`, lease ownership and deferred backoff may prevent new work. Discovery uses **one chunk per explicit request**; it does not recursively self-fetch through an Access bypass or an internal continuation service. The [MCP security boundary](authentication-and-mcp.md) verifies signed identity and restricts tool arguments.

The timetable and enabled status belong to the external automation registry. Historical records of successful scheduling are not a live status check; production task changes or manual invocations require separate owner approval. A GitHub deployment does not trigger any of these workflows.
