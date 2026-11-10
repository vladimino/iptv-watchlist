# Prediction next 502 during an owned run, 10 November 2026

[AIR-424](https://trello.com/c/KZ51Kn7N). Capture 10 November 2026, 19:18 Madrid (18:18 UTC). Read-only Cloudflare Worker logs (`view: events`, service `iptv`). No production write, no Task change, no model run, no lease reset.

## Symptom

Hourly Predictions run `e7c55264-af48-4065-bead-4b51a7dfcfb4` started 19:05:40 Madrid, added 8 predictions, last good `submit` 19:17:52–19:18:23. `prediction_next` from 19:18:29 failed HTTP 502 `storage_error` at ~19:18:43, `requestId` `0c093130-f21e-45cc-802c-3f9945462313`. `prediction_complete` was HTTP 200 at 19:19:04 (partial). A concurrent scheduled `prediction_start` at 19:18:18–19:18:26 returned `already_running` and did not take the writer lease.

EPG MCP status was already `complete`. That does not mean the Discovery authority was free: a catalog read can still be refused with `discovery_fence` while a publication or its tail holds the fence.

## Log

One `prediction_boundary_failed` line in 18:15–18:22 UTC, timestamp 2026-11-10T18:18:43.747Z:

```json
{"event":"prediction_boundary_failed","boundary":"next","stage":"unknown","code":"discovery_fence","kind":"error","requestId":"0c093130-f21e-45cc-802c-3f9945462313","runId":"e7c55264-af48-4065-bead-4b51a7dfcfb4"}
```

No `prediction_domain_budget` and no `exceededMemory` in 17:50–18:25 UTC. The invocations view was not available (HTTP 403) in this session.

`stage: unknown` because `enrichmentNext` rebuilt the queue without `atStage('queue_refresh')`. `start` already maps `discovery_fence` / `discovery_incomplete` to `503 prediction_catalog_held`; `next` still threw into `observedPrediction`, which records a `storage_error` stop.

## Verdict

The 502 is the same catalog hold as AIR-417's start-during-seal, on `next` of an owned run. It is not a D1 budget, isolate memory or lease race with the concurrent start. The eight committed predictions were kept; the run was ended partial because the caller completed after the 502.

## Change

`next`, `submit` and `complete` wrap the queue rebuild in `atStage('queue_refresh')` and answer `503 prediction_catalog_held` without stopping the run. A later `next` of the same `runId` continues. Unrelated rebuild failures stay `502 storage_error`.

## Limits

The 20:20 Madrid natural scheduled run is not in this capture. Whether the live Task treats `503` on `next` as a wait (retry) or still completes is the Task prompt, which this card does not change.
