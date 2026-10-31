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
- **`series.lease`:** `null`, or the lease the resolver writes: a non-empty string `id` and a finite, non-negative number `expiresAt` (a released lease has `expiresAt: 0`).

Supplied parts are checked against the shapes the EPG commit and the resolver write before any rule runs. A malformed part is reported, never read as an absent value or a passed time, and never throws:

- **Observation:**
  - `shows`: absent, `null`, or an array of objects with a finite number `start` and an optional string or number `channelId`;
  - `durations`: absent, `null`, or an array;
  - `seenInLatestSnapshot`: a boolean or absent;
  - `lastSeenAt` and `lastAiring`: finite numbers or absent;
  - `normalizedTitle` and `nonfilmReason`: strings or absent;
  - `year`: a number, a string or absent.

  Anything else is verdict `unknown` with reason `observation_malformed`. `evidence.missing` names the field paths, for example `observation.shows`.
- **Decision:** `status`, `evidenceKey`, `retryAt` and `terminalReason` are strings or absent. Anything else is `unknown` with reason `decision_malformed`, and `evidence.missing` names the fields. A string `retryAt` that does not parse is not malformed: it is the `retry_at_unparseable` anomaly.
- **Lease:** any other lease shape (no `id`, a missing, string or negative `expiresAt`) makes the series `unknown` with reason `lease_malformed`. It is not read as expired, because whether a writer holds the resolver cannot be told. A verdict that depends on the series is then `partial` with `missing: ["series"]`.

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
| `next` | `{actor, at}`: `none`, `scheduled_step`, `epg_commit`, `new_epg_evidence`, `owner_investigation` or `reread`, with a time when one is known |
| `review` | `{suggested, reason, target, available, unavailableReason}`. Review is suggested for an ambiguous or terminal identity. `available` is `false` until an identity review page exists (`identity_review_not_built`) |
| `execute` | Always `{available: false, capability: null, reason: "no_targeted_writer"}` |
| `evidence` | `{completeness, missing, anomalies}`: `missing` when a required part was not supplied; `partial` when the series is unknown for a verdict that depends on it, or the decision has an unparseable retry time |

### Verdicts

| `verdict` | When | `retry.helps` | `next` |
| --- | --- | --- | --- |
| `resolved` | The decision is `verified` | `no` | `none` |
| `excluded_nonfilm` | The title is screened as not a film and the identity is not confirmed | `no` | `none` |
| `not_current` | `historical` or `expired`: the resolver does not look at it | `no` | `new_epg_evidence` |
| `queued` | The next chunk may look it up: no decision, retry due, new evidence, a non-film exclusion the screening no longer reproduces, or a known alias the cheap pass verifies | per series, below | per series, below |
| `identity_conflict` | `ambiguous` on unchanged evidence, due or in backoff | `unlikely` (review) | the automatic re-check: its retry time, or per series when due |
| `backoff` | A future retry time on unchanged evidence | `no` (backoff is policy) | `scheduled_step` at the retry time |
| `no_more_evidence` | A terminal reason (`repeated_uncertain_match`, `awaiting_confirmation`) on unchanged evidence | `unlikely` (review) | `new_epg_evidence`: a new airing resets the attempts |
| `stale_generation` | The observation belongs to another generation than the published one | `unknown` | `reread` |
| `not_found` | The ledger has no candidate for the key | `unknown` | `none` |
| `unknown` | A required part is missing or malformed | `unknown` | `reread` |

### Series states

| `series.state` | When | `retry` for a queued observation | `next` for a queued observation |
| --- | --- | --- | --- |
| `continuing` | The next scheduled step runs a chunk | `only_sooner` (`already_queued`) | `scheduled_step` |
| `recovering` | The next step hands the series to the published generation, or settles or resumes an orphan | `only_sooner` (`already_queued`) | `scheduled_step` |
| `waiting` | `chunk_budget`, `backoff` (including TMDB throttling) or an error whose gate is in the future | `no` (`series_waiting`) | `scheduled_step` at the gate |
| `live_writer` | The resolver lease is live (a chunk or the poster maintenance route) | `no` (`writer_active`) | `scheduled_step` at the lease expiry |
| `stopped`, reason `missing_secret` | The TMDB secret is missing | `no` (`configuration_required`) | `owner_investigation` |
| `stopped`, any other reason | `complete`, `programme_changed`, `idle`, or no budget left | `series_level` (`series_stopped`) | `epg_commit` |
| `interrupted` | Stopped after repeated interruptions, or an orphan that will fail closed | `series_level` (`series_stopped`) | `epg_commit` |
| `unknown` | The record, lease or required health was not supplied or is malformed | `unknown` (`series_unknown`) | `none` |

### Ordinary queue, protected waits and live fences

`only_sooner` means the observation is in an **ordinary queue**: the series runs its next chunk whenever it is next called, so a targeted retry could at most take the observation before others in the pending order. It applies only to `continuing` and `recovering`.

Two other states keep the observation queued, but a retry would not even be sooner:

- **Protected wait (`waiting`):** the series holds back on purpose, to respect TMDB throttling, the chunk budget or an error delay. A retry must respect that gate too, so `retry.helps` is `no`.
- **Live fence (`live_writer`):** another writer holds the resolver lease. A retry must wait for the lease like any chunk, so `retry.helps` is `no`.

A missing TMDB secret is not a stop that a generation resets. Each EPG commit starts a series that stops the same way, and a whole-series action fails the same way, until the owner restores the configuration. So `retry.helps` is `no` with reason `configuration_required`, and `next.actor` is `owner_investigation` rather than `epg_commit`. The other stops do reset with the next EPG commit.

## Relation to the data health model

The [data health model](data-health.md) marks an unresolved observation whose retry time has passed as `discovery_retry` with `eligible: true`. That is necessary but not sufficient for a retry to help. The health model does not see the observation's activity, its evidence key, the screening, the resolver lease or the series state. This assessment adds them, and for an eligible observation it usually finds that the normal cycle already takes it (`queued`). A retry would be at most sooner (`only_sooner`) while the series moves, and would help nothing (`no`) while it waits, while a writer holds the lease, or while the configuration is missing.
