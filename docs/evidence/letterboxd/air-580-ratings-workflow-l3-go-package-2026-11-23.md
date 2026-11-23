# AIR-580: L3 GO package for retiring the legacy Ratings Workflow, 23 November 2026

**Status: PROPOSAL / NOT AUTHORIZED.** This document grants nothing. It is not an ADR, not an approved runbook and not an owner GO. It prepares a reviewable decision for the owner. No source code, test, `wrangler.jsonc`, ADR, registry or Mermaid file is changed by the pull request that carries it, and no Cloudflare, D1, R2, flag, mode or Scheduled Task was changed to write it.

[AIR-580](https://trello.com/c/w0rsARMP) · repository `main` `3e617b8d2656ddb652f60edcdd48125f7e6043fb` (the merge of PR 938; every `file:line` below was checked against that exact commit) · read-only Cloudflare observations of 23 November 2026, about 12:00 UTC. Earlier slices: the [inventory](air-580-legacy-ratings-writer-inventory-2026-11-22.md) (historical; parts of its statuses are superseded by this page), [PR 929](https://github.com/vladimino/iptv-watchlist/pull/929) (the hourly `ensure` call) and [PR 938](https://github.com/vladimino/iptv-watchlist/pull/938) (the HTTP and MCP writer entry points), both merged and deployed.

## Evidence boundary

- **Observed:** facts below marked with a source (a line of `main`, or a `GET` through the Cloudflare API connector). Only `GET` requests were sent. No instance was created, no Workflow, binding, cron or script was changed.
- **Not observed:** the ChatGPT Scheduled Task registry (read from the coordinator's report only: 25 Tasks, none named Ratings, Diary, Letterboxd or EPG; the absence of a named Task does not prove the absence of an external client), the live D1 state (the Ratings mode `external` and the control record's phase are quoted from the coordinator's readbacks, not re-read), and how a Cloudflare deploy treats an existing Workflow registration whose class and binding are removed from the configuration (not established, see "Open technical questions").

## 1. Exact resources and code edges

### Cloudflare, observed by read-only `GET`

| Resource | Observed value |
| --- | --- |
| Workflow `iptv-ratings` | id `2d40b865-3402-4104-9540-b15bab00d8cc`, class `RatingsWorkflow`, script `iptv`, created 2026-11-05T06:17:18Z, `modified_on` 2026-11-23T11:50:57Z |
| its instances | 7, all `complete`, 0 queued, running, paused, errored or waiting. Newest `ratings_20261122_0`, created 2026-11-22T16:00:29Z (before the handover); oldest `ratings_20261116_0`. None created since |
| Workflow `iptv-letterboxd` (KEEP) | id `bcb64880-23bd-472c-8e3f-7bc70949cb8a`, class `LetterboxdWorkflow`, 3 instances, all `complete` (slots 22 Nov 22:30, 23 Nov 04:30 and 10:30 Madrid) |
| other Workflows (KEEP) | `iptv-discovery` (576 complete), `iptv-epg` (14 complete, 1 terminated), `iptv-prediction-start` (9 complete), `iptv-producer` (164 errored, see section 7) |
| Cron triggers of script `iptv` | exactly four: `0 * * * *`, `1-59/2 * * * *`, `24 3 * * *`, `30 * * * *`. None belongs to the legacy Ratings executor |
| latest deployment | id `4638b482-3b57-47fb-958c-56e85fd3973d`, 2026-11-23T11:50:55Z, version `812c31ed-9cee-41b8-bf50-cbf54ac44458` at 100%, message "refactor(api): retire the legacy Ratings writer entry points ... (#938)". Every Workflow's `modified_on` moved to 11:50:57Z with that deployment |

### Code and configuration of `main` `3e617b8`

| Item | Where | Class | Why |
| --- | --- | --- | --- |
| `run`, `act`, `admit`, `drive`, `stopInstance` | `src/ratings-orchestration.js` lines 300, 246, 179, 203, 320 | REMOVE with the Workflow | the legacy Workflow loop; nothing starts an instance since the hourly call was removed |
| `runRatingsWorkflow` | `src/ratings-orchestration.js:355` | REMOVE with the class | called only by the class below |
| class `RatingsWorkflow` and its import of `runRatingsWorkflow` | `build.mjs:43` (generated `dist/server/workflow-entry.js`) | REMOVE with the binding | removing only the function would leave an exported Workflow pointing at a missing function (invalid bundle) |
| binding `RATINGS_WORKFLOW` (`name: iptv-ratings`, `class_name: RatingsWorkflow`) | `wrangler.jsonc:44-48` | REMOVE, L3 | changes the live binding on deploy |
| `RatingsOrchestration.readMode`, `drainState`, `externalGate`, `readControl`, `switchMode`, `clearQuarantine`, `handle`, `MODE_KEY`, `CONTROL_KEY` | `src/ratings-orchestration.js` lines 24, 65, 162, 88, 117, 150 | KEEP | the owner route and the handover proof read them (below) |
| `RatingsOrchestration.readModel` | `src/ratings-orchestration.js:331` | KEEP (owner disposition) | read by the monitor (`src/monitor.js:50-51`) and `ratings_sync_status` (`src/letterboxd-ratings.js:524-525`) |
| `RATINGS_SCHEDULE` and the `dailyDue` default | `src/domain/orchestration-policy.js` | KEEP | `readModel` calls `dailyDue(now)` without a schedule |
| owner route `POST /api/letterboxd/ratings/executor` | `src/worker.js:2775` | KEEP (owner disposition) | the only route that moves the legacy mode |
| `letterboxdHandoverFacts`, `letterboxdHandover`, `letterboxdHandoverGuards` | `src/worker.js` lines 2649, 2668, 2688 | KEEP | the proof `complete` toward `cloudflare` requires; reads `readMode`, `drainState`, `externalGate` |
| `LetterboxdRatings` engine, `src/letterboxd-diary.js`, `src/letterboxd-sync-ratings.js`, D1 ratings facts and queue, Events, the Letterboxd Sync ports and `LETTERBOXD_WORKFLOW` | whole files and the binding | KEEP | used by the active Letterboxd Sync; never "legacy" |
| shared `0 * * * *`, Discovery, EPG, Monitor, poster cron, `30 * * * *`, `iptv-letterboxd` | `wrangler.jsonc`, `src/worker.js` | KEEP | unrelated to the retirement |

Tests coupled to the binding or the Workflow body: `tests/ratings-orchestration.mjs` (the `run`, `act`, quarantine and D1 epoch sections build a fake `RATINGS_WORKFLOW`), `tests/letterboxd-sync.mjs:329` (a `RATINGS_WORKFLOW` stub for the `admit` fence check), `tests/epg-diagnostic-bindings-ready.mjs:12` (asserts the list of Workflow bindings), `tests/cron-schedule-simulation.mjs` (asserts the tick has no Ratings member), `tests/get-write-audit-lib.mjs`, `tests/discovery-workflow.mjs`. Live documents that name the class or the binding: `docs/architecture/runtime-topology.md`, `docs/architecture/scheduling-and-orchestration.md`, `docs/reference/orchestration-reliability.md`.

## 2. Impact and safety

1. **The binding is also read, not only used to create.** `drainState` (`src/ratings-orchestration.js:65-86`) calls `instanceStatus(env.RATINGS_WORKFLOW, instanceId)`, and `readModel` (`:341-342`) does the same only when the binding has a `get` function. With no binding, `instanceStatus` answers `unknown` (`readModel` then reports no liveness). `drainState` then answers `unreadable` **only if** the stored control record is in a live phase (`starting`, `running`, `waiting`) with an `instanceId`; any other control state still answers `verified`. The handover proof treats `unreadable` as not drained and refuses `complete`. So a binding removal is safe only if the control record is not in a live phase, which must be read-only verified before any GO, and the code slice must decide the intended `drainState` and `readModel` behaviour without the binding (instance liveness can no longer exist). This is a coupling the earlier inventory did not list.
2. **No dangling binding or export.** The class, its import in `build.mjs`, the function, the loop and the `wrangler.jsonc` entry must go in one coherent change; the tests that assert the Workflow binding list and the fake binding must change with it.
3. **Do not remove the shared engine.** `LetterboxdRatings`, the Diary parser, the removal phase, facts, queue and Events are the Letterboxd Sync's working dependencies.
4. **External consumers are not excluded.** The Task registry shows no named Ratings Task. That does not prove that no other client calls the retired HTTP routes or tools (they already answer 404 and unknown tool since PR 938).
5. **Deleting the Workflow registration also deletes its instances.** The Wrangler reference states that deleting a Workflow deletes its own instances, so the 7 completed `ratings_*` instances (the only platform-side record of the old Ratings runs) would be lost. Their outcomes are expected to be in the Ratings run record and the Events log rather than only in this list (not checked here); the owner should decide whether an export is wanted first.
6. **A `git revert` does not restore a deleted registration.** It restores code only. It restores no Cloudflare resource, no D1 or R2 data and no authority, and it opens no writer.

## 3. The material owner decision: reverse handover

Keeping the old mode route does not keep a **working** reverse handover once the Workflow is retired: `POST /api/letterboxd/ratings/executor` could still set the mode to `cloudflare`, but nothing could run the legacy executor. Since PR 929 the hourly tick no longer creates an instance either, so the rollback to the legacy writer already needs a reviewed code change (the runbook says so). This is a material decision, not a cleanup. Please choose one option.

**A. Keep the rollback capability.** Keep the Workflow body, the class, the binding and the registration (inert, no instance), and the mode, fence and `readModel` code.
- Consequence: the legacy writer can be restored by a reviewed redeploy of the hourly call (a small, known change) plus the owner's mode GO; no resource has to be re-created.
- Cost: dead code and one idle Workflow registration stay; the next reader of the code still sees two writers.

**B. Retire it, forward-only recovery.** Remove the body, class, binding and registration; keep or later migrate the mode, fence and `readModel`.
- Consequence: recovery from a Letterboxd Sync failure is forward only (hold, drain, quarantine, repair, re-canary with the new fences); the legacy writer cannot be brought back without re-creating the Workflow, the class and the binding.
- Cost of a return to the legacy writer: a reviewed change restoring the class, the loop, the binding and the hourly call, a re-registration of `iptv-ratings` (the old instance history is gone), and the owner's GO for every mode, authority and data change.
- Prerequisite that does not exist yet: a separately reviewed forward-only recovery procedure for the Letterboxd Sync, and the monitor moved off the legacy Ratings health (`src/monitor.js:50-51`).

**Recommendation:** A now; B only after the forward-only recovery procedure is written and accepted and the monitor reads only the Letterboxd stream. If the owner chooses B earlier, the GO text below applies with box 2 ticked.

Whatever is chosen, the mode row, the fences, `readModel` and the owner route are **not** removed by this package; their removal is a later, separate decision.

## 4. Execution plan if a GO is ever given

Prerequisites (all must hold): the owner's decision on section 3; the natural 17:00 Madrid EPG of 23 Nov verified read-only; a read-only check that the Ratings control record is not in a live phase; the exact resource names and ids of section 1 re-read read-only on the day; no open incident on the Letterboxd Sync.

1. **One code and configuration pull request** (never separate): remove `run`, `act`, `admit`, `drive`, `stopInstance`, `runRatingsWorkflow`, the class and its import in `build.mjs`, and the `RATINGS_WORKFLOW` entry; decide and implement `drainState` and `readModel` without the binding; update the listed tests, the three docs and the evidence index. Minimum regressions: the Letterboxd slots still write exactly one ratings Event and one watchlist Event per slot; the owner fences and `externalGate` are unchanged; no `iptv-ratings` instance can be created; `ratings_sync_status` and the monitor read; the handover proof's `ratingsDrained` is `true` for a closed, drained control record and fails closed for a live one; `workflow-entry.js` builds without the class; the shared `:00`, `:30` and fast crons are unchanged. Evidence: `npm ci`, `npm run test:all`, `npm run build`, independent review on the exact HEAD, green pull request CI.
2. **Approved merge, then the four post-merge jobs** (`Test and build`, `Test shard 2 of 3`, `Test shard 3 of 3`, `Deploy to Cloudflare`) and a read-only readback of the binding list, the Workflow list and the cron list. Deployment alone does not delete the registration.
3. **A separate resource deletion gate**, with its own request and its own explicit owner GO that nothing in this document or in the code GO grants (see section 5.3): the physical removal of the registration `iptv-ratings`, one operation, no retry, only after step 2 is verified. Readback of its absence and of the unchanged other five Workflows and four crons.
4. **Rollback and recovery**, stated before approval: step 1 by `git revert` (code only); step 3 cannot be undone by a revert, so the restoration is a reviewed change plus a re-registration, as in option B above.

## 5. Proposed decisions and approval texts (drafts for the owner; none is an approval)

The three parts are independent. Answering one grants nothing in another.

### 5.1 The material decision (section 3): option A or option B

> - [ ] **A.** Keep the legacy Ratings Workflow body, class, binding and registration (inert). Nothing is removed; no code or resource GO follows from this choice.
> - [ ] **B.** Retire them. I understand and accept that afterwards the legacy Ratings writer cannot be restored without a reviewed code change and a re-registration of the Workflow, and that recovery from a Letterboxd Sync failure is forward-only.

This choice alone authorizes no code change, no merge, no deployment and no resource deletion.

### 5.2 Code and configuration GO (only if B is chosen)

> Given option B, I authorize AIR-580 to remove the legacy Ratings Workflow body, the class `RatingsWorkflow` and the binding `RATINGS_WORKFLOW` in one reviewed code and configuration pull request, with its approved merge, the four post-merge jobs and a read-only readback of the binding, Workflow and cron lists. This text does **not** authorize `workflows delete`, the deletion of the registration `iptv-ratings` or of any instance, the Letterboxd Sync, the shared crons, any other Workflow, a Scheduled Task, a flag, a mode, D1 or R2.

### 5.3 Physical deletion of the registration: a separate future request, NOT authorized by 5.1 or 5.2

Neither 5.1 nor 5.2 permits invoking `workflows delete` or any equivalent. After 5.2 is deployed and verified, the executor must send the owner a new request that contains, read-only and dated on that day:

1. the exact current Workflow name and id (today `iptv-ratings`, `2d40b865-3402-4104-9540-b15bab00d8cc`), re-read, with its class and script;
2. its instance list and states, and the list of the other Workflows and the cron triggers, confirmed unchanged;
3. the owner's decision on the seven historical `ratings_*` instance records (export, accept the loss, or keep the registration), because deleting a Workflow also deletes its instances;
4. the verified post-deploy state (the binding and class gone, the bundle built, the four jobs green, no instance created) and the rollback and recovery statement of section 4;
5. a single operation, no retry, with a readback of absence and of the unchanged remainder.

Only an explicit owner reply to that later request is a GO for the deletion.

## 6. Open technical questions (not answered by the sources read)

- What a deploy does to an existing Workflow registration whose class and binding are removed from the configuration (whether the registration stays, becomes unbound or is rejected). The Cloudflare reference only documents the explicit `workflows delete`. To be established by the Cloudflare documentation or a non-production test before any GO.
- The current phase of the Ratings control record (`letterboxd/ratings/orchestration.json`), which decides section 2 point 1. Read-only, in D1, not read here.
- Whether any external client other than a Scheduled Task called the retired routes before PR 938.

## 7. Observation outside this scope

The Workflow `iptv-producer` shows 164 `errored` instances and no other state. It is unrelated to the Ratings Workflow; it was only seen in the same read-only listing and was not analyzed. It is reported to the coordinator for triage, not as a finding of this package.
