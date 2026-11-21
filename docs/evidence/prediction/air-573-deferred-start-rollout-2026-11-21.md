# AIR-573: deferred S5 start rollout, 2026-11-21 UTC

Card: [AIR-573](https://trello.com/c/4pD66DLd). Owner approval: [handoff](https://trello.com/c/4pD66DLd#comment-6b01d7b358e86c3c2baa6752). Implementation [PR #872](https://github.com/vladimino/iptv-watchlist/pull/872), [final independent review](https://github.com/vladimino/iptv-watchlist/pull/872#pullrequestreview-6007870772), squash `272c3b29401d927b157c20f586d3c9e501017ddc`, [CI/CD](https://github.com/vladimino/iptv-watchlist/actions/runs/44944724366) all three build/test shards and deployment successful; deployment completed 20:11:49 UTC. Cloudflare registered `iptv-prediction-start`. Refresh tools made `prediction_batch_key` and `prediction_batch_start.deferred` available; stateless key tool answered issued without storing or starting anything.

## Registry evidence

The four enabled Tasks were updated together and independently read back. The temporary :15 probe was removed. Their existing IDs, enabled states and hourly Europe/Madrid recurrences are unchanged. Disabled :48 retains the former text. No manual run, lease reset, storage edit, flag or schedule change was performed.

| Task | Registry ID | DTSTART (Europe/Madrid) | Enabled |
| --- | --- | --- | --- |
| IPTV Predictions v2 00 | `6af7a2d8369081918b79bb2892bac0fe` | `20261114T020000` | yes |
| IPTV Predictions v2 15 | `6afaf2b2aed8819198eaff652f1fcb55` | `20261116T131500` | yes |
| IPTV Predictions v2 30 | `Automation_c8e5b4cc89d08191b47e979b726a60a3` | `20261116T223000` | yes |
| IPTV Predictions v2 45 | `Automation_d9436aec7d108191a3822a244e382592` | `20261116T224500` | yes |
| IPTV Predictions v2 48 | `Automation_2ec98ac397d88191bedbb55bebd82149` | `20261120T004800` | no |

Installed four-way snapshot: **47,221 JavaScript characters / 71,184 UTF-8 bytes**, SHA-256 `1c5e1ecb8216f1629fd216addfea5a64764e77bed40a92c4d2c5ed1676d804cd`. [Exact installed prompt](../../reference/scheduled-task-prompts/hourly-predictions-batch-v2.md). Former S5 and disabled :48: **45,922 characters / 69,358 UTF-8 bytes**, SHA-256 `54e0e7eeb6bb628ca00a6b6a195eaf984a9483443446cf5f206f0e91b30be860`. [Frozen rollback](../../reference/scheduled-task-prompts/hourly-predictions-batch-v2-synchronous-s5.md). The prefix before step 2 and suffix from step 3 match byte-for-byte, retaining research, scoring, report, generationSize=1, submitBatchSize=5, manifestSize=5. Frozen dry-run and historical S7/S10 experiments remain unchanged.

## Acceptance still open

Registry equality and delivery do not establish successful natural execution. Verify subsequent actual receipts, preparation, readback, heartbeat, committed predictions, completion, orphan behavior and research quality against the S5 baseline. No manual production run is authorized. AIR-573 remains in Verification until accepted. The prior synchronous protocol remains available for an explicitly approved rollback. This record does not prove the cause of Task termination or claim the incident resolved.
