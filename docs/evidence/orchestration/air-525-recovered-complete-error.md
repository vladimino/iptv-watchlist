# AIR-525: EPG recovered `complete` with a prior attempt's `error` (17 November 2026, UTC)

Scope: code reading at `b7bf285` (`main`) and offline tests (`tests/epg-orchestration.mjs`, scripted pipeline, D1 stand-in and Workflow stand-in). No production read or write, no Workflow instance created, terminated or retried, no Task, flag, cron, schema or D1/R2 change. **No duplicate publication has been observed in production**: this is a proven logic defect and a crash/retry window, not an incident.

## Mechanism (from code)

1. `syncStep` (`src/worker.js`) writes `run.error` and saves `sync.json` whenever an `epg_commit` or `seal` step of a run throws.
2. A later step of the same `runId` that completes the run (`sealQueueStep`, or `finishSync` on the legacy path) writes `stage: complete` and `completedAt` and does not clear `run.error`. The seal branch's `catch` can also write `run.error` onto an in-memory run that `sealQueueStep` already saved as `complete` (a throw in the tail after the save), with the same result.
3. Before AIR-525, `drive` (`src/epg-orchestration.js`) credited a same-day complete run, and treated one with an owed event as usable, only when `!run.error`. If the action that drove the completion lost its result (platform retry) or its control CAS, so the control has no `doneAt`, the next action found `complete + error`, judged it unusable and called `/api/sync/start`. `beginSync` starts a new run over a complete one (only an owed event keeps the old run), so a second same-day run and publication would follow.
4. The read model's `doneToday` used the same `!run.error`, so `epg_status` reported `late` / overdue for a day that was already published.

Other consumers of `run.error` checked: the production monitor (`src/monitor.js`) already ignores it on a complete run (`runError` requires `stage!=='complete'`). The published-date surfaces of AIR-518 (`epgPublicationState` in `src/enrichment.js`) bind the run to the published programme and report `attempt.outcome: recovered`, which is the intended reading. The footer's `letterboxd_watchlist` integration (`src/enrichment.js`, `integrations`) still treats `complete + error` as not a fresh success; that is a read-only footer label, out of the scope of this card (AIR-518/AIR-519 surfaces), and is recorded here as a known limitation.

## Change

- `completion(env, run)` in `src/epg-orchestration.js`: a complete run without an error is proven by its stage (unchanged); one with an error is proven only by a valid `completedAt` and the D1 published pointer (`PublishedEpg.readAuthority`: `ready`, `programmeRunId === run.runId`). Results: `proven`, `unproven`, `unreadable`.
- `drive`: for a complete run of the control's own day, `proven` finishes (note `recovered_complete`) or drains the owed event / Ratings hand-over through `/api/sync/epg` on the same `runId`; `unproven` is `evidence_contradictory` (unsafe); `unreadable` is `d1_unavailable` (transient). No path from a same-day complete run reaches `/api/sync/start`. Foreign-day complete runs keep the AIR-464 rule.
- `readModel`: `doneToday` uses the same proof; `syncRun.priorAttemptError` reports the history. `GET /api/status` / `epg_status` add `priorAttemptError`; `error` is unchanged.
- Writers are unchanged: the error stays on the record as evidence.

## Red before, green after

The new block `7k` in `tests/epg-orchestration.mjs` was run against the previous `src/epg-orchestration.js` (only that file reverted):

- With the read-model assertions: `AssertionError: a proven complete run of today is done without a control doneAt` (`'late' !== 'healthy'`).
- With those assertions removed, the executor path: `AssertionError: no second /api/sync/start for a recovered complete run` (`1 !== 0`).

With the change, the whole file passes (`epg-orchestration: ok`).

## Cases covered (block `7k`)

| Case | Result |
|---|---|
| Same day, `complete`, valid `completedAt`, prior `error`, pointer at the run, control without `doneAt` | Read model `healthy`, `overdueMs: null`, `priorAttemptError: true`; no `/api/sync/start`, no step; control `doneAt`, `publishedRunId` and `runId` = the run, `lastStep.note: recovered_complete`; pointer and `error` unchanged; a repeated action stops on `complete` |
| Same, with an owed `epg` event and watchlist hand-over | One `/api/sync/epg` drain on the same `runId`, markers cleared, finished; no start |
| Same, the finishing control CAS lost once | Next action re-proves and finishes; no start |
| Pointer at another run, pointer at no run, no `completedAt`, malformed `completedAt` | Read model not `healthy`; `evidence_contradictory`, no `doneAt`, no start |
| Authority read throws inside the action | Transient `d1_unavailable` cooldown, then proven and finished; no start |
| `stage: seal` with an `error` | Not done, `priorAttemptError: false`; the seal continues under its `runId` |
| Complete with an `error` of the previous Madrid day | Today's run starts once (unchanged) |
| Complete without an `error` (pointer elsewhere) | Finished on its stage as before; no authority proof needed, `note: null` |

## Limitations

- Offline only. Production acceptance is a natural EPG run or recovery read through `epg_status`, the D1 publication/control and `sync.json`, if that scenario happens; the absence of an incident does not prove the replay path. The scenario is not to be provoked by hand.
- The footer `letterboxd_watchlist` label above is not changed here.
