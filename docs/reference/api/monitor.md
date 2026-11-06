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
| `alerting`, `deadman` | Whether a webhook and a heartbeat URL are configured (never the URLs) |
| `sideEffects` | Always `none` |

## `POST /api/monitor/test`

Sends one synthetic message (`kind: test`, key `monitor_test`) through the configured webhook, writes only `lastTestAt` on the monitor's own state document, raises no incident and changes no domain state. Answers `{sent: true}` or `{sent: false, reason}` where the reason is `off`, `no_channel` (no HTTPS webhook), `recent` (another test inside ten minutes) or `delivery_failed`. Running it against production needs the owner's action-specific approval.

## Alert message

A JSON `POST` to `MONITOR_WEBHOOK_URL` with only these fields: `source` (`iptv-monitor`), `at`, `kind` (`alert`, `reminder`, `escalation`, `recovery`, `test`), `severity`, `stream`, `key`, `message`, `overall`. No titles, ratings, credentials or private records.

## Issue keys

`epg_stale`, `epg_failed`, `epg_authority`, `epg_resource_limit`, `discovery_stalled`, `discovery_executor_stalled`, `discovery_generation_mismatch`, `discovery_executor_invalid`, `discovery_quarantined`, `discovery_resource_limit`, `ratings_stalled`, `ratings_quarantined`, `ratings_failed_permanent`, `ratings_switch_open`, `ratings_resource_limit`, `predictions_stale`, `predictions_backlog_growing`, and `<stream>_unreadable` when a source cannot be read.

## Thresholds

EPG: delayed 2 hours and degraded 5 hours after the Madrid 17:00 due time without a new publication. Discovery: waiting inside its own `nextCatchUpAt`/`retryAt`, degraded after 3 hours without allowed progress. Ratings: the orchestration read model's own health (stalled two hours after 17:30 Madrid). Predictions: delayed after 3 hours and degraded after 6 hours with pending work and no model batch. Alerts: a degraded issue is confirmed by a second snapshot, a needs-owner issue alerts at once, cooldown 6 hours or 2 hours, at most eight messages per issue per day.
