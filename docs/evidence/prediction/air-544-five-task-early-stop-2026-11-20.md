# AIR-544: early stop of the five-Task experiment and return to four Tasks

> Dated evidence, 20 November 2026 UTC. Not a runtime authority: the live Scheduled Tasks registry and the Worker's read-only runner contract decide the current state. This file authorizes no Task, schedule, prompt or Worker operation.

[AIR-544](https://trello.com/c/w6lw3KYy) ran a controlled configuration of five hourly Predictions v2 Tasks at `:00/:12/:24/:36/:48` with a 12-minute runner lease ([plan](air-544-ttl12-five-task-plan-2026-11-19.md), [registry install](air-544-five-task-registry-install-2026-11-20.md)). The owner stopped it early on 20 November 2026. This file records the observations that supported the decision, the registry rollback that has already been performed, and what is still open. It does not replace the planned 48-hour validation, which was not completed.

## Source and method

Every figure below comes from the read-only checkpoints that the Controller recorded on the AIR-544 card on 20 November 2026 (Trello comments at about 15:34, 17:47 and 18:01 UTC): Cloudflare D1 `SELECT` statements on `prediction_run` and the prediction pointers (`rows_written=0`, `changed_db=false`), the Worker status and queue tools, `enrichment_runner`, and independent Scheduled Tasks registry readbacks. The Executor did not repeat any production read and recomputed none of these numbers; where a number is quoted it is attributed to that card record.

## Observations

| | Four Tasks, 24 h before the experiment | Five Tasks, first 3.5 h |
| --- | --- | --- |
| Window (UTC) | 2026-11-19T14:13Z to 2026-11-20T14:13Z | 2026-11-20T14:13Z to 17:43Z |
| Distinct current prediction pointer updates | 292 = 12.17 per hour | 41 = 11.71 per hour (last 2 h: 24 = 12 per hour) |
| `complete` / `manifest_spent` runs | 61 (292 created, 13 per-film failures) | 9 (41 created, 4 per-film failures) |
| `interrupted` / `lease_expired` runs | 9 | 4 |
| Persistently leased runs and the share that lost the lease | 71 leased runs: 9 of 71 = 12.7 % | 13 leased runs: 4 of 13 = 30.8 % |
| Other | 1 `partial` / `api_error` | `already_running` refusals rose; their full count for the window is **not** established |

- Nominal slots rose by 25 % (five Tasks instead of four). The saved films did not rise: the experiment's hourly rate was about 3.8 % below the immediately preceding 24 hours and about 10 % below the separate 13 per hour figure of the [preflight](air-544-fifth-task-preflight-2026-11-19.md) (312 films in a different 24 h window).
- The share of leased runs that lost their lease was 2.4 times higher than in the earlier window. In absolute terms it was 4 in 3.5 hours against 9 in 24 hours.
- `already_running` refusals write no `prediction_run` row. The live `recentRuns` view showed many of them, including three in a row at the interim checkpoint, but the card does not claim a complete count.
- An interim checkpoint about 1.3 hours into the experiment (about 15:34 UTC) had counted 17 films added since the start, three per-film errors, three lease refusals and two `lease_expired` runs, and had judged the window too short to call the configuration successful or unsuccessful.

## What these numbers do not show

- The windows have different lengths (24 hours against 3.5 hours) and cover different hours of the day; EPG, Discovery work and the transport to the Task platform could have influenced both.
- No causal link is established between the five-Task configuration, the 12-minute lease and the lower rate. The decision rests on the combination of more lost leases, more collisions and no visible gain, which the Controller judged enough to recommend stopping; it is the owner's decision and not a statistical finding.
- This is **not** the completed 48-hour validation, **not** a measured post-rollback 24-hour figure and **not** proof that the earlier four-Task baseline is the better configuration.
- The heartbeat cadence of the Tasks is not observable (no timing log), so these observations say nothing about whether the 5-minute instruction was followed.

## Decision and registry rollback already performed

The owner expressed doubt about the experiment, then explicitly delegated the Scheduled Task part of the rollback to the Controller (items 1 and 2 of the recommendation). At about 18:00 UTC (19:00 Madrid) the Controller, through the Scheduled Tasks interface and with independent readbacks:

1. set `IPTV Predictions v2 48` (`Automation_2ec98ac397d88191bedbb55bebd82149`) to disabled, keeping its `:48` recurrence and not deleting it;
2. moved the existing Tasks back to `:15` (`IPTV Predictions v2 15`, `6afaf2b2aed8819198eaff652f1fcb55`), `:30` (`IPTV Predictions v2 30`, `Automation_c8e5b4cc89d08191b47e979b726a60a3`) and `:45` (`IPTV Predictions v2 45`, `Automation_d9436aec7d108191a3822a244e382592`); `IPTV Predictions v2 00` (`6af7a2d8369081918b79bb2892bac0fe`) was not touched. The hourly recurrence rule, `exact_schedule` and the Europe/Madrid zone were preserved.

The readback after the four calls showed four enabled Tasks at `:00/:15/:30/:45`, the fifth disabled, and all five saved prompts byte-identical (45,937 characters, SHA-256 `59208a479175bcb829ca979f69c3f7370e9abc3b545978f899efbb128e17b4e7`). The Worker still reported `leaseTtlMs=720000`. A running run was neither cancelled nor was the lease reset. No manual prediction, model, EPG or Discovery run and no other production write was part of the rollback.

## What remains and how it is delivered

- **Worker lease TTL.** Four Tasks on a 12-minute lease are not the earlier four-Task, 15-minute configuration, so the owner asked for a reviewed code change that restores `RUNNER_LEASE_TTL` to 15 minutes (the change that carries this file). It takes effect only when it is merged and deployed, which needs a separate owner approval; until then the deployed lease stays at 12 minutes. The heartbeat protocol (at least every 5 minutes before long generations), ownership, epoch, compare-and-swap, batch size and selection are not changed. Verification after release, by the Controller and read-only: `enrichment_runner` shows `leaseTtlMs=900000`, the registry shows exactly four enabled Tasks at `:00/:15/:30/:45` and the fifth disabled, and natural runs are compared without manual producers or a lease reset.
- **Prompt text.** The saved executable prompts keep the literal `TTL 12 минут` next to the 5-minute heartbeat. After the Worker returns to 15 minutes this is a conservative mismatch in wording only; the heartbeat remains safe. Changing it needs a separate owner-approved prompt-only operation, and the canonical snapshot is not edited here (its executable region and hash are unchanged).
- **Documentation.** The maintained references, runbook and architecture pages describe four active Tasks, one disabled fifth entry and a 15-minute lease. The five-Task registry evidence stays as dated history.
- **Measurement.** The 48-hour natural-run comparison proposed in the [plan](air-544-ttl12-five-task-plan-2026-11-19.md) is not run. Any new comparison, including a post-rollback 24-hour window, needs its own definition and owner decision.

Limits: all production figures are secondary (quoted from the card), one short experiment window, no causal analysis, no count of `already_running` for the window.
