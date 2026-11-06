# ADR 0094: A Discovery Workflow instance hands over before its D1 statement total nears the failure level

**Status:** Proposed  
**Original decision date:** 2026-11-06  
**Recorded at:** 2026-11-06  
**Approval source:** not yet decided; the owner decides `Accepted` or `Declined` before this record merges ([workflow](../process/agent-workflow.md)). The owner chose to fix, not roll back, on 2026-11-06.  
**Related work:** [AIR-360](https://trello.com/c/MjT1458Q), [AIR-324](https://trello.com/c/kNtaEbm8), [ADR 0083](0083-inert-discovery-workflow.md), [ADR 0093](0093-discovery-workflow-cron-reconcile.md), [dated evidence](../evidence/discovery/discovery-workflow-invocation-budget-air-360-2026-11-06.md)  
**Supersedes:** None. It adds a second handover trigger beside the 20 chunk instance limit of [ADR 0083](0083-inert-discovery-workflow.md) decision 5.  
**Superseded by:** None

## Context

After the owner set `DISCOVERY_EXECUTOR=workflow` on 6 November 2026, two consecutive Workflow instances did the same thing. Each ran 19 chunks that saved progress. The next chunk returned no progress (`threw: true`, error class `unknown`), the plan took the stall path (`stall-sleep`, one second), and the next `owner` step then failed in about 10 milliseconds on every platform retry with `discovery_unavailable`. The first instance ended `errored` after six attempts; the second showed the same steps. D1 analytics recorded no query from the Worker while the retries ran and no query with an error. Both instances ended at almost the same D1 statement total (12,287 and 12,192) although they ran 17 and 9 minutes and read 6.9 and 1.9 million rows. A Cloudflare status incident of the same morning (Wrangler, Pages and Workers Builds) ended before the first failure and names other components.

The existing recovery works: the hourly cron found the errored instance, stored `recovery`, and the next `:37` firing created a successor. The cost is about 19 chunks per hour, because every instance meets the same wall.

## Decision

1. **The wall is treated as a per-invocation budget that D1 statements consume.** The evidence fits a count that is reached after a fixed amount of work, not time, rows or a transient outage. The exact platform limit is not established and this record does not name one.
2. **The instance counts the statements it issues.** `runDiscoveryWorkflow` wraps the `DB` binding in a counting proxy. It counts statements prepared and batches issued, passes native statements to a batch untouched, and changes nothing else.
3. **At 6,000 statements the instance hands over.** The plan returns `rollover` with reason `invocation_budget` when the count reaches 6,000 and work remains, in addition to the existing 20 chunk limit. The successor is a new instance, hence a new invocation. This is about half of the level at which both instances failed. A rollover keeps the ADR 0083 fence: the owner check, the executor record and the successor create are unchanged.
4. **A failing step says why.** The owner, plan and chunk steps log one bounded, secret-free line (`discovery_workflow_step_failed`: step, error code and class, a 200 character message and cause, the statement and batch counts) and rethrow the same error. The progress record carries `invocation.statements` and `invocation.batches`.
5. **Nothing else changes.** `discovery_unavailable` still stops the owner gate, no retry budget grows, no error is swallowed, and the owner compare-and-swap, the published-generation fence, the D1 lease and the 20 chunk rollover stay.

## Alternatives considered

- **Raise the retry budget of the owner step.** Rejected: it only waits longer on a failure that every retry repeats.
- **Catch `discovery_unavailable` and continue.** Rejected: it would let a step progress with an unknown owner.
- **A lower chunk limit (for example 12).** Rejected as the control: the statements per chunk vary (645 to 700 in the observed chunks, more with a larger walk), so a count of chunks does not follow the consumed resource.
- **Roll back to the external executor.** Rejected by the owner for now; it needs a drain and a prompt restore.

## Consequences

An instance now ends after about ten chunks and a successor starts at once, so the series continues without the hourly gap. Every handover costs one create. The 6,000 figure is an estimate with a margin, not a measured limit. If the platform limit is smaller than the observed total the instance can still fail; the logged cause then names it.

## Recovery and migration boundary

Code only. No migration, flag, schedule, cron or Task changes. A rollback of the code returns the 20 chunk instance and the failure after 19 chunks; instances, D1 and R2 are not changed by a rollback.

## Evidence

- **Dated measurement and incident reading:** [AIR-360 evidence](../evidence/discovery/discovery-workflow-invocation-budget-air-360-2026-11-06.md)
- **Tests:** `tests/discovery-workflow.mjs` sections 11 and 12 (the instance hands over at the budget, the plan, the meter, the logged cause)
- **Uncertainty:** the platform limit and the exact failing call are not observed. A real Workflows runtime reproduction was not available (see the evidence note).
