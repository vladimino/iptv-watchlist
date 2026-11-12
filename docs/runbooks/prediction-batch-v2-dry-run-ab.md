# Batch runner v2 dry-run A/B procedure (AIR-450 input, proposed)

**Status: proposed procedure, nothing authorized.** This page is the repeatable procedure for the dry-run A/B experiment of [AIR-450](https://trello.com/c/XDyt4qIH)'s scope. Delivered by AIR-449 as documentation. Running it needs the owner's explicit, operation-specific approval. Creating, editing, enabling or running a Scheduled Task, any production `prediction_batch_start` or `prediction_batch_submit` (dry run included), flags and authority changes stay unauthorized until then ([authorization](../process/authorization-and-escalation.md#chatgpt-scheduled-task-authorization)). The dry run writes nothing to prediction state: no lease, run, queue, fingerprint, prediction, version object or view-index entry ([contract](../reference/api/prediction-runner.md#batch-runner-v2-proposed-contract)).

## Inputs

- **Frozen sample.** One record shaped as `$defs.sample` of [`batch-v2-ab.schema.json`](../reference/scheduled-task-prompts/batch-v2-ab.schema.json): `sampleId`, up to 100 distinct `filmIds`, `frozenAt`, `source`, `approvedBy`. AIR-449 does not choose production films (that would need a production read). The owner's AIR-450 approval freezes the ids once; every pass uses the same record, so passes differ only in grouping.
- **Prompt.** The `DRY RUN PROMPT` of [`hourly-predictions-batch-v2.md`](../reference/scheduled-task-prompts/hourly-predictions-batch-v2.md#dry-run-prompt) with `SAMPLE_ID`, `FILM_IDS` and `GROUP_SIZE` filled. Its generation steps 4–6 are byte-identical to the scheduled prompt's (tested), so the A/B changes grouping and nothing else.
- **Group sizes.** One pass for each `GROUP_SIZE` from 1 to 10, each in a clean context (no memory of earlier passes). Run the order 1, 10, 5, then the rest, so a context or quota limit shows early.

## Calls (exact)

```
prediction_batch_start({trigger:"manual", dryRun:true, pin:{filmIds:[...]}})   // once per pass; returns runId null and manifestHash
prediction_batch_submit({runId:"dry-run", epoch:1, dryRun:true, manifestHash, items:[{filmId, fingerprint?, prediction, inputHash}, ...]})   // 1..GROUP_SIZE items
```

`runId` and `epoch` are required by the MCP schema and by the Worker even in a dry run, and a dry-run start has no run, so the fixed synthetic pair `"dry-run"` and `1` is used. The Worker's dry-run branch never dereferences a run. The manifest is taken **once** and replayed from the held copy for the whole pass; the live queue is not re-read between groups. A group over 56 KiB is refused by the MCP tool with nothing submitted: that is itself a result (record it, resubmit one film at a time).

## Output contract

Each pass ends with one JSON object shaped as `$defs.result` of the schema: identity (`sampleId`, `groupSize`, `manifestHash`, profile and contract identity), per-film records (`plan`, `groupIndex`, the generated `fingerprint` and `prediction`, `submitStatus`, `liveInput`, sanitized `validation`, `generationMs`), per-call records (`itemCount`, `bodyBytes`, `toolMs`, `ok`) and `telemetry` (model, tokens, quota before and after, wall time). A value the platform does not show is `null` and its name goes into `telemetry.unavailable`; nothing is estimated. The result is read from the chat, never saved as a file or screenshot.

## Comparison criteria

1. **Same input.** All ten results carry the same `sampleId`, `manifestHash`, profile and contract identity, and every film `liveInput` is `same`. A pass with another `manifestHash` is discarded and rerun.
2. **Reliability per size.** Share of films per `submitStatus` (`would_write` against `validation_failure`), the issue paths and codes that recur, and groups refused for size.
3. **Quality against the size-1 pass.** For each film present in both: the absolute difference of `predictedRating` and `probability4Plus`, agreement of `confidence`, and whether the fingerprint evidence map validates. Report the distribution (median, p90, maximum), not one average. Only a stable result across sizes supports a larger `generationSize`; a drift that grows with the size is a finding against it.
4. **Model cost against tool latency.** Model generation (`generationMs`, or `wallMs` minus the sum of `toolMs`) is reported separately from MCP and Worker latency (`toolMs`) so a slow model is not read as a slow Worker. Where only `wallMs` is visible, say so.
5. **Quota.** Quota before and after each pass, and tokens where shown, per film and per pass. Unavailable stays unavailable.
6. **Decision output.** A table of the ten sizes against 2–5 and a recommended `generationSize` with the evidence. The owner decides the value; the Worker's range stays 1–10.

## Not part of this procedure

Any non-dry-run call, a Scheduled Task, an installed prompt, a production write, flags and the cutover (AIR-451). The [bounded-run signal](../reference/scheduled-task-prompts/hourly-predictions-batch-v2.md#owner-activation-gate-bounded-run-signal) is a separate owner decision before activation.
