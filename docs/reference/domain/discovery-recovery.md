# Discovery observation recovery assessment

`src/domain/discovery-recovery.js` answers, for **one** discovery observation (one EPG candidate key), the questions the owner asks before any retry:

- what happened to it;
- whether a retry of that one observation would change anything;
- what the pipeline will do next and when;
- whether its identity needs review instead of a retry.

It is pure and deterministic: no I/O, no clock of its own, no network. No route, Worker bundle or action capability loads it. It is the judgement a future read-only per-observation view runs over a bounded projection. Tests: [`tests/discovery-recovery.mjs`](../../../tests/discovery-recovery.mjs).

**Execution is never available.** No writer can retry one observation safely today. The candidate exists only inside the whole discovery ledger. The decisions are one shared object that every chunk rewrites whole under the resolver lease. The only resolver entry point, `POST /api/enrichment/discovery/resolve`, runs a chunk over the global pending order. Every assessment therefore carries `execute: {available: false, capability: null, reason: "no_targeted_writer"}`. The analysis and the proposed separate execution scope are in the [dated evidence](../../evidence/discovery-targeted-recovery-no-go-2026-10-31.md).

## Parity with the resolver

The module restates the resolver's rules instead of inventing its own:

| Function | Mirrors (in `src/discovery.js`) |
| --- | --- |
| `observationActivity(candidate, nowMs)` | `candidateActivity`: `current` only when a show starts in [now − 72 h, now + 24 h) and the candidate is in the latest scan (or the flag is absent); otherwise `historical` or `expired` |
| `observationEvidenceKey(candidate)` | `candidateEvidence`: title, year, sorted durations and sorted `channelId:start` shows |
| `observationActionable(candidate, decision, nowMs)` | `resolutionActionability`: whether the next chunk may look the observation up |
| `discoverySeriesState(series, publishedRunId, nowMs)` | the order `advanceDiscovery` decides in: a live lease, a checkpoint of another generation, an orphaned `running` record (with the fail-closed interruption rule), then `continuationDecision` |

The test runs both sides on the same generated inputs, more than a thousand candidate and decision pairs including the window boundaries, and on the series records and orphan cases. A change to one side that is not made to the other fails the build.

## Input

```text
assessObservationRecovery({
  now,                                   // ISO time, required
  target: {key},                         // the exact observation key, required
  published: {programmeRunId},           // the published generation
  observation,                           // the candidate for target.key; null = the ledger has no such key; undefined = not supplied
  decision,                              // the resolution entry for the key; null = none; undefined = not supplied
  series: {record, health, lease},       // raw continuation record (null when absent), its continuation health, raw resolver lease (null when absent)
})
```

- **`observation`:**
  - identity and generation: `key`, `programmeRunId`;
  - evidence fields: `normalizedTitle`, `year`, `durations`, `shows`;
  - activity fields: `seenInLatestSnapshot`, `lastSeenAt`, `lastAiring`;
  - `confirmedTmdbId`;
  - `nonfilmReason`: the [non-film screening](nonfilm-screening.md) result of its title, `null` when it passes.
  
  A candidate whose `key` differs from `target.key` is never judged in its place.
- **`decision`:** the resolution ledger entry for the key: `status`, `attempts`, `retryAt`, `terminalReason`, `evidenceKey`, `lastAttemptAt`.
- **`series.health`:** what pipeline status reports as `continuationHealth`. It is needed only for a `running` record.

Errors return `{error}` and nothing else: `invalid_input` (not an object), `invalid_clock` (`now` missing or unparseable), `invalid_target` (no key).

## Output

`{schemaVersion, target, verdict, reason, observation, decision, series, retry, next, review, execute, evidence}`

| Field | Meaning |
| --- | --- |
| `verdict`, `reason` | One of the verdicts below, with the rule that decided it |
| `observation` | `{activity, actionable, evidence}`: the activity, whether the next chunk may look it up, and whether the decision's evidence is `same`, `changed` or `no_decision` |
| `decision` | The safe subset of the decision: status, attempts, retry time, terminal reason, last attempt |
| `series` | `{state, reason, at}`: whether the discovery series will run another chunk, and when |
| `retry` | `{helps, reason}`: `no`, `only_sooner`, `unlikely`, `series_level` or `unknown`. Never `yes` |
| `next` | `{actor, at}`: `none`, `scheduled_step`, `epg_commit`, `new_epg_evidence` or `reread`, with a time when one is known |
| `review` | `{suggested, reason, target, available, unavailableReason}`. Review is suggested for an ambiguous or terminal identity. `available` is `false` until an identity review page exists (`identity_review_not_built`) |
| `execute` | Always `{available: false, capability: null, reason: "no_targeted_writer"}` |
| `evidence` | `{completeness, missing, anomalies}`: `missing` when a required part was not supplied; `partial` when the series is unknown for a verdict that depends on it, or the decision has an unparseable retry time |

### Verdicts

| `verdict` | When | `retry.helps` | `next` |
| --- | --- | --- | --- |
| `resolved` | The decision is `verified` | `no` | `none` |
| `excluded_nonfilm` | The title is screened as not a film and the identity is not confirmed | `no` | `none` |
| `not_current` | `historical` or `expired`: the resolver does not look at it | `no` | `new_epg_evidence` |
| `queued` | The next chunk may look it up: no decision, retry due, new evidence, a non-film exclusion the screening no longer reproduces, or a known alias the cheap pass verifies | `only_sooner` while the series moves; `series_level` when it stopped | per series |
| `identity_conflict` | `ambiguous` on unchanged evidence, due or in backoff | `unlikely` (review) | the automatic re-check: its retry time, or per series when due |
| `backoff` | A future retry time on unchanged evidence | `no` (backoff is policy) | `scheduled_step` at the retry time |
| `no_more_evidence` | A terminal reason (`repeated_uncertain_match`, `awaiting_confirmation`) on unchanged evidence | `unlikely` (review) | `new_epg_evidence`: a new airing resets the attempts |
| `stale_generation` | The observation belongs to another generation than the published one | `unknown` | `reread` |
| `not_found` | The ledger has no candidate for the key | `unknown` | `none` |
| `unknown` | A required part is missing or malformed | `unknown` | `reread` |

### Series states

| `series.state` | When | `next` for a queued observation |
| --- | --- | --- |
| `continuing` | The next scheduled step runs a chunk | `scheduled_step` |
| `waiting` | `chunk_budget`, `backoff` (including TMDB throttling) or an error whose gate is in the future | `scheduled_step` at the gate |
| `live_writer` | The resolver lease is live (a chunk or the poster maintenance route) | `scheduled_step` at the lease expiry |
| `recovering` | The next step hands the series to the published generation, or settles or resumes an orphan | `scheduled_step` |
| `interrupted` | Stopped after repeated interruptions, or an orphan that will fail closed | `epg_commit` |
| `stopped` | `complete`, `programme_changed`, `missing_secret`, `idle`, or no budget left | `epg_commit` |
| `unknown` | The record, lease or required health was not supplied or is malformed | `none` |

## Relation to the data health model

The [data health model](data-health.md) marks an unresolved observation whose retry time has passed as `discovery_retry` with `eligible: true`. That is necessary but not sufficient for a retry to help. The health model does not see the observation's activity, its evidence key, the screening, the resolver lease or the series state. This assessment adds them, and for an eligible observation it usually finds that the normal cycle already takes it (`queued`, `only_sooner`).
