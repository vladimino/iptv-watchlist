# Read paths and repair owners

This page shows what a GET, a HEAD or an MCP read tool may touch and which writer owns each repair. It follows [ADR 0107](../adr/0107-get-head-read-side-effect-boundary.md) (Accepted) and [ADR 0108](../adr/0108-epg-mirror-reconciliation-writer.md) (Accepted). Every arrow is current behavior verified by `tests/get-write-audit.mjs` and the writer tests: since [AIR-416](https://trello.com/c/f7FX4Elk) no read writes storage. Nothing here authorizes a production operation.

```mermaid
flowchart LR
    client["Browser, admin or MCP client"]
    subgraph Read["GET and HEAD"]
        pure["Pure read: stored state plus the clock"]
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
    pure -->|"SELECT and get only"| d1
    pure -->|"get only"| r2
    epg -->|"fenced mirror reconcile"| r2
    epg --> d1
    pred -->|"current: run and lease settlement on prediction_start"| r2
    pred -->|"current: fenced D1 prediction intent"| d1
    pred -->|"on prediction_start: deliver undelivered run events"| outbox
    outbox -->|"journal item, idempotent by id and time"| r2
```

## How to read it

- **Every read route, page and MCP read tool ends in `pure`.** No GET, HEAD or read tool writes R2 or D1 in any audited scenario; the baseline in [read side effects](../reference/api/read-side-effects.md) holds only the registered outbound read.
- **The compiled ratings seed is an in-memory overlay.** `GET /api/enrichment/view` and catalog reads apply it without persisting view-index changes; writers still materialize missing seed entries.
- **Compatibility mirrors are the EPG writer's job.** GET never calls `repairMirrors`. The hourly `EpgOrchestration.ensure` reconciles R2 copies of the published D1 generation even when the daily publication is not due; aligned mirrors, a held cutover and a live step lease write nothing. The marker lives in `published_epg_authority`; the R2 objects are compatibility mirrors, not a fallback ([EPG and availability](epg-and-availability.md), [ADR 0108](../adr/0108-epg-mirror-reconciliation-writer.md)).
- **Prediction recovery and event delivery.** An expired run lease is projected on the status and runs reads and persisted by `prediction_start` under the existing Predictions writer fence ([AIR-415](https://trello.com/c/NHyIKM6z)). The same start, under the same writer lease, delivers a run's start or stop event that did not reach the Events Log: it checks the records of the latest run and a small index of earlier failures (`enrichment/event-outbox.json`), retries a bounded number of times and then quarantines the entry, visibly in the status read ([events](../reference/domain/events.md), [AIR-416](https://trello.com/c/f7FX4Elk)). `GET /api/events` only reads. In the D1 prediction domain every persisted run object is a fenced D1 intent ([prediction pipeline](prediction-pipeline.md)).
- **Outbound requests.** One read sends a request of its own: the TMDB status probe (`GET` to TMDB, no body). It is registered as `outbound-read` and is not a storage write.
- **Authority is unchanged.** D1 stays authoritative for the published generation and the prediction domain; R2 mirrors are derived. The target moves the repair, not the authority ([persistence and migration](persistence-and-migration.md)).

## Enforcement

`tests/get-write-audit.mjs` builds the production bundle, runs it against an instrumented R2 bucket and an instrumented D1 in eight scenarios and compares the effects of every read route with the baseline `tests/get-write-baseline.mjs`. A new writer, a changed writer, an unregistered read route or MCP tool, and a baseline entry no request reproduces any more all fail the test. A fix card deletes its entry; see [testing and review](../process/agent-workflow.md).
