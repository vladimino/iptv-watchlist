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

`next`, `submit` and `complete` catch `discovery_fence` / `discovery_incomplete` only when `error.stage` is already `queue_refresh` (the tagged rebuild). They answer `503 prediction_catalog_held` without stopping the run. A fence on any other stage stays `502 storage_error`. `submit` returns `results`, `committed` and `identicalSubmit: "idempotent"`; a later identical payload is `already_current` (one version object, no extra history). `complete` does not persist a completed run or Event while held.

## Live Task prompt (read-only; not edited)

Independent review of the **enabled** hourly ChatGPT Task `Почасовые прогнозы «В эфире»` on 10 November 2026 (~19:53 Madrid): step 7 still says continue until a *systemic error* and then `prediction_complete` with an allowed stop reason. It names 503 `prediction_catalog_held` for neither start nor mid-run, and does not tell the caller to wait. This session did not re-read the ChatGPT registry (no live Task tool; no owner GO to edit). The proposed file [hourly-predictions-only.md](../../reference/scheduled-task-prompts/hourly-predictions-only.md) is also silent. Updating `docs/reference/scheduled-tasks.md` does not change the runtime prompt.

### Proposed prompt patch (owner GO required; do not apply from this PR)

Replace the first sentence of step 7 with:

```
7. Продолжай prediction_next/submit до mustComplete, queue_empty, eligible_queue_empty/retry_backoff. HTTP 503 с code prediction_catalog_held на prediction_next, prediction_submit или prediction_complete — ожидание, не системный сбой: сохрани свой runId, НЕ вызывай prediction_complete из‑за него. Повтори тот же шаг (для submit — тот же payload: Worker ответит already_current, второй версии не будет) в пределах одного TTL lease 15 минут; prediction_heartbeat около каждых 10 минут. Если каталог всё ещё занят к концу TTL — прекрати вызовы, не complete и не сбрасывай lease: обычное истечение lease и следующий hourly start. Системная ошибка (502 storage_error и другие mustComplete/quota/API) по-прежнему требует prediction_complete с разрешённым reason.
```

Keep the rest of step 7 (heartbeat wording already there, complete on owned run for real stops, re-read status). No unbounded retry loop, no lease reset.

## Limits

The 20:20 Madrid natural scheduled run is not in this capture. The live Task can still `prediction_complete` after a mid-run 503 until the owner-approved prompt edit above.
