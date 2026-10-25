# Read-only prediction diagnostics — MCP contract

[AIR-98](https://trello.com/c/JQEa1aK7) adds three owner-only MCP tools so a client can inspect the existing prediction queue without a one-off storage read. [AIR-82](https://trello.com/c/Oa33pTQK) can use that view for the queue investigation. [AIR-88](run-diagnostics.md) adds the run step log and caller-reported fault. These three tools stay read-only. This change does not add stored diagnostics, a D1 table, or a Scheduled Task, and it does not change how the queue, retries, coverage, or scoring are written.

## Tools

| Tool | What it returns |
| --- | --- |
| `prediction_queue_overview` | Published-generation and queue identity, snapshot time, hot/cold/total pending, `eligibleNow`, `deferredByRetry`, `nextRetryAt` in UTC, and coverage. `state` is `drained` only when nothing is outstanding. `temporarily_ineligible` means work remains and none of it is eligible, including retry backoff. |
| `prediction_film_diagnostics` | One film id: fingerprint presence and schema, prediction presence and whether it matches the current profile, hot/cold membership, retry kind/scope/attempts/`failedAt`/`retryAt`/`lastRunId`, the retry's `validation` summary when the last rejection recorded one (see [the submit validation contract](enrichment.md#submit-validation-contract)), and whether the view index agrees with the film objects. A missing fact is `unknown` or `not_recorded`. |
| `prediction_pending` | A page of at most 20 outstanding film ids. `filter` is `all`, `eligible`, or `deferred`. `deferred` includes retry backoff and cold films waiting behind hot work. The cursor belongs to one queue snapshot; after the queue changes it returns `snapshot_changed` and no ids. |

Eligibility is the same comparison the runner already uses (`queueReadyIds`): a numeric `retryAt` in the future is deferred. The response prints that instant as UTC. The tools do not refresh the queue or rewrite a retry.

Each response has `atomic: false`. The queue, profile, programme, and view index are separate objects. When their run id, profile, or index disagree, `snapshot.partial` is true and `snapshot.reasons` names the disagreement. Coverage is `unknown` when the programme, profile, or view index cannot be read. An empty confirmed set has `percent: null`.

The overview reads the prediction queue, taste profile, view index, programme, discovered films, and published generation. A film diagnostic also reads that film's fingerprint and prediction. A pending page reads the overview set and does not read one object per film. None of the tools lists the bucket or writes.

A saved failure is returned only as a short classification (`validation_error`, `parse_error`, `storage_error`, `quota`, and the existing safe stop reasons). The tools do not return profile text, fingerprint bodies, prediction text, prompts, tokens, or stack traces. A failure that was not stored is `not_recorded`. Historical retry records without a validation summary, and retries recorded for a system failure, return `retry.validation: null`; otherwise it is `{stage, reportedBy, issues}` re-checked against the closed vocabulary: a `stage` outside `caller_reported`, `fingerprint_schema`, `fingerprint_missing`, `prediction_schema` becomes `unknown`, a `reportedBy` other than `caller` or `worker` becomes `null`, and an issue whose `path` is not `fingerprint` / `prediction` with up to two field segments or whose `code` is not a contract issue code is dropped.

## Production impact and rollback

The tools are read-only and stay behind the existing `IPTV MCP` Access application. Deploying the Worker does not start sync, prediction, a retry, or a Scheduled Task, and it does not change a feature flag or the queue.

Rollback is reverting this change. The previous tool list comes back. There is no stored migration to undo.

## Check after deploy

This repository change does not call production. After the Worker deploy, an owner-only MCP client can read:

1. `prediction_queue_overview`.
2. `prediction_film_diagnostics` for the five AIR-82 films `tmdb_617505`, `tmdb_25539`, `tmdb_28512`, `tmdb_2193`, and `tmdb_927107`.
3. `prediction_pending` with `filter` `all`, then `eligible` and `deferred`, and a limit large enough for the outstanding page.

That check only reads. It is the point at which the AIR-82 investigation no longer needs a direct storage session. Do not reset retries, start the runner, or call a model as part of it.
