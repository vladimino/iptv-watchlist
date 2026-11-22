# Prompt delta — fixed `taskId` of the four Predictions batch v2 Tasks (ADR 0195)

**Status: owner-approved staged Controller rollout plan, not an installed prompt.** The four Tasks (`:00/:15/:30/:45`) are **disabled** after the isolated canary. The Product Owner approved the fixed-ID architecture and a staged rollout on 22 November 2026. The Tasks remain disabled until the reviewed code is merged, exact-head and post-merge CI/build/deploy are green, and the Controller performs the bounded staged cutover; this note enables, edits and runs nothing. The installed prompt text is the snapshot in [`hourly-predictions-batch-v2.md`](hourly-predictions-batch-v2.md) (the historical, identical-prompt norm; it is **not** the norm for the new prompts and is replaced by a new snapshot only after a verified install). This note is the **smallest change** of that prompt that implements [ADR 0195](../../adr/0195-scheduled-task-id-as-run-owner-label.md). It does not touch the research protocol, scoring rules, `manifestSize=5`, `generationSize=1`, `submitBatchSize=5`, the schedule, the timezone or the enabled state. It **supersedes** the [deferred-start delta](hourly-predictions-batch-v2-deferred-start-delta.md): `prediction_batch_key`, `deferred` and `invocationKey` are **not** used.

## The change: one common base plus one constant

The four prompts are the installed base text with exactly the three edits below, and differ from each other **only** in the value in edit 1:

| Task | slot | `taskId` |
| --- | --- | --- |
| IPTV Predictions v2 00 | `:00` | `task00` |
| IPTV Predictions v2 15 | `:15` | `task15` |
| IPTV Predictions v2 30 | `:30` | `task30` |
| IPTV Predictions v2 45 | `:45` | `task45` |

**Edit 1 — add to «ПАРАМЕТРЫ ЭТОГО ЗАПУСКА»** (the parameters paragraph, after `manifestSize=5`), with the Task's own value:

> `taskId=taskNN` — постоянный идентификатор ЭТОЙ Scheduled Task (не секрет, не генерируй, не меняй, не придумывай и не копируй из другого места). Передавай `taskId` в КАЖДОМ вызове: `prediction_batch_start`, `prediction_batch_manifest`, `prediction_heartbeat`, `prediction_batch_hold`, `prediction_batch_submit`, `prediction_complete` (и можешь передавать в `prediction_batch_validate`, `enrichment_runner`, `enrichment_status`, `enrichment_queue`).

**Edit 2 — step 2 (the start).** Replace `prediction_batch_start({trigger:'scheduled', manifestSize})` by `prediction_batch_start({trigger:'scheduled', manifestSize, taskId})`, still called once per execution, and extend the outcome list with:

> - `start_pending` (HTTP 200, содержит твой `runId`, `epoch`, `retryAfterMs`): это ТВОЙ же run, его манифест ещё готовится. Не вызывай старт заново без паузы и не считай это неудачей: подожди `retryAfterMs`, затем вызови `prediction_batch_manifest({taskId, runId, part:'envelope'})` и повторяй, пока `manifest_pending` (не дольше 3 минут). Это не `already_running`.
> - повторный ответ `running` с тем же `runId` и `lease.epoch` на повторный старт: это тот же run, продолжай с ним (манифест тот же).
> - `already_running`: теперь означает ЧУЖУЮ Task (другой `taskId`) — успех, не присваивай `runId`, закончи без `prediction_complete`.
> - `task_args_mismatch` (409): дефект промпта (другие параметры старта в повторе); сообщи код и закончи, `prediction_complete` не нужен.
> - `wrong_owner` (409) на любом вызове run: ты не владелец этого run; закончи без `prediction_complete`, ничего не повторяй.
> - Если ответ на старт потерян или оборвался, повтори ТОТ ЖЕ `prediction_batch_start` (те же аргументы и тот же `taskId`, не больше 3 раз с паузой 5 с): повтор вернёт тот же манифест или `start_pending`, второй run не создаётся.

**Edit 3 — every later call of a run** (`prediction_batch_manifest`, `prediction_heartbeat`, `prediction_batch_hold`, `prediction_batch_submit`, `prediction_complete`) gets `taskId` next to `runId`, for example `prediction_batch_submit({taskId, runId, epoch, items})`; a lost submit answer is replayed with the **same body** including `taskId`.

## Staged cutover (owner-approved Controller operation; not part of code delivery)

The Product Owner approved this bounded staged rollout on [AIR-573](https://trello.com/c/4pD66DLd), 22 November 2026. The Controller executes it **only after** PR #891 is independently reviewed, merged, exact-head CI succeeds and all post-merge jobs succeed: `Test and build`, `Test shard 2 of 3`, `Test shard 3 of 3`, and `Deploy to Cloudflare`. No manual prediction, lease reset or other production writer is permitted.

1. Read live MCP `tools/list` and confirm the new required `taskId` enum on the six run tools. Read all four Task entries and confirm that each is disabled, with its original schedule, timezone and no active production runner lease by read-only `enrichment_status`. If an active lease is found, do not reset or force-complete it; defer the change until it expires naturally.
2. While **all four Tasks remain disabled**, install and read back all four distinct prompts using the approved three edits. Compare each installed prompt to the common base plus its unique ID, verify lengths and SHA-256, and ensure `task00`, `task15`, `task30`, `task45` match the four scheduled slots exactly. The original hourly schedules and timezone do not change.
3. Enable **only `IPTV Predictions v2 00` (`task00`)**. Observe its next **natural** scheduled invocation; do not trigger it manually. Read the Saved Task report and authoritative Worker status/queue to confirm a real `created` or `recalculated` prediction persisted, not merely a `200` start, `running`, `start_pending`, `held` or `already_running`. A read-only confirmation of at least one committed forecast is the gate to step 4. If this is not demonstrated, halt rollout, keep the other three disabled, disable `task00` if the natural run failed, and record the concrete outcome in AIR-573. No lease reset, retries, extra Task or unapproved Worker mutation.
4. Only after step 3 passes, enable `IPTV Predictions v2 15`, `30` and `45` as the second bounded transition, retaining their preverified prompts/schedules. Verify the next natural runs and committed forecasts; check for orphan `already_running` chains and ownership refusal errors. Leave AIR-573 in `Верификация` until production forecasts and stability are confirmed.
5. Rollback if needed: disable all four Tasks first; do not re-enable prompts that omit `taskId` against the new MCP. Restore previous prompts together with or after a verified Worker revert. Code rollback alone does not alter Task configuration or stored run state.

## What the Controller must check

- The live registry prompts contain no `invocationKey`, `deferred` or `prediction_batch_key`.
- Each prompt names exactly one of `task00`, `task15`, `task30`, `task45`, equal to its slot.
- `tests/scheduled-task-prompt-v2.mjs` pins the *installed* snapshot; it changes only when the snapshot file is replaced after a verified install.
