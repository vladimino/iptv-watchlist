# Selective prediction compatibility: profile version 2 publication (stage S4)

**Executed:** 2026-10-28, by the owner in a browser session behind Cloudflare Access (DevTools console, same-origin `fetch`): approved dry run 05:49:40.081 UTC, publication 05:49:42.925 UTC (Madrid 06:49, CET)
**Verified:** 2026-10-28, about 05:51 UTC, owner-only IPTV MCP read tools only (`enrichment_profile`, `enrichment_queue`, `prediction_queue_overview`, `prediction_film_diagnostics`)
**Code:** `main` `d14f861`; no file under `src/` changed since `1f92365`, the code of the S3 dry run. The Worker version was not read
**Approval:** owner approval of publication of the pre-approved version 2 only, recorded on [AIR-206](https://trello.com/c/87mg3VNi) (card comment of 28 October, 05:28 UTC). The declaration approval is in [S3 evidence](air-206-s3-declaration-2026-10-28.md). The switch `PREDICTION_PROFILE_COMPATIBILITY=selective` (S2) was set by the owner in the Cloudflare dashboard before this stage. No Scheduled Task, model, sync, discovery or other flag was changed
**Verdict:** **S4 complete.** Version 2 is current with the approved change impact and a two-link lineage. Under `selective`, 2,054 of 2,342 predictions stay usable and only 288 are requeued, where strict would have requeued all 2,342. Both invariants (`wouldRequeue`, `strictDisagreements`) are 0

## Before the publication

| Control | Value (about 05:33 UTC) |
| --- | --- |
| Profile | version 1, `profileHash` `14cbed70…9753` |
| Queue snapshot | refreshed 05:25:54.889Z, `compatibility.mode` `strict` (taken before the switch), 2,342 `exact`, 0 / 0 / 0, drained, consistent |
| Film diagnostics `2Eao` | prediction current, `mode: selective` (the switch is in effect) |

**Limit.** No queue snapshot shows `selective` on version 1 alone. The owner chose to publish before the next scheduled run (06:20 UTC), and the publication's own queue refresh is the first selective snapshot. That loses no safety: with version 1 and no lineage, selective decides exactly as strict ([S0](air-206-s0-strict-baseline-2026-10-27.md), finding 2), and the sampled diagnostics already ran in selective mode with every prediction current.

## The calls

The console script checked that the current profile was version 1 with the expected hash. It built version 2 from that response and sent one approved dry run. It sent the publication only if the dry run answered `200`, `valid: true` and the expected hashes and fields. A repeat in the tab was blocked.

| Call | Answer |
| --- | --- |
| `PUT /api/enrichment/profile`, `dryRun: true`, with `approval` | HTTP 200, `valid: true`, `profileHash` `78d004ea…449d`, `changedFields` `["horrorPreferences"]`, `declarationSha256` `3a4d577f…0330`, `from` version 1 `14cbed70…9753` |
| The same body with `dryRun: false` (one call, no retry) | HTTP 200, `version` 2, `updatedAt` 2026-10-28T05:49:40.160Z, the approved `changeImpact`, `lineage` [version 1 (no impact), version 2 (selective)] |

## After the publication

**Profile.** `enrichment_profile` returns version 2, `profileHash` `78d004ea…449d`, the `changeImpact` and the two-link lineage above. The only text difference from version 1 is the approved sentence at the end of `horrorPreferences`.

**Queue.** The publication refreshed the queue at 05:49:41.736Z (`profile_updated`). The snapshot is consistent and has no reasons.

| Field | Value |
| --- | --- |
| `compatibility.mode` / `profileVersion` | `selective` / 2 |
| `films` / `missing` | 2,342 / 0 |
| `strict` | current 0, stale 2,342 |
| `selective` | current 0, compatible 2,054, stale 288 |
| `reasons` | `profile_unaffected` 2,054, `profile_impacted` 286, `film_features_unknown` 2 |
| `wouldKeep` / `wouldRequeue` / `strictDisagreements` | 2,054 / 0 / 0 |
| Pending (overview) | 288: hot 235, cold 53; all eligible now, none deferred |
| `pendingCount` (runner list) | 257: hot 235 plus cold watchlist films; the 31 cold non-watchlist films (`coldWithoutPrediction`) are counted in cold remaining but stay out of the runner list by design |
| Coverage | 2,054 / 2,342 current (87.7 %), window 1,628 / 1,863 (87.4 %) |
| Adaptive batch | 12 (`backlog_usage_unknown_conservative_cap_12`) |

- **288 = 286 + 2.** 286 predictions are reached by the horror selector. 2 films lack bound impact features and count as unknown, so they are stale. These are likely ids indexed after the S1 backfill.
- **`wouldRequeue` 0.** No prediction that strict would keep is requeued.
- **`strictDisagreements` 0.** Selective never keeps a prediction that it cannot justify.

**Film diagnostics.**

| Film | Genre in the sample | Prediction | `cause` / `mode` | Lane | Index |
| --- | --- | --- | --- | --- | --- |
| `2Eao`, `w0e6`, `d2hI` | not horror | current, `profileMatch: false` | `compatible` / `selective` | none | agreed |
| `Dh8e` (The Conjuring: Last Rites), `H4k` (Insidious), `3dqc` (Insidious: Chapter 2) | horror | stale | `profile_changed` / `selective` | hot, eligible | agreed |
| `4sr2` (The Conjuring) | horror | stale | `profile_changed` / `selective` | none (outside the window) | agreed |

## Findings

1. **The publication is the approved one.** The hashes, changed field, selector and approval answered by production equal the S3 declaration.
2. **Selective invalidation works as designed.** Only horror films (plus 2 unknowns) went back to the queue, instead of the whole catalogue.
3. **The next scheduled prediction run regenerates the requeued films.** It runs 06:20 UTC (Madrid 07:20) and uses the conservative batch cap of 12. Observing that first run is the next stage (S5).
4. **Flag rollback warning (R1).** With version 2 current, setting the switch back to `strict` would make all 2,342 predictions stale, because strict compares the profile hash exactly. Rollback after this point means stopping and reviewing first, not flipping the switch.

## Limits

- The answers are the owner's console output (screenshot), not a server log. The Worker version and flag bindings were not read from Cloudflare; the effective mode comes from the queue and the diagnostics.
- The genre of each sampled film comes from its title, not from the stored fingerprint. Seven films are a sample, not a census.
- The 286 impacted predictions were not checked one by one against their genres.
