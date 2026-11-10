# Production monitor and incident response

For [AIR-349](https://trello.com/c/VUyampoh) and [ADR 0095](../adr/0095-cloudflare-native-production-monitor.md). The monitor only diagnoses and reports; it never recovers anything. Every activation step below needs the owner's separate approval.

## What it is and is not

A tick on the existing hourly cron that reads the stored status of EPG, Discovery, Ratings and the prediction queue, judges it, keeps `monitor/state.json` and sends actionable alerts to the one channel the owner selected: a generic HTTPS webhook or the Telegram Bot API. It is independent of ChatGPT. It is **not** an availability check: a Worker cannot see its own total outage or a Cloudflare-wide outage. That needs an external dead-man service pinged by `MONITOR_HEARTBEAT_URL`.

## Activation order (each needs an owner GO)

1. Choose the channel and the dead-man service. For the generic webhook set `MONITOR_WEBHOOK_URL`; for Telegram ([ADR 0097](../adr/0097-monitor-telegram-bot-api-transport.md)) set `MONITOR_TELEGRAM_BOT_TOKEN` and `MONITOR_TELEGRAM_CHAT_ID` and then `MONITOR_TRANSPORT=telegram`. Optionally set `MONITOR_HEARTBEAT_URL`. The bot token must be a Worker secret and, like `MONITOR_WEBHOOK_URL`, is never in git, GitHub, Trello or logs. `MONITOR_TELEGRAM_CHAT_ID` is a destination identifier held as a plain Worker variable (it is visible in the Cloudflare Dashboard and is still kept out of logs and public reports; see ADR 0097 decision 3); `GET /api/monitor/status` shows `transport` and `alerting` without them.
2. Set `MONITOR=on`. Read `GET /api/monitor/status`: one healthy snapshot with a fresh `heartbeatAt`. There is no observe-only mode: `MONITOR` is `off` or `on`, and while the selected channel is not configured `on` keeps the snapshot and sends nothing.
3. Send one synthetic message with `POST /api/monitor/test` (only with `MONITOR=on`; `off` and any other value refuse it without a write or a request), confirm the owner received it, and that a second call inside ten minutes is refused.
4. Confirm the dead-man service sees the pings and alerts when they stop (disable the pings briefly only with the owner's approval).

Roll back by setting `MONITOR` to `off` or removing it. Alerts already sent stay sent.

## When an alert arrives

Read `GET /api/monitor/status` first (a pure read), then the domain's own status, and decide. A manual action needs its own action-specific owner approval; the monitor never takes it.

| Issue key | Read | Meaning and next step |
| --- | --- | --- |
| `epg_stale`, `epg_failed` | MCP `epg_status`, `epg_pipeline_status` | No generation published since the Madrid 17:00 due time. See the deployment runbook |
| (no alert) EPG `health: late` | MCP `epg_status`: `orchestration.seal` (`cursorItems` of `itemTotal`, `updatedAt`) and `orchestration.publication.overdueMs` | The publication is more than 15 min past due and not waiting or cooling down. A cursor that moves between two reads is a slow seal, not a stopped one: read the `epg_phase` exit events (`writeMs / batches` is the D1 round trip) before anything else, and do not step or retry the run by hand. See the [AIR-420 evidence](../evidence/d1-migration/air-420-seal-ledger-round-trips-2026-11-10.md) |
| `epg_authority` | the published EPG authority marker | Held or unreadable: owner |
| `discovery_stalled`, `discovery_executor_stalled`, `discovery_generation_mismatch` | `epg_pipeline_status` | A backlog without allowed progress. Check the executor mode and the Workflow before any resolver call |
| `discovery_quarantined`, `discovery_executor_invalid` | `feature_flags`, the Workflow readout | The retry budget is exhausted or the flag value is invalid: owner |
| `ratings_stalled`, `ratings_quarantined`, `ratings_failed_permanent`, `ratings_switch_open` | `ratings_sync_status` (`orchestration`) | See the Ratings integration reference; clearing a quarantine is an owner action |
| `predictions_stale`, `predictions_backlog_growing` | `prediction_queue_overview` | Pending predictions and no real model progress (empty scheduled batches do not count): the hourly ChatGPT task, its quota or the model |
| `outbox` growing in `/api/monitor/status` | `outboxOldestAt`, the channel provider (webhook service or Telegram) | Notifications are queued because the channel fails. They are kept and retried with the same id (at most five attempts per tick, two when the channel is down); fix the channel (owner), nothing is lost |
| `*_resource_limit` | Workers Observability | Repeated Worker 1102 or memory limits |
| `<stream>_unreadable` | the named status | A source could not be read; confirm whether the authority marker is held or loading |

`waiting` and `delayed` never alert: a backlog inside its backoff, an EPG within two hours of its due time and a Ratings cooldown are by design.

## Cost, retention and privacy

When `on`, one tick is a handful of small R2 reads, one conditional R2 write and at most the alerts and one ping; when `off` it does nothing. The state document is one small object overwritten each tick. Messages and state hold no titles, ratings, credentials or private records.

## Telegram delivery problems

| `lastDeliveryFailure.reason` | Meaning and next step |
| --- | --- |
| `config_invalid` | A token or chat id is missing or malformed (status shows `alerting: false`); nothing was sent and the queue is kept. Owner: set a valid token (secret) or chat id |
| `http_401`, `http_403` | The token is wrong or revoked, or the bot was removed from the chat. Owner: fix the bot or the secret |
| `telegram_not_ok`, `http_400` | Telegram refused the request, for example a wrong chat id. Owner: check the chat binding |
| `rate_limited` | Telegram answered 429; `holdUntil` shows when sending resumes. Nothing is lost |
| `timeout`, `network`, `http_5xx`, `malformed_response` | Telegram or the network is failing; messages are kept and retried (two attempts per tick while it fails) |

A growing `outbox` with a `lastDeliveryFailure` means alerts are not reaching the owner even though the monitor is alive: the dead-man heartbeat will not show this. Telegram cannot deduplicate, so after a Worker crash the owner may see one message twice (same `Ref`). Switch back to the webhook by removing `MONITOR_TRANSPORT`.

## D1 projector grouped write path

With `D1_ENRICHMENT_BULK=on` ([ADR 0106](../adr/0106-bulk-projector-write-path.md), [reference](../reference/data/d1-schema.md)) the projector run summary (the `d1_enrichment_projection` log line, `projection_run.summary_json`, `GET /api/d1/status` `projector.lastRun.summary`) carries a `bulk` object. With the flag off, `bulk` is absent and the summary is what it was. The fields are whole numbers, fixed names and one short error sample: no payload, id, key or SQL.

| Field | Meaning |
| --- | --- |
| `groups`, `filmGroups`, `personGroups`, `groupSize` | Group cycles of the run, by lane, and the configured group size |
| `applied`, `fallbacks`, `fallbackReasons` | Groups written by their one batch, and groups sent to the per-entity path by reason (`guard_refused`, `prefetch_miss`, `undigestable_read`, `plan_error`, `too_large`, `constraint`, `batch_error`, `digest_unusable`) |
| `guardRefusals`, `constraintFallbacks`, `prefetchMisses` | Groups the in-batch assertions refused, groups a constraint rolled back, reads the collecting pass issued that the trace had not |
| `prefetchReads`, `guards`, `prefetchStatements`, `statements` | Traced reads, assertions in the write batches, statements of the read batches and of the write batches |
| `prefetchMs`, `applyMs` | Time in the read batches and in the write batches |
| `films`, `people`, `perWindowSecond` | Films and Persons the groups wrote and the rate over the seconds since the budget clock started (the window grant, or the run start) |
| `stop`, `errors` | Why the grouped path ended before the run did: `batch_error`, `fallback_rate`, `budget` (no group fits the clock or the statement budget left), or the reason a run was stopped (`lease_lost`, `window_lost`, `authority_moved`, `authority_unavailable`); up to five error samples |

**`bulkBudget`** (present only with the flag on): `wallMs` the write-phase budget this run used (180,000 with a held window and the marker, 60,000 otherwise), `policy` (`l1`, `l1_unavailable`: the flag without a window or marker, or `explicit`: a caller's own value) and `effectiveMs`, the budget after the window's absolute expiry (the smaller of the two, counted from the grant). A run that ends `budget` with `bulk.stop: budget` and `policy: l1` spent its 180 s, or what the window left of it, minus the reserve; the same outcome with `policy: l1_unavailable` means no window was held.

How to read it. The healthy picture is `fallbacks` 0 and `prefetchMisses` 0, `guards` equal to `prefetchReads`, and `statements` around 95 per Film. Stop conditions during the first observed runs after activation (each needs the owner and a decision brief, never a retry loop): a fallback share above 5 % of `groups`; any `constraint` fallback whose error names a unique or foreign key violation that the per-entity path does not also report; a dangling credit (`film_person_credit` rows with no `person`); an outcome `deferred` with `authority_moved` or `authority_unavailable` (the Film/Person marker moved, is absent or left `r2` and `prepared`: the projector must not write, and the marker is the owner's); a D1 error that names a batch or statement size (`batch_error`, check `errors`); a window that ran past its absolute deadline; throughput below half of the offline model. The run itself latches the grouped path off for the rest of the run at a fallback share above 5 % after ten groups, or an unknown batch outcome, and then continues per entity (each of those writes still asserts the marker). Switching the flag off restores the per-entity path on the next run and undoes no row.

## D1 projector run: phase timing (AIR-392)

The D1 enrichment projector ([ADR 0056](../adr/0056-d1-enrichment-write-through.md), [ADR 0103](../adr/0103-projector-exclusive-window.md)) logs one `event: d1_enrichment_projection` line per hourly run and keeps the same summary in `projection_run.summary_json` (also `GET /api/d1/status`, `projector.lastRun.summary`). Since [AIR-392](https://trello.com/c/ivMqVpKC) the summary carries three additive measurement groups. They only read the clock around calls the run already makes; no run, fence, budget, retry or write depends on them. They hold fixed names and whole numbers only: no payload, id, key, SQL or parameter. All times are milliseconds on the Worker's `Date.now()`, which advances only across I/O: pure CPU work between two calls shows as 0 ms and lands in the I/O phase that follows it, so a CPU-local share cannot be separated by these fields.

**`timing`: the run in order.** `leaseMs` (taking the projector lease), `windowMs` (ADR 0103 request to grant, only when a window was taken; the existing `window.waitMs` is the part spent waiting for quiet), `diffMs` (load, view and diff, see `phases`), `diffResidualMs` (the named remainder of the diff, see below), `writeGateMs` (the pre-write authority check), `writeMs` (the write loop), `windowReleaseMs`, `leaseReleaseMs` and `runMs` (log line only: they are measured after `summary_json` is stored). `leaseMs`, `windowMs`, `diffMs`, `writeGateMs` and `writeMs` are consecutive and add up to at most `runMs`.

The first write is measured on the budget clock's start (the grant when a window is held, otherwise the run start), at two boundaries, and each is absent when the run never reached it: `preTxnMs` to the moment the first fenced transaction is **entered** (its planning starts), `preWriteMs` to the moment the first batch is **submitted** to D1 (the instant before `binding.batch`, so it is an attempt, kept when that batch fails, not a confirmation of success), and `firstBatchPlanMs` = `preWriteMs - preTxnMs`, the repository's own planning (its reads and statement assembly) before that submission; `firstBatchStatements` is the size of that first batch.

**`phases`: a sequential partition of the diff.** Entries do not overlap, so they add up. Each is `{ms, n, q, rows}`: wall time, calls, D1 adapter queries and rows read.

| Name | What it covers |
| --- | --- |
| `store.writersIdle` | The writer-idle checks (two R2 reads each), before and after the reads |
| `store.publishedSnapshot` | The published EPG generation read, before and again after the reads |
| `store.handoffGuard` | The Discovery authority handoff guard |
| `store.readBlock` | The whole block of R2 and discovery reads (they run together, see `detail`) |
| `store.ownerReview` | The owner-review authority and its fenced read |
| `store.etagRecheck` | The repeated etag check of every object read (`rows` = objects) |
| `store.build` | Building the store (CPU) |
| `diff.schemaContract`, `diff.metadataCache`, `diff.predictionAuthority` | The D1 reads of the schema version, the metadata cache and the prediction authority |
| `diff.lifecycle`, `diff.ownerOverlay`, `diff.inputs` | Building the view and the entity inputs (CPU) |
| `diff.keys` | The fresh change keys of every entity of the view, computed once (CPU), when the view has at least 5,000 entities |
| `diff.checkpointCount` | One `COUNT(*)` of `projection_state` (the summary's `stored`) and the backlog check: a view with far more entities than the table has rows reads the table whole |
| `diff.checkpointDigest` | One D1 query that returns, per bucket (kind and a hash of the last four UTF-8 bytes of the id, at most 8,192 buckets), the count and two 32-bit sums of the stored keys' hash part; `rows` = buckets. Present when the buckets can be used |
| `diff.checkpointRows` | The rows of only the buckets that differ from the fresh keys, in statements of up to 90 buckets, at most six at a time; `rows` = rows read |
| `diff.storedRead` | The previous read of every checkpoint (`rows` = checkpoints; since AIR-395 interim paged: a table of up to 6,000 rows is one query, a larger one a first page, a count and the other pages together, six at a time, accepted only when the rows add up to the count with no duplicate, otherwise read whole). It runs for a view below 5,000 entities, when more than 40 % of the buckets differ, when the view has far more entities than the table has rows (a backlog), and when a key is not of the expected shape |
| `diff.plan`, `diff.admittedFirst` | The change keys and the plan (CPU) |
| `diff.membersRead`, `diff.syncProbe`, `diff.storedSyncRead`, `diff.knownFilmsRead`, `diff.aliasesRead` | The remaining D1 reads of the diff, each with its row count |

`diffMs` = the sum of `phases` + `diffResidualMs` exactly (the residual is the untimed glue and CPU, never negative; it is emitted for every run whose diff was attempted, including `failed`, `deferred` and `dry`). `detail` is not part of this equation. `loadMs` (the `store.*` part) and `viewMs` keep their old meaning.

**`detail`: overlapping reads.** `read.watchlist`, `read.programme`, `read.metadata`, `read.titles`, `read.people`, `read.catalog`, `read.resolution`, `read.diary`, `read.retirements`, `read.viewIndex`, `read.verifiedFilms`, `read.ownerMirror` (only under the `r2` owner-review authority): the time of each individual read inside `store.readBlock`. They run concurrently, so their sum exceeds the block's wall time; never add `detail` to `phases`. `read.catalog` and `read.resolution` are routed through the Discovery authority (D1 under authority `d1`).

How to read a run: `preWriteMs` is the overhead before the first write; it is `preTxnMs` (the diff, the write gate and the glue before the first transaction) plus `firstBatchPlanMs`. With a window the wait is in `windowMs`, not in it (the budget clock restarts at the grant). In a slow run find the largest `phases` entry first, and compare it with `diffResidualMs`; if it is `store.readBlock`, the largest `detail` read names the object; if it is a `diff.*Read`, compare its `rows` and `q` with its `ms`; if `firstBatchPlanMs` is large, the repository planning before the first submission is the overhead. Judge several runs, fast and slow, never one. An entry that is missing means the run ended before it (`failed`, `deferred`, `dry`).

**Retained duplicates (AIR-405).** `retainedCount` and `retainedFilms` (at most 20 entries of `id`, `reason` `duplicate_film_retained` and `held`, the prediction-domain tables that hold rows of the Film the link would retire) appear in the run summary only when a Letterboxd Film was skipped on purpose because its catalog twin holds prediction, fingerprint or candidate facts. It is not an error: it does not raise `errorCount`, does not make the run `partial` and is not counted in `writtenFilms`. The Film has no checkpoint, so every run plans it again (a few queries each) and a changed input or the facts going away lets it through. A foreign key error of any other table, `identity_collision` and an EPG history refusal are still errors in `errors`.

**D1 meta per phase (AIR-396).** Every `phases` and `detail` entry whose reads carried a D1 `meta` also holds `sqlUs` (the database's own `sql_duration_ms`, summed, in microseconds), `dbRows` (`rows_read`), `dbN` (reads with a meta) and `replica` (of those, served by a replica, so normally 0). `ms - sqlUs/1000` is the part of the phase that is not D1 SQL execution: queueing, transport, and CPU charged to it because the Worker clock does not advance during CPU. Entries without D1 reads (R2, CPU-only phases) and batches do not carry them. No SQL, parameter or id is recorded.

**Which checkpoint path a run took (AIR-395).** The summary field `checkpointMode` is `buckets` or `full`, and `checkpointBuckets` is `{expected, stored, differing}` (buckets the view has, buckets the table has, buckets that differ) `{expected, missing, skipped:'backlog'}`, or a `skipped` of `unsafe_id` (a fresh id that is not well-formed UTF-16) or `bucket_mismatch` (a digest or row whose bucket the Worker does not recognize: the database and the Worker disagree about the mapping). Both read the whole table, and `bucket_mismatch` is not expected: a run that reports it needs the ids involved found and the mapping checked, not a retry loop. `buckets` means the stored keys were summarized in D1 and only the differing buckets were read; the plan, the writes and the change keys are exactly those of reading every checkpoint. While a backlog is large (the view has far more entities than the table has rows, as on 2026-11-09) a run reads the whole table as before and `diff.storedRead` is present; the buckets are expected to be used once the backlog has drained.


**The boundary line `d1_enrichment_phase`.** A run that reaches the write also logs one earlier line, `event: d1_enrichment_phase`, `stage: diff_complete_write_start`, immediately before the write starts and after the diff, the write gate and the write budget are settled. It carries `projection`, `trigger`, `mode`, `startedAt`, `timing` (`leaseMs`, `windowMs` when a window was taken, `diffMs`, `writeGateMs`), the view and diff counts (`films`, `people`, `stored`, `changedFilms`, `changedPeople`), the size of the plan (`plan.films`, `plan.people`, `plan.sync`, `plan.absent`), the D1 `queries` so far, `bulk` and `bulkBudget`. It has no id, title or payload, reads no clock and sends no query. Use it when the platform ends a run without its summary line (a Workers outcome of `exceededMemory` or a time limit): a boundary line with the run's `startedAt` shows the run completed its diff, so the end came in the write phase or later; no boundary line shows nothing by itself, because a log line can be lost, and is not proof that the end came earlier. A dry run, a run the input guard refuses and a run that fails before the write log no boundary line. The boundary line does not replace the summary line and does not enter `summary_json`.
