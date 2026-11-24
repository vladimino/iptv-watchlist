# AIR-588: offline cost of a Task `batch_start` before and after A1, A2 and C, 24 Nov 2026

**Card:** [AIR-588](https://trello.com/c/vyxbU1l0). **Capture:** 24 Nov 2026, offline only. **Scope:** the implementation of options A1, A2 and C approved by the owner ([GO](https://trello.com/c/vyxbU1l0#comment-6b04c96acb544ab06006a57d)); decisions in [ADR 0204](../../adr/0204-prediction-ordering-drift-leaves-the-start.md) and [ADR 0205](../../adr/0205-batch-start-compact-ready-envelope.md); the problem in the [RCA](air-588-predictions-stop-rca-2026-11-23.md). **No production call, Task, lease, flag or data operation** was made; nothing here is a production latency.

## Method

`scripts/prediction-start-bench.mjs` imports the **built** Worker bundle (`dist/server/index.js`, every module the deployed Worker carries) and runs it over a sqlite D1 stand-in migrated through the whole chain (schema 37) and an in-memory R2, seeded by the local-dev fixture store (`scripts/local-d1.mjs`: every domain marker as in production, a published generation) widened to a synthetic catalog of 40 films without predictions, half airing in the hot window. It rebuilds the queue, then times one labelled Task start (`taskId: task00`, `trigger: scheduled`) and reads the Worker's own `prediction_step_timing` line, the instrumentation production logs. `--drift` adds one Discovery-assigned show to the published generation after the rebuild (a changed assigned-shows signature of the same generation, the AIR-529 case seen on most production starts); `--compact` sends `answer: envelope`.

- **Before:** `main` at `e04413e` (the RCA merge, no AIR-588 code). **After:** the AIR-588 implementation branch.
- `model` multiplies the counts by the mean per-call times of one production start (23 Nov 2026 20:35 UTC, `c8ab0cd9`: 126.7 s over 486 D1 calls, 38.4 s over 91 R2 calls). It ignores overlap and catalog size and is a **model, not a measurement**.
- The fixture catalog is small: a production queue rebuild reads thousands of films (188 D1 calls in `queue_refresh` on 23 Nov against 51 here), and production manifests are about three times larger (S7 42.6–44.2 KB against 13.8 KB here). Absolute counts are offline; the differences are what this page measures.

Reproduce: `npm run build && node scripts/prediction-start-bench.mjs --manifest 7 --drift [--compact] --json`.

## Results

| Scenario | D1 calls before → after | R2 calls | Runner-lease R2 mirror PUTs | Schema probes (`sqlite_master` + `schema_contract`) | Queue refresh rounds | Answer bytes | `model` |
| --- | --- | --- | --- | --- | --- | --- | --- |
| S5, current queue | 164 → 123 | 42 → 35 | 13 → 6 | 36 → 8 | 0 → 0 | 12,897 | 60.5 → 46.8 s |
| S5, ordering drift | 243 → 123 | 49 → 35 | 14 → 6 | 56 → 8 | 1 → 0 | 12,892 → 12,897 | 84.0 → 46.8 s |
| S7, current queue | 172 → 131 | 42 → 35 | 13 → 6 | 36 → 8 | 0 → 0 | 13,860 | 62.5 → 48.9 s |
| **S7, ordering drift** | **259 → 131** | **49 → 35** | **14 → 6** | **56 → 8** | **1 → 0** | 13,855 → 13,860 | **88.2 → 48.9 s** |
| S7, ordering drift, `answer: envelope` | 259 → 131 | 49 → 35 | 14 → 6 | 56 → 8 | 1 → 0 | 13,855 → **1,280** | 88.2 → 48.9 s |
| S10, current queue | 184 → 143 | 42 → 35 | 13 → 6 | 36 → 8 | 0 → 0 | 15,357 | 65.7 → 52.0 s |
| S10, ordering drift | 283 → 143 | 49 → 35 | 14 → 6 | 56 → 8 | 1 → 0 | 15,352 → 15,357 | 94.4 → 52.0 s |

Stages of the S7 start with ordering drift, D1 / R2 calls: before `preflight` 35/3, `queue_refresh` 51/3, `preflight_refreshed` 34/3, `preflight_lease` 35/3, `persist` 79/30; after `preflight` 29/3, `preflight_lease` 28/3, `persist` 55/25 (no `queue_refresh`, no `preflight_refreshed`).

- **A1** (request-scoped schema probes, claim and gate checks by read): about 41 D1 and 7 R2 calls fewer per start, 7 fewer lease writes and mirror PUTs, 28 to 48 fewer schema probes.
- **A2** (ordering drift deferred to the hourly writer): the refresh and the second preflight are gone from the start (about 85 D1 and 6 R2 calls here, 188 + 46 D1 calls in the production start of 23 Nov).
- **C** (compact envelope): the start's answer drops from 13.9 KB to 1.3 KB here; the envelope does not grow with the films' metadata (`tests/prediction-air-588-envelope.mjs` section 6). The part reads it requires are the existing `prediction_batch_manifest` reads (9 for S7).
- Envelope of the fixture S7 run: 1,272–1,280 B; manifest 12.2–13.8 KB; largest film part 409 B. Production film parts are larger (production S7 manifests were 42.6–44.2 KB in total).

## Limits

- Offline, small catalog, sqlite stand-in: no claim of production wall time. The production target of the GO (start 30–50 s, below 60 s) is judged only by the `prediction_step_timing` lines of natural starts after deploy, compared per deploy and `manifestFilms`.
- A start on a current queue in production (no refresh) took 53–72 s for S7 on 23 Nov; A1 removes the repeated probes and lease writes from it, A2 removes nothing more there.
- Whether the faster start and the envelope restore the client's delivery is not established ([RCA](air-588-predictions-stop-rca-2026-11-23.md)); the recovery criterion is natural submits and durable commits.

## Tests on the same change

`tests/prediction-air-588-request-reuse.mjs` (A1), `tests/prediction-air-588-ordering.mjs` and the updated `tests/prediction-hot-reconcile-same-generation.mjs` (A2), `tests/prediction-air-588-envelope.mjs` (C), `tests/scheduled-task-air-588-envelope-candidates.mjs` (prepared prompts), with the existing keyed, task-label, deferred, budget and dry-run suites.
