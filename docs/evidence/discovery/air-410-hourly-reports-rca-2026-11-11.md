# AIR-410: why the Events Log lost the Discovery line (11 November 2026)

**Capture:** code reading of `main` at `6ff0ac2`, offline tests and the earlier Events Log observation reported by the owner. No production read, write, Discovery chunk, TMDB call, Workflow action or event repair was made for this report.

**Established (code and tests).**

- PR #476 wrote a `discovery` event only (a) when a chain settled at its terminal stop or (b) when a scheduled firing found the queue of the published generation confirmed empty (`remaining` and `cheapRemaining` zero, continuation `complete`).
- A chain that crosses hours (rollover, `step_cap`, recovery successors) is one logical tick. Every hourly cron during it returns `in_progress` or `recovery_waiting`, goes through neither path and writes nothing. The first test suite encoded that (scenario 9: «a running chain is not an empty queue», no event written), which is the wrong boundary rather than a missed case.
- The two old empty events (16:00 and 17:00 Madrid on 10 November) came from path (b) while the queue was `complete`. After the 10 November EPG publication reopened the queue, the chain ran across later hours and path (b) no longer applied, so no new event appeared.

**Not established.** Production hour-by-hour chunk results of 10-11 November (not read); whether a chain was running in a particular hour beyond what the owner reported.

**Decision.** [ADR 0111](../../adr/0111-discovery-hourly-reports.md): one report per scheduled hourly firing, as deltas, in every state. Offline tests in `tests/discovery-events.mjs` cover four hours of one chain with rollovers, duplicate, late and missed crons, every status, strict empty queue, replay, a checkpoint racing the close, a lost put, a crash before removal, outbox saturation, an unreadable record, DST hours, generation replacement and legacy delivery; mutation checks (removing the replay guard, the closed-hour guard, the outbox cap, the accumulator reset, the cheap-pass zero or the `null` counters) each fail them.

**Acceptance still open.** Production proof needs two consecutive natural hourly `discovery` events after the merge deploy, read through the owner's Events Log or an authorized read-only source (not `GET /api/events` as a probe), and the owner's acceptance.
