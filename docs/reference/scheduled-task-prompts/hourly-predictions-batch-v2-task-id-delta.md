# Prompt delta — fixed `taskId` of the four Predictions batch v2 Tasks (ADR 0195)

**Status: proposal for the Controller, not an installed prompt.** The four Tasks (`:00/:15/:30/:45`) are **disabled** for an owner-approved canary at the time of writing and stay disabled until a separate owner-approved production cutover; this note enables, edits and runs nothing. The installed prompt text is the snapshot in [`hourly-predictions-batch-v2.md`](hourly-predictions-batch-v2.md) (the historical, identical-prompt norm; it is **not** the norm for the new prompts and is replaced by a new snapshot only after a verified install). This note is the **smallest change** of that prompt that implements [ADR 0195](../../adr/0195-scheduled-task-id-as-run-owner-label.md). It does not touch the research protocol, scoring rules, `manifestSize=5`, `generationSize=1`, `submitBatchSize=5`, the schedule, the timezone or the enabled state. It **supersedes** the [deferred-start delta](hourly-predictions-batch-v2-deferred-start-delta.md): `prediction_batch_key`, `deferred` and `invocationKey` are **not** used.

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

## Atomic cutover (owner/Controller; not part of the code delivery)

The Controller performs this only with the owner's explicit, operation-specific approval, after the code PR is independently reviewed, merged and green on exact HEAD with post-merge `Test and build` (three shards) and `Deploy to Cloudflare`:

1. Read the live `tools/list` and confirm `taskId` (closed enum) is present on the six run tools; read the registry prompts of all four Tasks; confirm all four are still disabled and that no run holds the lease (read-only `enrichment_status`; never reset a lease).
2. Install the four prompts (base + edits above, one distinct value each) **while all four are still disabled**; read each back from the registry and record its length and SHA-256 and that the four differ only by the `taskId` value.
3. Enable the four Tasks as one controlled transition (not one by one); do not run any Task manually.
4. Verification is only real committed forecasts of the natural runs and the absence of an orphan `already_running` chain; `start = 200`, `already_running`, a green CI or a registry readback are not acceptance. Keep the card in «Верификация» until the natural runs prove it.
5. Rollback: restore the previous prompts (they send no `taskId` and are refused by the new MCP, so restore them together with, or after, a Worker revert), and disable the Tasks first.

## What the Controller must check

- The live registry prompts contain no `invocationKey`, `deferred` or `prediction_batch_key`.
- Each prompt names exactly one of `task00`, `task15`, `task30`, `task45`, equal to its slot.
- `tests/scheduled-task-prompt-v2.mjs` pins the *installed* snapshot; it changes only when the snapshot file is replaced after a verified install.
