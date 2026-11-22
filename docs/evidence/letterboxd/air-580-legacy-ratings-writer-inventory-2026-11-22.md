# AIR-580: legacy Ratings writer retirement, offline inventory and removal map, 22 November 2026

[AIR-580](https://trello.com/c/w0rsARMP) · 22 November 2026 · phase 1 only: read-only source inventory on `main` `cc80af1`, no code change, no production read or write by this session.

**Gate:** nothing in this map may be merged or deployed before [AIR-571](https://trello.com/c/b6UrtwUG) is `Готово` and complete (F1, F2, four natural slots, owner acceptance). Physical removal of the Cloudflare `iptv-ratings` registration or the `RATINGS_WORKFLOW` binding needs a second, separate owner L3 GO on the exact resources.

## Not verified by this session

- Live Worker, D1 and Cloudflare state. The production facts (`RatingsOrchestration` mode `external`, epoch 2; `LetterboxdSync` `cloudflare`, epoch 1; Watchlist `d1/open/3`; four crons; the `iptv-ratings` Workflow with 8 completed instances) are quoted from the card handoff of 22 November 2026, 20:15 Madrid, not re-read here.
- ChatGPT Scheduled Task registry (no read access from this session).

## Finding that corrects the card

The card lists "the obsolete 17:00 `ensure` on the shared hourly cron" as a cleanup candidate. At `cc80af1` **`RatingsOrchestration.ensure` has no caller in `src/`** (`src/worker.js` `scheduled` only calls `LetterboxdSync.ensure` for cron `:30` and the EPG/Discovery/Monitor work on `:00`). Only tests call it. So the old writer already cannot start a new `iptv-ratings` instance from production code; what remains is dead code, a dormant Workflow class/binding, and the fencing/handover code that the new writer still reads.

## Classification

`KEEP` = a live dependency of the new writer, the monitor or rollback safety. `CODE-RETIRE` = confirmed unreachable or superseded, removable in a code PR after the AIR-571 gate. `OWNER-DECISION` = removal weakens a safety or rollback property. `L3` = a live Cloudflare resource, never touched by a code PR alone.

| # | Symbol / route | Where | Consumers found | Class | Note |
| --- | --- | --- | --- | --- | --- |
| 1 | `RatingsOrchestration.ensure` | `src/ratings-orchestration.js` (`ensure`) | none in `src/`; `tests/ratings-orchestration.mjs` | CODE-RETIRE | Only path that created `iptv-ratings` instances; already uncalled. |
| 2 | `RatingsOrchestration.run/act/admit/drive/stopInstance`, `runRatingsWorkflow` | `src/ratings-orchestration.js:426`, `build.mjs:43` | only the `RatingsWorkflow` class exported by `build.mjs` | CODE-RETIRE | Workflow body. Remove with item 12; the exported class name must go in the same change as the binding decision. |
| 3 | `RATINGS_SCHEDULE` and the default `schedule` of `dailyDue` / `nextDailyDue` | `src/domain/orchestration-policy.js:7,67,74` | `dailyDue` is also used by `epg-orchestration.js:723,972` and `monitor-policy.js` (EPG schedule passed explicitly) | CODE-RETIRE (constant and default only) | Keep `dailyDue`/`nextDailyDue`. Make `schedule` a required argument; check every caller passes one. |
| 4 | `/api/letterboxd/ratings/start`, `/step` (POST) | `src/worker.js:2776` via `LetterboxdRatings.handle` | MCP `ratings_sync_start/step`, `tests/ratings-api.mjs` | OWNER-DECISION | After handover both answer `external_writer_fenced` (0 writes). Prefer a typed `410` compatibility answer over deleting the route; owner chooses. Also a registered write route in `tests/get-write-baseline.mjs` (`MCP_WRITE_TOOLS`). |
| 5 | MCP `ratings_sync_start`, `ratings_sync_step` | `src/mcp.js:49,50,316` | scheduled-task prompts under `docs/reference/scheduled-task-prompts/` mention them historically | OWNER-DECISION | Same choice as item 4. MCP tool list is a published contract (`docs/reference/api/mcp.md`). |
| 6 | `/api/letterboxd/ratings/executor` (POST, mode switch / `clear_quarantine`) | `src/worker.js:2775` → `RatingsOrchestration.handle` | the owner mode switch; `letterboxdHandover` | OWNER-DECISION | This is the owner-only reverse-handover entry. Removing it removes the documented rollback to the old writer. |
| 7 | `letterboxdHandover`, `letterboxdHandoverFacts`, `letterboxdHandoverGuards` | `src/worker.js` ~2645-2700 | `LetterboxdSync` mode switch (D2/E activation and any later reversal) | KEEP (until owner decides item 6) | They call `RatingsOrchestration.readMode/drainState/externalGate`; they cannot go while the Letterboxd mode switch can still run. |
| 8 | `RatingsOrchestration.readMode`, `drainState`, `externalGate`, `MODE_KEY`, `CONTROL_KEY` | `src/ratings-orchestration.js` | item 7; `LetterboxdRatings` fence (`src/letterboxd-ratings.js:553`) | KEEP | The `external` mode row plus the gate is what fences the legacy entry points. |
| 9 | `RatingsOrchestration.readModel` | `src/ratings-orchestration.js`; `src/monitor.js:49-52`; `src/letterboxd-ratings.js:524` | monitor `ratings` stream, `ratings_sync_status` | OWNER-DECISION | Monitor still evaluates a Ratings stream built from it. Retiring requires a monitor-policy change (the Letterboxd stream already exists) and a `docs/reference` update. |
| 10 | `ratings_sync_status`, `/api/letterboxd/ratings/status` | `src/mcp.js:48,315`, `src/worker.js:2767` | operators, monitor | KEEP | Read-only diagnostics; required by the card. |
| 11 | `LetterboxdRatings` engine (`src/letterboxd-ratings.js`), `src/letterboxd-sync-ratings.js`, `src/ratings-d1.js`, Diary parser, removal phase, Events | whole files | the new `src/letterboxd-sync.js` phase ports | KEEP | Not legacy. `ratingsFence` / `fencedEnv` in `src/letterboxd-sync.js:70` is the new writer's epoch guard. |
| 12 | `RATINGS_WORKFLOW` binding, class `RatingsWorkflow`, registered Workflow `iptv-ratings` | `wrangler.jsonc:44-48`, `build.mjs:43` | none after item 1 | L3 | Removing the `wrangler.jsonc` entry changes the live binding on deploy (`keep_vars` does not cover Workflow bindings). Separate owner GO with exact resource names; readback of absence afterwards. History: 8 completed instances, last 22 Nov 17:00 Madrid, before handover. |
| 13 | `letterboxd/ratings/executor.json`, `orchestration.json`, `run.json` documents | D1 `ratings_document`, R2 mirrors | handover facts, fence | KEEP | Data is kept unless the owner approves deletion separately. |
| 14 | Cron `0 * * * *`, `1-59/2 * * * *`, `24 3 * * *`, `30 * * * *` | Cloudflare schedules | EPG, Discovery, Monitor, poster, Letterboxd | KEEP | `:00` is shared; nothing to remove. |
| 15 | ChatGPT Scheduled Tasks for Ratings | ChatGPT registry | none (Daily Ratings Task already retired and disabled per `docs/reference/scheduled-tasks.md`) | L3 | Registry not readable here; any change needs a separate operation-specific owner authorization. |

## Test impact (offline)

Files that reference the retired surface and must change together with it: `tests/ratings-orchestration.mjs` (8 hits, mostly `ensure`/`run`), `tests/ratings-api.mjs` (12), `tests/letterboxd-sync.mjs` and `tests/letterboxd-sync-bundle.mjs` (12 each, handover/fence), `tests/monitor-runtime.mjs` (2), `tests/mcp.mjs`, `tests/get-write-baseline.mjs`, `tests/cron-schedule-simulation.mjs` (3), plus the registry `scripts/test-classification.mjs` and shard map `scripts/run-tests.mjs`.

Negative tests to add before any removal: legacy `ratings_sync_start/step` after handover answer `external_writer_fenced` with zero writes; no `iptv-ratings` instance can be created; no second Ratings or Watchlist Event per slot; shared `:00` tick still runs EPG, Discovery and Monitor; stale epoch fails closed.

## Documentation to update with the code change

`docs/architecture/scheduling-and-orchestration.md` (Ratings 17:00 sequence, Mermaid with GitHub render QA), `docs/reference/integrations/letterboxd-ratings.md`, `docs/reference/feature-flags.md`, `docs/reference/api/mcp.md`, `docs/runbooks/letterboxd-sync.md`, `docs/runbooks/letterboxd-activation.md`, `docs/runbooks/deployment.md`, the ADR 0101 qualification note against ADR 0186 (no rewrite of Accepted history), and this evidence index.

## Owner decisions needed

1. **Legacy entry points (items 4-6):** answer with a typed `410` and keep the code path tiny, or delete the routes and MCP tools. Recommendation: `410` for `ratings/start|step` and the MCP pair, keep `ratings/executor` until the reverse handover is no longer wanted.
2. **Mode row and reverse handover (items 6-9):** keep the `external` mode row, `externalGate` and `readModel` as a permanent single-writer fence, or retire them with a documented forward-recovery plan. Recommendation: keep the fence, retire only items 1-3.
3. Separately, the L3 GO for items 12 and 15, only after the code PR is deployed.

## Proposed minimum PR scope (after the AIR-571 gate)

Items 1-3 and their tests, the typed compatibility answer for items 4-5 if chosen, and the documentation above. No `wrangler.jsonc` change, no D1 or R2 change, no flag, no Task.
