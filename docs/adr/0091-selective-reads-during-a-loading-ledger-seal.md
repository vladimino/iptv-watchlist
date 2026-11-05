# ADR 0091: Three independent reads stay open while a ledger seal is loading

**Status:** Proposed  
**Original decision date:** 2026-11-05  
**Recorded at:** 2026-11-05  
**Approval source:** not yet decided; the owner decides `Accepted` or `Declined` before this record merges ([workflow](../process/agent-workflow.md))  
**Related work:** [AIR-355](https://trello.com/c/HbhJNQ7V), [ADR 0085](0085-d1-authoritative-discovery.md), [dated evidence](../evidence/d1-migration/air-355-incident-seal-loading-2026-11-05.md)  
**Supersedes:** None. It narrows one consequence of ADR 0085 and leaves the rest of that record in force.  
**Superseded by:** None

## Context

[ADR 0085](0085-d1-authoritative-discovery.md) makes every discovery read fail closed while `discovery_transfer` is `loading`, so that a half-written ledger is never served. On 5 November 2026 an EPG commit streamed the whole active ledger (20,064 observations) into D1 inside one MCP request. The write rate was about 7 observations per second, so the handoff needs tens of minutes; the client cancelled the request after about 118 seconds, twice. The transfer stayed `loading`, 36,671 observations of the previous run were `retiring` and 328 of the new run were `active`. Nothing was lost: the decisions, the admissions and the history did not change.

Because every owned key failed closed, three consumers that do not need the ledger at all were blocked with it: the EPG input scan (it reads the catalog `epg/discovered-films.json` before it can start again), the prediction queue (the same catalog) and the discovery status and continuation reads. The EPG commit therefore could not be retried and predictions stopped, although the catalog, the status and the continuation were exactly what they were before the handoff began.

The ledger handoff writes only the active ledger (`discovery_observation` and its shows), the transfer row, the lease and the authority generation. It never writes `discovery_admission`, `discovery_status`, `discovery_continuation` or `discovery_checkpoint`. Other operations also use `loading` (a catalog replace, a decision replace, a segment load); for those, the admission table can be half replaced (`pending` rows), so `loading` alone does not say which operation is in progress.

## Decision

1. **Three keys stay readable while a ledger seal is loading:** `epg/discovered-films.json` (and the generation copy of the catalog for the authoritative run), `epg/discovery-status.json` and `epg/resolver-continuation.json`. The answer carries `transfer: 'loading'` so a consumer can tell.
2. **The condition is that `loading` is a ledger seal and nothing else.** The transfer is a ledger seal only when the ledger is mid-handoff (previous observations are `retiring`, or the transfer names another programme) **and** no admission is `pending`. A catalog, decision or segment load that stopped half way leaves `pending` admissions or no retiring ledger, and then these keys fail closed exactly as before.
3. **The read is checked at both ends.** It fails with `discovery_fence` if the authority, the programme or the loading state changed while it ran. It does not require the generation to stand still, because a seal moves the generation with every batch and does not touch these keys.
4. **Everything else stays closed:** the active ledger and the generation ledger, the observation pages and the walks, the observation index, the decisions, the score preview, the workflow record, every current-generation join, the resolver, identity and reconsider paths and **every write**. A write during `loading` is refused as before. There is no R2 fallback, no automatic reset or repair, and no complete publication of an unfinished ledger.
5. **What is not decided here:** how the seal finishes. A resumable, bounded seal that completes in explicit steps, and the order of the EPG commit and the seal, is a separate decision. Until it exists the EPG commit must not be run, because a retry replays the seal from the first observation and is cancelled again. This record only stops a stalled seal from blocking independent consumers.

Accepting this record does not authorize any production operation.

## Alternatives considered

- **Keep failing closed everywhere (ADR 0085 as written).** Rejected as the only rule: it turns a stalled ledger handoff into an outage of predictions and of the EPG commit's own first read, with no data at risk.
- **Serve the catalog from R2 while D1 is loading.** Rejected: it creates a second source of truth and a stale answer. ADR 0085 forbids a silent R2 fallback and this record does not add one.
- **Open every key except the ledger.** Rejected: decisions and the score preview are paired with ledger observations by the readers that matter, and no consumer needs them during a seal. They can be opened later by their own record with their own proof.
- **Decide on `loading` alone.** Rejected: a half-replaced catalog is also `loading`, and serving it would hand a torn catalog to predictions.

## Consequences

Predictions and the EPG input scan read a consistent catalog while a ledger seal is stalled, and `epg_status`-style diagnostics can read the continuation. The pipeline status and every ledger reader still fail closed, so an operator cannot read ledger counts during a stalled seal. The marker is advisory: a consumer that ignores it still gets the correct catalog. A seal that is actively running moves the generation but not these keys, so these reads stay stable during it.

## Recovery and migration boundary

No schema change and no data change. Code rollback restores the earlier, fully closed behaviour and does not touch D1. This record does not unblock the EPG commit: the stalled production seal needs the separate resumable handoff and its own owner-approved recovery steps.

## Evidence

- **Dated incident reading:** [read-only production observation and offline reproduction](../evidence/d1-migration/air-355-incident-seal-loading-2026-11-05.md)
- **Tests:** `tests/discovery-seal-reads.mjs` (independent reads open and marked, ledger reads and every write closed, a half-replaced catalog stays closed, the marker disappears when the seal finishes) and `tests/discovery-seal-interrupted.mjs` (the interrupted handoff)
- **Uncertainty:** the live Scheduled Task state and whether the new generation ledger object exists in R2 were not read.
