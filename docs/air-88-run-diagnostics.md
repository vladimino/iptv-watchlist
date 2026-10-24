# AIR-88 run diagnostics

[AIR-88](https://trello.com/c/xWA4evuk) records what the Worker attempted, what response it formed, and what the caller later reports. [AIR-87](https://trello.com/c/aeimvOxq) stays closed. Its historical `api_error` (`b9b8e90e-0f64-4217-9de2-0c42ea0da10a`, `firstNextAt` set, `firstSubmitAt` null, `added` 0) is not rewritten or explained by this telemetry. [AIR-82](air-82-prediction-rca.md) still owns the `queue_empty` / outstanding-pending mismatch; this change does not alter queue membership, retry delay, or completion codes.

## What a step means

Each `start`, `next`, `submit`, `heartbeat`, and `complete` appends at most eight steps on the existing `enrichment/run-diagnostics/` object. A step has `attemptedAt`, `completedAt`, `outcome` (`entered`, `produced`, or `failed`), `httpStatus`, `elapsedMs`, `errorClass`, `requestId`, `observedBy: "server"`, and `delivery: "unconfirmed"`.

`entered` is the attempt. `produced` means the Worker formed a response. `failed` means the handler threw; the client then sees HTTP 502 and `storage_error`. `lastAttemptedStep` is the latest step. `lastCompletedStep` is the latest `produced` step. `firstNextAt` can be set while `lastCompletedStep` is still `start`: the next attempt began, and no next response was formed.

The server cannot attest that the caller received a response. Stored `delivery` stays `unconfirmed`. `GET /api/enrichment/status` adds `diagnostics.steps[].callerAcknowledged` only when a later `complete` fault echoes that step's `requestId` in `receivedRequestId`. `GET /api/enrichment/runs` returns the same projection. Neither route is new, and neither starts a run.

The correlation id is `X-Request-Id` when it matches `^[A-Za-z0-9_-]{1,80}$`; otherwise the Worker generates one. The same value is returned as JSON `requestId` and the `X-Request-Id` response header so MCP `structuredContent` can see it. Old clients ignore the extra fields.

## Caller fault and external stops

`POST /api/enrichment/complete` accepts an optional `fault` object: `origin` (`worker_http`, `transport`, `model_provider`, `orchestrator`, `unknown`), `failedStep`, `providerErrorCode`, `httpStatus`, and `receivedRequestId`. The stored record is `reportedBy: "caller"` and `attribution: "caller_reported"`. That record is written only when `reason` is an external or other systemic stop (`api_error`, `model_unavailable`, `model_error`, `external_termination`, `quota`, `storage_error`, and the other `systemicReason` results). A missing reason, or `queue_empty`, `eligible_queue_empty`, `parse_error`, or `retry_backoff`, rejects `fault` with HTTP 400. The run stays in progress and no caller fault is stored. A duplicate complete stays idempotent and does not replace an existing fault. An invalid fault on a running run also returns 400 and does not stop the run. Provider codes that contain credential-like or prompt-like text are rejected. The fault is not copied onto the Event.

`receivedRequestId` sets `callerAcknowledged` only on the step whose `requestId` is exactly that value. Any other id, including one the Worker never issued, leaves every step unacknowledged. Stored `delivery` stays `unconfirmed`.

An external stop (`api_error`, `model_unavailable`, `model_error`, `external_termination`) without `fault` is stored as `attribution: "external_unattributed"`, `origin: "unknown"`, `reportedBy: null`, `errorClass: "unknown"`. `api_error` alone does not prove a Worker fault. A thrown handler or a formed `lease_lost` / `storage_error` response is the server observation (`serverFault.origin: "worker"`). `queue_empty`, `eligible_queue_empty`, and one item `parse_error` do not set `serverFault`.

Item failures still use `failureStage: "parse_error"` and the same retry. The diagnostic adds only `itemValidation`: `consecutive` and the last eight `{stage, reportedBy}` pairs. `stage` is `caller_reported`, `fingerprint_schema`, `fingerprint_missing`, or `prediction_schema`. Five consecutive item failures still stop as `format_error_storm`. The new fields do not store the exception text, model output, film id, or title.

## Caller change, outside this repository

The ChatGPT Scheduled Task is not a Worker cron and is not edited here. When that task is next changed, it should:

1. Send or read `X-Request-Id` / `requestId` on `prediction_start`, `prediction_next`, `prediction_submit`, `prediction_heartbeat`, and `prediction_complete`.
2. Remember the id only from a response the client actually received.
3. On a real external stop, call `prediction_complete` with the existing `reason` plus `fault`. Set `receivedRequestId` to the id from the last response the client received, `failedStep` to the step that failed, and `origin` to `worker_http`, `transport`, `model_provider`, `orchestrator`, or `unknown`.
4. Omit `fault` when the client cannot tell where the failure happened. The Worker then records `external_unattributed` instead of guessing.

Full end-to-end confirmation of caller metadata is not possible in this change. It remains unconfirmed until that task sends `fault`.

## Production

No R2 migration, feature flag, queue rewrite, or new public route. Deploy is the ordinary GitHub `main` Worker publish after review. Rollback is reverting that publish; it does not rewrite existing diagnostic objects. Old rows simply lack `steps`.
