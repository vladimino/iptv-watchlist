# ADR 0136: Batch v2 clients choose manifestSize; spending the selected manifest is a normal complete

**Status:** Accepted  
**Original decision date:** 2026-11-13  
**Recorded at:** 2026-11-13  
**Approval source:** Owner decision in conversation 13 November 2026 (Europe/Madrid), scoped on [AIR-463](https://trello.com/c/7pGBGSh0); does not rewrite historical [ADR 0122](0122-prediction-batch-runner-v2-dual-protocol.md)  
**Related work:** [AIR-463](https://trello.com/c/7pGBGSh0); prerequisites [AIR-447](https://trello.com/c/3jrJcvWH), [AIR-448](https://trello.com/c/0Huo5rW6), [AIR-450](https://trello.com/c/VPd21Y9d); successor cutover [AIR-451](https://trello.com/c/NN3N6kRp)  
**Numbering:** Drafted as 0135 on the AIR-463 branch; renumbered to **0136** on merge with `main` after [ADR 0135](0135-epg-priority-discovery-pause.md) (AIR-458) claimed that number  
**Supersedes:** None (narrows ADR 0122’s fixed 100-film start selection for clients that opt in; omitted `manifestSize` keeps the ADR 0122 default)  
**Superseded by:** None

## Context

ADR 0122 delivered `prediction_batch_start` as one self-sufficient manifest of at most 100 eligible films. The AIR-450 isolation experiment chose a practical short invocation of **five** researched films (`generationSize=1`, `submitBatchSize=5`). Ending after those five while ready films remained in the global queue required `prediction_complete({reason:'time_budget'})`, which the Worker recorded as `status: partial` with title «Прогнозы приостановлены» — a false pause for a successful short packet. Clients needed an explicit selection cap and a truthful normal completion when the selected manifest was spent.

## Decision

1. **`manifestSize` on start.** `prediction_batch_start` / `POST /api/enrichment/batch/start` accept optional `manifestSize`: integer **1..100**. Omitted → **100** (ADR 0122 compatibility). Invalid type, 0, negative, fraction or >100 → **400**, no writes. `limits.maxManifestBytes` and `limits.maxManifestFilms=100` remain the server ceiling. `generationSize` and `submitBatchSize` stay client/prompt parameters and are **not** derived from `manifestSize`. The answer echoes `manifestSize` (requested) and `filmsSelected` (actual). Selection uses the same hot→cold / eligibility / retry / fencing path and reads only as many film payloads as the cap needs.
2. **Dry-run and pin.** `dryRun:true` accepts `manifestSize`. `pin.filmIds` longer than the effective size is an invalid request (no silent truncate). The 256 KiB `manifest_too_large` guard still measures the real returned answer.
3. **`manifest_spent` complete.** For a `batch_v2` run, when every `selectedIds` film is settled (`created` / `recalculated` / `already_current` or a recorded per-film retry failure), `prediction_complete({reason:'manifest_spent'})` is a **normal** completion: `status: complete`, lease released, one truthful Event with selected/created/recalculated/failed counters and real global outstanding/ready — even when ready films remain. It is **not** `partial`, **not** `time_budget`, **not** «Прогнозы приостановлены», and **not** a false `queue_empty`. Unsubmitted slots and `deferred_budget` fail closed (`409 manifest_not_spent`). Profile / contract drift between the last submit and complete is fenced the same way as a reasonless complete (`409` profile/contract changed), so the caller ends with `profile_changed` / `runner_aborted` rather than a false spent success; lease / storage failures keep existing stop semantics. Replay of a finished run re-emits the same Event once and does not create a second one.
4. **Out of scope.** No Task create/enable/disable/run, no authority flip, no submit/validate/assessment weakening. Installing short Tasks with `manifestSize=5` is [AIR-451](https://trello.com/c/NN3N6kRp).

## Alternatives considered

- **Keep `time_budget` and accept the partial Event** — rejected: false “paused” signal for a successful short packet.
- **Server-side default of five without a parameter** — rejected: breaks ADR 0122 clients and dry-run experiments that expect up to 100.
- **Auto-truncate `pin` to `manifestSize`** — rejected: fail closed on oversize pin.

## Consequences

- Short Scheduled Task invocations can request five films and complete with `manifest_spent` without lying about queue drain or pause.
- Monitoring and the status footer treat `manifest_spent` as a normal run reason.
- Prompt text is a client-parameterized template; changing the file does not edit the Scheduled Task registry.

## Recovery and migration boundary

Code-only additive contract. Rollback is redeploy of the previous Worker. Already written predictions, Events, D1 and R2 are not reverted by a code rollback. This ADR authorizes no production writer, Task operation or live prediction run.

## Evidence

- **Original decision:** owner conversation 13 November 2026; [AIR-463](https://trello.com/c/7pGBGSh0)
- **Implementation:** this delivery PR
- **Dated verification:** offline tests `tests/prediction-manifest-size.mjs`, `tests/scheduled-task-prompt-v2.mjs`; [evidence note](../evidence/prediction/air-463-manifest-size-complete-2026-11-13.md)
- **Uncertainty:** production latency and Task throughput under four hourly invocations remain for AIR-451

## Addendum 2026-11-16 — one client-visible copy (AIR-510)

A live Scheduled Task with `manifestSize=5` created the run and then stopped with `external_termination` because the full tool result did not fit the Task working context. The Worker ceiling (256 KiB) had accepted the answer. Two copies of the same JSON (`content[0].text` and `structuredContent`) and the full schema document (profile-schema, prediction-schema and rules sections the prompt does not read) were the extra bytes. The MCP result for a successful `prediction_batch_start` now sends the JSON once, as text. `contract.schema` in that JSON keeps `contract`, the fingerprint vocabulary and `schemaDigest` of the full document. Film `modelMetadata`, stored fingerprints and `profile.body` are unchanged. `queue_changed` adds `cause` (`stale`, `revision` or `manifest`) and still does not retry. This addendum authorizes no Task edit and no production start.

## Addendum 2026-11-16 — owned-run manifest readback (AIR-510 reopen)

Task C (run `6e98e0fa-e4eb-408b-82de-dc289536b46f`, 22:33 Madrid) and Task D (run `cf083134-8093-4064-b4bb-98a4191f8391`, 22:41 Madrid) both received Worker `manifestBytes` 42,115 of the same five `selectedIds`. C called `prediction_complete(external_termination)` with zero submits; D submitted 5/5 and `manifest_spent`. The Worker start was HTTP 200 both times. Reordering fields in one JSON object does not make a truncated prefix parseable: `JSON.parse` fails, and the live Task prompt still needs `contract.schema.contract` plus every film `modelMetadata`.

A real `batch_start` persist stores the exact start answer at `enrichment/batch-manifest/<runId>.json`. `prediction_batch_manifest` returns one bounded JSON part (`envelope`, `profile`, `contract`, or one `film`) for the live lease holder and writes nothing. A truncated start text is `truncated_manifest` (fail closed: no invented films). An incomplete part set is not a usable manifest. A second `prediction_batch_start` stays `already_running`. Dry-run starts store nothing. No Task registry edit and no production start in this change. The installed prompt does not call the readback until a separate owner GO.

## Follow-ups

- [AIR-451](https://trello.com/c/NN3N6kRp) controlled cutover of hourly Tasks to batch v2 with `manifestSize=5`
