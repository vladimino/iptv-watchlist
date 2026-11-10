# ADR 0107: GET and HEAD are query-only; repair belongs to a named, fenced, idempotent writer

**Status:** Proposed (owner approval pending; this ADR changes no runtime behavior and authorizes no operation)  
**Original decision date:** unknown (proposal recorded 2026-11-10)  
**Recorded at:** 2026-11-10  
**Approval source:** not documented. The scope was approved by the owner on card [AIR-412](https://trello.com/c/TuRMtgFF) (umbrella [AIR-411](https://trello.com/c/6abdVoGq)); the target model below is a proposal for the owner's acceptance  
**Related work:** [AIR-411](https://trello.com/c/6abdVoGq), [AIR-412](https://trello.com/c/TuRMtgFF), [AIR-413](https://trello.com/c/orvuzDW5), [AIR-414](https://trello.com/c/GJefgNm8), [AIR-415](https://trello.com/c/NHyIKM6z), [AIR-416](https://trello.com/c/f7FX4Elk); dated audit [GET/HEAD read side effects, 2026-11-10](../evidence/api/air-412-get-head-audit-2026-11-10.md); [ADR 0008](0008-atomic-epg-publication.md), [ADR 0079](0079-d1-authoritative-published-epg.md), [ADR 0100](0100-epg-cloudflare-workflow-executor.md)  
**Supersedes:** None. It adds a rule that no earlier ADR states; it does not change the authority of any domain.  
**Superseded by:** None

## Context

The route inventory of the production bundle was read and every read route, every page and every MCP read tool was requested in eight storage scenarios against an instrumented R2 bucket and an instrumented D1 ([audit](../evidence/api/air-412-get-head-audit-2026-11-10.md), [route and baseline reference](../reference/api/read-side-effects.md)). The audit found:

- **Fourteen HTTP routes and three MCP tools perform storage writes from a read**, through four shared helpers: the published-generation pin (`PublishedEpg.repairMirrors`), `diagnosticHistory` (settles a run whose lease expired), `recoverStopEvents` (delivers an undelivered stop event) and `ensureInitialRatings` (merges a personal-ratings seed into the view index).
- The mirror repair runs **on every read of a D1-authority generation, even when the compatibility mirrors are current**: the alignment test compares the watchlist etag with a field `currentGeneration()` does not return, so a request pays one or two fenced D1 `UPDATE` pairs for nothing. With mirrors missing or old it also rewrites five R2 objects. Eight admin and catalog routes, the programme and watchlist reads, the view and status reads and two MCP tools reach it only because they read the published generation.
- The MCP tools `prediction_queue_overview` and `prediction_film_diagnostics` are annotated `readOnlyHint: true` and write in D1 mode. `enrichment_status` is annotated `readOnlyHint: false` precisely because it writes.
- One outbound request exists on a read (`GET /api/integrations/tmdb/status`); it changes nothing of ours but spends provider quota.
- The previous guard (`tests/get-side-effects.mjs`) replaces only R2, allows four writing routes by name and did not see the D1 branch at all, so none of the D1 writers above was visible to it.

Consequences of writes on reads, as observed: a read competes with the writer that owns the same object (the EPG mirror, the prediction run record), a failed repair is swallowed or turned into a failed read, a crawler or a HEAD-like probe triggers recovery, an MCP client that trusts `readOnlyHint` is wrong, and the system's own diagnostics change what they measure. D1 is the authority for the published generation; R2 holds compatibility mirrors that a read is not the owner of.

## Decision

1. **GET and HEAD are query-only.** A GET or HEAD handler, and every helper it calls, performs no R2 put or delete, no D1 `INSERT`, `UPDATE`, `DELETE` or DDL, creates no Workflow instance, dispatches no Durable Object or continuation, schedules no `waitUntil` work and sends no outbound request other than a registered read-only GET. HEAD of an API route answers 404 or 405 as today and has no effect.
2. **A read computes, it does not settle.** When stored state is stale (an expired lease, an undelivered event, a mirror behind its authority), the read returns the **effective** state computed from the stored state and the clock, with the degraded or lagging condition explicit in the response, and persists nothing. It never retries on its own and never substitutes R2 for a D1 authority that is held or unreadable; it fails closed as it does today. Caches in memory are allowed; they are not storage.
3. **Repair has a named owner, is fenced, is idempotent, is repeatable and is observable.** Each repair kind is assigned to one writer that already exists and is already authorized for its domain, not to a read and not to a new schedule:
   - **EPG compatibility mirrors** (R2 objects derived from the D1 generation): the EPG writer. The generation publication already ends in a mirror tail; the reconciliation of drift belongs to the same Cloudflare EPG executor ([ADR 0100](0100-epg-cloudflare-workflow-executor.md)) and its `ensure` in the existing hourly tick. It writes R2 first and the D1 marker last, under the existing generation fence, and reports the lag. Card: AIR-414.
   - **Prediction run and lease settlement** (a run whose lease expired, its diagnostic row): the Predictions writer, at the points where it already runs (`prediction_start` settles the previous run; `prediction_complete` ends one). A new explicit owner command is introduced only if the card shows that a stalled run cannot wait for the next start. Card: AIR-415.
   - **Event delivery** (the stop and start events of a run): an outbox owned by the same writer, with a deterministic event id, bounded retries and a visible failure, so an event exists without anyone opening a page. Whether the sweep is part of the write path or an `ensure` in the existing hourly tick is decided by AIR-416 with the owner. Card: AIR-416.
   - **Personal-ratings seed in the view index:** a pure overlay in memory on read; persisting the seed, if it is needed at all, is a step of the ratings import or reconcile that already writes the index. Card: AIR-413.
4. **MCP annotations are promises.** `readOnlyHint: true` means no effect in any scenario and is enforced by the audit. A tool that writes is annotated as a writer; `MCP_STATUS` (`readOnlyHint: false`) is a transitional label for a status tool that still writes, not a category. After AIR-415 `enrichment_status` is annotated `readOnlyHint: true`.
5. **The audit is the contract.** `tests/get-write-audit.mjs` runs the production bundle against an instrumented R2 and D1 in eight scenarios (R2 authority healthy, with pending work, with nothing seeded; D1 authority with current, missing and old mirrors, with the cutover held, with pending work). A read route, page or MCP tool the inventory does not know, a new effect, a changed effect and a baseline entry nobody can reproduce all fail the test. The known writers are a **documented baseline** (`tests/get-write-baseline.mjs`) with the exact effects and SQL, the owner card and the reason. A fix deletes its entry; the audit then holds the route to no effect from that merge on. The baseline is not an allowlist for new work: adding an entry for a new writer requires an ADR change.
6. **Outbound read-only requests are registered and visible.** A read may send one registered GET to a provider when that is the route's purpose (the TMDB status probe). It never sends a body, a mutating method or a secret in a URL, and it is listed in the baseline as `outbound-read`, not as a storage writer.
7. **Safe switch to zero writes.** Every fix removes the write from the read and adds the writer behind the existing authority (the writer runs under the same fence, the same flags and the same owner gates as before) in one PR; the baseline entry is deleted in that PR. No fix creates a cron trigger, a Scheduled Task, a Workflow binding or a migration without its own owner decision.

**Not decided here:** the delivery mechanism of AIR-416's outbox (write-path versus an hourly `ensure`), whether AIR-415 needs an explicit owner command, the shape of the degraded markers in each response (each card keeps its DTO), any change to a feature flag, a schedule or an authority marker, and any production operation. This ADR is not an authorization for any of them.

## Alternatives considered

Evaluated during the audit; none was discussed with the owner beyond the card's constraints (no repair under GET, no new cron or Task, no automatic GET retries).

- **Keep the allowlist of writing reads (status quo, extended to D1).** Rejected: it records the writers without removing their cost or their races, and every new shared helper silently widens it. The audit keeps the same list as a visible baseline with owners instead.
- **Keep self-healing reads, make them cheaper and safer (idempotent, fenced).** Rejected as the target: the repair would still run in the request path of a reader, still compete with the writer, still be triggered by any client, and a read could still fail because a repair failed. The first audit finding (a write on every read of an aligned generation) is exactly the amplification this invites.
- **A new cron, Scheduled Task or Workflow per repair.** Rejected by the card: new schedules need their own owner decision; each repair has an existing writer.
- **Fail reads that need repair.** Rejected: a stale mirror or an expired lease is a state to show, not an error; a degraded but correct answer is the conservative behavior.
- **A runtime guard that makes any write inside a GET throw.** Not adopted now: it would turn today's silent self-healing into production errors before the writers exist. The audit is that guard at test time; a runtime guard can follow once the baseline is empty.

## Consequences

- Reads become safe to cache, to probe and to call from clients and from MCP without a side effect; diagnostics stop changing the state they report.
- Repair latency is bounded by the owning writer's cadence, not by a visit; until a writer runs, a mirror or a run can be visibly behind. The degraded state must be shown, which is a response change each fix card has to make deliberately.
- The audit costs about seven seconds of the suite and builds the production bundle once; the baseline is maintained alongside the fixes.
- The route inventory is derived from the bundle, so a new read route or MCP tool fails the audit until it is registered.

## Recovery and migration boundary

This ADR and its audit change no runtime code, data, flag, schedule or marker; reverting the PR removes only tests and documents. Each fix card carries its own rollback and states which durable effect a code rollback does not undo (an R2 mirror rewritten, a run record settled, an event delivered). An ADR never authorizes an operation: no production read of a potentially writing route, no replay and no repair is permitted by it.

## Evidence

- **Original decision:** not documented; scope on [AIR-412](https://trello.com/c/TuRMtgFF).
- **Implementation:** the audit harness and baseline in the AIR-412 pull request (`tests/get-write-audit.mjs`, `tests/get-write-audit-lib.mjs`, `tests/get-write-audit-harness.mjs`, `tests/get-write-baseline.mjs`).
- **Dated verification:** [audit 2026-11-10](../evidence/api/air-412-get-head-audit-2026-11-10.md) (offline, no production request).
- **Uncertainty:** the audit runs the D1 branches of the published EPG, discovery and owner-review authorities and of the prediction domain on the production marker values as the scenarios build them; the ratings, metadata-cache and Film/Person authorities stay on R2 in every scenario. A production-only state (a private ratings seed, a different marker) can add a writer the scenarios do not reproduce. The repository's empty seed is replaced in the scenarios with pending work.

## Follow-ups

[AIR-413](https://trello.com/c/orvuzDW5), [AIR-414](https://trello.com/c/GJefgNm8), [AIR-415](https://trello.com/c/NHyIKM6z) and [AIR-416](https://trello.com/c/f7FX4Elk) remove the baseline entries in turn. Current state belongs to Trello and GitHub.
