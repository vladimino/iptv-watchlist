# Monitor status and synthetic test

Contract of [AIR-349](https://trello.com/c/VUyampoh) and [ADR 0095](../../adr/0095-cloudflare-native-production-monitor.md). Both routes sit behind the Worker's Cloudflare Access like every other route.

## `GET /api/monitor/status`

A pure read of the stored monitor result: nothing is evaluated, written or sent.

| Field | Meaning |
| --- | --- |
| `mode` | `off` or `on` (the `MONITOR` flag as the Worker sees it; any value other than `on` is `off`) |
| `stored` | Whether a snapshot document exists |
| `heartbeatAt`, `heartbeatAgeMs` | Time of the last saved snapshot and its age at read time. An external dead-man check can poll this |
| `overall` | The worst stream state: `healthy`, `waiting`, `delayed`, `degraded` or `needs_owner` |
| `streams[]` | `epg`, `discovery`, `ratings`, `predictions`, `catalog_posters` (see [Catalog poster stream](#catalog-poster-stream)) and `canonical_producer` (see [Canonical Producer stream](#canonical-producer-stream)), each with `state`, a few non-private `facts` and its issue keys |
| `openIssues[]` | Alertable issues with `key`, `severity`, `firstSeenAt`, `sendCount` |
| `outbox`, `outboxOldestAt` | Number of undelivered notifications and the queue time of the oldest; a growing value means the channel is failing |
| `cancelledUndelivered` | Alerts cancelled because their issue cleared before they were ever delivered |
| `alerting`, `deadman` | Whether the selected transport (webhook or Telegram) is configured and well-formed, and whether a heartbeat URL is set (never the URLs, token or chat id) |
| `sideEffects` | Always `none` |

## `POST /api/monitor/test`

Sends one synthetic message (`kind: test`, key `monitor_test`) through the configured transport (the generic webhook or Telegram, per `MONITOR_TRANSPORT`), only when `MONITOR=on`; writes only `lastTestAt` on the monitor's own state document, raises no incident and changes no domain state. Answers `{sent: true}` or `{sent: false, reason}` where the reason is `off` (`MONITOR` is not `on`, including the retired `dry` token: a synthetic test is refused before any state read or request), `no_channel` (the selected transport is not configured and well-formed), `recent` (another test inside ten minutes), `rate_limited` (a Telegram retry hold is active), `concurrent` (another request claimed the test first) or `delivery_failed`. The cooldown stamp is committed before the message is sent. Running it against production needs the owner's action-specific approval.

## Transports

`MONITOR_TRANSPORT` chooses the channel: absent, empty or `webhook` is the generic webhook, `telegram` is the Telegram Bot API (ADR 0097), anything else is invalid and nothing is sent. A chosen transport never falls back to the other. `GET /api/monitor/status` reports `transport` (`webhook`, `telegram` or `invalid`) and `alerting` (whether that transport is configured and well-formed), never a URL, token or chat id.

## Alert message (webhook transport)

A JSON `POST` to `MONITOR_WEBHOOK_URL` with only these fields: `source` (`iptv-monitor`), `id` (a stable idempotency id, repeated on a retry of the same message), `at`, `kind` (`alert`, `reminder`, `escalation`, `recovery`, `test`), `severity`, `stream`, `key`, `message`, `overall`. No titles, ratings, credentials or private records.

## Issue keys

`epg_stale`, `epg_failed`, `epg_authority`, `epg_resource_limit`, `discovery_stalled`, `discovery_executor_stalled`, `discovery_generation_mismatch`, `discovery_quarantined`, `discovery_resource_limit`, `ratings_stalled`, `ratings_quarantined`, `ratings_failed_permanent`, `ratings_switch_open`, `ratings_resource_limit`, `predictions_no_progress`, `catalog_posters_unknown`, `catalog_posters_lost`, `canonical_producer_no_progress`, `canonical_producer_failed`, `canonical_producer_held_by_delivery` (never alerts), `catalog_posters_stalled`, `catalog_posters_overdue` (only once degraded), `catalog_posters_failed`, and `<stream>_unreadable` when a source cannot be read.

## Thresholds

EPG: delayed 2 hours and degraded 5 hours after the Madrid 17:00 due time without a new publication. Discovery: waiting inside its own `nextCatchUpAt`/`retryAt`, degraded after 3 hours without allowed progress. Ratings: the orchestration read model's own health (stalled two hours after its 17:00 Madrid due time (ADR 0101; 17:30 before)). Predictions ([ADR 0182](../../adr/0182-prediction-progress-policy-shared-by-footer-and-monitor.md)): degraded when eligible work exists and there is no confirmed progress for 60 minutes (the same limit and predicate the Footer uses; four Tasks are expected per hour with about 7 minutes of drift); `waiting` while all work is deferred by its own retry time; `healthy` when nothing is eligible; `delayed` (no alert) while the progress time or the eligible split is unknown. Confirmed progress is a productive batch, a drained run or a moved processed counter, never a heartbeat, `already_running` or a noop wake-up. Alerts: a degraded issue is confirmed by a second snapshot (`predictions_no_progress` by one, because it is computed from stored run times; with the hourly tick it alerts 60 to about 120 minutes after the last confirmed progress, plus Cron and Telegram latency and with no absolute SLA if either fails), a needs-owner issue alerts at once, cooldown 6 hours or 2 hours, at most eight messages per issue per day.

Delivery is at-least-once. Webhook receivers should drop a message whose `id` they have already handled.

## Telegram transport (`MONITOR_TRANSPORT=telegram`)

Configured only through the Worker bindings `MONITOR_TELEGRAM_BOT_TOKEN` (a Worker secret) and `MONITOR_TELEGRAM_CHAT_ID` (a plain Worker variable that identifies the destination; the code reads both as environment strings; see [ADR 0097](../../adr/0097-monitor-telegram-bot-api-transport.md) decision 3); a missing or malformed value makes `alerting` false and nothing is sent (the outbox is kept). Each message is one `POST https://api.telegram.org/bot<token>/sendMessage` (a fixed endpoint, 10 second timeout) with `chat_id`, `text` and `disable_web_page_preview: true`; no `parse_mode`, so the text is plain. The text is, in order: `IPTV monitor: <ALERT|REMINDER|ESCALATION|RECOVERED|TEST> (<severity>)`, `Stream: <stream>`, `Issue: <key>`, the short diagnostic, `Overall: <state>`, `At: <UTC time>` and `Ref: <outbox id>`. Fields are limited to printable ASCII and a fixed length. No title, rating, personal datum or secret is sent.

A delivery counts only when the HTTP status is successful **and** the body says `ok: true`. Every other answer leaves the message queued and uncounted, with a fixed reason in `lastDeliveryFailure` (`telegram_not_ok`, `http_<status>`, `malformed_response`, `timeout`, `network`, `rate_limited`, `config_invalid`, `transport_invalid`); the AIR-349 budget (five attempts per tick, stop after two consecutive failures, rotation to the tail) is unchanged. On a 429 the answer's `retry_after` (or the `Retry-After` header; one minute when absent; capped at one hour) is stored as `holdUntil`: ticks before it make no attempt, `POST /api/monitor/test` answers `rate_limited`, and nothing sleeps. Telegram has no idempotency key, so `Ref` helps a reader but cannot deduplicate; a crash after Telegram accepted a message and before the state commit can repeat it. Exactly-once is not claimed.

The status adds `holdUntil` and `lastDeliveryFailure` (`{at, reason}`) next to `outbox`, `outboxOldestAt` and `cancelledUndelivered`.

## Catalog poster stream

`catalog_posters` judges the automatic weekly poster retry ([ADR 0179](../../adr/0179-weekly-automatic-catalog-poster-retry.md), [operating procedure](../../runbooks/catalog-poster-hydration.md#weekly-automatic-retry)). It is evaluated by the same hourly `Monitor.run` and reuses the alert deduplication, cooldown, recovery and transport of the other streams. The stream is absent from the snapshot only when the poster module is not part of the running Worker; when its facts cannot be read the stream reads `unreadable` like any other.

**Fact source.** One read of the poster checkpoint `epg/catalog-poster-weekly.json` plus the Monitor's own state document. No TMDB request, no domain write, no repair. The checkpoint is the single source that the Monitor, the footer source `posters` and the Events Log type `catalog_posters` all derive from, so they cannot disagree.

**Two write-once markers** in `monitor/state.json`, written only by `Monitor.run` (never by a GET) and never cleared: `catalogPostersBaselineAt` is set the first time the stream is evaluated and no checkpoint exists; `catalogPostersSeenAt` is set the first time a **valid** checkpoint is read. They make the bootstrap grace a one-time allowance: after `catalogPostersSeenAt` an absent checkpoint is `lost`, not a new grace. If the Monitor's own state document is lost as well, the stream falls back to bootstrap grace once (an accepted residual risk).

**Predicates.** The first true row wins. `now` is the Monitor clock, `W` the start of the current week (Sunday 00:00 UTC), `D` the `nextRetryAt` of a pending run. The poster cron fires daily at 03:24 UTC; the sweep starts on the first firing of a new week.

| Order | Domain state | Predicate | Monitor status |
| --- | --- | --- | --- |
| 1 | `unknown` | checkpoint unreadable, corrupt, wrong `schemaVersion` or incomplete for its status; or the Monitor is off | `degraded` |
| 1a | `lost` | no checkpoint and `catalogPostersSeenAt` is set | `degraded` |
| 2 | `failed` | `status=failed`, or `retryAttempts` at the cap of 6, or `rateLimitStreak` of 2 or more | `needs_owner` |
| 3 | `stalled` | the outbox holds 8 undelivered entries, or an undelivered entry is older than 52 h; or `status=running` and `now - lastAttemptAt` is above 2 h; or `status=pending` and `now > D + 26 h` | `degraded` |
| 4 | `grace` | no checkpoint, no `SeenAt`, and `now` is not later than the first 03:24 UTC after the baseline plus 26 h | `healthy` |
| 5 | `overdue` | no checkpoint after that grace; or the checkpoint's `weekStart` is older than `W` and `now > W + 03:24 UTC + 26 h` | `delayed`, and `degraded` once 2 h more have passed |
| 6 | `waiting` | `status=pending` (retry scheduled) or `status=running` (in progress), not stalled | `waiting` |
| 7 | `healthy_idle` | `status=completed` with a receipt for the current week, or for the previous week before the current week's grace expires; includes zero due films and normal 90-day holds | `healthy` |

Only `degraded` and `needs_owner` raise an issue (`catalog_posters_<state>`); `waiting`, `delayed`, `grace` and `healthy_idle` never alert. An empty due set, a no-poster verdict and a legitimate retry wait are not faults. The stream `facts` carry `state`, `detail`, `freshnessAt` (the newest of `lastScheduledAt`, `lastAttemptAt`, `lastCompletedAt`) and `nextExpectedAt`.

**Detectability limit.** An idle daily firing writes nothing and is therefore not detectable. The Sunday sweep is monitored from its persisted weekly receipt, and daily firings only when an unfinished run was due. The constants (26 h grace, 2 h, 52 h, retry cap 6, outbox 8) live in the implementation and are measured on the first natural weeks, not proven. The stream is implemented and tested offline only; the cron it judges is not activated by this documentation.

## Canonical Producer stream

AIR-572. `canonical_producer` judges the EPG to canonical Film/Person Producer ([ADR 0141](../../adr/0141-producer-workflow-chain-protocol.md)) by **durable progress only**, so a Workflow that never starts can no longer hide behind a healthy EPG. It is evaluated by the same hourly `Monitor.run`, uses the same outbox, deduplication, cooldown, recovery and transport as the other streams, and adds no scheduler, secret or channel. The stream is absent only when the Producer module is not part of the running Worker.

**Facts (bounded, read-only D1, exactly three SQL statements per live tick, counted on the prepared SQL in `tests/canonical-producer-chain.mjs`; no table inventory, no schema read, no scan, no write):** one statement for the published `(P,g)` from `published_epg_authority` joined by primary key to its `published_at`, the `canonical_producer_chain` row of `P` (primary key) and the `canonical_producer_run` row of the exact generation `P:g` (indexed on `origin, source_generation`). The reader is `readProducerMonitorFacts`; it does not use `PublishedEpg.readAuthority`, which alone costs three statements. `GET /api/monitor/status` reads only the stored document and evaluates nothing.

**Progress clock.** Only **proven** work is progress: units finished in the **same run row and the same pass** (`n_applied + n_noop + n_kept` grew), or the cursor of that pass moved. A new pass number, a new pass state, a new run row, a new generation, a growing `n_failed`, a strike, a falling counter (a replay), an EPG publication, a takeover, a lease renewal, a heartbeat and a chain `updated_at` are never progress by themselves, so restarts and rollovers with zero finished units cannot reset the clock. The first sighting of a pass is evidence only if it already finished units or holds a cursor, and then only at its own stored update time. The no-progress streak starts at the later of the publication and the first live tick, survives a rollover of the published generation and is cleared only by proven progress. State is kept in `canonicalProducer` of `monitor/state.json` (written only by `Monitor.run`). Since AIR-593 the clock (`MonitorPolicy.canonicalProducerClock`) and the facts (`MonitorPolicy.canonicalProducerFacts`) are pure functions of the policy module, and the reader is exposed as `Monitor.canonicalProducerFacts`, so the status footer («Обогащение каталога», [footer source](enrichment.md#footer-source-for-the-canonical-producer)) judges the same facts with the same `evaluateCanonicalProducer`. The footer reads the stored clock and never writes it. Each Monitor tick now also stores `observedAt` (the tick that wrote the clock; additive, the writer semantics are unchanged). A reader evaluates in `readOnly` mode: a movement is dated by the run row's `updated_at`, never by the read, there is no first-tick grace, and `lagging` needs a clock written within 90 min (`producerClockFreshMs`, below `producerNoProgressMs`); otherwise the footer reports `unconfirmed` (`MonitorPolicy.evaluateCanonicalProducerReader`). Verdicts that D1 decides alone (current, stops, hold, stalled) are never masked by the clock.

| `facts.status` | Stream state | Meaning | Alert |
| --- | --- | --- | --- |
| `current` | `healthy` | The run of the published generation is `passed` and its applied generation equals it (zero eligible units included). Nothing else is `current`. | no |
| `waiting` | `waiting` | Inside the 2 h window, or no generation is published. | no |
| `lagging` | `waiting` | Published more than 2 h ago, but the run is still moving. A late, moving pass is not stalled. | no |
| `stalled` | `degraded` | No durable progress for more than 2 h (`producerNoProgressMs`), whatever the chain state (pending, active, expired takeover, missing chain or run). Key `canonical_producer_no_progress`. | first snapshot |
| `failed` | `degraded` | The chain or run is `stopped` with a recoverable class (`transient`, `receipt`, `authority`). Key `canonical_producer_failed`. | first snapshot |
| `blocked` | `needs_owner` | `stopped` with an identity code (`producer_identity_*`) or a `terminal`, `fail_closed` or `exhausted` class. Key `canonical_producer_failed`. | at once |
| `held_by_delivery` | `delayed` | The static delivery hold is on (below). Visible, never `healthy`, never a success. | no (deliberate) |
| `unreadable` | `degraded` | A read failed. The streak is kept. Key `canonical_producer_unreadable`. | two snapshots |

With the hourly cron an actionable alert follows publication by about 2 to 3 hours (excluding an outage of the cron or the transport). While the hold is on nothing is read and the clock is cleared, so lifting the hold gives the live Producer a full window instead of an instant alert.

**Delivery hold (AIR-572).** `PRODUCER_DELIVERY_HOLD` in `src/canonical-producer-workflow.js` is a static constant, shipped `true` (default-DENY) until the AIR-572 lift and `false` since; the guard holds on any value other than `false`. While it holds, `reconcileProducerChain` (hourly EPG) performs no I/O and creates no Workflow instance, and `runProducerWorkflow` (an instance that already exists) returns `held_by_delivery` before its nonce, claim or any D1 access. It depends on no flag, secret, environment or D1 state, and does not touch EPG publication or any other canonical writer. The monitor reports it as `held_by_delivery`. **The hold is lifted** (`false`) by the owner-approved AIR-572 change that followed the Watchlist membership switch to the Letterboxd Sync ([ADR 0203](../../adr/0203-watchlist-membership-letterboxd-single-writer-projection.md), marker `sync` generation 1 on 23 Nov 2026 UTC): the hourly reconcile launches the chain of the published run and the stream is judged by durable progress from that deploy on. Re-imposing it is again a code change.


**Outcome delivery fact (AIR-594, [ADR 0208](../../adr/0208-producer-outcome-events-delivery-store.md) decision 7).** The hourly `Monitor.run` (not the read-only footer reader) adds `facts.outcomeDelivery` = `{active, readable, pending, oldestPendingAt}` from a separate read of the outcome outbox: one schema probe and, when the table exists, one indexed count of the pending rows (these are not among the three statements above). `active: false` means the migration `0038` is not applied (no outcome reports yet); `readable: false` means the probe or the count failed. It is shown, never judged: no state in the table above reads it, a healthy Producer with undelivered reports stays healthy, and no issue, alert, reminder or Telegram message comes from it. The reports themselves are in the [events reference](../domain/events.md#canonical-producer-outcome-report-canonical_producer).
The monitor never retries, resets a lease or repairs data. A synthetic test message needs its own approval.
