# AIR-43 shadow rollout

Controlled comparison of the legacy resolver and the scored resolver. This record is the preflight. `SCORED_RESOLUTION` was not set, no resolver chunk was run, and `on` was not enabled.

Related: [AIR-43](https://trello.com/c/7NY6n1Az), [AIR-42](https://trello.com/c/drLBuWjl), [AIR-48](https://trello.com/c/rVf8rRoJ), [AIR-49](https://trello.com/c/YNaLFwtW), [AIR-65](https://trello.com/c/MKb4JMXi). Prerequisites: [PR 45](https://github.com/vladimino/iptv-watchlist/pull/45), [PR 47](https://github.com/vladimino/iptv-watchlist/pull/47). Deploy run: [CI/CD 39870651210](https://github.com/vladimino/iptv-watchlist/actions/runs/39870651210).

## 1. What is deployed

Checked 2026-10-22 23:25 UTC.

| Item | Value |
| --- | --- |
| `origin/main` | `203727b5c59a6a315bfd3e86cbbbf1bcb9819c81` |
| PR 47 | Merged 2026-10-22 23:16:03 UTC. Pull-request checks ran Test and build only. Deploy is skipped on pull requests and runs on the push to `main`. |
| Push workflow | [39870651210](https://github.com/vladimino/iptv-watchlist/actions/runs/39870651210). Test and build succeeded. Deploy to Cloudflare succeeded. |
| Worker deployment | `6be9a444-099f-47b5-9ee5-6f7ee6310ef9`, created 2026-10-22 23:17:27 UTC, source `wrangler`, message `Compare shadow on the same TMDB evidence as legacy (#47)`, 100% on version `1e95cc8d-93ee-4b23-bbea-a9c321b139d9`. |
| Compatibility | `2026-10-18`, standard usage, `cpu_ms` 120000. Schedules: none. |

`SCORED_RESOLUTION` is absent. `scoredResolutionMode` therefore returns `off`. The plain-text binding `LIFECYCLE_LOCALIZATION` is `on:programme,on:watchlist,on:epg`. That value was read, not changed. `BUCKET` is present. The TMDB token binding is present and its value was not read. `keep_vars` is true in `wrangler.jsonc`, so a later code deploy does not add or remove this variable.

Rollback, once the variable exists, is deleting that plain-text binding or setting its text to anything other than `shadow` or `on`. Both are `off`. No code change is required. This session could not perform that write: the Cloudflare API token can read Worker settings and returned HTTP 403 on `PATCH /accounts/…/workers/scripts/iptv/settings`. The accepted scopes for that write are Workers Admin, Workers Editor, or Workers Scripts Write. Local Wrangler is not logged in.

## 2. Invariants in the deployed code

Read from `203727b`, `src/discovery.js`. These are code facts. They were not observed on a live shadow run.

- `shadow` is the legacy branch. It still writes the legacy decision and the catalog. It does not replace that decision with a scored one.
- Scorer candidates and competitors are copied before `indexFilm` runs for that candidate. A film inserted by the same legacy write is not a pre-existing alias. The preview field is `knownBefore`.
- Search hits legacy already fetched are included in that score. The gate reuses legacy's movie card when the accepted id is that card.
- A shadow-only card is requested after the legacy candidates of the chunk, through `tmdbRequest` rather than the counter behind the 16-call legacy cap. A 429 is swallowed. The chunk error and the candidate attempt counter stay unchanged.
- That extra request is skipped when fewer than 12 seconds remain before the 22-second chunk deadline. The row stays `detail_not_compared`.
- `detail_not_compared` is only the label for an accepted score that never received a card. It is not `legacy_only`.
- The preview stores `programmeRunId`. `scorePreviewSummary` drops a preview whose run id is not the pinned generation, so a stale preview is not a current count.
- A published-generation mismatch still refuses the catalog write. Shadow does not add its own catalog write.

## 3. Baseline, before any flag change

Published generation `2e63530d-27f6-43cc-85dd-f5a2c9c97e16`, phase `published`, discovery ledger `updatedAt` 2026-10-22 15:01:30 UTC. The staged discovery ledger was the one read. Raw candidates 23079. Filtered non-movies 3200. Ledger rows 48777.

`epg/discovery-score-preview.json` does not exist.

`epg/discovery-status.json` is the previous generation, `5811dc50-2072-41f5-97ee-5ca66470df78`, finished 2026-10-20 20:37:42 UTC: stage `partial`, checked 7, TMDB calls 14, added 3, remaining 38921, hot remaining 17643, error null. It is not the status of the published generation.

`epg/resolver-continuation.json` at 2026-10-22 15:02:44 UTC: stage `paused`, reason `epg_committed`, `remainingChunks` 12, `retryAt` null, `programmeRunId` null. The new generation was committed and the resolver has not taken that queue.

Decision histogram on the published ledger:

| Status | Rows |
| --- | ---: |
| no decision | 40207 |
| `excluded_nonfilm` | 4769 |
| `verified` | 3132 |
| `no_confident_match` | 609 |
| `ambiguous` | 39 |
| `duration_mismatch` | 21 |

Shape of the same ledger, not of the actionable subset: year present 13219, year absent 35558, short title 6393, longer title 42384, `seenInLatestSnapshot` 19507, more than one stored duration 9901, 5893 normalized titles shared by more than one row. Rows already `verified` are not actionable. The current-window subset was not counted here, because that filter is `resolutionActionability` and it was not executed.

The designed limited run is the paused continuation: 12 chunks, each at most 24 candidates and 16 legacy TMDB calls, hot and dated rows first. That order is a selection bias. It will not by itself be a stratified sample of remakes, short titles, and contradictory runtimes.

## 4. Comparison

No shadow run was started. There are no comparison counts.

| Comparison | Count |
| --- | ---: |
| `agree_verified` | not collected |
| `legacy_only` | not collected |
| `scored_only` | not collected |
| `agree_unresolved` | not collected |
| `different_id` | not collected |
| `detail_not_compared` | not collected |

No discrepancy table. No extra TMDB calls. No 429 from this attempt. Legacy decisions were not rewritten by a shadow pass, because the pass did not run.

## 5. Recommendation

**INSUFFICIENT DATA.** This is not a GO and not a NO-GO on the resolver. `on` stays unset.

Next step, with a token that can patch Worker settings:

1. Add one plain-text binding, `SCORED_RESOLUTION` = `shadow`. Resend the existing plain-text bindings and the R2 binding unchanged. Keep the TMDB secret by inheritance, not by reading it. Do not change `LIFECYCLE_LOCALIZATION`, schedules, routes, or compatibility.
2. Read the binding back. It must be the string `shadow`. Then `GET /api/enrichment/pipeline/status` must report `scoringPreview.cutover` `shadow`. That route only reads.
3. Run the already paused continuation, 12 chunks, through `POST /api/enrichment/discovery/resolve` or the MCP discovery step. Do not start an EPG sync and do not start predictions.
4. Read `scoringPreview.comparison` for generation `2e63530d-27f6-43cc-85dd-f5a2c9c97e16` only. Review every `legacy_only`, `scored_only`, and `different_id` before any cutover proposal.
5. Roll back by deleting `SCORED_RESOLUTION` or setting it to `off`.

Until that sample exists, AIR-43 is not ready for cutover.
