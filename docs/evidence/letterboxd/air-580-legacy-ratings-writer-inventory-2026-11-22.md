# AIR-580: legacy Ratings writer retirement, offline inventory and removal map, 22 November 2026

[AIR-580](https://trello.com/c/w0rsARMP) · 22 November 2026 · phase 1 only: read-only source inventory on `main` `cc80af1`, no code change, no production read or write by this session.

**Gate:** this documentation-only inventory may be merged after independent review and CI. The later retirement **code and config** (removing the `ensure` call, the Workflow body, routes or the `wrangler.jsonc` binding) may not be merged or deployed before [AIR-571](https://trello.com/c/b6UrtwUG) is `Готово` and complete (F1, F2, four natural slots, owner acceptance). Physical removal of the Cloudflare `iptv-ratings` registration or the `RATINGS_WORKFLOW` binding needs a second, separate owner L3 GO on the exact resources.

## Not verified by this session

- Live Worker, D1 and Cloudflare state. The production facts (`RatingsOrchestration` mode `external`, epoch 2; `LetterboxdSync` `cloudflare`, epoch 1; Watchlist `d1/open/3`; four crons; the `iptv-ratings` Workflow with 8 completed instances) are quoted from the card handoff of 22 November 2026, 20:15 Madrid, not re-read here.
- ChatGPT Scheduled Task registry (no read access from this session).

## Scheduled `ensure` call: still executed, but inert

The card lists "the obsolete 17:00 `ensure` on the shared hourly cron" as a cleanup candidate, and that is accurate. At `cc80af1` the shared hourly `scheduled` handler still runs `RatingsOrchestration.ensure(env,{now:Date.now()})` at `src/worker.js:2740`, inside one `Promise.allSettled` together with the Discovery reconcile, `EpgOrchestration.ensure` and `Monitor.run`, behind the discovery head-start. The comment at `src/worker.js:2732` describes it ("with the executor mode external it reads one document and returns"). Cron `:30` separately calls `LetterboxdSync.ensure` (`src/worker.js:2738`).

The safe state today is therefore: a scheduled `ensure` call still happens every hour, but it is fenced. While the Ratings mode row is `external` it reads the mode document and returns `reason: 'external'` without creating an `iptv-ratings` instance (`src/ratings-orchestration.js`, `ensure`), and the new Letterboxd owner has taken over. Retiring it needs an explicit edit of `src/worker.js:2740` that keeps the other three consumers in the same `allSettled`; only then can the Ratings-only `ensure`/`run` implementation be removed.

*Correction note:* an earlier revision of this file (HEAD `82235f4`) stated that `ensure` had no caller in `src/`. That was wrong: a width-truncated grep hid the call on line 2740. The independent review of PR 919 found it.

## Classification

`KEEP` = a live dependency of the new writer, the monitor or rollback safety. `CODE-RETIRE` = confirmed unreachable or superseded, removable in a code PR after the AIR-571 gate. `OWNER-DECISION` = removal weakens a safety or rollback property. `L3` = a live Cloudflare resource, never touched by a code PR alone.

| # | Symbol / route | Where | Consumers found | Class | Note |
| --- | --- | --- | --- | --- | --- |
| 1 | `RatingsOrchestration.ensure` and its scheduled call | `src/ratings-orchestration.js` (`ensure`); call site `src/worker.js:2740` (comment `:2732`) in the shared hourly `Promise.allSettled` with Discovery reconcile, `EpgOrchestration.ensure`, `Monitor.run` | the hourly tick; `tests/ratings-orchestration.mjs`, `tests/cron-schedule-simulation.mjs` | CODE-RETIRE | Only path that creates `iptv-ratings` instances. Still called every hour but inert while the mode is `external` (reads one document, returns). Retire by editing line 2740 and keeping the other `allSettled` members and the shared `:00` cron, then remove the implementation. |
| 2 | `RatingsOrchestration.run/act/admit/drive/stopInstance`, `runRatingsWorkflow` | `src/ratings-orchestration.js:426`, `build.mjs:43` | the `RatingsWorkflow` class that `build.mjs:43` emits into `workflow-entry.js` (imports `runRatingsWorkflow`, `run()` calls it) | CODE-RETIRE, **second slice** | Workflow body. It is wired to the live `RATINGS_WORKFLOW` binding and the exported class, so it must be removed together with the class, `build.mjs` and the binding decision (item 12), never in a no-config-change PR: removing only the function would leave an exported Workflow pointing at a missing implementation (invalid bundle). A staged stub would need its own build and runtime tests and owner approval. |
| 3 | `RATINGS_SCHEDULE` and the default `schedule` of `dailyDue` / `nextDailyDue` | `src/domain/orchestration-policy.js:7,67,74` | `dailyDue` is also used by `epg-orchestration.js:723,972` and `monitor-policy.js` (EPG schedule passed explicitly) | KEEP for now; CODE-RETIRE only after item 9 is decided | `RatingsOrchestration.readModel` (`src/ratings-orchestration.js:407`) calls `policy().dailyDue(now)` without a schedule, and `Monitor.ratingsFacts` and `LetterboxdRatings.status` use that reader (items 9-10). Deleting the constant or making `schedule` required would break them. Keep the constant and default until those readers are migrated or retired, with the exact explicit schedule or replacement read model and regression tests specified first. |
| 4 | `/api/letterboxd/ratings/start`, `/step` (POST) | `src/worker.js:2776` via `LetterboxdRatings.handle` | MCP `ratings_sync_start/step`, `tests/ratings-api.mjs` | OWNER-DECISION | After handover both answer `external_writer_fenced` (0 writes). Prefer a typed `410` compatibility answer over deleting the route; owner chooses. Also a registered write route in `tests/get-write-baseline.mjs` (`MCP_WRITE_TOOLS`). |
| 5 | MCP `ratings_sync_start`, `ratings_sync_step` | `src/mcp.js:49,50,316` | scheduled-task prompts under `docs/reference/scheduled-task-prompts/` mention them historically | OWNER-DECISION | Same choice as item 4. MCP tool list is a published contract (`docs/reference/api/mcp.md`). |
| 6 | `/api/letterboxd/ratings/executor` (POST, mode switch / `clear_quarantine`) | `src/worker.js:2775` → `RatingsOrchestration.handle` | the owner mode switch; `letterboxdHandover` | OWNER-DECISION | This is the owner-only reverse-handover entry. Removing it removes the documented rollback to the old writer. |
| 7 | `letterboxdHandover`, `letterboxdHandoverFacts`, `letterboxdHandoverGuards` | `src/worker.js` ~2645-2700 | `LetterboxdSync` mode switch (D2/E activation and any later reversal) | KEEP (until owner decides item 6) | They call `RatingsOrchestration.readMode/drainState/externalGate`; they cannot go while the Letterboxd mode switch can still run. |
| 8 | `RatingsOrchestration.readMode`, `drainState`, `externalGate`, `MODE_KEY`, `CONTROL_KEY` | `src/ratings-orchestration.js` | item 7; `LetterboxdRatings` fence (`src/letterboxd-ratings.js:553`) | KEEP | The `external` mode row plus the gate is what fences the legacy entry points. |
| 9 | `RatingsOrchestration.readModel` | `src/ratings-orchestration.js`; `src/monitor.js:49-52`; `src/letterboxd-ratings.js:524` | monitor `ratings` stream, `ratings_sync_status` | OWNER-DECISION | Monitor still evaluates a Ratings stream built from it. Retiring requires a monitor-policy change (the Letterboxd stream already exists) and a `docs/reference` update. |
| 10 | `ratings_sync_status`, `/api/letterboxd/ratings/status` | `src/mcp.js:48,315`, `src/worker.js:2767` | operators, monitor | KEEP | Read-only diagnostics; required by the card. |
| 11 | `LetterboxdRatings` engine (`src/letterboxd-ratings.js`), `src/letterboxd-sync-ratings.js`, `src/ratings-d1.js`, Diary parser, removal phase, Events | whole files | the new `src/letterboxd-sync.js` phase ports | KEEP | Not legacy. `ratingsFence` / `fencedEnv` in `src/letterboxd-sync.js:70` is the new writer's epoch guard. |
| 12 | `RATINGS_WORKFLOW` binding, class `RatingsWorkflow`, registered Workflow `iptv-ratings` | `wrangler.jsonc:44-48`, `build.mjs:43` | only the `ensure` path of item 1 (`env.RATINGS_WORKFLOW.create`) | L3 | Removing the `wrangler.jsonc` entry changes the live binding on deploy (`keep_vars` does not cover Workflow bindings). Separate owner GO with exact resource names; readback of absence afterwards. History: 8 completed instances, last 22 Nov 17:00 Madrid, before handover. |
| 13 | `letterboxd/ratings/executor.json`, `orchestration.json`, `run.json` documents | D1 `ratings_document`, R2 mirrors | handover facts, fence | KEEP | Data is kept unless the owner approves deletion separately. |
| 14 | Cron `0 * * * *`, `1-59/2 * * * *`, `24 3 * * *`, `30 * * * *` | Cloudflare schedules | EPG, Discovery, Monitor, poster, Letterboxd | KEEP | `:00` is shared; nothing to remove. |
| 15 | ChatGPT Scheduled Tasks for Ratings | ChatGPT registry | none (Daily Ratings Task already retired and disabled per `docs/reference/scheduled-tasks.md`) | L3 | Registry not readable here; any change needs a separate operation-specific owner authorization. |

## Test impact (offline)

Files that reference the retired surface and must change together with it: `tests/ratings-orchestration.mjs` (8 hits, mostly `ensure`/`run`), `tests/ratings-api.mjs` (12), `tests/letterboxd-sync.mjs` and `tests/letterboxd-sync-bundle.mjs` (12 each, handover/fence), `tests/monitor-runtime.mjs` (2), `tests/mcp.mjs`, `tests/get-write-baseline.mjs`, `tests/cron-schedule-simulation.mjs` (3), plus the registry `scripts/test-classification.mjs` and shard map `scripts/run-tests.mjs`.

Negative tests to add before any removal: legacy `ratings_sync_start/step` after handover answer `external_writer_fenced` with zero writes; no `iptv-ratings` instance can be created; no second Ratings or Watchlist Event per slot; stale epoch fails closed.

Regression for the shared cron dispatch (required with the code change): after the `RatingsOrchestration.ensure` call is removed from `src/worker.js:2740`, a `:00` scheduled firing still runs the Discovery reconcile, `EpgOrchestration.ensure` and `Monitor.run`, creates no Ratings Workflow instance, and a failure of one member does not stop the others (the `allSettled` shape is kept). `tests/cron-schedule-simulation.mjs` is the natural home.

## Documentation to update with the code change

`docs/architecture/scheduling-and-orchestration.md` (Ratings 17:00 sequence, Mermaid with GitHub render QA), `docs/reference/integrations/letterboxd-ratings.md`, `docs/reference/feature-flags.md`, `docs/reference/api/mcp.md`, `docs/runbooks/letterboxd-sync.md`, `docs/runbooks/letterboxd-activation.md`, `docs/runbooks/deployment.md`, the ADR 0101 qualification note against ADR 0186 (no rewrite of Accepted history), and this evidence index.

## Owner decisions needed

1. **Legacy entry points (items 4-6):** answer with a typed `410` and keep the code path tiny, or delete the routes and MCP tools. Recommendation: `410` for `ratings/start|step` and the MCP pair, keep `ratings/executor` until the reverse handover is no longer wanted.
2. **Mode row and reverse handover (items 6-9):** keep the `external` mode row, `externalGate` and `readModel` as a permanent single-writer fence, or retire them with a documented forward-recovery plan. Recommendation: keep the fence, retire only items 1-3.
3. Separately, the L3 GO for items 12 and 15, only after the code PR is deployed.

## Proposed minimum PR scope (after the AIR-571 gate)

**First code PR (no config change):** only the `RatingsOrchestration.ensure` call at `src/worker.js:2740` (the other scheduled consumers and the shared `:00` cron stay) and then the now-unused `ensure` path, with the shared-cron regression above, the typed compatibility answer for items 4-5 if chosen, and the documentation above. It keeps `run`/`act`/`admit`/`drive`/`stopInstance`, `runRatingsWorkflow`, the `RatingsWorkflow` class and `build.mjs` wiring, `RATINGS_SCHEDULE` and the `dailyDue` default, `readModel`, `readMode`, `drainState`, `externalGate` and the handover code. No `wrangler.jsonc` change, no D1 or R2 change, no flag, no Task. Merge only after AIR-571 is Done.

**Second slice (separately owner-approved, with the L3 resource GO):** `run`/`act`/`admit`/`drive`/`stopInstance`, `runRatingsWorkflow`, the `RatingsWorkflow` class and its `build.mjs` wiring, and the `RATINGS_WORKFLOW` binding in `wrangler.jsonc`, with exact build and runtime tests and a production readback of the binding's absence.

**Deferred until item 9 is decided:** `RATINGS_SCHEDULE` and the `dailyDue`/`nextDailyDue` default.
