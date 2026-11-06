# AIR-360: Discovery Workflow stall-sleep and owner-gate failure

**Captured:** 2026-11-06, 10:44–13:25 UTC. **Method:** read-only Cloudflare GET (Workflow instances and steps, GraphQL D1 analytics, observability) and D1 `SELECT`. Nothing was written, started or stopped.

## Observations

| Item | Instance 0 (`discovery_5744…_0`) | Instance 1 (`discovery_5744…_1`) |
| --- | --- | --- |
| Created / ended | 10:37:36 / 11:00:08 UTC (errored) | 12:37:34 UTC / errored after 12:51:34 UTC |
| Progress chunks | 19 (47–51 s each) | 19 (23–27 s each) |
| Next chunk output | `threw: true, progress: false, error: unknown`, 20 s | the same, 2 s |
| Next steps | `stall-sleep-82-1` (1 s) then `owner-83-1` | `stall-sleep-85-1` (1 s) then `owner-86-1` |
| Owner attempts | 6, every one `discovery_unavailable`, each 9–20 ms | 6, the same, each 7–10 ms |
| D1 statements, instance lifetime | 12,287 | 12,192 |
| D1 rows read | 6.87 million | 1.94 million |

- The step retry delays were 10 s, 20 s, 40 s, 80 s and 160 s (platform setting, 5 retries). No D1 query from the Worker was recorded during the retries, and no recorded D1 query carried an error.
- Before the failure the Worker issued about 700 D1 statements a minute. `stall-sleep` is the only sleep in either instance.
- The Cloudflare status incident of the morning (Wrangler Deployments, Pages and Workers Builds) ran 09:47–10:08 UTC and does not name D1, Workers or Workflows.
- The hourly cron then recovered: it stored `recovery` (attempts 1, due 11:38:33 UTC) at 11:37:33 and created the successor at 12:37:34.

## Reading

- The two failures reproduce at the same step pattern and at almost the same D1 statement total whatever the duration and rows read. That fits a count reached after a fixed amount of work. It does not fit a time limit, a rows-read quota or a random outage.
- A failure that returns in about 10 ms, repeats on every retry and reaches no D1 query points at a client-side refusal inside the invocation. `discovery_unavailable` is the generic wrapper of `readAuthority` and `readWorkflow` for any D1 exception, so the original error text was lost.
- Neither instance slept before the failure (the one `stall-sleep` follows the failing chunk), so each ran in one Worker invocation and its instance lifetime equals that invocation: the data cannot tell a per-invocation count from a per-instance count. The change bounds the instance total, which bounds both.
- Not established: which platform limit it is, and why the first failing chunk is the twentieth in both cases (the chunk call count of the 20 chunk series limit is a coincidence that was not ruled out).

## What was and was not reproduced

The Node tests run the instance with stubbed steps. A local Workflows runtime was not used: no local runtime enforces the platform count, so it could not reproduce the failure, and a production-invasive reproduction was not authorized. The fix therefore does not claim a proven root cause. It bounds the work an instance does and records the cause when a step fails.

## Result of the change

`tests/discovery-workflow.mjs` shows an instance of 650-statement chunks handing over after ten chunks (6,520 statements) with a successor create, the plan under the budget, the counting proxy, a log made of fixed classes that holds none of an adversarial message, a failing first read of the chunk step that is logged and rethrown, and a sleep and replay in which the rebuilt count stops the instance at ten chunks in all (fifteen without it). Production acceptance is separate in AIR-324.

## Addendum, 2026-11-06 14:58 UTC: a third instance

Method as above, read-only. Instance `discovery_5744…_2` was created at 14:37:36 UTC by the hourly cron on the Worker version before the AIR-360 deploy (deployment 14:40:51 UTC), so it ran the old code.

| Item | Instance 2 |
| --- | --- |
| Progress chunks | 19 (27–30 s each) |
| Sleeps | none (no `stall-sleep`) |
| Failing step | `progress-78-1`, 6 attempts, each 13–15 ms, every one `discovery_unavailable`; instance errored at 14:52:20 UTC |
| D1 statements, instance lifetime | 12,328 |
| D1 rows read | 3.28 million |

- The three totals (12,287, 12,192, 12,328) agree within about one percent although the instances ran 22, 14 and 14.7 minutes, read 6.87, 1.94 and 3.28 million rows, and failed at different steps: `owner` after `stall-sleep` twice, `progress` once. This instance never slept. So the `stall-sleep` to `owner` sequence of the first two instances was only the step on which the count happened to run out; it is not the cause, and the reading above, a count reached after a fixed amount of work, is supported by a third observation.
- The change of [ADR 0094](../../adr/0094-discovery-workflow-invocation-budget.md) is unchanged by this: it counts statements and hands over at 6,000, about half of the observed total.
- Not yet observed: an instance created after the deploy. The next hourly cron firing (15:37 UTC) can only arm the recovery of this errored instance; a successor on the new code follows at the next firing.
