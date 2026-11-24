# AIR-572: Producer `producer_budget_infeasible` after the hold lift, RCA and offline fix, 24 Nov 2026

**Card:** [AIR-572](https://trello.com/c/ugyHjnc4). **Scope:** read-only production observation, then an offline reproduction and fix. The production reads were:

- Cloudflare Workflow instances and their steps;
- Worker logs through the telemetry query;
- bounded D1 `SELECT` statements by primary key (`rows_written` 0, `changes` 0, `changed_db` false).

No Workflow, lease, chain, run, flag, Task or data was changed. All times UTC.

## Production observation

The hold lift ([PR #961](https://github.com/vladimino/iptv-watchlist/pull/961), `main` `37ad10b`) deployed at 00:09:48. The published run was `d8dc6ec8-…`, generation 518.

| Instance | Created | Steps | Outcome |
| --- | --- | --- | --- |
| `pw_22948481_1` (epoch 1) | 01:00:31 | `nonce-1`, `claim-1` (chain revision 2, `release_pin` null), then `work-1`. The first `work-1` attempt ran from 01:00:34 to 01:05:07 and failed with `producer_cas_lost`. The second attempt ran from 01:05:17 to 01:05:39. | Output `stopped` / `film_person_unavailable`: pass `slices` 0, `recorded` false. The chain was left `active` with a lapsing lease. |
| `pw_22948481_2` (epoch 2, takeover) | 02:00:32 | `claim-1` (revision 20, `release_pin` `empty`), then `work-1` from 02:00:35 to 02:05:07. | `stopped` / `producer_budget_infeasible` |

D1 readback (`SELECT`):

- **Chain:** `stopped`, `producer_budget_infeasible`, `fail_closed`, epoch 2, revision 35, takeovers 1, `run_key` NULL.
- **Run `epg:d8dc6ec8-…:518`:** `passing`, 4,042 units, 1,412 with a durable outcome (11 `applied`, 1,401 `noop`), cursor `person_mutation`, revision 30.

The run made real progress before the stop.

**Monitor:** the 03:00 hourly `Monitor.run` reported `needs_owner` with `canonical_producer_failed` and delivered one message (`sent` 1, `failed` 0). 04:00 sent nothing; 05:00 sent one again.

## Root causes (code, not data or platform)

1. **The budget treated a large divisible invocation as indivisible.**
   - `successorDecision` stopped the chain when the largest measured invocation plus the reserve exceeded the headroom (5,000). An invocation is up to 20 slices of 50 units within a 270 s deadline.
   - The meter counts about 37 statements per unit, so one full invocation is far above 5,000. The first boundary therefore always said `producer_budget_infeasible`, although that invocation had just completed.
   - ADR 0141 D5 defines infeasibility on the floor (the smallest invocation), not on a measured multi-slice invocation. It also requires that the instance never exceed its budget, but the slice loop had no budget gate.
2. **The fence was copied after the release pin.**
   - `pinChainReleases` advances `fence.revision` in place. The Workflow then replaced its `fence` with a copy, while `scoped.producerFence` (used by every slice commit to renew the lease) kept the original object.
   - From then on the copy's revision fell behind. The stop at the end of epoch 1 lost its revision CAS (`producer_cas_lost`).
   - The retried step used the stale copy, failed its first slice (`film_person_unavailable`) and could not record the stop. The chain stayed `active` until the 02:00 takeover.
   - Epoch 2 had the pin already, so it hit only cause 1.

`run_key` NULL on the chain is not a cause: the monitor and the run are keyed by `source_generation`.

## Offline reproduction (production-shaped fixture)

The fixture has 400 watchlist films, each with one director and eight distinct actors, giving 4,200 units, and one departed Film so a release pin is written. It runs on the real `runProducerWorkflow` path over the sqlite D1 stand-in, metered like `meterD1`. No private identifiers were used.

- **Before (`main` `fa9607c`).** The first invocation handled 1,000 units with 39,307 calls and 37,283 statements (28,352 executed D1 calls). Its stop then threw `producer_cas_lost` (cause 2). With cause 2 fixed alone, the chain stopped `producer_budget_infeasible` (cause 1), as epoch 2 did.
- **Unit cost by kind and input.** Statements, measured offline at the input caps:

  | Kind | Applied | No-op |
  | --- | --- | --- |
  | `film_facts` | 45 | 15 |
  | `person_mutation` | 30 | 10 |
  | `film_credits` | 37 + about 1 per credit (79 at 43 credits) | 10 |

  Credits are bounded by `CREDITS_PER_UNIT_MAX` = 50 at plan time.

## Fix: admission at a-priori ceilings (first version reviewed, then reworked)

The first version (`3ff3645`) gated each slice on the largest slice measured so far. Independent [review](https://github.com/vladimino/iptv-watchlist/pull/967) found two P1 problems:

- A historical maximum is not an admission bound. A cheap slice followed by an expensive one could cross the headroom, and the first slice of every invocation was unconditional.
- The completion sweep and the receipt reconcile of ADR 0141 T-10 were outside the budget.

The reworked fix:

- **One meter for the whole instance:** the claim, every invocation and the end path.
- **Every operation admitted before it runs**, at an a-priori ceiling with the end reserve kept: the invocation start, each unit (by kind and credits, with two applies and the following slice commit), each sweep read and settle, the completion, and each receipt page (cut to what the budget holds). See the [driver reference](../../reference/data/producer-driver.md#instance-budget-inside-the-workflow-chain-adr-0141-d5-air-572).
- **A refusal ends at a durable boundary** and hands over. The successor resumes at the cursor, also past the last unit.
- **Infeasible** means an instance made no durable progress.
- **Epoch cap:** a hand-off the cap refuses now stops the chain on the record instead of returning a hand-off without a successor. This was a pre-existing defect found while testing.
- **Fence:** one object.

## Tests (real Workflow path, membership marker `sync`/1 as deployed)

`tests/canonical-producer-budget.mjs`:

- **Two generations.** A heterogeneous plan (0 to 12 actors, 1 to 3 directors, Films over the credit cap as planner refusals) completes at the default limit. So does the next publication (a new programme run): cheap no-ops first, then changed credits on the last Films, superseding the live refusals of the earlier generation.
- **Lost receipt responses.** Three receipt batches commit and then lose their response. The chain stops transient, is recovered as the hourly reconcile does, and the drain settles the open receipts. This runs at the default limit and at a narrow one.
- **Infeasible.** A limit too small for one operation stops `producer_budget_infeasible` without a successor or a run row.

`tests/canonical-producer-budget-boundaries.mjs`:

- **Boundaries.** The next publication with a backlog of more than 100 earlier live results, at two narrow limits. Instances end inside the sweep, at the completion, and as a successor whose cursor is already past the last unit.
- **Epoch cap.** A re-published programme run at a narrow limit reaches `CHAIN_EPOCH_CAP` and stops `producer_chain_epoch_cap` / `fail_closed`.

Asserted every time:

- each instance's total metered calls and statements, claim and end path included, stay within the headroom;
- every admitted operation's real cost stays at or below its ceiling;
- every unit is durable and no shadow Film is created;
- `watchlist_film` is untouched (`sync`/1).

**Mutation check by hand.** Each of these guards, removed alone, fails at least one of the two files:

- the fence copy;
- the unit, sweep-settle, receipt and completion admissions;
- the no-progress infeasibility rule;
- the epoch-cap stop.

## Limits and open points

- **Epoch cap per programme run.** One programme run has at most `CHAIN_EPOCH_CAP` (64) instances, and a re-publication of the same run counts on.
  - An instance holds roughly 130 applied or 300 to 450 no-op units, so the current plan (about 4,000 units, mostly no-ops at steady state) needs about 10 to 30 instances.
  - The first full pass after a long hold is mostly applied units and can need about 30.
  - A much larger plan would reach the cap and stop `fail_closed` on the record.
- **V-3 of ADR 0141 is still open.** It concerns how Cloudflare counts D1 statements toward the instance limit.
  - Production executed one invocation of hundreds of units, about 20,000 or more metered statements in one step, without a platform error.
  - The meter counts every `prepare`; only executions reach D1.
  - Settling V-3, and with it the headroom, is an owner decision under T-6. This fix keeps the conservative meter unchanged.
- **The P518 chain is untouched.** The chain of `d8dc6ec8-…`/518 stays `stopped` `fail_closed`, and the reconcile does not relaunch it. The next published EPG run starts a new chain naturally, and the reconcile supersedes the old one. No reset or reopen is part of this change.
