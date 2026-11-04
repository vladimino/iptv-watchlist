# ADR 0087: An interrupted discovery series resumes only through a gated confirm

**Status:** Proposed  
**Original decision date:** 2026-11-04  
**Recorded at:** 2026-11-04  
**Approval source:** not documented  
**Related work:** [AIR-341](https://trello.com/c/r8tfPFjt), [ADR 0006](0006-one-chunk-discovery.md), [ADR 0030](0030-discovery-queued-at-publication.md), [ADR 0083](0083-inert-discovery-workflow.md), [ADR 0085](0085-d1-authoritative-discovery.md)  
**Supersedes:** None  
**Superseded by:** None

## Context

A discovery series that loses two hops in a row before either stores its continuation checkpoint is written `paused` with `reason: interrupted`. Every ordinary step, including the hourly Scheduled Task, then answers `stop` and runs no chunk. The existing forced `POST /api/enrichment/discovery/resolve` (a body whose `chunks` is omitted or positive) still bypasses that stop, except a future chunk budget, backoff or error wait. That bypass does not check that the published generation, the programme, the source ledger and the continuation name one run, that the last status does not already claim the hop finished, or that the discovery authority is open.

The production series that prompted this record was read earlier as `epg_status.stage=complete`, continuation `paused` / `interrupted` / `settled`, with `lastBatch.checkpoint=cheap_pass`. A `cheap_pass` status is written after the cheap identity pass and before the hop's final status and continuation checkpoint. This record does not establish why the invocation ended. A diagnostic entry closed as `interrupted` with `cause: unknown` means the Worker cannot tell a platform kill from a lost outcome write. No production object was re-read while this decision was written.

The continuation, the lease and the status stay on the current discovery adapter. While the discovery marker is absent or `r2`, that adapter is R2. While it is `d1` and `cutover` is `open`, the same confirm uses the adapter. A held marker and a `loading` transfer already fail writers closed ([ADR 0085](0085-d1-authoritative-discovery.md)).

## Decision

1. **The hourly path stays a stop.** `epg_sync_step` and any resolve body that does not carry `recovery: "interrupted"` keep today's `continuationDecision`. `interrupted` is not an exception beside the due `chunk_budget` renewal. The Scheduled Task prompt and schedule are not changed. The task may take a later ordinary chunk only after a successful confirm has replaced the record with an ordinary checkpoint whose `nextAction` is `continue` (or a due `wait`) for the same published generation, and only under the existing stage A preflight.
2. **The confirm is not `force`.** `recovery: "interrupted"` sets `force` false. `chunks: 0` with that field returns the verdict and writes nothing. `chunks` omitted is the confirm and runs at most one ordinary chunk. Any other `chunks` value with that field is rejected. The existing forced resolve is unchanged.
3. **The gate is fail-closed.** The confirm runs only when the sync stage is `complete`; the published pointer, `programme.json`, the current discovery source and the continuation name the same programme run; the record is `paused` / `interrupted` with a positive integer budget; the lease is absent or expired and well formed; no continuation retry or catch-up time is in the future; and the discovery authority is the R2 path, or `d1` with `cutover` `open` and transfer `idle` or `committed`. The checkpoint proof is a same-hop status with no `finishedAt` (a `cheap_pass` status is the known shape) or a prior hop's finished status, and no diagnostics entry claims this hop stored its continuation checkpoint. A finished status for the same hop, a claimed checkpoint, a missing or unattributable status, a malformed ring, a live or malformed lease, a future backoff, a held or loading authority, an unreadable authority, a workflow executor, or a missing TMDB token refuses. A refusal writes no continuation, lease, decision, catalogue row or external call.
4. **One chunk, then the ordinary contract.** An eligible confirm uses the stored budget, the existing lease and the continuation compare-and-swap. The running record carries `interruptions` one below the fail-closed limit and a `recoveryPermit` naming the interrupted hop. A death before the checkpoint therefore stops the series again instead of becoming an automatic resume. The checkpoint drops the permit and the count. A repeat confirm sees a record that is no longer `interrupted`, or a hop that is still `running`, and runs no second chunk. A compare-and-swap loss releases the lease and answers `busy` without claiming the chunk. Decisions already stored for a key stay one decision; the chunk does not start a second series or copy the ledger.
5. **No new store and no new executor.** The receipt is the continuation checkpoint and the step diagnostic. No new R2 key, D1 table, feature flag, cron or Workflow transition is added. `DISCOVERY_EXECUTOR=workflow` refuses the confirm and does not start a workflow.

Not decided here, and not authorized by accepting this record: a production confirm, any `epg_sync_step` against the live interrupted series, a Task prompt change, a discovery or TMDB run, a lease reset, a marker change, or a migration.

## Alternatives considered

- **Teach the hourly prompt to send the confirm or to force the step.** Rejected. The stored reason is a terminal stop, so a longer prompt does not make the Worker run a chunk, and turning the hourly call into an unconditional force would repeat a hop that has already killed two invocations.
- **Use the existing `force` flag as the recovery.** Rejected. `force` skips the generation, status and authority checks this gate exists to apply. It remains available and unchanged.
- **Add a recovery receipt object or a new MCP tool.** Rejected. The continuation compare-and-swap is the readback: a lost response is settled by reading the record, which is no longer `interrupted` when the checkpoint landed. A new tool would give the hourly caller a way to send the confirm.

## Consequences

An interrupted series stays stopped until a new EPG generation, an explicit forced resolve, or this confirm. The confirm can spend one chunk of TMDB and decision writes, which are the same idempotent writes an ordinary chunk makes. A killed confirm hop fail-closes and needs another confirm; it does not resume itself on the hour. Operators read `recovery` on the resolve response and `interruptedRecovery` on pipeline status. Neither field authorizes a call by itself.

The discovery flowchart is unchanged. This record does not approve a production recovery.

## Recovery and migration boundary

The confirm is reversible only by the continuation it writes: a successful chunk's decisions and catalogue updates stay, as they do for any other chunk. Code rollback does not restore R2 or D1. Accepting this ADR does not authorize the confirm against production, a Scheduled Task edit, a flag, a lease reset, or a discovery-authority transition.

## Evidence

- **Original decision:** [AIR-341](https://trello.com/c/r8tfPFjt)
- **Implementation:** the commit that adds this file
- **Dated verification:** [local contract, 2026-11-04](../evidence/discovery/interrupted-recovery-contract-2026-11-04.md)
- **Uncertainty:** the production invocation's cause is not established. The earlier read-only snapshot was not repeated for this record.

## Follow-ups

A production confirm of the current series is a separate owner approval after this record is accepted and the code is deployed. The hourly prompt is not part of that approval.
