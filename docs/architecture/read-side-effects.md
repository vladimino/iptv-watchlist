# Read paths and repair owners

This page shows what a GET, a HEAD or an MCP read tool may touch, which reads **still write today** and which writer owns each repair. It follows [ADR 0107](../adr/0107-get-head-read-side-effect-boundary.md) (Accepted) and [ADR 0108](../adr/0108-epg-mirror-reconciliation-writer.md) (Proposed). Solid arrows are current behavior verified by `tests/get-write-audit.mjs`; the dashed arrows are the remaining **target** for prediction-run settlement, the event outbox and the ratings-seed overlay. Nothing here authorizes a production operation.

```mermaid
flowchart LR
    client["Browser, admin or MCP client"]
    subgraph Read["GET and HEAD"]
        pure["Pure read"]
        helper["Helpers that still write:<br/>run history, stop events, ratings seed"]
    end
    subgraph Writers["Named writers"]
        epg["EPG hourly ensure"]
        pred["Predictions writer"]
        outbox["Predictions event outbox"]
    end
    subgraph Storage["Storage"]
        d1[("D1: published generation,<br/>prediction domain")]
        r2[("R2: compatibility mirrors,<br/>runs, journal")]
    end
    client --> pure
    client --> helper
    pure -->|"SELECT and get only"| d1
    pure -->|"get only"| r2
    helper -->|"prediction fence UPDATE"| d1
    helper -->|"put run and journal"| r2
    epg -->|"fenced mirror reconcile"| r2
    epg --> d1
    pred -.->|"target: run and lease"| r2
    pred -.->|"target: D1 prediction intent"| d1
    outbox -.->|"target: event delivery"| r2
```

## How to read it

- **Every read route, page and MCP read tool ends in `pure` for the published EPG.** The `helper` branch is still taken by the view, status, runs and events reads and by MCP `enrichment_status` (the exact list and the exact effects are the baseline in [read side effects](../reference/api/read-side-effects.md)).
- **Compatibility mirrors are the EPG writer's job.** GET never calls `repairMirrors`. The hourly `EpgOrchestration.ensure` reconciles R2 copies of the published D1 generation even when the daily publication is not due; aligned mirrors, a held cutover and a live step lease write nothing. The marker lives in `published_epg_authority`; the R2 objects are compatibility mirrors, not a fallback ([EPG and availability](epg-and-availability.md), [ADR 0108](../adr/0108-epg-mirror-reconciliation-writer.md)).
- **Prediction recovery has two read-triggered parts.** Settling an expired run lease (run record and diagnostic row) and delivering an undelivered stop event (run record, diagnostic row, journal item, delivered flag). In the D1 prediction domain every one of those objects is a fenced D1 intent, which is why the D1 branch shows the `prediction_domain_*` statements ([prediction pipeline](prediction-pipeline.md)).
- **Outbound requests.** One read sends a request of its own: the TMDB status probe (`GET` to TMDB, no body). It is registered as `outbound-read` and is not a storage write.
- **Authority is unchanged.** D1 stays authoritative for the published generation and the prediction domain; R2 mirrors are derived. The target moves the repair, not the authority ([persistence and migration](persistence-and-migration.md)).

## Enforcement

`tests/get-write-audit.mjs` builds the production bundle, runs it against an instrumented R2 bucket and an instrumented D1 in eight scenarios and compares the effects of every read route with the baseline `tests/get-write-baseline.mjs`. A new writer, a changed writer, an unregistered read route or MCP tool, and a baseline entry no request reproduces any more all fail the test. A fix card deletes its entry; see [testing and review](../process/agent-workflow.md).
