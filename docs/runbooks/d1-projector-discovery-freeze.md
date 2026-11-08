# L3 runbook (DRAFT, not executed): Discovery pause window for the D1 enrichment projector

**Status:** Draft prepared for [AIR-383](https://trello.com/c/Hnuf2tB0) after the owner chose option D of the decision brief on 2026-11-08. **Nothing in this page has been run, and it authorizes nothing.** Every step that changes production (a Worker variable, a Scheduled Task, a workflow instance) is an L3 operation under the [authorization policy](../process/authorization-and-escalation.md) and needs the owner's operation-specific GO, named by tool, target, value and time window. Times are UTC unless Europe/Madrid is stated.

**State of the automatic window.** Its code is in the repository behind the feature flag `D1_ENRICHMENT_WINDOW` (off) and the table of migration `0018` (not applied); neither is active. The owner's GO to apply the migration, the measurements of the lease hold times and of a run under the wait, and the proof that an EPG publication waits for the window ([ADR 0103](../adr/0103-projector-exclusive-window.md) decision 5) come before any activation, and none of them is a step of this page.

**Scope of this page.** It is a manual, one-off fallback performed by a human. An automatic, bounded window coordinated through D1 is proposed in [ADR 0103](../adr/0103-projector-exclusive-window.md) (Proposed); this page does not describe it and stays valid as the fallback if that design is not accepted or cannot be demonstrated.

## Why this exists

The projector (`src/d1-enrichment.js`, single hourly Worker cron (`triggers.crons` in `wrangler.jsonc`)) pins the global Discovery authority generation before it reads and checks it again right before the write. Between those two points lies the whole diff phase (10.6 s of reading, 21.2 s in total on the 2026-11-08 08:37 run). Measured on 2026-11-08 07:31–10:01 UTC from `discovery_decision_history`, Discovery wrote in every one of 150 consecutive minutes and the generation rose by 16–17 per minute (about one bump per 3.5 s). A bounded retry of the read phase has a stable-window probability of about 5 % at 10.6 s and 0.25 % at 21.2 s (Poisson, 17 per minute), so it cannot restore progress; the generation fence must not be weakened. Option D therefore removes the writer for a window long enough for the projector to drain. It treats the symptom by hand: the primary approach is the automatic, bounded window proposed in [ADR 0103](../adr/0103-projector-exclusive-window.md), and this page remains the manual fallback.

Estimated work to drain (from the 08:37 plan in the [AIR-373 inventory](../evidence/d1-migration/air-373-baseline-inventory-2026-11-08.md), a plan that moves while Discovery runs): 3,163 Films and 12,400 Persons. The per-run budget wrote 775 Persons on the runs that wrote; Films are one batch each. Plan for **at least 16–20 hourly ticks**, and re-measure after the first two ticks. The window is a multi-hour to roughly one-day pause of Discovery, not a short stop.

## Facts established read-only on 2026-11-08 (re-verify in preflight, never rely on them)

- `feature_flags` readback at 10:07 UTC: `DISCOVERY_EXECUTOR=workflow`, `D1_ENRICHMENT_WRITE=on`, `MONITOR=on`, `MONITOR_TRANSPORT=telegram`, `DISCOVERY_LEDGER_MODE` absent.
- D1 `discovery_authority`: `mode=d1`, `cutover=open`, generation 32204 at about 10:05 UTC.
- The `epg_pipeline_status` MCP read answered `discovery_fence` at 10:07 UTC: that read fails closed while Discovery holds a fence, so it cannot be the preflight probe. Use D1 `SELECT`s.
- Code: with `DISCOVERY_EXECUTOR=external` the cron `reconcileDiscoveryWorkflow` creates nothing and a running instance ends at its next decision with `executor_not_workflow` (`src/discovery-workflow.js`, terminal reason). A chunk already in flight finishes under its 90 s lease first.

## Inventory of every writer of the Discovery generation or its inputs

Each one must be quiet, or proven unable to write, for the whole window. The list is a starting point; the preflight must confirm it live.

| # | Writer | Normal trigger | How it is held quiet | Verified how |
| --- | --- | --- | --- | --- |
| 1 | Discovery Workflow instance (`DISCOVERY_EXECUTOR=workflow`) | Worker cron reconcile and self-renewing instances | Set the variable to `external` (owner, Cloudflare Worker variable); the cron then creates none and a live instance stops | `feature_flags`; Workflows instance list (Cloudflare API, read); generation stops moving |
| 2 | Hourly ChatGPT Scheduled Task (`:20` Europe/Madrid), Stage A discovery catch-up through `epg_sync_step` | ChatGPT scheduler | Owner pauses that exact Task for the window, or accepts that with `external` it will run chunks; **it must be paused** | Registry readback `Automations.peek` by the stable ID in the [scheduled-task contract](../reference/scheduled-tasks.md) |
| 3 | Daily EPG/watchlist Scheduled Task (17:00 Europe/Madrid) | ChatGPT scheduler | Owner decides: pause it for a window that spans 17:00, or start the window after it completes. It publishes a new generation and writes the sources the projector reads | Registry readback; `epg_status` stage `complete` |
| 4 | Manual `epg_sync_start`/`epg_sync_step`, resolve and admin discovery-recovery routes | Owner or a session | Nobody calls them; this is a procedural hold, so say so in the owner's GO | Generation stops moving |
| 5 | Ratings workflow executor | Worker cron `ensure` | Not a Discovery writer; leave untouched. Its independence is a requirement, not something to pause | n/a |
| 6 | Monitor `Monitor.run` | Worker cron | Not a writer of these inputs; leave `MONITOR=on` (the permanent emergency gate). Expect Discovery-stall alerts during the window; the owner decides in the GO whether to acknowledge them | Telegram alerts |
| 7 | D1 enrichment projector | Worker cron | The only writer left; it is the purpose of the window | `projection_run`, `projection_state` |

Do not reset a lease, edit `epg/resolver-lease.json`, or change `D1_ENRICHMENT_WRITE`, `MONITOR` or any cron during the window.

## Preflight (read-only, all L0)

1. `git fetch origin main`; confirm the deployed Worker version and that no other change to `src/d1-enrichment.js` or `src/discovery*.js` is in flight. Confirm the AIR-373 session has no run that reads or writes production at the same time.
2. `feature_flags`: record the four values above exactly. Stop if `D1_ENRICHMENT_WRITE` is not `on` or `DISCOVERY_EXECUTOR` is not `workflow`.
3. D1 `SELECT`s, saved as counts only: `discovery_authority` (`mode`, `cutover`, `generation`, `programme_run_id`), `discovery_lease` (`lease_id`, `expires_at`), `discovery_transfer.state`, the latest `projection_run` row (`outcome`, `finished_at`, summary), `COUNT(*)` of `projection_state` by kind.
4. Registry readback of the two Scheduled Tasks (ID, `is_enabled`, schedule, last run); the Workflows list for Discovery instances (liveness).
5. Record a D1 Time Travel bookmark only if the owner asks for one; the projector writes rows its own change keys can reproduce, so this is not a default prerequisite (proportionality section of the [agent workflow](../process/agent-workflow.md)).
6. Agree the stop conditions and the maximum window in the GO (suggested: 24 h, review after every tick).

## Pause (owner performs each step; one GO per operation)

1. Pause the hourly ChatGPT Discovery/predictions Task named in inventory row 2. Read it back. (Predictions share that Task: record that predictions stop too, or ask the owner to choose a narrower prompt change instead, which is its own approval.)
2. If the window would span 17:00 Madrid, pause the daily EPG Task as well, or wait until it has completed and start after.
3. Set `DISCOVERY_EXECUTOR=external` on the Worker. Read it back with `feature_flags`.
4. **Drain, do not reset.** Wait for the in-flight chunk and lease to expire by themselves (lease TTL 90 s) and for any live workflow instance to end with `executor_not_workflow`.

## Window-open test (read-only; the window counts only when all hold)

- `discovery_lease.expires_at` is in the past and `lease_id` is NULL or expired.
- `discovery_transfer.state` is not `loading`.
- The generation is identical in two `SELECT`s at least 5 minutes apart.
- No Discovery Workflow instance is running, queued or waiting.
- `epg_status` shows no sync in `metadata` or `epg` stage.

If any condition fails, do not wait for the cron to fail: fix the writer that moved, or abort and resume.

## During the window

The projector is run only by its normal hourly cron; **no manual run**. After each tick read, with D1 `SELECT` only: the `projection_run` row (outcome, `reason`, `loadMs`, `durationMs`, written counts, `remaining`, `leaseLost`), `COUNT(*)` of `projection_state`, and `MAX(projected_at)`. Expected: `outcome` of `budget` or `complete` with rising counts and a falling `remaining`, no `leaseLost`, no `partial`. Review points: after the first tick (did it write at all), after the second (rate and the estimate of ticks left), then every tick.

Stop and resume immediately (see Resume) if: two consecutive ticks write nothing and the reason is not `writer_active`/`input_changed` explained by a quiet-test failure; any `leaseLost`, `failed` or `partial` outcome; an `absent_guard` or `membership_guard` outcome (the projector is fail-closed here and does not write; the cause is input, not the window); the owner withdraws the GO; the maximum window is reached.

## Done criteria for the window

Either `remaining=0` with a run `complete` and an unchanged plan on the next tick (a zero-write convergence tick), or a recorded reason to stop. The window itself proves only that the projector can progress without the writer; it does not prove progress under live Discovery, and the card is not done by it.

## Resume (owner performs; one GO per operation)

1. Set `DISCOVERY_EXECUTOR=workflow`; read it back. The next cron reconcile recreates the instance, which re-reads authority, generation, executor record and the recovery gate; no manual start.
2. Re-enable the paused Scheduled Task(s) and read them back. Do not trigger them manually.
3. Verification (read-only): generation moves again, one Discovery instance is running, a Discovery chunk completes in the next tick, the monitor shows no open incident after its own recovery, Ratings and EPG crons unaffected.
4. Record the sanitized evidence (counts and timestamps only) in `docs/evidence/d1-migration/` with the index entry.

## Rollback and limits

Resuming is the rollback: setting `workflow` back and re-enabling the Task restores the prior state. It does not undo projector writes (they are the intended outcome) and a code or variable change reverts neither D1 nor R2 data. A change to an authority marker, lease, schedule or cron is outside this runbook.

## What this runbook does not fix

After resume Discovery again bumps the generation about 17 times a minute, so the projector starves again as soon as its backlog regrows (every EPG publication or catalog change creates new work). Sustained liveness is the subject of the automatic, bounded window proposed in [ADR 0103](../adr/0103-projector-exclusive-window.md); the scoped-revision design was rejected by the owner. This manual freeze stays the fallback, not the primary architecture.
