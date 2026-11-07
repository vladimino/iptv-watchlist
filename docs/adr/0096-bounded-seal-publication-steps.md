# ADR 0096: The staged publication after the catalog is three bounded steps

**Status:** Accepted  
**Original decision date:** 2026-11-07  
**Recorded at:** 2026-11-07  
**Approval source:** Product Owner accepted ADR 0096 on 2026-11-07 in the [AIR-353 Trello decision record](https://trello.com/c/Hqq2JhnH); technical review of PR #393 at `4e21c13` accepted the implementation subject to exact-head CI and delivery gates.  
**Related work:** [AIR-353](https://trello.com/c/Hqq2JhnH), [AIR-356](https://trello.com/c/JJI9O5I5), [AIR-324](https://trello.com/c/kNtaEbm8), [ADR 0092](0092-resumable-bounded-ledger-seal.md), [dated evidence](../evidence/d1-migration/air-353-seal-publish-wall-2026-11-07.md)  
**Supersedes:** [ADR 0092](0092-resumable-bounded-ledger-seal.md) decision 3 in part: its single `publish` step becomes three steps. The job, the cursor, the fences and every other decision of that record stay.  
**Superseded by:** None

## Context

[ADR 0092](0092-resumable-bounded-ledger-seal.md) ends the staged publication in one `publish` step: the published pointer, the mirrors, the generation copy and the discovery intent, then the commit tail (the watchlist, the scan observation, the events, the prediction queue refresh), then the reply that opens the discovery series. On 6 November 2026 that step took **83.7 s** of wall time (CPU 4.2 s) for 39,920 observations: 2.4 s from request entry to the phase, 31.4 s for the pointer, mirrors, copy and intent, 44.0 s for the commit tail (17.2 s before the queue refresh, 26.8 s for the refresh itself) and 6.8 s to the reply. The shortest MCP client waits about 60 s, so that client timed out on a step that the Worker then finished. The ledger and catalog steps take about 30 to 36 s and were not affected. A timed-out step has an unknown outcome and a blind repeat is not allowed, so the combined step cost an operator a readback and a pause.

## Decision

1. **After the catalog, the publication is three steps**, each answering `stage: seal` and `discovery.nextAction: continue` until the last:
   - `publish`: four units in order: the published pointer (with the programme document of the generation), the mirrors, the generation copy, then the discovery intent with `uncertain.json`.
   - `finalize`: four units: the ratings hand-over, the watchlist, the scan observation, the events (the part of the commit tail that does not touch the prediction queue).
   - `queue`: the prediction queue refresh, then the run is `complete`, its staging payload is removed and the reply opens the discovery series.
2. **A step is a list of units with a budget counted from the request's entry.** `postSync` passes its entry time to the step. The ledger and catalog steps keep small units (a batch, a catalog slice) and start none after 32 s from entry. The three publication phases have large units, so they start none after **20 s** from entry; their worst case is that budget plus the longest unit that started before it. The first unit that is not finished always runs (a step that could start nothing would never progress). When the budget has passed after a unit, the step saves the finished units in `run.seal.units` and answers `continue` in the same phase; the next call resumes with the next unit.
3. **The pointer is the one atomic unit.** Before it the previous generation stays published and its fence is checked (a changed fence refuses the step); a repeat after it finds the generation published and skips it, so the pointer moves exactly once whatever is cancelled, before or after it and before the discovery intent.
4. **A failed unit is never recorded as done.** A mirror write or generation copy that fails (or throws) is retried by the next calls, up to three tries, and is then recorded as `gave_up`, named in `run.sealDegraded` and in the answers (`seal.degraded`, and `degraded` in the final answer), never as `ok`. The mirrors are also repaired by the readers (`PublishedEpg.repairMirrors`), and the watchlist fallback is written when they failed. A fatal error (a changed fence, an unreadable payload) keeps the phase and the step is repeated.
5. **Each unit is idempotent and a failing step keeps its phase.** The watchlist save compares the update time, the scan observation is keyed by the run, events are keyed, the queue refresh recomputes. A cancelled step, a lost answer or a restart therefore repeats safely; the units saved by a checkpoint are read back from the run.
6. **The run is complete only after the queue refresh.** Before, the run was marked complete first and a refresh failure was recorded on it. Now the refresh runs first; a failure is recorded in `enrichmentQueueError` (bounded to 160 characters) and does not hold the run.
7. **The ratings result is carried.** The final answer carries `ratingsPipeline` (`separate`, or `blocked` with `ratingsMigration`) as before.
8. **The chunk reports its preflight.** The discovery chunk's timings gain `preChunkMs`: the gap between the start of the preflight in `advanceDiscovery` and the chunk's own clock. It is `null` when the chunk was started without an entry time.
9. **Residual unknown outcome.** A single unit longer than the client wait (a slow D1 or R2 day, or a queue refresh of 27 s on a slow day) can still end a call at the client with an unknown outcome. The contract is then: read back `epg_status` and the `seal.phase`, and call again; every unit is safe to repeat once it is known not to be running. A cancelled call can hold the discovery lease for up to 90 s and a call during that time answers `busy` ([AIR-362](https://trello.com/c/EhORTvy5)).
10. **Not decided here:** a request-level deadline for the external discovery chunk (the Workflow runs its chunks in a step of ten minutes, see [ADR 0083](0083-inert-discovery-workflow.md)); the contract of `busy`/`wait` during a seal (AIR-362); the generation handoff `input_missing` of the cron reconcile ([AIR-363](https://trello.com/c/Hc2g5etw)); the latency of the cron recovery ([AIR-364](https://trello.com/c/QSu1SDvS)); a Cloudflare Workflow as publisher, which stays a separate owner decision if this bounded path fails its measurement.

## Alternatives considered

- **Raise the client wait.** Rejected: it is outside the Worker's control, and 83.7 s leaves no margin for a slower day.
- **Move the publication to the Workflow.** Rejected for now: it is a larger change of executor and ownership; the three steps need no new component and keep the existing fences.
- **Split only the pointer from the tail.** Rejected: the tail alone is about 51 s with the reply, too close to 60 s. The queue refresh (26.8 s) is the natural second cut.
- **Skip the queue refresh in the publication.** Rejected: the queue must follow the published programme; moving it to a later step keeps that guarantee.

## Consequences

An EPG commit through the staged path takes two more client calls. No step is expected to exceed about 35 s on the 6 November sizes (see the evidence), so every step has about 25 s of margin under 60 s. A client or prompt that follows `continue` until `complete` needs no change.

## Recovery and migration boundary

Code only. No migration, flag, schedule, cron or Task changes. A run that is in the old `publish` phase when the new code starts takes the new `publish` step and continues. Code rollback returns the single combined step and does not revert D1, R2 or published generations.

## Evidence

- **Dated measurement:** [AIR-353 evidence](../evidence/d1-migration/air-353-seal-publish-wall-2026-11-07.md)
- **Tests:** `tests/discovery-seal-publish.mjs` (the four publish units around one pointer: a refused fence, a cancellation before the pointer, a cancellation after it and before the intent, a passed deadline between units in every phase, a failed mirror write or copy retried and then reported as degraded, a lost answer and a restart after a checkpoint, a slow pointer; the three phases in order, the persist and refresh while the run is still sealing, a failed refresh recorded and bounded, a failing step keeps its phase, a repeated queue step), `tests/discovery-chunk-budget.mjs` (`preChunkMs`)
- **Uncertainty:** the per-step wall times after the split are estimated from the measured phases of the combined step, not measured; a run through the new steps in production has not happened.
