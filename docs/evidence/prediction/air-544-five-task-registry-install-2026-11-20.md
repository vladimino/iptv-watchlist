# AIR-544: five hourly Predictions v2 Tasks, owner-authorized live registry installation

**Captured:** 20 November 2026, around 15:13 Europe/Madrid. **Boundary:** step 3 of the [AIR-544 controlled five-Task PoC](https://trello.com/c/w6lw3KYy), after the owner explicitly approved changing the existing schedules and creating a fifth Task. This is a dated production registry readback, not permission to run a Task manually, change more Tasks or write prediction data.

## Live configuration after individual and final readbacks

All five are enabled and use `exact_schedule`, `Europe/Madrid`, `FREQ=HOURLY;INTERVAL=1`. The installed prompts compare **byte-for-byte identical** across all five saved Task records: 45,937 JavaScript characters and the one approved `не реже, чем раз в 5 минут (TTL 12 минут)` phrase. The [canonical prompt snapshot](../../reference/scheduled-task-prompts/hourly-predictions-batch-v2.md) pins SHA-256 `59208a479175bcb829ca979f69c3f7370e9abc3b545978f899efbb128e17b4e7` and 69,378 UTF-8 bytes. The fifth Task was created with the exact in-memory live registry prompt from Task 00, not by reconstructing or shortening it.

| Live title (unchanged for older Tasks) | Registry ID | Hourly minute | DTSTART with Europe/Madrid TZID |
| --- | --- | --- | --- |
| `IPTV Predictions v2 00` | `6af7a2d8369081918b79bb2892bac0fe` | `:00` | `20261114T020000` |
| `IPTV Predictions v2 15` | `6afaf2b2aed8819198eaff652f1fcb55` | `:12` | `20261116T131200` |
| `IPTV Predictions v2 30` | `Automation_c8e5b4cc89d08191b47e979b726a60a3` | `:24` | `20261116T222400` |
| `IPTV Predictions v2 45` | `Automation_d9436aec7d108191a3822a244e382592` | `:36` | `20261116T223600` |
| `IPTV Predictions v2 48` | `Automation_2ec98ac397d88191bedbb55bebd82149` | `:48` | `20261120T004800` |

**Title caveat:** titles 15/30/45 are still their previous minute-based identifiers. Only schedules of these three Tasks were changed; their titles and executable prompts were intentionally left unchanged, without adding title edits to the owner's approved operation. Use the live recurrence, not the old title suffix, to determine the nominal start minute.

The Worker deploy of [PR #804](https://github.com/vladimino/iptv-watchlist/pull/804), merge `95d7f1398b5e3af34b2d7e5584b2ed588458bfb3`, was independently verified before step 3: `enrichment_runner` HTTP 200, `protocol=batch_v2`, `leaseTtlMs=720000`, heartbeat at least every five minutes. No Worker deploy, model call, manual prediction run, lease reset, queue/storage/flag/Access mutation, or separate monitoring Scheduled Task was part of the step-3 registry edits.

## Measurement boundary and rollback

These are **five independent hourly schedules**, not a single 12-minute scheduler. Scheduler drift can cause concurrent starts and genuine `already_running` refusals. A 12-minute TTL is the idle-renewal timeout, not a maximum run duration or a collision-free interval. The installed configuration confirms **scheduling only**, not five successful natural starts, a quality result or a throughput gain.

The [dated preflight](air-544-fifth-task-preflight-2026-11-19.md) recorded 312 unique committed predictions in 24 hours (13.0/h). A fresh full 48-hour post-heartbeat/pre-TTL baseline was **not** collected before the step-2 deploy. Therefore do not label this as a new baseline or claim this PoC isolates the effect of the fifth Task. During the natural-run observation, distinguish nominal slots, observed Saved Task reports, verifiable actual starts (only if that source exists), `batch_start` requests, genuine `leaseRefused` and other HTTP 409, committed unique films per hour, `lease_expired`, interrupted runs, per-film errors and research F/P/S. The proposed checkpoints (approximately 1/3/6/12/24/36/48 hours) and numerical stop rules in the [PoC plan](air-544-ttl12-five-task-plan-2026-11-19.md) are not yet explicitly accepted as binding monitoring or automated rollback policy. There is no continuous Controller or automatic rollback created by this operation.

A rollback needs its own operation-specific owner authorization: disable the fifth Task, restore the three prior schedules `:15/:30/:45`, and if needed revert the Worker TTL through a separately reviewed PR/deploy. Do not reset the lease or run predictions to accelerate observation. [AIR-544](https://trello.com/c/w6lw3KYy) remains open for natural-run evidence and the owner's keep/rollback decision.

**Documentation impact:** this dated evidence and index, the Scheduled Tasks reference and prompt wrapper, the scheduling and prediction architecture pages, and the Predictions operations runbook. Historical snapshots remain historical. No executable prompt text or source code was modified.
