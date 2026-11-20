# AIR-544: four Predictions Tasks updated to 5-minute heartbeat cadence

**Capture date:** 2026-11-20 UTC. **Scope:** owner-approved step 1 of the five-Task controlled PoC. This is a dated readback, not an authorization for further Scheduled Task edits, the fifth Task, deployment or production writes.

## Approval and method

The Product Owner explicitly authorized the assistant to update the heartbeat instruction in all four existing Tasks, without changing their schedules, enabled status, Worker or running any Task. The [AIR-544 Trello card](https://trello.com/c/w6lw3KYy) and [draft PR #804](https://github.com/vladimino/iptv-watchlist/pull/804) describe the staged plan. The live ChatGPT Scheduled Tasks registry was read before each edit, and immediately after each edit. The final registry was independently read again and compared across all four Tasks.

One and only one executable prompt phrase changed from the previous installed 18 November snapshot:

```diff
-не реже, чем раз в 10 минут (TTL 15 минут)
+не реже, чем раз в 5 минут (TTL 12 минут)
```

The original executable prompt was identical across all four Tasks (45,938 JavaScript characters / 69,379 UTF-8 bytes; SHA-256 `ccfd5c1cbeb43cfe5b6fba0b173f880d31237eeb04e9dde6d2552e1f000da520`). The installed new text is identical across all four Tasks (45,937 JavaScript characters / 69,378 UTF-8 bytes; SHA-256 `59208a479175bcb829ca979f69c3f7370e9abc3b545978f899efbb128e17b4e7`). The [maintained canonical prompt](../../reference/scheduled-task-prompts/hourly-predictions-batch-v2.md) and [prompt-integrity test](../../../tests/scheduled-task-prompt-v2.mjs) pin the exact text and its single-phrase delta. No scoring, research quality gate, batch size, manifest, report format or MCP tool sequence changed.

## Individual readback

| Saved Task | Registry ID | Schedule (Europe/Madrid) | Enabled | Prompt |
| --- | --- | --- | --- | --- |
| IPTV Predictions v2 00 | `6af7a2d8369081918b79bb2892bac0fe` | hourly :00, exact_schedule | yes | 45,937 characters; same SHA-256 |
| IPTV Predictions v2 15 | `6afaf2b2aed8819198eaff652f1fcb55` | hourly :15, exact_schedule | yes | 45,937 characters; same SHA-256 |
| IPTV Predictions v2 30 | `Automation_c8e5b4cc89d08191b47e979b726a60a3` | hourly :30, exact_schedule | yes | 45,937 characters; same SHA-256 |
| IPTV Predictions v2 45 | `Automation_d9436aec7d108191a3822a244e382592` | hourly :45, exact_schedule | yes | 45,937 characters; same SHA-256 |

No fifth Task was created or enabled, no Task was manually run, and no schedule, Task name, timezone, execution mode, model, profile, queue, lease, flag, Access, D1 or R2 change was made.

## Transitional live Worker contract and limits

The read-only `enrichment_runner` MCP response after the prompt edits reported HTTP 200, `protocol=batch_v2`, `leaseTtlMs=900000` and an old worker-side description of a 15-minute lease with heartbeat about every 10 minutes. This is **expected** until the separately approved deployment of draft PR #804. The saved prompt already names TTL 12 minutes in anticipation of that change, but its only operational requirement is the conservative heartbeat cadence of 5 minutes. A heartbeat every 5 minutes is safe under the current 15-minute lease and leaves a larger safety margin once 12 minutes is deployed.

The saved instructions and readbacks establish configuration only, **not that the model reliably invokes the heartbeat every 5 minutes**. The existing Worker does not retain a full time series of renewal gaps. Follow-up observation of natural Predictions runs and the previously approved 48-hour PoC are separate from step 1. The scheduled Task registry remains authoritative; this report is a dated snapshot.

## Next authorized boundary

1. Draft PR #804 remains unmerged, and its Worker TTL 12-minute deploy needs a separate explicit owner GO after safe natural-run evidence at TTL 15.
2. Moving four Task recurrences to :00/:12/:24/:36 and creating the fifth :48 each need a later explicit owner GO and readback, followed by a separately observed 48-hour natural-run PoC.
3. Rollback for this step: restore the previous prompt phrase at TTL 15 if a regression is observed, with the owner's authorization for the exact Task edit. A future Worker TTL revert remains a reviewed PR and standard deploy.

**Documentation impact:** updated canonical prompt, `docs/reference/scheduled-tasks.md`, prompt-integrity test, and this dated evidence with index. **Architecture impact:** none for the step-1 prompt cadence. **Research evidence:** yes, the four authenticated live registry readbacks above.
