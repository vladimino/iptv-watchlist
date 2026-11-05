# ADR 0092: The discovery ledger is sealed by a resumable job in bounded steps, and publication follows the seal

**Status:** Proposed  
**Original decision date:** 2026-11-05  
**Recorded at:** 2026-11-05  
**Approval source:** not yet decided; the owner decides `Accepted` or `Declined` before this record merges ([workflow](../process/agent-workflow.md)); the owner chose a migration for the job's cursor on 2026-11-05  
**Related work:** [AIR-356](https://trello.com/c/JJI9O5I5), [AIR-355](https://trello.com/c/HbhJNQ7V), [ADR 0085](0085-d1-authoritative-discovery.md), [ADR 0091](0091-selective-reads-during-a-loading-ledger-seal.md), [dated evidence](../evidence/d1-migration/air-356-resumable-seal-2026-11-05.md)  
**Supersedes:** None. It changes how the publish handoff of [ADR 0085](0085-d1-authoritative-discovery.md) is carried out; the marker, the fail-closed reads and the lease of that record stay.  
**Superseded by:** None

## Context

[ADR 0085](0085-d1-authoritative-discovery.md) publishes a new generation's active ledger into D1 as part of the EPG commit: the commit streams every observation into `discovery_observation` inside its own request. On 5 November 2026 that took about 7 observations per second against 20,064 observations, so it needs tens of minutes, and the client cancels the request after about two minutes. Two attempts were cancelled, the transfer stayed `loading`, and every retry would start again from the first observation, because the handoff kept no progress: it flipped the previous ledger to `retiring` at its start and had no cursor. Nothing was lost, but no attempt could ever finish ([incident reading](../evidence/d1-migration/air-355-incident-seal-loading-2026-11-05.md)). [ADR 0091](0091-selective-reads-during-a-loading-ledger-seal.md) stops a stalled seal from blocking independent readers; it does not finish a seal.

## Decision

1. **The seal is a job with a durable cursor.** Schema 12 adds one table, `discovery_seal` (job id, programme run, the source document and its etag, the item total, a cursor in items and in bytes, and a phase `idle`, `items`, `archive` or `done`). The cursor moves in the **same D1 batch** as the observation rows it counts, by compare-and-set on the previous cursor, behind the lease and generation fence. A request that dies leaves the rows and the cursor agreeing. The batch itself is idempotent (an upsert and a delete-and-insert of the shows), so a replay after an unknown outcome is safe and a lost race writes nothing.
2. **The previous ledger is flipped to `retiring` once per job.** The same job beginning again does not flip. A job for another source, or a `loading` transfer that has no job (the interrupted handoff of the old inline seal), starts over: everything active, including whatever an earlier attempt wrote, becomes `retiring` in the batch that records the job, and observations that are written again take their rows over.
3. **Steps are bounded.** One request does at most about 30 seconds of work: a step reads the immutable generation ledger from R2 **by byte offset** (the cursor), writes batches of about 30 observations until its time is spent, and always completes at least one atomic unit. Archiving the retiring rows is bounded too (500 observations per batch), and the commit is the last batch: it moves the transfer to `committed` and the authority and the published marker to the new programme.
4. **The EPG commit no longer seals inline.** With D1-authoritative discovery and the schema 12 table present, the commit stores the generation ledger in R2, stores a staging payload (the programme, the catalog, the watchlist, the uncertain list and the publish fence) and moves the run to stage `seal`. Steps then run in order: `ledger` (seal and archive), `catalog` (bring the catalog up to date by its difference to D1, a bounded part per step, done only when a step finds nothing to write), `publish` (move the published pointer, write the mirrors, open the discovery series, finish the run). **The published pointer moves only after the ledger is committed and the catalog is up to date.** Until then the previous generation stays published and readable.
3. **The client contract.** `epg_sync_step` answers `stage: seal` with a `seal` object and `discovery.nextAction: continue` until the run is `complete`; `epg_sync_start` returns the active run in stage `seal` instead of starting another.
4. **Without the table nothing changes.** A Worker deployed before the migration is applied keeps the previous inline behaviour; applying the migration is a separate owner-approved operation and does not start a seal.
5. **Not decided here and not authorized by accepting this record:** applying `0012`, recovering the production run, a retry of the stalled EPG commit, a lease or transfer reset, a flag, a Task or a cutover.

## Alternatives considered

- **Raise the write throughput only** (multi-row inserts, larger batches). Rejected as the fix: it helps (this change also uses it) but a seal of tens of thousands of observations still takes minutes and still has no resume.
- **Keep the cursor in R2 or in an existing D1 row.** Rejected by the owner: an R2 marker is a second store of control state, and the existing rows (`discovery_transfer.batches`, `discovery_checkpoint`) have other meanings. A table makes the batch-and-cursor link atomic.
- **Run the seal outside the request** (`waitUntil` or a self-fetch). Rejected: no durable cancel or resume, and it forwards request context.
- **Publish the EPG generation first and seal afterwards.** Rejected: the published generation and the discovery ledger would disagree, and the ledger is the source of the next discovery chunk.

## Consequences

An EPG commit becomes many short steps (about 25–35 at the size of the incident, see the evidence) driven by the existing `continue` loop; a cancelled step costs at most one batch. The previous generation stays published during the seal. The discovery authority names the new programme from the seal's commit until the publish step, a window of one or two steps; the discovery chunk treats a mismatched generation as busy. The catalog is updated in pieces during the `catalog` step: readers see a mix of old and new films for that window, never a torn film.

## Recovery and migration boundary

Migration `0012` is additive and refuses anything below schema 11. Code rollback does not revert D1 or R2: a job in progress stays resumable by this code only. Rolling the Worker back to code without this record while a job is in `items` or `archive` leaves the transfer `loading`, which the earlier code treats as the stalled seal described above. The production recovery of the stalled run is an ordered, separately approved sequence.

## Evidence

- **Dated measurement and tests:** [AIR-356 evidence](../evidence/d1-migration/air-356-resumable-seal-2026-11-05.md)
- **Tests:** `tests/discovery-seal-resume.mjs` (cursor and rows agree after any cancellation, no second flip, unknown outcome and two writers refused by the cursor, bounded archive, the incident shape), `tests/discovery-seal-publish.mjs` (byte-offset reads of a multibyte document across cancelled steps, the catalog difference, the whole staged publication and its order)
- **Uncertainty:** the real D1 round trip of the seal batch, and the CPU of a step on production, are unmeasured.
