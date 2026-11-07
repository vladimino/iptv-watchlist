# Monitor status and synthetic test

Contract of [AIR-349](https://trello.com/c/VUyampoh) and [ADR 0095](../../adr/0095-cloudflare-native-production-monitor.md). Both routes sit behind the Worker's Cloudflare Access like every other route.

## `GET /api/monitor/status`

A pure read of the stored monitor result: nothing is evaluated, written or sent.

| Field | Meaning |
| --- | --- |
| `mode` | `off`, `dry` or `on` (the `MONITOR` flag as the Worker sees it) |
| `stored` | Whether a snapshot document exists |
| `heartbeatAt`, `heartbeatAgeMs` | Time of the last saved snapshot and its age at read time. An external dead-man check can poll this |
| `overall` | The worst stream state: `healthy`, `waiting`, `delayed`, `degraded` or `needs_owner` |
| `streams[]` | `epg`, `discovery`, `ratings`, `predictions`, each with `state`, a few non-private `facts` and its issue keys |
| `openIssues[]` | Alertable issues with `key`, `severity`, `firstSeenAt`, `sendCount` |
| `outbox`, `outboxOldestAt` | Number of undelivered notifications and the queue time of the oldest; a growing value means the channel is failing |
| `cancelledUndelivered` | Alerts cancelled because their issue cleared before they were ever delivered |
| `alerting`, `deadman` | Whether the selected transport (webhook or Telegram) is configured and well-formed, and whether a heartbeat URL is set (never the URLs, token or chat id) |
| `sideEffects` | Always `none` |

## `POST /api/monitor/test`

Sends one synthetic message (`kind: test`, key `monitor_test`) through the configured transport (the generic webhook or Telegram, per `MONITOR_TRANSPORT`), only when `MONITOR=on`; writes only `lastTestAt` on the monitor's own state document, raises no incident and changes no domain state. Answers `{sent: true}` or `{sent: false, reason}` where the reason is `off`, `dry` (`MONITOR=dry` sends and writes nothing, so a synthetic test is refused before any state read or request), `no_channel` (the selected transport is not configured and well-formed), `recent` (another test inside ten minutes), `rate_limited` (a Telegram retry hold is active), `concurrent` (another request claimed the test first) or `delivery_failed`. The cooldown stamp is committed before the message is sent. Running it against production needs the owner's action-specific approval.

## Transports

`MONITOR_TRANSPORT` chooses the channel: absent, empty or `webhook` is the generic webhook, `telegram` is the Telegram Bot API (ADR 0097), anything else is invalid and nothing is sent. A chosen transport never falls back to the other. `GET /api/monitor/status` reports `transport` (`webhook`, `telegram` or `invalid`) and `alerting` (whether that transport is configured and well-formed), never a URL, token or chat id.

## Alert message (webhook transport)

A JSON `POST` to `MONITOR_WEBHOOK_URL` with only these fields: `source` (`iptv-monitor`), `id` (a stable idempotency id, repeated on a retry of the same message), `at`, `kind` (`alert`, `reminder`, `escalation`, `recovery`, `test`), `severity`, `stream`, `key`, `message`, `overall`. No titles, ratings, credentials or private records.

## Issue keys

`epg_stale`, `epg_failed`, `epg_authority`, `epg_resource_limit`, `discovery_stalled`, `discovery_executor_stalled`, `discovery_generation_mismatch`, `discovery_executor_invalid`, `discovery_quarantined`, `discovery_resource_limit`, `ratings_stalled`, `ratings_quarantined`, `ratings_failed_permanent`, `ratings_switch_open`, `ratings_resource_limit`, `predictions_stale`, `predictions_backlog_growing`, and `<stream>_unreadable` when a source cannot be read.

## Thresholds

EPG: delayed 2 hours and degraded 5 hours after the Madrid 17:00 due time without a new publication. Discovery: waiting inside its own `nextCatchUpAt`/`retryAt`, degraded after 3 hours without allowed progress. Ratings: the orchestration read model's own health (stalled two hours after 17:30 Madrid). Predictions: delayed after 3 hours and degraded after 6 hours with pending work and no model batch. Alerts: a degraded issue is confirmed by a second snapshot, a needs-owner issue alerts at once, cooldown 6 hours or 2 hours, at most eight messages per issue per day.

Delivery is at-least-once. Webhook receivers should drop a message whose `id` they have already handled.

## Telegram transport (`MONITOR_TRANSPORT=telegram`)

Configured only through the Worker bindings `MONITOR_TELEGRAM_BOT_TOKEN` (a Worker secret) and `MONITOR_TELEGRAM_CHAT_ID` (a plain Worker variable that identifies the destination; the code reads both as environment strings; see [ADR 0097](../adr/0097-monitor-telegram-bot-api-transport.md) decision 3); a missing or malformed value makes `alerting` false and nothing is sent (the outbox is kept). Each message is one `POST https://api.telegram.org/bot<token>/sendMessage` (a fixed endpoint, 10 second timeout) with `chat_id`, `text` and `disable_web_page_preview: true`; no `parse_mode`, so the text is plain. The text is, in order: `IPTV monitor: <ALERT|REMINDER|ESCALATION|RECOVERED|TEST> (<severity>)`, `Stream: <stream>`, `Issue: <key>`, the short diagnostic, `Overall: <state>`, `At: <UTC time>` and `Ref: <outbox id>`. Fields are limited to printable ASCII and a fixed length. No title, rating, personal datum or secret is sent.

A delivery counts only when the HTTP status is successful **and** the body says `ok: true`. Every other answer leaves the message queued and uncounted, with a fixed reason in `lastDeliveryFailure` (`telegram_not_ok`, `http_<status>`, `malformed_response`, `timeout`, `network`, `rate_limited`, `config_invalid`, `transport_invalid`); the AIR-349 budget (five attempts per tick, stop after two consecutive failures, rotation to the tail) is unchanged. On a 429 the answer's `retry_after` (or the `Retry-After` header; one minute when absent; capped at one hour) is stored as `holdUntil`: ticks before it make no attempt, `POST /api/monitor/test` answers `rate_limited`, and nothing sleeps. Telegram has no idempotency key, so `Ref` helps a reader but cannot deduplicate; a crash after Telegram accepted a message and before the state commit can repeat it. Exactly-once is not claimed.

The status adds `holdUntil` and `lastDeliveryFailure` (`{at, reason}`) next to `outbox`, `outboxOldestAt` and `cancelledUndelivered`.
