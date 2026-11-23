# AIR-580: retirement of the legacy Ratings Workflow, final acceptance, 23 November 2026

[AIR-580](https://trello.com/c/w0rsARMP) · 23 November 2026 (all times UTC; Madrid is UTC+01:00) · documentation only: this report and its index entries record what was done and observed; the pull request that carries it performs no production action and changes no contract.

**Result: accepted.** The legacy Ratings Workflow, its class and its binding are retired and deployed, the Cloudflare registration `iptv-ratings` is deleted, and the natural EPG run of 23 November and the Letterboxd Sync slot `2026-11-23T1630` completed healthily afterwards.

## Provenance

- **Executor-observed** facts were read by the executor of this task through `GET` requests of the Cloudflare API connector and `SELECT` statements on the production D1 (every `SELECT` reported `rows_written` 0). They are marked *(executor)*.
- **Coordinator-observed** facts are quoted from the coordinator's acceptance comment of 23 Nov 2026 16:27 UTC on the Trello card (the card comment is the source; the executor did not repeat every check). They are marked *(coordinator)*.
- **Owner-reported**: the output of the owner's own terminal command. It is marked *(owner)*.

## Chronology

| Time (UTC) | Event | Source |
| --- | --- | --- |
| 11:50 | [PR 938](https://github.com/vladimino/iptv-watchlist/pull/938) deployed: the HTTP routes `POST /api/letterboxd/ratings/start` and `/step` answer 404 and the MCP tools `ratings_sync_start` and `ratings_sync_step` are unknown tools | PR, deployment |
| 13:33:01 | [PR 942](https://github.com/vladimino/iptv-watchlist/pull/942) merged as `9e15b11bc752f8449e5fe699a4377852e6f7c3b6`: the Workflow loop, `runRatingsWorkflow`, the class `RatingsWorkflow` and the binding `RATINGS_WORKFLOW` removed; the owner route refuses `cloudflare` with `legacy_executor_retired`; `drainState` fails closed for a live-phase control record | PR |
| 13:35 | post-merge [CI/CD 45185031538](https://github.com/vladimino/iptv-watchlist/actions/runs/45185031538), four jobs successful; Cloudflare deployment `c7a25fd4-8622-4858-a0bf-cc2b686fd2fc` (version `c43d92a3-c567-49ae-a977-3a21ed6df527`, 100%) | Actions, Cloudflare *(executor)* |
| after 13:36 | read-only readback after the deploy (exact time not recorded): no `RATINGS_WORKFLOW` binding; five Workflow bindings; four crons; the registration `iptv-ratings` still listed (7 `complete` instances, `modified_on` 12:58:55Z, not updated by this deployment, while the five script-bound registrations were) | Cloudflare *(executor)* |
| 14:03:43 | the executor's single `DELETE /accounts/{account_id}/workflows/iptv-ratings` through the Cloudflare API connector, sent after a fresh preflight that matched the baseline and after the owner's explicit GO ("Разрешаю удалить", with the loss of the history of seven instances and without an export). Answer **HTTP 401, code 10000, Authentication error**: the connector token reads Workflows but may not delete one. No retry, no other credential or tool was used | *(executor)* |
| 14:03:53 | reconciliation by `GET`: registration present with the same id and 7 `complete` instances; the other five registrations, the bindings and the crons unchanged. Nothing was deleted or changed | *(executor)* |
| about 14:07 | the **owner** ran `npx wrangler workflows delete iptv-ratings` (wrangler 4.86.0) in their own terminal: "Workflow "iptv-ratings" removed successfully" | *(owner)* |
| 14:07:42 | read-only readback: `GET /workflows/iptv-ratings` and its `/instances` answer **404**; `GET /workflows` lists exactly five registrations with the baseline ids; five Workflow bindings, none named `RATINGS_WORKFLOW`; the four crons | Cloudflare *(executor)* |
| 15:30 to 15:32 | natural Letterboxd Sync slot `2026-11-23T1630` (details below) | *(coordinator)*, Cloudflare and D1 *(executor)* |
| 16:00 to 16:04 | natural EPG run of 23 Nov (details below) | *(coordinator)*, D1 *(executor)* |
| 16:36 | the executor's second read-only check (below) | *(executor)* |

The physical deletion was executed by the owner, not by the executor; the executor's own attempt was refused and had no effect. Nothing in this report is a claim that the executor deleted the resource.

## Cloudflare state after the deletion

Read again at 16:36 UTC *(executor)*, `GET` only:

- `GET /workflows/iptv-ratings` → HTTP 404. The registration is gone, together with its seven historical instance records (`ratings_20261116_0` to `ratings_20261122_0`, all `complete` before the deletion). Their loss was knowingly authorized; the domain Ratings and Letterboxd Sync data in D1 and R2 were not touched by the deletion.
- Exactly five registrations remain, with the baseline ids: `iptv-letterboxd` `bcb64880-23bd-472c-8e3f-7bc70949cb8a`, `iptv-prediction-start` `35df70b6-ceaf-4129-b042-3d838f650b9d`, `iptv-producer` `31652c19-318f-46dc-a405-0ebc171682d9`, `iptv-epg` `e219887b-8055-4c32-b4dc-6c9d63b71c8c`, `iptv-discovery` `01852468-f090-4ea3-b78e-7c477c76c040`.
- The script `iptv` has exactly the five Workflow bindings `DISCOVERY_WORKFLOW`, `EPG_WORKFLOW`, `LETTERBOXD_WORKFLOW`, `PREDICTION_START_WORKFLOW`, `PRODUCER_WORKFLOW`; the four crons `0 * * * *`, `1-59/2 * * * *`, `24 3 * * *`, `30 * * * *`.
- The same readback (after the deploy and at 14:07) answered the open question of the [L3 package](air-580-ratings-workflow-l3-go-package-2026-11-23.md): a deployment that drops the class and the binding does **not** delete the registration; it stays listed, unbound, with its `modified_on` not updated, until it is deleted explicitly.

## Natural EPG run of 23 November

*(coordinator)*: the MCP `epg_status` answered HTTP 200 with `mode` `cloudflare`, `runKey` `2026-11-23`, `runId` `d8dc6ec8-b7e0-43a2-a02a-25269f00ba2f`, phase `done`, stage `complete`, health `healthy`, no failure, no quarantine, owner `epg_20261123_1` finished; the Cloudflare instance `complete` with 5 steps and no error; due 16:00:00Z, pointer published 16:03:57.868Z (3 min 57.868 s), completion 16:04:20.796Z. The MCP `epg_pipeline_status` (operational view): published programme matches, D1 published authority `ready/d1/open`, no live EPG lease; Discovery runs on its own Workflow without `stalled` or `recoveryIncident`.

*(executor)* cross-check by `SELECT` at 16:36: `published_epg_authority.programme_run_id` and `finalized_run_id` are both `d8dc6ec8-b7e0-43a2-a02a-25269f00ba2f`, `finalized_at` 2026-11-23T16:04:20.891Z, `madrid_run_key` `2026-11-23`. The EPG did not read the retired Ratings Workflow: the run used its own `EPG_WORKFLOW`.

## Letterboxd Sync and the Watchlist

*(coordinator)*: slot `2026-11-23T1630` finished at 15:32:27Z with `ratings` `finished`, `watchlist` `no_change`, `reconciliation` `done`, health `healthy`, `eventsPending` 0, `overdueSlots` empty, no quarantine; the legacy Ratings read model is `external`, epoch 2, with no liveness.

*(executor)*: the instance `lbsync_20261123_1630_0` is `complete` on `iptv-letterboxd` (four `complete` instances in total at 16:36). D1: `watchlist_authority` `d1`, generation 3, writes `open`; `watchlist_current` version 3, 393 films, last attempt `no_change`, effects drained at version 3; the Ratings mode document `external`, epoch 2, drain `verified`.

## Boundaries of this acceptance

- **Mirror.** The root `watchlist.json` mirror reported `owed` after the slot, not `stale`, with no attempts and no warning *(coordinator)*. This is recorded as a delivery that has not yet come due; it is neither a failure nor proof that the mirror was delivered.
- **Producer.** The Workflow `iptv-producer` shows only `errored` instances (164 at 12:00Z, 166 at 13:35Z, 167 at 16:36Z, *(executor)*). It is unrelated to the Ratings Workflow and is tracked separately in [AIR-572](https://trello.com/c/ugyHjnc4); it does not block this retirement.
- **Access-protected Worker endpoints** (the 404 of the old HTTP routes) were not called by the executor in this check.
- **No reverse path.** The owner's decision B is final: there is no handover back to a legacy Ratings writer. Recovery of the Letterboxd Sync is forward only ([runbook](../../runbooks/letterboxd-sync.md#recovery-forward-only)). Restoring a legacy writer would need a new reviewed implementation and a new owner decision.

## Relation to the L3 GO package

The [L3 GO package](air-580-ratings-workflow-l3-go-package-2026-11-23.md) stays as written: a historical proposal, never itself an authorization. What it left open was settled afterwards, outside the package: the owner chose option B and gave an operation-specific GO; the code and configuration change was reviewed and deployed ([PR 942](https://github.com/vladimino/iptv-watchlist/pull/942)); the deployment behaviour of the registration was observed (above); and the physical deletion was performed by the owner. Its prerequisite of a natural 17:00 EPG before deployment is superseded by the coordinator's correction that no technical dependency exists between the deletion and the EPG; the natural EPG was verified afterwards as an independent acceptance of the deployed Worker (above).

## Sources

[PR 938](https://github.com/vladimino/iptv-watchlist/pull/938), [PR 942](https://github.com/vladimino/iptv-watchlist/pull/942), [CI/CD 45185031538](https://github.com/vladimino/iptv-watchlist/actions/runs/45185031538); the Trello card [AIR-580](https://trello.com/c/w0rsARMP): the [attempt and the 401](https://trello.com/c/w0rsARMP#comment-6b0447d6ef808dccb466ef22), the [deletion and its readback](https://trello.com/c/w0rsARMP#comment-6b0448c650c20198e6f1d0b7) and the [final acceptance](https://trello.com/c/w0rsARMP#comment-6b04696de1224e49f5f573f2).
