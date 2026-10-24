# AIR-84 shadow sample

> Historical sample. See [evidence registry](../README.md) for context and later decisions. This text is not a current operational authorization.

**INSUFFICIENT DATA.** Do not set `SCORED_RESOLUTION=on` or `CANDIDATE_DISCOVERY=on`. Do not start [AIR-68](https://trello.com/c/qbLDc6Ql).

This is the production check after [AIR-83](https://trello.com/c/3wmMNyWo). It is not a new search and not a cutover. The AIR-66, AIR-67, and AIR-81 counts stay separate. Do not add these rows to them.

## 1. What was measured

Live code includes `0eb32ef` (PR 57). The Worker deploy before the flag change was `89aced6d-922f-4baf-ae8e-c7a5fd0d6179`, source `wrangler`, 2026-10-23T15:45:31Z, message PR 59. That deploy is after `0eb32ef`. `SCORED_RESOLUTION` was already `shadow`. `CANDIDATE_DISCOVERY` was absent. Schedules were 0.

The published generation was `cf3ba3ac-f962-4475-b9cd-3de1b07bd1eb`, phase `published`, updated 2026-10-23T15:02:58Z. Continuation was paused on `epg_committed` with 12 chunks left, from 2026-10-23T15:04:29Z. The resolver lease was not active. No variant-pending file existed. This run did not start an EPG sync or the prediction runner.

The approved window set only `CANDIDATE_DISCOVERY=shadow`. Dashboard deploy `caeb984a-f191-43d0-bdf2-9133be333525` at 2026-10-23T15:53:39Z. A settings deploy does not change the script. The read-back was exactly `shadow`, and `SCORED_RESOLUTION` stayed `shadow`.

Three `POST /api/enrichment/discovery/resolve` calls followed. The cap for this card is four. The run stopped after the stored plans had been sent. Each preview below was read before the next chunk replaced it. The last preview is chunk 3 only and is not the total.

| Chunk | Wall | Checked | Legacy `tmdbCalls` | Added | `variantCalls` | `variantSkipped` | `variantDeferred` | `variantPending` | Error |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 1 | 31047 ms | 58 | 11 | 4 | 0 | 2 | 1 | 1 | null |
| 2 | 33456 ms | 7 | 14 | 4 | 2 | 6 | 3 | 3 | null |
| 3 | 33047 ms | 5 | 10 | 5 | 6 | 0 | 0 | 0 | null |

All three stayed on `cf3ba3ac-f962-4475-b9cd-3de1b07bd1eb`. No retry, no 429. After chunk 3 the continuation had 9 chunks left and `nextAction` `continue`, because ordinary unresolved rows remain. Worker cron is empty, so nothing resumes it.

`variantCalls` is outside `tmdbCalls`. The eight variant calls are the extra search. Chunk 1 stored `maroon 5 live the town|2023` and did not send it. Chunk 2 sent that plan (`variantCalls` 2) and stored three more. Chunk 3 sent those three (`variantCalls` 6) and left the pending file empty. A plan that missed the deadline was executed by the next permitted chunk.

Scored preview rows, deduped by observation key. None repeat across the three snapshots.

| Comparison | Rows |
| --- | ---: |
| `agree_verified` | 13 |
| `agree_unresolved` | 5 |
| `legacy_only` | 0 |
| `scored_only` | 0 |
| `different_id` | 0 |
| `detail_not_compared` | 0 |
| rows with `proposedCandidates` | 0 |

The thirteen agreements were already the legacy `verified` write. Legacy inserted thirteen catalog films. No catalog id came from a variant proposal. The four titles that the extra search actually queried stayed `no_confident_match` with no TMDB id and `attempts` 1:

- `maroon 5 live the town|2023`
- `айдар гараев о шоу плохие песни проблемах квн и современных артистах музloft 3|2021`
- `отт бь ч|2006`
- `из нее сделали пельмени или мать сама ее продала тайна исчезновения алены имамовой тюменский маньяк|2024`

Those queries are the original title one year either side. None of them is a spelling change, a spelled-out number, or a dropped part suffix. None produced a proposal, so there was no movie-detail check of a variant hit and no false id to audit.

After the third chunk the flag was removed. Dashboard deploy `7884c1f5-5fb6-49b7-be29-d14411a6b1b6` at 2026-10-23T15:58:17Z. The read-back has no `CANDIDATE_DISCOVERY`. `SCORED_RESOLUTION` is still `shadow`. Schedules are still 0.

## 2. What this sample cannot say

The named misses are still in the new generation and still behind `retryAt`. They were not selected, and this run did not clear or wait out that backoff. They stay fixture-only:

| Observation | Stored state |
| --- | --- |
| `блейд 1\|1998` | `no_confident_match`, retry still ahead |
| `11 друзей оушена\|2001` | `no_confident_match`, retry still ahead |
| `ирония судьбы или с легким паром\|1975` | `no_confident_match`, retry still ahead |
| `мортал комбат\|1995` | `no_confident_match`, retry still ahead |
| `чудо женщина\|2020` | `no_confident_match`, retry still ahead |
| `гол 2\|2008` | `no_confident_match`, retry still ahead |
| `чужой против хищника 1\|2004` | `no_confident_match`, retry still ahead |

`чудо женщина|2017` and `блэйд|1998` are already `verified`. A verified row is not re-scored. Chunk 1 checked 58 rows and spent 11 legacy lookups, so most of that chunk never reached the scorer. This sample does not separate a yearless cheap-pass collision from the scorer.

There is no live recall delta against AIR-81. Eight real variant calls on titles that are not the diagnostic films, and zero proposals, do not show that a spelling, numeral, or neighbouring-year title would be found or refused.

## 3. Decision

**INSUFFICIENT DATA for [AIR-68](https://trello.com/c/qbLDc6Ql).**

The AIR-83 schedule did what it was built to do: one plan waited, the next chunk sent it, and the continuation did not call that wait a finished queue. The searches that ran did not propose an id and did not write the catalog. The classes that would justify a cutover were not in the window. Another twelve chunks of the same hot queue would keep writing legacy decisions and would still not select the rows whose `retryAt` has not arrived.

`SCORED_RESOLUTION` stays `shadow`. `CANDIDATE_DISCOVERY` is unset again. A later sample needs its own approval before the flag is set. No catalog or decision rewrite is required.
