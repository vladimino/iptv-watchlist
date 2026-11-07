# Production monitor and incident response

For [AIR-349](https://trello.com/c/VUyampoh) and [ADR 0095](../adr/0095-cloudflare-native-production-monitor.md). The monitor only diagnoses and reports; it never recovers anything. Every activation step below needs the owner's separate approval.

## What it is and is not

A tick on the existing hourly cron that reads the stored status of EPG, Discovery, Ratings and the prediction queue, judges it, keeps `monitor/state.json` and sends actionable alerts to one HTTPS webhook. It is independent of ChatGPT. It is **not** an availability check: a Worker cannot see its own total outage or a Cloudflare-wide outage. That needs an external dead-man service pinged by `MONITOR_HEARTBEAT_URL`.

## Activation order (each needs an owner GO)

1. Choose the channel and the dead-man service. For the generic webhook set `MONITOR_WEBHOOK_URL`; for Telegram ([ADR 0097](../adr/0097-monitor-telegram-bot-api-transport.md)) set `MONITOR_TELEGRAM_BOT_TOKEN` and `MONITOR_TELEGRAM_CHAT_ID` and then `MONITOR_TRANSPORT=telegram`. Optionally set `MONITOR_HEARTBEAT_URL`. The secrets are Worker secrets, never in git, GitHub, Trello or logs; `GET /api/monitor/status` shows `transport` and `alerting` without them.
2. Set `MONITOR=dry` and read one tick in Workers Observability (`event: monitor`): the overall state and issue keys, nothing written or sent.
3. Set `MONITOR=on`. Read `GET /api/monitor/status`: one healthy snapshot with a fresh `heartbeatAt`.
4. Send one synthetic message with `POST /api/monitor/test`, confirm the owner received it, and that a second call inside ten minutes is refused.
5. Confirm the dead-man service sees the pings and alerts when they stop (disable the pings briefly only with the owner's approval).

Roll back by setting `MONITOR` to `off` or removing it. Alerts already sent stay sent.

## When an alert arrives

Read `GET /api/monitor/status` first (a pure read), then the domain's own status, and decide. A manual action needs its own action-specific owner approval; the monitor never takes it.

| Issue key | Read | Meaning and next step |
| --- | --- | --- |
| `epg_stale`, `epg_failed` | MCP `epg_status`, `epg_pipeline_status` | No generation published since the Madrid 17:00 due time. See the deployment runbook |
| `epg_authority` | the published EPG authority marker | Held or unreadable: owner |
| `discovery_stalled`, `discovery_executor_stalled`, `discovery_generation_mismatch` | `epg_pipeline_status` | A backlog without allowed progress. Check the executor mode and the Workflow before any resolver call |
| `discovery_quarantined`, `discovery_executor_invalid` | `feature_flags`, the Workflow readout | The retry budget is exhausted or the flag value is invalid: owner |
| `ratings_stalled`, `ratings_quarantined`, `ratings_failed_permanent`, `ratings_switch_open` | `ratings_sync_status` (`orchestration`) | See the Ratings integration reference; clearing a quarantine is an owner action |
| `predictions_stale`, `predictions_backlog_growing` | `prediction_queue_overview` | Pending predictions and no real model progress (empty scheduled batches do not count): the hourly ChatGPT task, its quota or the model |
| `outbox` growing in `/api/monitor/status` | `outboxOldestAt`, the webhook provider | Notifications are queued because the channel fails. They are kept and retried with the same id (at most five attempts per tick, two when the channel is down); fix the channel (owner), nothing is lost |
| `*_resource_limit` | Workers Observability | Repeated Worker 1102 or memory limits |
| `<stream>_unreadable` | the named status | A source could not be read; confirm whether the authority marker is held or loading |

`waiting` and `delayed` never alert: a backlog inside its backoff, an EPG within two hours of its due time and a Ratings cooldown are by design.

## Cost, retention and privacy

When `on`, one tick is a handful of small R2 reads, one conditional R2 write and at most the alerts and one ping; when `off` it does nothing. The state document is one small object overwritten each tick. Messages and state hold no titles, ratings, credentials or private records.

## Telegram delivery problems

| `lastDeliveryFailure.reason` | Meaning and next step |
| --- | --- |
| `config_invalid` | A token or chat id is missing or malformed (status shows `alerting: false`); nothing was sent and the queue is kept. Owner: set a valid secret |
| `http_401`, `http_403` | The token is wrong or revoked, or the bot was removed from the chat. Owner: fix the bot or the secret |
| `telegram_not_ok`, `http_400` | Telegram refused the request, for example a wrong chat id. Owner: check the chat binding |
| `rate_limited` | Telegram answered 429; `holdUntil` shows when sending resumes. Nothing is lost |
| `timeout`, `network`, `http_5xx`, `malformed_response` | Telegram or the network is failing; messages are kept and retried (two attempts per tick while it fails) |

A growing `outbox` with a `lastDeliveryFailure` means alerts are not reaching the owner even though the monitor is alive: the dead-man heartbeat will not show this. Telegram cannot deduplicate, so after a Worker crash the owner may see one message twice (same `Ref`). Switch back to the webhook by removing `MONITOR_TRANSPORT`.
