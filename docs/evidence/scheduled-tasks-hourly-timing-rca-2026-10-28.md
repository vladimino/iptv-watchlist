# Hourly Scheduled Task timing: `:00` shown for a `:20` trigger — RCA

- **Captured:** 28 October 2026. **Card:** [AIR-223](https://trello.com/c/eWeaZziA). **Code inspected:** `main` at `d14f861`.
- **Scope:** the "next run" times shown by the footer, the prediction API, the discovery contract and the MCP texts, compared with the hourly task's recurrence. Code and documentation only.
- **Operational authority:** none. No production read or write, no task, prompt, flag or schedule change was made for this report. The live recurrence below is the observation recorded on the card, not a registry read made for this report.

## Symptom

On 28 October 2026 the footer showed `Следующий запуск: около 07:00` (Europe/Madrid), and a ChatGPT session reported "the next regular refresh is at 06:00 UTC (`nextCatchUpAt`), now 05:33". The card records the hourly task `Почасовые прогнозы «В эфире»` as `DTSTART;TZID=Europe/Madrid:20261027T202000`, `RRULE:FREQ=HOURLY;INTERVAL=1`, `default_timezone: Europe/Madrid`, with the last run scheduled for 05:20 UTC and started at 05:22 UTC. The nominal next trigger was therefore 06:20 UTC (07:20 Madrid), not 06:00 UTC.

## Root cause

`src/enrichment.js` defined one helper, `nextCatchUpAt()`, as `new Date(Math.floor(Date.now()/3600000+1)*3600000)`: the next whole UTC hour. It knew nothing about the task's recurrence, and it served two meanings:

1. **The discovery wait gate.** `src/discovery.js` stored it as the checkpoint's `nextCatchUpAt` for `chunk_budget` and errors, used it as the default in `discoveryContract` for every `wait`, in `busyOutcome` and the `generation_pending` branch, and `continuationDecision` / `hardWait` refuse a step until it has passed. As a gate the whole hour is sound: it lies before the next `:20` trigger in the same hour.
2. **The "next scheduled run".** The same value was returned as `nextCatchUpAt` by the prediction queue status, the runner responses, the writer-busy 409, the prediction Events, and as `predictions.nextScheduledRun` in `GET /api/enrichment/footer/status` (via `queueStatusView`). `public/app.js` printed it as `Следующий запуск: около HH:MM`. The MCP texts called the discovery value only "do not call before", so a caller reading `nextCatchUpAt` had nothing else to name as the next run.

Every reader that meant the second sense therefore reported the whole hour, 20 minutes before the actual trigger. The `:00` was also written into the prediction-operations runbook ("A nominal `:00` trigger"), while the Scheduled Task contract already said `:20`.

## Fix (same delivery)

- One expected recurrence, `HOURLY_TASK_SCHEDULE = {timeZone: 'Europe/Madrid', minute: 20}`, and `hourlyTaskRunAt(from)`: the first instant at or after `from` whose Madrid wall-clock minute is `:20`, computed through `Intl`, `null` on an unusable time zone or recurrence.
- The footer, the queue status, runner responses and Events report that nominal time (`nextScheduledRunAt`; `nextCatchUpAt` kept as a compatibility name in prediction responses).
- The discovery gate is unchanged (`nextCatchUpAt`, next whole UTC hour, backoff time or lease expiry). A `wait` now also carries `nextScheduledRunAt`, the first trigger at or after the gate.
- Tests: `tests/scheduled-task-timing.mjs` (hour boundary, both 2026 Madrid DST changes, backoff and gate fencing, footer and discovery downstream, fail-closed without time zone data, single `:20` constant agreeing with the contract).

## Documentation audit

| Page | Finding | Action |
| --- | --- | --- |
| `docs/reference/scheduled-tasks.md` | Daily 17:00 and hourly `:20` Europe/Madrid correct; no distinction between nominal trigger and discovery gate | Timing section added |
| `docs/runbooks/prediction-operations.md` | "A nominal `:00` trigger" — wrong | Corrected to `:20`; gate vs trigger explained |
| `docs/reference/api/enrichment.md` | "next catch-up time" and footer `nextScheduledRun` undefined; `nextCatchUpAt` row correct as a gate | Clarified; `nextScheduledRunAt` row added |
| `docs/reference/api/mcp.md` | `wait` row correct as a gate | Pointer to the expected trigger added |
| `docs/architecture/scheduling-and-orchestration.md` | Diagram actors `Daily EPG Task (17:00)` / `Hourly Task (hourly)` correct; no wrong time | Prose pointer only; Mermaid unchanged |
| `docs/runbooks/mcp-connectivity.md` | "Wait for `nextCatchUpAt`" rows refer to the gate — correct | None |
| `docs/runbooks/deployment.md` | Dated observation "17:00 Europe/Madrid and hourly predictions" — not wrong | None |
| `docs/evidence/scheduled-tasks-audit-2026-10-25.md` | Historical snapshot | None (evidence is not rewritten) |

## Limits

The Worker cannot read the task registry, so drift between `HOURLY_TASK_SCHEDULE` and the live recurrence is not detected at runtime; it is caught only by a registry audit against the Scheduled Task contract. Whether the scheduler fires once or twice in the repeated October hour is not known; the nominal estimate lists both instants. Production verification after deploy is limited to read-only MCP status tools.
