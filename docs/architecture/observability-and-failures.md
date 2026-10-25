# Observability and failure attribution

A recorded server response is **not proof that a client received it**. Worker diagnostics, caller-attributed faults and historical evidence must remain distinct. Sources: [run diagnostics contract](../reference/api/run-diagnostics.md), [prediction diagnostics](../reference/api/prediction-diagnostics.md), [failure provenance ADR](../adr/0016-run-diagnostic-provenance.md) and [prediction operations](../runbooks/prediction-operations.md).

```mermaid
flowchart TD
    requestStep["MCP or HTTP runner step"]
    server["Worker step diagnostic"]
    outcome{"What did the Worker observe?"}
    entered["Attempt entered"]
    produced["Response formed"]
    failed["Handler failure"]
    delivery["Delivery remains unconfirmed"]
    caller{"Did caller later report a matching requestId?"}
    acknowledged["Caller acknowledgement recorded"]
    unknown["No receipt claim"]
    fault["Caller-reported fault with origin and failedStep"]
    status["Read-only status and diagnostics projection"]
    requestStep --> server --> outcome
    outcome --> entered
    outcome --> produced --> delivery
    outcome --> failed --> status
    entered --> status
    delivery --> caller
    caller -->|yes| acknowledged --> status
    caller -->|no| unknown --> status
    requestStep -.->|separate later completion report| fault --> status
```

A step can be `entered`, `produced` or `failed`. The persisted server record retains `delivery: unconfirmed`; a later caller-supplied `receivedRequestId` can acknowledge only the matching step. External stops without attributed fault data remain `external_unattributed`. A caller's `origin` is recorded as a **caller report**, not reclassified as a server-observed cause. One item validation failure and retry backoff are not automatically system failures.

The owner-only diagnostic MCP tools [documented here](../reference/api/prediction-diagnostics.md) expose bounded queue state and per-film evidence; they do not themselves retry items, restart runs or migrate storage. Historical Events and dated investigation reports are **not** proof of present task scheduling, provider health or live flags. Always distinguish request attempt, formed response, caller acknowledgement, completed run and external Scheduled Task execution.

## EPG continuation step diagnostics

The same attempt / formed-response / failure distinction applies to the EPG resolver continuation ([AIR-151](https://trello.com/c/iZ7TR7y0)). Each `epg_sync_step` or discovery resolve request that reaches the Worker handler is one **step entry** with two channels of different reliability. The Worker log gets an `entered` line before any storage access and a `completed` (a response was formed, whatever its status) or `failed` (the handler threw) line afterwards, both carrying the same entry `id`; this is the arrival evidence. The ring `epg/resolver-continuation-diagnostics.json` (last 20 entries, read through `GET /api/enrichment/pipeline/status` / `epg_pipeline_status` as `continuationDiagnostics`) receives the same entry best effort, `entered` first and the outcome after, and the final log line says whether each write succeeded (`recorded`). The entry records the caller boundary (`mcp`, `http`, `internal`), the route and branch taken, the `discovery` contract returned and the `advanceDiscovery` trace: continuation record before, lease state, decision, hop id, chunk outcome and the record after.

What the data can and cannot establish: a `completed` entry whose branch explains why no chunk was saved (`lease_live`, `contract` with `wait`/`stop`, `missing_secret`, a chunk `error`, or `saved.owned: false`) is server-observed; an `entered` log line with no outcome line of the same `id` shows the request was interrupted after arrival; an `entered` ring entry with no outcome shows the same when the outcome write failed or the isolate died. The absence of a ring entry is only *no persisted evidence* (the write can fail silently and 20 later steps evict it). The absence of both log lines within the log retention window shows that no request reached the Worker handler; it does not show where it stopped, because a request rejected by Cloudflare Access (`401`/`403`), dropped by the client or never sent leaves the same absence. Entries carry codes from closed vocabularies, UUIDs, timestamps and counts only (thrown messages are classified, never copied), and recording them never retries or dispatches anything. The fields are in [the MCP contract](../reference/api/mcp.md#continuation-diagnostics-air-151); the reading procedure is in [the connectivity runbook](../runbooks/mcp-connectivity.md#diagnosing-a-stalled-epg-continuation).

No live operations are introduced by this page.
