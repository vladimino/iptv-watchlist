# Discovery ingress and generation-bump audit for a projector quiet window (2026-11-08)

**Purpose:** the factual base for [ADR 0103](../../adr/0103-projector-exclusive-window.md). It lists every way a Discovery writer can start or continue, every statement that moves `discovery_authority.generation`, and the measured rate of those writes. It decides nothing and authorizes no production operation. An earlier, broader audit of the projector inputs and of all Discovery write paths was preserved in the closed [PR #429](https://github.com/vladimino/iptv-watchlist/pull/429); this record keeps only what the window needs.

**Method.** Code read at `origin/main` `8434e8b`. Production evidence is read-only aggregate D1 `SELECT`s taken on 2026-11-08 (every response `changed_db=false`, `rows_written=0`), one `feature_flags` readback and the Cloudflare documentation on cron limits. No R2 read, no projector, cron, Discovery or sync run, no flag, lease, Task or schedule change, no payload text.

## 1. Measured rate (D1, 2026-11-08)

| Quantity | Value |
| --- | --- |
| Window | 07:31–10:01 UTC (150 minutes), `discovery_authority.generation` 29,604 to 32,199 |
| Global generation bumps | 2,595, about 17.3 per minute, none of the 150 minutes without a Discovery write |
| Decision changes in the window | 1,429 (`discovery_decision_history` rows by generation) |
| Whole diff phase of the projector | 21.2 s on the 08:37 UTC run, 10.6 s of it reading |
| Probability that a window of `T` seconds holds no bump (Poisson, 17 per minute) | 10.6 s: 5.0 %; 21.2 s: 0.25 %; 30 s: 0.02 % |

Consequence: the strict generation fence cannot pass while Discovery keeps writing, and no retry or filtering of "irrelevant" bumps changes that enough (about 10 of the 17 bumps a minute are real decision or admission writes). The only way to keep the fence unchanged is a window in which Discovery does not write.

## 2. Where a Discovery writer starts (admission)

Every Discovery chunk, seal, publish handoff and owner correction obtains the single D1 lease row (`discovery_lease`, id 1, TTL 90 s) through `DiscoveryAuthority.acquireLease` (`src/discovery-authority.js`, the `UPDATE discovery_lease SET lease_id=?, ... WHERE id=1 AND (lease_id IS NULL OR expires_at<=?)`). Its callers:

| Caller | Reached by |
| --- | --- |
| `acquireDiscoveryLease` (`src/discovery.js` 194), used at lines 458, 580, 1415 | the resolver chunk and status paths, which the Discovery Workflow (`runWorkflowChunk`), the explicit HTTP route `/api/enrichment/discovery/resolve`, the MCP `epg_sync_step` and the hourly external Task all reach |
| `acquireDiscoveryLease` in `src/worker.js` 837, 859, 928 | non-sealed publish, `publishEpgGeneration` and `stageSealedGeneration` (the EPG commit); they throw `Resolver is writing the catalog` when the lease is not obtained |
| `DiscoveryAuthority.acquireLease` in `src/worker.js` 1118 | `sealStep` |
| `acquireDiscoveryLease` in `src/admin/discovery-recovery.js` 365, 396, 699, 743 | owner reconsider and identity-correct execute routes |

Behaviour already in place when the lease is not obtainable: the paged chunk returns `stage: busy` with `lease_held` and a `nextCatchUpAt` (AIR-362); `workflowPlan` returns `{action:'wait', until: lease.expiresAt, reason:'busy'}` while a lease is live (`src/discovery-workflow.js` 144) and the instance sleeps with `step.sleepUntil` (line 470) without counting a stall; `reconcileDiscoveryWorkflow` runs from the same hourly cron as the projector.

## 3. Statements that move `generation` without holding the lease

Every other generation bump in `src/discovery-authority.js` sits behind the lease fence (`fence()` line 182, `loadingFence()` line 360, `beginLedgerSeal` line 374, `markIntentRunning` line 1136). The statements below do **not** require a live lease, so a lease held by someone else does not stop them:

| Statement | Line | Caller |
| --- | --- | --- |
| `writeContinuation` (generation CAS and revision CAS only) | 1045 | resolver checkpoint, and the workflow's own state |
| `writeWorkflow` (generation CAS and revision CAS only) | 1072 | `src/discovery-workflow.js` state writes (`settleWorkflowIfOwner`) |
| `importSegment` (requires that **no** lease is live) | 927, 951, 958 | no caller in `src/` or `scripts/` |

The Workflow writes its own state (`writeWorkflow`, through `settleWorkflowIfOwner`) when it notices a busy lease (line 469) and on its later steps, so a held lease alone would still let generation bumps through; whether it also writes on waking was not traced. A window therefore needs an in-SQL guard on these statements too. The offline cutover scripts (`scripts/discovery-cutover.mjs`, `scripts/discovery-production.mjs`) run only in marker mode `r2` and are outside the window.

## 4. What the projector checks today

- `d1EnrichmentWritersIdle` reads the **R2** object `epg/resolver-lease.json` and `sync.json` (`src/d1-enrichment.js` 118–122). Under a D1 Discovery authority the lease key is not an R2 object (ADR 0085 decision 4), so this check cannot see the D1 lease. The projector's only protection against a Discovery writer is therefore the generation pin.
- The pin is taken at the first handoff guard and compared once more before the first write batch (`d1EnrichmentHandoffGuard`, line 217). The write batches themselves reference only the projector's own lease (`D1_ENRICHMENT_FENCE`).
- The projector's inputs also include R2 objects written by the EPG sync (`metadata.json`, `titles.json`, `people.json`, the published programme and watchlist mirrors). The existing sync-stage check and etag re-check cover them; a window does not change that.

## 5. Platform limits relevant to waiting for quiet

Cloudflare documents a 15-minute wall-time limit for a Cron Trigger invocation and that the runtime waits for the promise of the `scheduled()` handler (up to that limit). The projector's present budget is 60 s of wall time for its write phase. A wait of a few minutes for quiet plus the run fits the limit; the CPU use of waiting is negligible, because the wait is D1 polling, not computation. Not measured: the real wall time of a complete run with writes, and how long Discovery chunks hold the lease in practice (the TTL is 90 s; typical chunk duration was not read).

## 6. Not measured

- The distribution of Discovery lease hold times and the gaps between chunks.
- The duration of a projector run that writes a full 60 s budget, under the new wait.
- Whether any Discovery ingress path writes an R2 object that the projector reads (none was found; the implementation card must prove it with a test that enumerates R2 writes reachable from a chunk).
- The effect on the daily EPG publication (17:00 Europe/Madrid, which is the cron's own hour tick) when a window is requested near it.
