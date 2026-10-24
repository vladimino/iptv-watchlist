# AIR-100 rollout and rollback

> Historical sample. See [evidence registry](../README.md) for context and later decisions. This text is not a current operational authorization.

This is the runbook for [AIR-68](https://trello.com/c/qbLDc6Ql). **It is not a cutover.** AIR-100 does not set `SCORED_RESOLUTION=on` and does not write production. The flag change, the one resolver chunk, and the rollback are AIR-68 actions and need a separate owner approval. [AIR-69](https://trello.com/c/FlcWZX7W) still watches two ordinary EPG generations after that window. Evidence is [AIR-99](https://trello.com/c/SHbYQwll) and [PR #70](https://github.com/vladimino/iptv-watchlist/pull/70).

## What AIR-99 already measured

Five detail calls, all HTTP 200, all `detail_verified`: 36647, 161, 395, 163, 603. No false verified in those five. The ledger had 49715 rows. `readyNow` was 15036, and 14896 of them had no catalog title. Those 14896 were not searched. That is not a false-id rate and not a recall rate. A yearless short title already stored as `known_epg_alias`, `11 14|`, would be `ambiguous_short_title_without_year` if the scorer ran. That is a gate difference, not a proven wrong id.

## Cheap pass

The cheap pass is not a scored-path defect. In `resolveDiscoveryChunk` it runs before `scoredResolutionMode` is read. A candidate with `confirmedTmdbId` and no decision becomes `verified` / `known_epg_alias` under `off`, `shadow`, and `on`. `resolutionActionability` then drops every `verified` row, so the scored loop never reopens it. `11 14|` already has that decision. Turning `on` does not rescore it, does not clear it, and does not call TMDB for it.

A new `confirmedTmdbId` with no decision still takes the same legacy write under `on`, and still makes no TMDB call. AIR-99 found zero such rows. The next EPG publish can create one. That write is the existing path, not a new identity invented by the scorer. `tests/air-100-rollout.mjs` pins both cases. The local test also keeps a reviewed catalog title.

`known_alias_year_runtime` is the other legacy shortcut. It is inside the `mode!=='on'` branch. Under `on` an unresolved row does not take it. The existing Dune test in `tests/scored-discovery.mjs` already requires `on` to withhold `verified` until `detail_verified`.

Do not delete cheap-pass rows during the window or the rollback. Do not treat the scorer disagreement as a wrong id without a separate look at that one stored id.

## Baseline

Read on 2026-10-24 after PR #70 and PR #71. No setting was changed.

| Item | Value |
| --- | --- |
| `origin/main` | `4823139` |
| Worker deploy | `0b8a0a39-fd18-4fc2-a7e2-e0c41783e771`, source `wrangler`, 2026-10-24T09:28:04Z, message `PR #71: Add read-only MCP diagnostics for the prediction queue` |
| `SCORED_RESOLUTION` | `shadow` |
| `CANDIDATE_DISCOVERY` | unset |
| `LIFECYCLE_LOCALIZATION` | `on:programme,on:watchlist,on:epg` |
| Schedules | 0 |
| Published generation | `cf3ba3ac-f962-4475-b9cd-3de1b07bd1eb`, phase `published` |
| Last resolver status | `partial` at 2026-10-23T15:56:59Z, same generation, `retryAt` null, `error` null |

`wrangler.jsonc` does not contain `SCORED_RESOLUTION`. `keep_vars` is true. A settings change does not change the script, and a later code deploy does not remove the dashboard binding. The flag is global. It is not a per-film canary.

AIR-68 repeats this read before the switch. Stop if the generation id changed, a schedule exists, `CANDIDATE_DISCOVERY` is set, or `epg/resolver-lease.json` has `expiresAt` in the future.

## What the first window turns on

Only `SCORED_RESOLUTION=on`. `CANDIDATE_DISCOVERY` stays unset. With discovery unset, `on` scores catalog titles and one exact-title search. It does not run part, spelling, or numeral variants. Those five AIR-99 films are already checked. They are not a reason to turn discovery on in the same window. Variant search of the 14896 rows stays out of this approval.

The code already bounds one chunk: 24 candidates, stop at 16 TMDB calls, 22 second deadline. A 429 sets `retryAt` and stops the chunk. Only `detail_verified` inserts a catalog film or attaches a showing. `needs_verification` and `candidate_decision` write a decision, not a film.

## AIR-68 sequence

Do this only after the owner approval below. Schedules stay 0. Nothing else starts the resolver.

1. Read the baseline again. Record generation, flags, schedule count, lease expiry, and the current `added` on `epg/discovery-status.json`.
2. In the Worker settings, set only `SCORED_RESOLUTION` to `on`. Leave `CANDIDATE_DISCOVERY` absent. Leave lifecycle text unchanged. Save. A settings deploy does not change the script.
3. Read the settings back. Continue only if the value is exactly `on`, discovery is still absent, lifecycle text is unchanged, and schedules are still 0.
4. Call `POST /api/enrichment/discovery/resolve` once. Do not call it again in this step. Do not start EPG sync or the prediction runner.
5. Read `epg/discovery-status.json` and `epg/discovery-score-preview.json`. List decisions whose `identitySource` is `tmdb_detail` and whose `checkedAt` is at or after the status `startedAt`. That list is the spot check. It is the new scored writes, not the 14896.
6. Stop the window unless every row in that list has a title, year, and runtime the owner accepts, `added` is at most 8, `error` is null, `stage` is not `programme_changed`, and the generation id is unchanged. A clean chunk with zero `detail_verified` is a successful first look, not a failure.
7. A second chunk needs the same check again. It is not automatic. AIR-69 is still the two-generation watch after the window, not a substitute for this spot check.

## Stop

Stop and roll back before another chunk if any of these are true:

- HTTP 429 or a non-null status `retryAt` or `error`
- `stage` is `programme_changed`, or the published generation id changed
- `added` for the chunk is greater than 8
- any spot-checked `detail_verified` is a different film from the broadcast
- `CANDIDATE_DISCOVERY` is present, or a schedule is present
- the lease is still held after the chunk returns

One rejected id stops the window. It does not authorize a bulk delete.

## Rollback

Rollback is a settings change back to the previous value. Set `SCORED_RESOLUTION` to `shadow`. Do not unset it in this procedure: `shadow` is the state this runbook started from, and it keeps the legacy writer plus the non-writing preview. Read the settings back.

Do not delete or rewrite these objects: `epg/discovery-resolution.json`, `epg/discovered-films.json`, `programme.json`, `epg/generations/<id>/programme.json`, `titles.json`, `enrichment/view-index.json`, the prediction queue, or stored predictions. A scored decision and a catalog film written during the window stay. Reviewed titles stay because a watchlist attach copies the existing programme title and the catalog update keeps the stored title fields it does not replace. Shows already on a film stay. `refreshPredictionQueue` rebuilds the pending list from missing predictions; it does not delete a stored prediction.

After the read-back, confirm one known reviewed title is unchanged, one pre-window `verified` decision is unchanged, and the generation id is unchanged. Then stop. Repair of a single bad id is a separate edit, not part of the flag rollback.

## Owner approval

This packet does not turn the flag on. Approving it authorizes AIR-68 to execute the sequence above once.

Approve the first window if you accept all of the following:

- `SCORED_RESOLUTION` goes from `shadow` to `on` globally. `CANDIDATE_DISCOVERY` stays unset. Schedules stay 0.
- The 14896 rows without a catalog title are not pre-checked. The first chunk reveals the real search, detail, and decision counts, and then it stops.
- The cheap pass stays. Existing `known_epg_alias` rows, including `11 14|`, are left as stored. That disagreement is not treated as a proven wrong id.
- New `detail_verified` rows are spot-checked one by one. More than 8 new catalog films, a 429, a generation change, or one rejected id stops the window.
- Rollback sets `shadow` again and does not delete decisions, catalog films, reviewed titles, shows, or predictions.
- AIR-69 still has to watch two ordinary EPG generations. This window does not replace it.

Prerequisites: [AIR-99](https://trello.com/c/SHbYQwll), [PR #70](https://github.com/vladimino/iptv-watchlist/pull/70), [AIR-68](https://trello.com/c/qbLDc6Ql), [AIR-69](https://trello.com/c/FlcWZX7W). Production impact of this document is none. Production impact of an approved AIR-68 window is one resolver chunk, bounded TMDB calls, and scored writes only after `detail_verified`.
