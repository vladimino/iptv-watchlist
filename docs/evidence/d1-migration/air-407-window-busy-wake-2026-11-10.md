# Discovery Workflow: a busy checkpoint refused by a projector window waits for the window, not for the next hour

**Captured:** 2026-11-10 UTC, offline: the code of `main` at `652b2ea` and `tests/discovery-workflow.mjs` (the real Workflow loop with a fake step runner and a fake clock). No production read or write was made for this report; the two production episodes below are the ones recorded in the card's read-only analysis of that day.
**Scope:** [AIR-407](https://trello.com/c/UAKm2NPJ). The Workflow loop's `busy` branch in `src/discovery-workflow.js`.
**Verdict:** **FIXED OFFLINE; PRODUCTION NOT YET OBSERVED.** A busy chunk whose progress checkpoint is refused by a held projector window now sleeps to that window's one expiry (capped at 330 s like every other window wait). Before, it slept to the later of that expiry and the busy chunk's own `nextCatchUpAt`, which is the hourly gate. The new test fails on the previous code with the wake one hour late and passes on this change.
**Used by:** [ADR 0103](../../adr/0103-projector-exclusive-window.md) (the Workflow waits until the window's time).

## The defect

In the `busy` branch the loop saved a `waiting` record, and when the window refused that write (`reason: projector_window`) it slept until `Math.max(until, windowWakeAt(settledBusy))`. `until` is `outcome.discovery.nextCatchUpAt` of the busy chunk, the shared hourly gate, so the maximum was the end of the hour, not the window's expiry (about five minutes after the grant). The card's analysis of one instance (series 110) records two such waits, `busy-sleep-15-1` from 06:01:02 to 07:00:00 UTC and `busy-sleep-28-1` from 07:01:03 to 08:00:00 UTC, against window expiries of 06:05:43 and 07:05:44 UTC; the waits through the plan and the window-sleep paths at 08:01 and 09:00 UTC ended at the exact expiry. This report did not re-read those production steps.

## The change

`src/discovery-workflow.js`, the `busy-sleep`: when the refusal is `projector_window` and carries a finite, positive deadline (`window.expiresAt` or `windowUntil`), the wake is `windowWakeAt(settledBusy)` (that deadline, at most 330 s ahead). A refusal that names no readable deadline keeps the previous wake (`Math.max(until, fallback)`, so the hourly gate), and every other busy keeps `until`. The plan-wait branch, the rollover, the persist loops and the recovery loop are not touched.

## Tests

`tests/discovery-workflow.mjs`, section 16 (b2), the live loop `plan continue → chunk busy(nextCatchUpAt = next hour) → busy checkpoint refused by a window → sleep`:

| Case | Result |
| --- | --- |
| window of 300 s | first sleep is `busy-sleep` at exactly the window expiry, more than 30 minutes before the hour; no chunk starts before it; one sleep per busy round (no loop); after the window the ordinary busy wait is the hourly gate; nothing charged to the stall or recovery budget |
| no window | `busy-sleep` at the hourly gate, unchanged |
| refusal without a readable deadline | `busy-sleep` at the hourly gate, unchanged |
| window of 20 minutes | the wake is capped at 330 s |

The existing cases of section 16 (a) to (f) (plan wait, window-sleep, start, rollover, stop, recovery) pass unchanged. On the previous code the first case fails: the sleep is one hour late.

## Limits

- Not observed in production: the next confirmed window-busy is the proof; none is to be provoked.
- The plan-wait branch (`sleep`) still uses the later of its own time and the window expiry; the card's analysis found it correct in the two later episodes, so it is left alone.
- The source of the hourly `until` of the busy chunk (`lease_lost` or `record_changed`) is not established here and is not needed for the fix.
