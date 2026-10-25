# Hourly Scheduled Task: orphaned discovery recovery prompt

**Captured at:** 2026-10-25, after the owner-authorized prompt change (update acknowledged at 21:50:51 UTC; configuration independently re-read from the live ChatGPT Scheduled Tasks registry during the same evening). **Source:** live ChatGPT Scheduled Tasks registry, not GitHub or the application's Events page. **Evidence type:** operational configuration snapshot. **Scope:** one hourly Task and its expected recovery contract; no storage contents, source-data sample, execution transcript or secrets captured.

## Authorization and context

The owner requested that the safe orphaned-continuation behavior be added to the existing hourly Task before merging the Worker recovery implementation. The approved source code is [PR #106](https://github.com/vladimino/iptv-watchlist/pull/106); the documentation alignment is tracked in [the Scheduled Task documentation card](https://trello.com/c/yERRztCT). The Worker code and external Task prompt are independently deployed/configured; neither one invokes the other automatically. The Task's pre-existing prediction validation gate remains in place.

## Configuration observed

| Field | Live registry observation |
| --- | --- |
| Task identity | `Почасовые прогнозы «В эфире»` |
| Enabled | `true` |
| Recurrence | `DTSTART;TZID=Europe/Madrid:20261021T000000` plus `RRULE:FREQ=HOURLY;INTERVAL=1` |
| Timezone metadata | `default_timezone: Europe/Madrid` |
| Timing mode | `exact_schedule` |
| Hourly processing order | Stage A: existing-generation discovery, then Stage B: predictions |
| Prediction preflight | `prediction_validate` required before every `prediction_submit`; absent tool fails closed |
| Worker recovery gate | Raw `running` is never sufficient; require `continuationHealth.status=orphaned`, expired or absent lease, matching published/pinned generation, no generation conflict, valid `resumeBudget`, and no future backoff/wait |

**Change versus prior expectation:** a `running` discovery continuation may now be advanced by **one ordinary same-generation `epg_sync_step`** when a compatible Worker establishes all recovery preconditions. If health is absent (older Worker), uncertain, busy/live or contradicts the generation, the hourly Task must skip the writer. Every later chunk still requires an explicit call and safe server `nextAction=continue`; `epg_sync_start`, forced retries and lease resets remain prohibited for this Task. The daily 17:00 Europe/Madrid EPG Task was not changed by this prompt edit.

## Result, uncertainty and verdict

**Observed result:** the existing hourly Task remained enabled and retained its hourly Europe/Madrid recurrence; the prompt contained the recovery preflight and kept the full prediction-validation instructions. **Configuration verdict:** aligned with the maintained [expected operational contract](../reference/scheduled-tasks.md) after the documentation change.

**Limits:** reading the Task registry proves its configured instruction and recurrence, not that a scheduled execution actually called `epg_sync_step`, successfully committed a discovery checkpoint or produced a prediction. Worker `epg_pipeline_status` and the Scheduled Task execution history must be correlated separately for run acceptance. Server-side leases, published-generation identifiers and R2 state can change between status reads. The Task registry remains authoritative for actual configuration; this dated record is historical.

**Used by:** [documentation alignment card](https://trello.com/c/yERRztCT) and [recovery delivery](https://trello.com/c/wpalDqcB). **Superseded by:** none recorded. **Operational authority:** this report grants none; any further manual production writer remains subject to action-specific owner approval.
