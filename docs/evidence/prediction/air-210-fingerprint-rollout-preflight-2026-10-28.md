# Fingerprint selective migration: read-only rollout preflight (AIR-210, stage P0)

**Captured:** 2026-10-28, 12:02–12:06 UTC (Madrid 13:02–13:06), read-only
**Sources:** owner-only IPTV MCP read tools (`enrichment_queue`, `prediction_queue_overview`, `enrichment_profile`, `prediction_film_diagnostics`, `prediction_pending`) and one read-only Cloudflare API `GET` of the Worker `iptv` script settings and deployments. `enrichment_status`, `GET /api/enrichment/view`, `/runs` and `/api/events` were not called: they may write (`tests/get-side-effects.mjs`)
**Code:** `main` `2ccda77` (AIR-209 merged); the Worker's latest deployment `ac2f4814-bbf3-4eca-904f-c2a99e108464` (version `03df031f-…`, 100 %) was created 2026-10-28T11:54:40Z, after that merge
**Authorization:** the read-only preflight handoff on [AIR-210](https://trello.com/c/DM1Rrnrz) (card comment of 28 October, 11:56 UTC). No flag, Task, R2, D1, model, sync, discovery, retry, lease or migration action
**Verdict:** **no migration work exists in production today**, so no selective fingerprint migration can be observed yet: the transition registry is empty and every fingerprint is at schema 1 / prompt 1. The two switches of ADR-0035 are both unset. What a bounded rollout can prove now is the safety of each switch, not a migration; the options are in the last section

## Worker configuration (read-only settings read)

| Binding | Value | Effective |
| --- | --- | --- |
| `PREDICTION_FINGERPRINT_COMPATIBILITY` | absent | `strict` |
| `FINGERPRINT_VERSION_OBJECTS` | absent | `off` |
| `PREDICTION_PROFILE_COMPATIBILITY` | `selective` | selective profile rule (AIR-206) |
| `PREDICTION_VERSION_OBJECTS` | `on` | immutable prediction version objects |

The other bindings (R2 bucket `iptv`, EPG URL, Letterboxd, Finds and MCP Access values, the TMDB secret) are unchanged and outside this card. Ten deployments exist; the latest is the AIR-209 code.

## Queue and compatibility (stored snapshot of 08:12:10.756 UTC)

The stored queue predates the AIR-208 and AIR-209 deployments, so it has no `fingerprintCompatibility` block and no versions of its own yet (`null` in `GET /api/enrichment/queue/status`); the overview reports the fingerprint rule from the Worker instead.

| Field | Value |
| --- | --- |
| Programme generation | `b2699929-…`, published, consistent, no reasons |
| Profile | version 2, `profileHash` `78d004ea…449d`, selective `horrorPreferences` impact, two-link lineage (unchanged since AIR-206 S4) |
| Films / missing | 2,344 / 0 |
| Profile rule (`compatibility`) | mode `selective`, exact 94, compatible 2,054, stale 196 (`profile_impacted` 194, `film_features_unknown` 2); `wouldKeep` 2,054, `wouldRequeue` 0, `strictDisagreements` 0 |
| Fingerprint rule (overview) | mode `strict`, target schema 1 / fingerprint prompt 1 / prediction prompt 1, registry digest `4f53cda1…b945` = SHA-256 of `[]` (verified locally) |
| Pending | 196 (hot 143, cold 53), all eligible, none deferred; runner list 165 (the 31 cold non-watchlist films stay out by design) |
| Coverage | 2,148 / 2,344 (91.6 %); window 1,690 / 1,833 (92.2 %) |
| Hot / cold | 1,852 / 492; `hotPredicted` 1,709 |
| Last recorded batch | the v1 scheduled run of 05:24–05:25 UTC; `lastCheckAt` 05:25:54; `nextScheduledRunAt` 12:20 UTC |

Progress since the AIR-206 S5 read (07:39 UTC): exact 62 → 94, stale 228 → 196, coverage 90.3 % → 91.6 %. **No queue refresh has been recorded between 08:12 UTC and this read (12:04 UTC)**, and `lastBatch` still names the 05:24 run: the runner has written nothing for about four hours. Whether the Scheduled Task is paused, idle or looping without a checkpoint is not readable from here; it is an open question for the owner before any stage.

## Film sample (diagnostics, AIR-209 fields)

| Film | Fingerprint | Prediction | Index |
| --- | --- | --- | --- |
| `2Eao`, `w0e6`, `d2hI` (not horror) | schema 1, prompt 1, `produced: generated`, `previous: null`, `current` and `usable`, `exact`, migration `none`, mode `strict` | current, `profileMatch: false`, `cause: compatible`, `reason: profile_unaffected`, `requiredWork: none`, mode selective / fingerprint mode strict | agreed |
| `Dh8e` (horror), `tmdb_1813`, `tmdb_27475` (first pending page) | same fingerprint facts | stale, `cause: profile_changed`, `reason: profile_impacted`, `requiredWork: prediction_only`, hot lane, eligible | agreed |

`produced`, `previous` and `promptVersion` are the diagnostics' readings of pointers written before AIR-208: absent fields read as `generated`, `null` and 1, as the contract says. No pointer written by the AIR-208 code exists yet, because no fingerprint has been written since the deployment.

## What the rules would decide today

- **Fingerprint rule `selective`:** every stored fingerprint is exact for the target (schema 1, prompt 1) and the registry is empty, so the verdict is `current/exact` for every film and no decision changes. The restore path has nothing to restore. The only observable effect would be the new block in the queue after its next refresh (mode `selective`, every fingerprint reason `exact`, classes `unchanged` = predicted films, `migration` all `none`) and `fingerprintMode: selective` in the diagnostics.
- **`FINGERPRINT_VERSION_OBJECTS=on`:** the next fingerprint the runner accepts (a film with `requiredWork: fingerprint_and_prediction`: today only new films, since every stored fingerprint is usable) would also get an immutable body and generation record. Existing 2,344 fingerprints get none: no backfill route exists, so a later rollback to a stored record is possible only for fingerprints written after the switch.
- **A migration** needs a declared transition in the code registry together with a changed `FINGERPRINT_SCHEMA_VERSION` or `FINGERPRINT_PROMPT_VERSION` (or `PREDICTION_PROMPT_VERSION`), released through its own PR with the owner's approval of the exact declaration, as the profile publication of AIR-206 S3 was. No such change is proposed or scheduled.

## Rollback facts

- Unsetting either switch restores today's behaviour exactly; with the registry empty neither direction changes a decision, so there is no mass invalidation risk at this stage (unlike the profile rule, where `strict` would requeue every non-exact prediction).
- `FINGERPRINT_VERSION_OBJECTS` back to `off` stops new objects; written objects stay (the Worker never deletes).
- A code revert does not remove bindings or objects.

## Options for the owner (each a separate approval)

| Option | What it proves | Risk | Verification (read-only) |
| --- | --- | --- | --- |
| **A. `FINGERPRINT_VERSION_OBJECTS=on`** | the writer precondition of ADR-0035 section 2 on real submits; no decision changes | low: one more create-only write per accepted fingerprint; a body conflict fails that film's submit with `storage_error` | the next new film's diagnostics show `produced: generated`, `previous: null`, `promptVersion: 1` from a freshly written pointer; a read-only R2 object listing under `enrichment/films/<id>/fingerprints/` and `fingerprint-generations/` shows one body and one record; no `storage_error` in the queue retries |
| **B. `PREDICTION_FINGERPRINT_COMPATIBILITY=selective`** | the switch, the queue block and reader parity live, as AIR-206 S2 did for the profile rule | low: no decision changes today; readers, queue and runner already share one rule | after the next scheduled refresh: `fingerprintCompatibility.mode: selective`, `strict.stale` 0, `fingerprintReasons.exact` = predicted films, `wouldRequeue` 0, `strictDisagreements` 0, overview consistent; diagnostics `fingerprintMode: selective`, `reason: exact` |
| **C. a first real transition** | selective migration itself: bounded batches, preemption, partial classes, restore | needs a product decision (what the fingerprint prompt or schema change is), a code release with the declaration and the owner's approval of its exact hash, and a decision about the 2,344 fingerprints without generation records (a backfill route is new code) | out of this preflight; a separate card |

Order, if A and B are both approved: A first, then B, so that any fingerprint written during the observation already has its record. Neither requires a manual run; the regular Scheduled Task produces the writes to observe, once it is running again.

## Run gap (follow-up read, 12:21–12:25 UTC)

The independent review of this report observed that the hourly prediction Scheduled Task is enabled and that its latest scheduled run (11:20 UTC) was recorded `no_update`, with the last substantive result at 05:20 UTC. A second read-only pass found:

| Source | Reading |
| --- | --- |
| `enrichment_queue` | unchanged: `refreshedAt` 08:12:10.756Z, `lastBatch` the run `bb6b6cc0-…` of 05:24–05:25 UTC (profile version 1, one film), `lastCheckAt` 05:25:54Z; `nextScheduledRunAt` moved to 13:20 UTC (it is computed from the clock, not from a run) |
| `prediction_queue_overview` | `state: eligible`, `cause: ready`, 143 hot films eligible now, none deferred, no running lease |
| Workers Observability, 05:00–12:25 UTC, grouped by route | `POST /mcp` dense between about 06:35 and 08:00 UTC (60–100 calls per seven-minute bucket), then at most a handful per bucket after 08:12 UTC; no runner-sized burst at 08:20, 09:20, 10:20 or 11:20 |

So no prediction run has reached the Worker since 05:25 UTC: the Worker reports ready work and no lease, and the Task's hourly firings end without starting one. The reason sits in the Task's own decision, which the Worker cannot see; the per-call tool names are not in the logs (the events view of the Observability API failed on this Worker's records). A stale field the Task might gate on is `lastBatch.remaining: 0` from the last version-1 run, while the live `hotRemaining` is 143; that is a hypothesis, not a finding.

Consequence for the options: a flag switch observed through the regular Task would show nothing while the gap lasts. Before A or B, the owner restores or explains the Task's runs, and a fresh baseline is read after the first substantive run.

## Limits

Point-in-time reads at one stored queue refresh; the live Scheduled Task state was not read; five sampled films are not a census; no R2 object was listed. The settings read shows bindings, not what the Task's own session sees.
