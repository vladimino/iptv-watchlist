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

## Offline reproduction and fix (production-shaped fixture)

The fixture has 400 watchlist films, each with one director and eight distinct actors, giving 4,200 units, and one departed Film so a release pin is written. It runs on the real `runProducerWorkflow` path over the sqlite D1 stand-in, metered like `meterD1`. No private identifiers were used.

| Code | Result |
| --- | --- |
| Before (`main` `fa9607c`) | First invocation: 1,000 units, 39,307 calls / 37,283 statements (28,352 executed D1 calls). The stop then throws `producer_cas_lost` (cause 2). With cause 2 fixed alone, the chain stops `producer_budget_infeasible` (cause 1), as epoch 2 did. |
| After | Every invocation stays at or below 4,890 calls / 4,684 statements and hands over after two slices (100 units). The chain completes in 43 instances (`passed`, `complete`, 4,200 / 4,200 durable outcomes, no shadow Film). |

The regression test in `tests/canonical-producer-chain.mjs` uses a smaller fixture of the same shape (50 films, 300 actors, a release pin) on the real path. It asserts all of the following:

- the first invocation hands over instead of stopping;
- the release pin is written;
- the first slice always runs;
- every invocation stays inside the metered headroom;
- every successor is created for the next epoch;
- the chain completes with every unit durable and no shadow Film.

Each of the three changes, reverted alone, fails that test: the fence copy, the old infeasibility rule and the slice gate.

## Limits and open points

- **Instances per plan.** About 100 units per instance means about 41 instances for the current 4,042 units, inside `CHAIN_EPOCH_CAP` 64. A plan above about 6,000 units would reach the cap (`producer_chain_epoch_cap`). Noop units are probably cheaper; this was not measured here.
- **V-3 of ADR 0141 is still open.** It concerns how Cloudflare counts D1 statements toward the instance limit. Production executed one invocation of hundreds of units, about 20,000 or more metered statements in one step, without a platform error. The meter counts every `prepare`, but only executions reach D1. Settling V-3, and with it the headroom, is an owner decision under T-6; this fix keeps the conservative meter unchanged.
- **The chain of `d8dc6ec8-…`/518 stays `stopped` `fail_closed`.** The reconcile does not relaunch it. The next published EPG run starts a new chain naturally, and the reconcile supersedes the old one. No reset or reopen is part of this change.
