# Scheduled Tasks: daily drift monitor and staged Ratings Task (30–31 October 2026)

**Captured:** 30–31 October 2026 (UTC). **Source of the live configuration:** the coordinator's owner-authorized changes and read-backs of the live ChatGPT Scheduled Tasks registry, as recorded on the [AIR-293 card](https://trello.com/c/pUgAE8HU) (description, and comments of 2026-10-30 18:03 UTC and 2026-10-31 00:01 UTC). **Not independently re-read:** the executor of this documentation had no access to the Scheduled Tasks registry; every registry field below is the coordinator's recorded read-back, not a fresh observation. **Pinned repository reference:** `main` at `3a2d23b` for the Worker code checks. **Evidence lifecycle:** dated, historical configuration record; the registry stays authoritative. **Scope:** four automations' configuration; no execution transcript, storage contents or secrets captured.

## Authorization

- **30 October 2026.** The owner approved converting the existing weekly drift audit into a daily read-only monitor, as mitigation after the inconclusive platform RCA of [AIR-292](https://trello.com/c/CTxq4Khy), in which the daily EPG task was observed disabled with the actor unproven. No other production action was approved.
- **31 October 2026.** The owner requested an independent daily Ratings Task and a clarification of the daily EPG task's prompt. The approval covered creating the new task disabled and editing the EPG prompt; it did not cover enabling the Ratings Task, running it, or any ratings writer. The ratings design, code and activation are [AIR-296](https://trello.com/c/6lFnWkr8), [AIR-294](https://trello.com/c/IzWiVABa) and [AIR-295](https://trello.com/c/VtFZ6cci).

## Configuration recorded

| Automation | Change | Recorded read-back |
| --- | --- | --- |
| `IPTV Scheduled Task Drift`, `6ade65245de481919b816c5f5026c121` | Weekly Monday 09:00 Europe/Madrid → daily 17:45; prompt extended with the `epg_status` read | `enabled=true`; `DTSTART;TZID=Europe/Madrid:20261030T174500`; `RRULE:FREQ=DAILY;BYHOUR=17;BYMINUTE=45`; `default_timezone` Europe/Madrid; `next_run_time` was `null` |
| Ratings Task, `6ae52289ae9481919a68eec9310f5d8c` | Created, then disabled | `enabled=false`; flexible daily recurrence around 18:00 Europe/Madrid, provisional |
| Daily EPG task, `Automation_5d50308ce72c8191a50242fa604836b2` | Prompt only: after the code split ratings belong to the separate task; the task calls no ratings tool itself | `enabled=true` and 17:00 Europe/Madrid unchanged; existing EPG and discovery steps kept |
| Hourly predictions task | None | Not edited |

**Drift monitor prompt, as recorded:** read-only checks of the EPG and hourly tasks' enabled state, latest run, schedule and prompt against `docs/reference/scheduled-tasks.md` on `main`, plus the Worker's `epg_status` for EPG freshness; a notification only on anomalous findings; no self-healing and no production writer.

## Worker code at the pinned reference

- The Letterboxd ratings and Diary stage still runs inside the EPG commit: both commit paths in `src/worker.js` end with `completeWithRatings`. The EPG prompt change does not move it out of the commit.
- The MCP tool list in `src/mcp.js` has no ratings tool; `epg_status` (`MCP_READ`) returns `stage`, `runId`, `updatedAt`, `ratingsPending`, `ratingAttempt` and `ratingError` from `sync.json`.

## Verdict and limits

**Verdict:** the maintained [Scheduled Task contract](../reference/scheduled-tasks.md), [scheduling diagram](../architecture/scheduling-and-orchestration.md) and [drift monitor runbook](../runbooks/scheduled-task-drift.md) are aligned with the recorded configuration. Independent comparison with the live registry: **NOT VERIFIED** by the executor (no registry access).

**Limits:** a registry read-back proves the configured instruction and recurrence, not that a run will occur, read the right state or deliver a notification; the monitor shares the platform of the tasks it watches. No `run_now` was issued, and no first daily monitor run is recorded here. A documentation revert does not revert any live schedule; changing a task back needs a new owner decision.

**Operational authority:** this report grants none.
