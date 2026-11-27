# AIR-687, second delivery: an unclassified `discovery_fence` still cost an hour (27 November 2026)

Scope: the card [AIR-687](https://trello.com/c/jrP0z56f) (production evidence of 27 Nov 2026 20:00 Madrid as recorded there), source reading of `main` at `53ead03` (it contains [#1035](https://github.com/vladimino/iptv-watchlist/pull/1035)), and the offline real sqlite D1 stand-in of the AIR-534 fixture with a recording TMDB stub. No production access, no Cloudflare API, no real TMDB. The first delivery's evidence is [air-687-fence-hourly-lockstep-2026-11-27.md](air-687-fence-hourly-lockstep-2026-11-27.md).

## Production observation (from the card, not re-read here)

Instance `discovery_54ba0055350b4938a79b1956838a8ffd_17`: `chunk-14-1` finished 20:00:10 Madrid with `checked=9`, `usefulProgress=true`; `chunk-18-1` (20:00:15 to 20:00:32) answered `stage=error`, `error=discovery_fence`, `failureKind=fence`, `failureConstraint=null`, `checked=0`, `retryAt=null`, `usefulProgress=false`; `plan-21-1` waited for 21:00 and `chunk-26-1` worked normally. The hourly Cron reconcile ran at 20:00:26. The step output carries `usefulProgress`, so the first delivery's code ran: the short retry was not applied to this refusal.

## Established (code and offline reproduction)

- Before this delivery the short retry applied only to a refusal proven to be a batch `CHECK` failure whose fence statement expected an older generation (`retryableFenceCollision`). Every other `discovery_fence` thrown outside `guarded` became `stage: error` with `nextCatchUpAt` = the next hour boundary and `retryAt: null`.
- That covers every refusal without such a cause. Reachable fence sources in `src/discovery-authority.js` (source reading): batch `CHECK` failures of fenced writes (status, continuation, decisions, assignments); read-side generation compares (a read that raced a writer is refused with `discovery_fence`, no cause attached: the fenced reads of the ledger, observations and replay pages); and direct refusals (a write naming another run than the gate, a decision whose observation vanished or whose evidence key changed, the ledger transfer job state). Only the first kind carried the data the first delivery asked for.
- The evening sequence is reproduced on the real fixture: a productive chunk (8 decisions), then a cause-less refusal of the next chunk's read at the hour boundary gives `stage: error`, `retryAt: null`, `nextCatchUpAt` = next hour on `main` at `53ead03`.
- Busy paths without a deadline of their own had the same hour default: `busyOutcome` set `nextCatchUpAt()` for a lost lease race and for a record moved by another hop, so the Workflow slept to the hour (the first night's `chunk-2-1`, `stage=busy`, matches this shape; not proven to be this branch). `lease_live` (lease expiry), `projector_window` (its expiry) and `epg_priority` (its poll time) already carried their own time.

## Not proven

- Which statement or read failed at 20:00:32 and why the first delivery's strict check did not apply: `failedAt` and the cause were not recorded in the retained output. Candidate explanations are all in the table above; none is shown by the evidence, and the correlation with the Cron at 20:00:26 is not a cause. The Worker version (`a724f5b0`) differs from the instance's recorded version (`d08a3186`) on the card; the output contains `usefulProgress`, so the new code ran.
- The historical seven-hour night and the 06:00 recovery (see the first evidence file).

## Change

1. The decision no longer depends on the refusal's own classification. `assessFenceRefusal` reads the published pointer, the authority gate and the hop's lease back after the refusal. While the pointer names the run as `published`, the authority is ready, not held, not loading and bound to the run, and the lease renews, the checkpoint is `paused`/`backoff` with a `retryAt` and the Workflow wakes there (independent of the hourly Cron); readback that cannot be completed is also re-evaluated later (`state_unreadable`). A state that contradicts continuing keeps the fail-closed `error` checkpoint and records the contradicting fact (`fenceBasis`: `pointer_not_published`, `authority_not_ready`, `authority_held`, `authority_loading`, `other_programme`, `lease_lost`). Nothing is written by the assessment and no unconfirmed mutation is repeated: the next chunk re-reads and re-fences everything and decisions are idempotent per key. Fences, lease, idempotency and atomicity are unchanged.
2. The wait: six consecutive re-evaluations wait 30 s, then the existing Workflow recovery ladder (1 min, 5 min, 15 min, 1 h). The first delivery's cap that returned to the hour is replaced by this ladder; a persistent refusal is visible as a growing `fenceCollisions` (the monitor reads a counted loop as a zero-work loop) with `fenceCause`/`fenceBasis`.
3. A busy without its own deadline, for the Workflow executor only (`caller: internal`), waits for the live lease's expiry, else one short recheck; external callers keep the hourly contract.
4. Diagnostics (bounded, no SQL or data): `fenceRevalidation`, `fenceCause` (`generation_moved`, `batch_fence`, `batch_check`, `read_or_direct`), `fenceBasis`, `fenceCollisions`, `failedAt` in the chunk summary and the continuation.

## Residual paths (listed, not changed)

Workflow-state writes of `settleWorkflowIfOwner` that meet `authority_held` or exhaust their bounded conflict retries end the step as deferred; the executor then depends on the existing reconcile for recovery. This is not the evening failure and was left to its own bounded contract; a lost lease (`LeaseLostError`) and an unknown write outcome keep their existing recovery. A genuine hold, EPG priority, another run, cooldown and a permanent refusal are unchanged and fail closed.

## Tests

`tests/discovery-fence-collision.mjs` (core), real sqlite D1 stand-in, real `advanceDiscovery`, `runWorkflowChunk`, `workflowPlan` and `discoveryQueueState`: K, the evening sequence (productive chunk, cause-less read refusal, a short checkpoint with `fenceCause: read_or_direct`, nothing persisted by the refused chunk, the plan wakes within seconds, the next real chunk persists new decisions with no duplicate, the counter is cleared); G, eleven consecutive refusals back off 30 s ×6, 60 s, 300 s, 900 s, 3600 s, 3600 s without an immediate hour or a hot loop; I, each outcome of the assessment (confirmed state with and without a cause, another run, loading transfer, lost lease, non-published and missing pointer, unreadable state, authority bound to another run); H, the end-to-end fail-closed cases; L, the busy paths for the internal and the external caller. They fail on `main` at `53ead03`.

## Open

Natural production acceptance on the delivered version: a real transient conflict with its cause and basis, the retry time, durable work before the next hour boundary, further queue movement and a correct Monitor. The absence of a conflict proves nothing.
