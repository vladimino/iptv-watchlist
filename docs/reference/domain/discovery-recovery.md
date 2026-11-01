# Discovery observation recovery assessment

`src/domain/discovery-recovery.js` answers, for **one** discovery observation (one EPG candidate key), the questions the owner asks before any retry:

- what happened to it;
- whether a retry of that one observation would change anything;
- what the pipeline will do next and when;
- whether its identity needs review instead of a retry.

It is pure and deterministic: no I/O, no clock of its own, no network. The Worker bundles it as `DiscoveryRecovery`. The [per-observation recovery read](../api/admin.md#discovery-observation-recovery-get-apiadmindiscovery-recovery) and the guarded action run it over a record of the [observation index](discovery-observation-index.md). Tests: [`tests/discovery-recovery.mjs`](../../../tests/discovery-recovery.mjs).

**No retry, one reconsideration.** Nothing here looks an observation up or runs a chunk. `execute` says only whether `discovery_reconsider@1` may be offered: it [lifts the terminal fence](#the-reconsideration-gate) of an observation whose automatic attempts ended on unchanged evidence, so that the next ordinary resolver chunk may take it again. Decision: [ADR 0061](../../adr/0061-discovery-observation-index-and-reconsider.md). Correcting the movie id is a separate capability, [`discovery_identity_correct@1`](../api/admin-actions.md#identity-correction-discovery_identity_correct1) ([ADR 0080](../../adr/0080-discovery-identity-correction.md)). This assessment does not become that capability. A current verified decision is not a limbo row; the owner opens that one key from the verified-observation index, and this assessment still reports `resolved`.

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
  index: {state},                        // the observation index state the observation was read from; only `fresh` lets the action be offered
  throttle: {retryAt},                   // the resolver's last TMDB throttle time from epg/discovery-status.json, or null
})
```

`index` and `throttle` affect only `execute`.

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

`{schemaVersion, target, verdict, reason, observation, decision, series, retry, next, review, execute, evidence}`; `schemaVersion` is 2.

| Field | Meaning |
| --- | --- |
| `verdict`, `reason` | One of the verdicts below, with the rule that decided it |
| `observation` | `{activity, actionable, evidence}`: the activity, whether the next chunk may look it up, and whether the decision's evidence is `same`, `changed` or `no_decision` |
| `decision` | The safe subset of the decision: status, attempts, retry time, terminal reason, last attempt |
| `series` | `{state, reason, at}`: whether the discovery series will run another chunk, and when |
| `retry` | `{helps, reason}`: `no`, `only_sooner`, `unlikely`, `series_level` or `unknown`. Never `yes` |
| `next` | `{actor, at}`: `none`, `scheduled_step`, `epg_commit`, `new_epg_evidence`, `owner_investigation` or `reread`, with a time when one is known |
| `review` | `{suggested, reason, target, available, unavailableReason}`. Review is suggested for an ambiguous or terminal identity. `available` stays `false` with `identity_review_not_built`: the suggestion is not an executable gate. The identity form is [`discovery_identity_correct@1`](../api/admin-actions.md#identity-correction-discovery_identity_correct1), judged from the index offer, not from this field |
| `execute` | `{available, capability: "discovery_reconsider", version: 1, reason, effect: {when, at}}`, the [reconsideration gate](#the-reconsideration-gate) |
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

## The reconsideration gate

`execute` is decided after the verdict, in this order; the first that applies wins:

| Order | `execute.reason` | `available` | When |
| --- | --- | --- | --- |
| 1 | `index_not_current` | no | `index.state` is not `fresh` |
| 2 | by verdict | no | The verdict is not `no_more_evidence`. The reason is `already_resolved`, `not_a_film`, `not_current`, `already_eligible` (`queued`), `identity_ambiguous` (`identity_conflict`), `backoff_is_policy`, `generation_changed`, `target_absent` (`not_found`) or `evidence_incomplete` (`unknown`) |
| 3 | `terminal_reason_unknown` | no | The terminal reason is not `repeated_uncertain_match` or `awaiting_confirmation` |
| 4 | `identity_ambiguous` | no | The decision is `ambiguous` |
| 5 | `writer_active` | no | `series.state` is `live_writer`: the resolver lease is live |
| 6 | `series_unknown` | no | `series.state` is `unknown`, including a malformed lease |
| 7 | `series_backoff` | no | `waiting` for anything but the chunk budget: TMDB or storage backoff, an error delay |
| 8 | `configuration_required` | no | Stopped for a missing TMDB secret |
| 9 | `tmdb_throttled` | no | `throttle.retryAt` is in the future |
| 10 | `eligible` | yes | `effect.when` is `next_ordinary_chunk` (`continuing`, `recovering`), `after_series_wait` with `effect.at` (waiting for the chunk budget), or `next_series` (stopped or interrupted: the next EPG commit opens a series that takes it) |

`DISCOVERY_RECONSIDER_REASONS` and `DISCOVERY_RECONSIDER_EFFECTS` are the closed vocabularies.

`reconsiderIssue(assessment)` turns the gate into the data health issue the [guarded action contract](../api/admin-actions.md) judges a preview by: `{id: "discovery_reconsider:<key>", subject: {kind: "observation", id: key}, action: {code: "discovery_reconsider", eligible, reason}, evidence: {completeness}}`. `eligible` is `true` when the gate is available. It is `null` (unknown, never eligible) for an `unknown` verdict, `index_not_current` and `series_unknown`, and `false` otherwise.

`reconsideredDecision(previous, {at, idempotencyKey})` is the decision the action writes. It is the same record with `terminalReason: null` and `retryAt: null`, plus `reconsidered: {at, idempotencyKey, capability: "discovery_reconsider@1", previousTerminalReason, previousRetryAt, attemptsAtReconsider}`. `attempts`, `evidenceKey`, `status` and the scoring are kept. The resolver's `resolutionActionability` then finds the decision actionable, and its next uncertain outcome on the same evidence reaches the attempt limit and is terminal again at once: the owner buys exactly one more ordinary attempt. The resolver's next write of the decision drops the marker; the action record keeps the history.

## Relation to the data health model

The [data health model](data-health.md) marks an unresolved observation whose retry time has passed as `discovery_retry` with `eligible: true`. That is necessary but not sufficient for a retry to help. The health model does not see the observation's activity, its evidence key, the screening, the resolver lease or the series state. This assessment adds them, and for an eligible observation it usually finds that the normal cycle already takes it (`queued`). A retry would be at most sooner (`only_sooner`) while the series moves, and would help nothing (`no`) while it waits, while a writer holds the lease, or while the configuration is missing.
