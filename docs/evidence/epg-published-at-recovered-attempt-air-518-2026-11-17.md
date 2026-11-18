# EPG publication date after a recovered seal attempt (AIR-518)

**Captured:** 2026-11-17 (revised the same day after the independent review of PR #730: binding made mandatory, legacy fallback narrowed). **Scope:** code reading and offline fixture tests (`tests/epg-published-at.mjs`, `tests/status-footer.mjs`, `tests/status-footer-ui.mjs`). No production read or write was made for this report; the production facts below are the ones recorded on the [AIR-518 card](https://trello.com/c/9TuQIIud).

## Symptom (from the card)

The routine EPG run of 16 November 2026 (`runId` `47663279-3e6b-423d-b696-b22edfcead91`) finished at 19:17 UTC with `stage: complete`, Cloudflare EPG Workflow `phase: done`, and its generation is the published D1 generation. The header «Обновлено», the badge «Данные устарели» and the footer EPG line still showed the previous publication, and the footer EPG health was `failed`.

## Root cause (code)

1. `sealFinalizeStep` runs after the `publish` phase has moved the pointer. Its `finalize_scan` unit can throw `rated_admission_incomplete` (`persistScan`, `src/worker.js`).
2. The seal branch of the step route catches the error and stores `run.error` on `sync.json`.
3. The retry of the same run completes `finalize` and `queue`; `sealQueueStep` writes `stage: complete`, `completedAt`, `updatedAt = completedAt`, but does not delete `error`.
4. `epgUxPublishedAt` accepted a complete record only with no `error`, so it returned the carried `lastEpgPublishedAt` of the previous run; `integrationHealth` classified any `error` as `failed`. `public/app.js` measured the 36-hour age from that old `publishedAt`.

## Fix (read side only)

`epgPublicationState(sync, report)` in `src/enrichment.js` is the one read model for `GET /api/programme` `publishedAt`, the header, the badge, the compact and detailed footer EPG line, the EPG integration health and the next run's carried `lastEpgPublishedAt`. A complete record is the receipt of the published generation when it has a valid `completedAt` (written only at durable completion; the legacy `updatedAt` fallback applies only when the field is absent) and both its `runId` and the pinned published programme's `runId` are present and equal. The start's carried `lastEpgPublishedAt` uses a separate unbound helper, `epgCarriedPublishedAt`. A kept error then becomes `attempt.outcome: recovered`, shown as `lastAttempt` on the EPG entry. The writer, `sync.json`, D1 and R2 are unchanged.

## Offline results

| Case | `publishedAt` / `lastSuccessAt` | EPG state |
| --- | --- | --- |
| complete + `completedAt` + kept `rated_admission_incomplete`, same runId as the published programme | completion of this run (16 Nov 20:17 Europe/Madrid) | `healthy`, `lastAttempt.outcome: recovered`, `lastFailureAt: null` |
| same, 37 h / 49 h later | unchanged | `healthy` (48 h integration threshold) / `stale`; header «Данные устарели» from 36 h |
| failure before the pointer switch (`stage: seal`, error) | previous completion | `failed`, `lastFailureAt` = attempt time |
| seal in flight, no error | previous completion | `running` |
| complete record of another run than the published programme (stale mirror, other generation) | previous completion | `unknown` / `epg_unproven` |
| recovered record, published programme unreadable | previous completion | `unknown` / `epg_unproven` |
| clean complete record, published programme unreadable | previous completion | `unknown` / `epg_unproven` |
| no `sync.runId`, or a published programme without `runId` | previous completion | `unknown` / `epg_unproven` |
| malformed or `null` `completedAt` beside a valid `updatedAt` | previous completion | `unknown` / `epg_unproven` |
| pre-AIR-390 record (no `completedAt` field), same runId | its complete `updatedAt` | `healthy` |
| error and no completion receipt, or an invalid `completedAt` | previous completion | not a success |
| feed ended, publication fresh | — | header «Будущей программы нет», not «Данные устарели» |

Madrid display was checked across the 25 October 2026 DST change. Reads never rewrite `sync.json`; the GET audits (`tests/get-write-audit.mjs`, `tests/get-side-effects.mjs`) pass.

**Verdict:** GO for the read-model correction. Not production evidence; acceptance on production is a read-only check after deploy.

## Not changed

The kept `error` is still written by the seal step and not cleared on completion; `src/epg-orchestration.js` `drive` and `doneToday` still read `!run.error`. Those are writer and orchestration paths outside this card.
