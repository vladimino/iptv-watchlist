# Ratings Cloudflare executor: offline evidence (AIR-347)

Captured 2026-11-05 (UTC) from the repository only. **No production read or write, no Letterboxd request, no Cloudflare setting change was made.**

## What was measured

`tests/ratings-orchestration.mjs` runs the executor against the in-memory R2 harness, a fake Workflow binding, an injected clock and random source, and a sqlite D1 stand-in for the epoch fence.

| Scenario | Result |
|---|---|
| 17:30 Madrid due instant, 24 Oct and 28 Mar (CEST/CET) and both DST change days (25 Oct, 29 Mar) | one run key per Madrid date; next date is a new key |
| Two concurrent `ensure` calls | one wins the control CAS, exactly one Workflow create |
| Whole run | Diary page 1 only (1 request), run `finished`, control `done` |
| 403 `cf-mitigated` | 1 request, no in-run retry, next Madrid date starts with a fresh budget |
| 429 | six-hour pause is the cooldown; same date completes after it |
| Repeated network failure | cooldowns ~1, 5, 15, 60 minutes, fifth consecutive failure quarantines the run key |
| Isolated pipeline | domain quarantine, cleared only by the explicit action, which runs no step |
| Mode `switching` / `cloudflare` | external `start`/`step` refused, reads open; drain not verified refuses completion |
| Stale epoch commit on D1 | whole batch refused, nothing written, generation unchanged |
| Status read | no write |

## Limitations

Real Workflow scheduling, wakeup loss, step memory/CPU and Letterboxd behaviour are not covered. The harness cannot model every D1 plus R2 combination.
