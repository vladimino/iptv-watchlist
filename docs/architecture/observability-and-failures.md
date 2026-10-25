# Observability and failure attribution

A recorded server response is **not proof that a client received it**. Worker diagnostics, caller-attributed faults and historical evidence must remain distinct. Sources: [run diagnostics contract](../reference/api/run-diagnostics.md), [prediction diagnostics](../reference/api/prediction-diagnostics.md), [failure provenance ADR](../adr/0016-run-diagnostic-provenance.md) and [prediction operations](../runbooks/prediction-operations.md).

```mermaid
flowchart TD
    call["MCP or HTTP runner step"]
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
    call --> server --> outcome
    outcome --> entered
    outcome --> produced --> delivery
    outcome --> failed --> status
    entered --> status
    delivery --> caller
    caller -->|yes| acknowledged --> status
    caller -->|no| unknown --> status
    call -.->|separate later completion report| fault --> status
```

A step can be `entered`, `produced` or `failed`. The persisted server record retains `delivery: unconfirmed`; a later caller-supplied `receivedRequestId` can acknowledge only the matching step. External stops without attributed fault data remain `external_unattributed`. A caller's `origin` is recorded as a **caller report**, not reclassified as a server-observed cause. One item validation failure and retry backoff are not automatically system failures.

The owner-only diagnostic MCP tools [documented here](../reference/api/prediction-diagnostics.md) expose bounded queue state and per-film evidence; they do not themselves retry items, restart runs or migrate storage. Historical Events and dated investigation reports are **not** proof of present task scheduling, provider health or live flags. Always distinguish request attempt, formed response, caller acknowledgement, completed run and external Scheduled Task execution.

No live operations or new telemetry instrumentation are introduced by this page.
