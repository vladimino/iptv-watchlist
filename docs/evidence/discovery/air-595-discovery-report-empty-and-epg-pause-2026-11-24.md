# AIR-595: hourly Discovery reports of a drained queue and of the EPG-priority pause (24 Nov 2026)

Card: [AIR-595](https://trello.com/c/dPjrNIbQ). Scope: root cause of three hourly Discovery events of 23 Nov 2026 and the code fix. Read-only production observation (L0) plus offline tests. No production write, flag, Task, migration, manual run or event cleanup. All times are UTC; Europe/Madrid was UTC+1.

## Sources

- Code: `main` at `6ca5c24` (the checkout of this change). The deployed Worker version was not read separately; the log lines below match this code's log shapes.
- Workers Logs (`POST /accounts/{id}/workers/observability/telemetry/query`, service `iptv`, needles `discovery_workflow_reconcile` and `discovery_hour_close`).
- The stored journal objects `events/items/…-discovery-hour-<generation>-<hour>.json` for the hours 14:00 to 23:00 of 23 Nov (R2 object GET and list).
- D1 `iptv`, read with `SELECT` only on 24 Nov about 09:30: `discovery_status`, `discovery_continuation`, `discovery_workflow`, `discovery_epg_priority`. Only state fields are quoted; no film, key or title.

## The three events

| Hour (UTC) | Madrid | Stored event | Owner saw |
| --- | --- | --- | --- |
| 15:00 | 16:00 | `kind=hour`, `status=empty`, `reason=queue_empty`, `queueEmpty=true`, `remaining=0`, generation `bf89ba90` | «Очередь Discovery пуста», success |
| 16:00 | 17:00 | `kind=report_failed`, `reason=write_conflict`, `status=null`, generation `bf89ba90` | «Отчёт за час не удалось сформировать», warning |
| 22:00 | 23:00 | `kind=hour`, `status=idle`, `reason=backlog_empty`, `queueEmpty=false`, `remaining=0`, generation `d8dc6ec8` | «Discovery не работает: запуска не требовалось», success, remaining 0 |

## Finding 1: the 22:00 event (established)

Observed:

- The scheduled reconcile at 22:00:25 answered `reason=stopped`, generation `d8dc6ec8`, series 27.
- D1, unchanged since 19:24:56 (no chunk ran after it): the executor record is `phase=stopped`, `reason=backlog_empty`, generation `d8dc6ec8`. The continuation is `stage=paused`, `reason=chunk_budget`, `remainingChunks=0`, same generation. The status file of the same generation and the **same `hopId`** as the continuation is `stage=partial` with `remaining=0`, `cheapRemaining=0`, `deferred=0`, `waitingRetry=0`, `error=null`, and `legacyPending=true` (the legacy alias sweep of ADR 0158: `sweepChunks` 25 of 40, lap not complete, `eligible` 0).
- The hours 20:00 to 23:00 all carry `status=idle`, `reason=backlog_empty`, `remaining=0`, `queueEmpty=false`.

Mechanism (code): `continuationAfterChunk` (`src/discovery.js`) does not complete a series while `legacyPending` is true, so the last chunk of the hop budget paused it on `chunk_budget`. `renewDiscoverySeries` (`src/discovery-workflow.js`) then refused a new budget because `remaining` was 0 (`backlog_empty`), a terminal stop. `discoveryReportQueue` claimed an empty queue only for a `complete` continuation, so a fully drained queue was reported as `idle`. Nothing was wrong with Discovery; the report could not prove what the state proves.

Not changed (execution policy, out of scope): the sweep stays unfinished until the next generation because the executor stops on `backlog_empty`. ADR 0158 names the hop chunk budget as one of the sweep's bounds.

## Finding 2: the 16:00 event (inferred from code and timing, strongly supported)

Observed:

- 16:00:24 scheduled reconcile `reason=stopped` (generation `bf89ba90`); 16:00:29 `discovery_hour_close_failed` with `reason=write_conflict`, `notice=delivered`.
- The EPG event of the new generation `d8dc6ec8` is stamped 16:04 UTC (17:04 Madrid): the publication of the day happened four minutes after the close.
- The pause arms at 16:55 Madrid (`EPG_PRIORITY_LEAD_MINUTES` 5 before the 17:00 due), so at 17:00:24 Madrid it was held for the day.

Mechanism (code): the reconcile path `ensurePublishedDiscoveryIntent` → `stopped` writes nothing, so it was not refused. The close then writes the executor record without a lease; `writeWorkflow` (`src/discovery-authority.js`) carries the pause predicate and answers `discovery_epg_priority`. `writeWorkflowStateSoft` turns that into `priorityBusy`, but `closeHourlyDiscoveryReport` handled only `windowBusy` and counted every other refusal as `write_conflict`, three attempts in about five seconds, then the notice.

Limitation: no log line names the refusal kind of that write (the close logged only its own reason), and the pause row is read today as `clear`, so the refusal by the pause is inferred from the code path, the time and the absence of any other writer at minute 0 (the fast tick runs on odd minutes), not observed directly. With this change the same case logs `reason=epg_priority`.

## Finding 3: the first report after a publication lost its period (established, latent)

Observed: the 17:00 report of `d8dc6ec8` has `from: null` (112 chunks, 87 added, all in that period), while every report keeps `from` = the previous closed hour.

Mechanism (code): when the reconcile starts the first series of a NEW generation, `ensureDiscoveryWorkflow` called `createWorkflowInstance` without the previous record, so the accumulator (`report` with `since` and `lastClosedHour`), the `outbox` and the rollover receipt of the old record were not carried, contrary to the reference contract. On 23 Nov the old accumulator held no chunk, so no delta was lost that day; an undelivered outbox entry or deltas held by a pause-refused close would have been dropped.

## Fix

- `discoveryReportQueue` proves an empty queue from the full evidence of the drained series (record stopped on `backlog_empty`, continuation paused on `chunk_budget` with no chunk left and a hop id, status of that hop and generation with every queue part the number 0 and no error). Anything missing or unknown keeps `idle`; an unreadable status is the unreadable queue.
- `closeHourlyDiscoveryReport` names a pause refusal `epg_priority` (not retried, accumulator untouched, appended ledger reason index 5 in the separate v2 ledger), keeping an independent queue read failure of the same close as `fault=queue_unreadable`. The notice names no other state when the reconcile was refused by the same pause; an independent confirmed state is still named. A genuine lost compare-and-swap stays `write_conflict`.
- `ensureDiscoveryWorkflow` passes the previous record to `createWorkflowInstance`, so the report, outbox and last closed hour cross a generation change.
- The card of a `report_failed` notice with `reason=epg_priority`, and of an hourly report with `status=blocked`, `reason=epg_priority`, reads «Discovery приостановлен на время обновления программы» with a warning badge and no report-failure text.

## Independent review follow-up (24 Nov 2026)

The first review of [vladimino/iptv-watchlist#977](https://github.com/vladimino/iptv-watchlist/pull/977) asked for three changes, all made in the same PR:

- **An independent queue read failure beside the pause.** A close whose queue read failed (`queue_unreadable`) and whose record write the pause refused produced the same notice as a clean pause. The notice now keeps both: `reason=epg_priority` and `fault=queue_unreadable` (no counters), through the ledger and its replay; the log line carries `fault` too.
- **No promise of resumption.** The pause card said Discovery would continue after the programme update, also beside an exhausted or stalled chain. It now says only when the gate lifts (the update published and certified complete), and an independent failure keeps its sentence and error badge.
- **Rollback without loss.** The Worker before this change drops every ledger tuple it cannot decode when it writes its ledger back, so a reason index 5 in `events/discovery-report-faults.json` would be lost on a rollback. Notices it cannot rebuild now go to a second object, `events/discovery-report-faults-v2.json`, which that Worker never reads or writes; the old object holds only tuples it decodes. Covered offline with the older reader's decode rule copied verbatim into `tests/discovery-events.mjs` 18c.

## Second review follow-up (24 Nov 2026)

The re-review accepted the first follow-up and found two regressions of the ADR 0118 recovery bounds in the two-object ledger, both fixed in the same PR:

- **Drain bound refunded on an exception.** The per-object drain answered `attempted: 0` when its cleanup threw after the journal puts, so the second object could spend another 64. The firing now merges both objects, fixes one batch of at most 64 before the first put, and cleans each object afterwards; no failure path can add puts.
- **Capacity and order changed per object.** The admission now counts both objects against the one 8,760 bound and refuses a second entry for an hour queued in either; the drain orders both by hour, oldest first. The only remaining difference is the rollback window, documented in the reference: the older Worker bounds only its own object.

Covered by `tests/discovery-events.mjs` 18d (oldest-first across both, both objects beyond one drain, a thrown cleanup put, a refused compare-and-swap followed by a thrown read, idempotent recovery, the logical bound from either side, one entry per hour across both).

## Third review and owner decision (24 Nov 2026)

The third review accepted the drain fix and qualified the admission: the two objects have independent compare-and-swaps, so two simultaneous writers to different objects can each add one entry above 8,760, and a simultaneous repeat of one hour with two reason classes can queue two tuples (one visible journal event). `tests/discovery-events.mjs` 18e reproduces both deterministically and shows that the next admission is refused and the drain bound holds; the reference states the exact, best-effort guarantee. The Product Owner selected option A on 24 Nov 2026 ([decision](https://trello.com/c/dPjrNIbQ#comment-6b056ce779079110d0ef3bb5), [PR comment](https://github.com/vladimino/iptv-watchlist/pull/977#issuecomment-7129406215)): the bounded best-effort exception is accepted and no new lock, migration or coordination mechanism is introduced. It is recorded as [ADR 0208](../../adr/0208-discovery-report-fault-ledger-in-two-objects.md), which partially supersedes ADR 0118.

## Tests (offline)

- `tests/discovery-events.mjs` 17: the drained series of 22:00 (empty with real counters, also with the period's own chunks) and every negative (another hop, another generation, each queue part non-zero or unknown, an owed chunk, other pause reasons, a stale or non-terminal stop, a running reconcile, an unreadable status).
- `tests/discovery-events.mjs` 18: the pause refusal (one attempt, `epg_priority` notice, no counters, accumulator kept, log reason), repeat of the hour, other confirmed states beside the pause, ledger encode/decode and older tuples, pause release with the held deltas once, a genuine `write_conflict`, a report admitted during the pause.
- `tests/discovery-events.mjs` 18b / 18b' / 18c: a continuation or status read that throws beside the pause (notice with `fault`, v2 ledger, replay unchanged, clean pause without `fault`, release with deltas once); the rollback reader of the old ledger and the untouched v2 object.
- `tests/discovery-events.mjs` 19: a new generation through `ensureDiscoveryWorkflow` carries report, outbox, rollover and `lastClosedHour`; the next report's `from` is the last closed hour.
- `tests/epg-priority-gate.mjs`: the close against the real pause statement on a sqlite D1 stand-in: refused as `epg_priority` (with `fault=queue_unreadable` when the continuation read throws, without it otherwise) with no D1 write and no generation move, then admitted after the handoff with the held deltas once.
- `tests/activity-ui.mjs`: the pause cards, the independent failure beside the pause, the drained empty card and a real idle card.

## Acceptance still open

Natural production checks after deploy: an hour after a series drains with the sweep open must read «Очередь Discovery пуста», and the 17:00 Madrid hour of an EPG publication must read «Discovery приостановлен на время обновления программы» with the next report carrying the period. Stored events of 23 Nov are not rewritten.
