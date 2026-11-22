# Letterboxd Sync activation runbook (AIR-571 holdpoints B to F)

**Status (22 Nov 2026): prepared, NOT performed, NOT authorized.** This page is the executable plan the owner can approve operation by operation. Nothing on it is authorized by a deploy, by the merge of the code it describes or by this page. Every operation below needs its own explicit owner GO, naming the operation, the target, the pins and the window; a GO for one operation is not a GO for the next. The prerequisite **O4** ([AIR-551](https://trello.com/c/YAVPlcAe) Done, with a natural EPG run observed after the checkpoint cutover) must hold before B. Decisions and rationale: [ADR 0186](../adr/0186-letterboxd-sync-and-independent-watchlist-authority.md) (O1, O4, O5, decisions 1, 3 and 8). The earlier no-GO package and its findings: [go/no-go package](../evidence/d1-migration/air-571-go-no-go-package-2026-11-21.md). The commands and refusals of each operator: [Letterboxd Sync runbook](letterboxd-sync.md).

## Rules that apply to every step

- **Windows.** No operation or deployment of this plan between **16:30 and 17:00 Europe/Madrid** (the 16:30 Letterboxd slot, the 17:00 daily EPG and its pinned last-good snapshot). No two authority cutovers share a window: B and C do not share a window with each other, with the AIR-551 activation or with any EPG, Ratings, Discovery or Predictions cutover. Madrid time is stated with UTC in every receipt.
- **Receipt per mutation.** Before: a Time Travel bookmark and a fresh read-only `status`. After: the operator's readback, a second bookmark and an independent read of the facts the step claims. A step whose outcome is `write_uncertain` is never repeated: stop, read, and ask for a new GO with new pins.
- **No forcing.** No manual EPG, Ratings, Letterboxd, Discovery, TMDB or Predictions run, no lease reset, no retry, no flag, no Scheduled Task. Natural runs only.
- **The old schedule stays.** The daily Ratings executor, its Cloudflare Workflow and the legacy `ratings_sync_*` entry are not removed before acceptance (O5); they are fenced by the mode protocol, not deleted.
- **One writer.** After every handover command `GET /api/letterboxd/sync/mode` shows the admitted writers; one is the goal, zero is a visible state, two must never be reached by these commands.

## Preflight (read-only, before every GO packet)

1. **Code and deploy.** The merged commit, its post-merge CI/CD jobs (all four) and the deployed version. Evidence of the last preflight: [activation preflight, 22 Nov 2026](../evidence/d1-migration/air-571-activation-preflight-2026-11-22.md).
2. **Authority markers.** `node scripts/watchlist-cutover-production.mjs --target iptv` (status) and the bootstrap status: Watchlist marker, pointer, the certified published generation, the EPG liveness, the EPG checkpoint authority (O4: `d1`/`open`) and the Letterboxd mode (absent or `external`). The D1 schema must be at least 33.
3. **Cron and Workflow configuration.** `GET /accounts/{account}/workers/scripts/iptv/schedules` (expected: exactly the three current expressions `0 * * * *`, `1-59/2 * * * *`, `24 3 * * *`) and `GET /accounts/{account}/workflows` (expected: no Letterboxd Workflow before E). Account-wide cron count against the plan limit (5 on Workers Free, 1,000 on Workers Paid): the fourth cron is within both.
4. **Live health.** The Letterboxd read model, the EPG run state and the Discovery state through their own read-only routes. Any running EPG step, Ratings instance or Discovery lease blocks B, C and D.

## Holdpoints

| # | Operation | Command or action | Pins and facts | Receipt and readback | Stop condition | Rollback |
| --- | --- | --- | --- | --- | --- | --- |
| P | Prerequisites | none (read) | O4 verified from the EPG checkpoint marker `d1`/`open` and a certified natural EPG run after the cutover | the preflight above | AIR-551 not Done; any preflight item false | not applicable |
| B | Bootstrap import | `node scripts/watchlist-bootstrap-production.mjs --target iptv` (status), then `--bootstrap --confirm bootstrap` with `--expect-run`, `--expect-epg-generation`, `--expect-count`, `--expect-members-sha256`, `--expect-sha256` | the pins come from the owner's saved `GET /api/watchlist` (digest command) and the stored source read by status | snapshot v1, count, order and digests equal to the source; no change, effect or ledger row; marker still `epg` | any difference; the generation moved; an EPG step in flight | none needed: the marker is `epg`, a wrong import is ignored; the import is idempotent by digest |
| C1 | Fence the root | `scripts/watchlist-cutover-production.mjs --hold` (epg/open to epg/held), then `--fence-root` with the generation and the root etag read before | the bootstrap receipt pins; the root etag | marker `epg`/`held` G+1; the root carries the fence of G+1 and the same list | liveness unknown or busy; Letterboxd mode not closed; the root moved | `--release-abort` (epg/held back to epg/open) |
| C2 | Switch | `--activate` with `--expect-root-etag` of the fence, then `--release` | the same pins; the mirror receipt is cleared by `activate` | marker `d1`/`held` then `d1`/`open`; the snapshot serves; the EPG reads it; no second membership writer | root not fenced for this generation; checkpoint not `d1`; digest failure | the owner data rollback below |
| D1 | Close the Ratings executor | the Ratings executor route's existing three-step switch to `external`, then wait for its drain | Ratings mode epoch and revision | Ratings mode `external`; no live instance; the step lease released | a live Ratings instance; an undrained step | the same route back to `cloudflare` (its own step) |
| D2 | Close admission, complete | `POST /api/letterboxd/sync/mode` `close_admission` (target `cloudflare`), then `complete`, each with `confirm` and fresh `expectEpoch`/`expectRevision` | the proof (five parts) read by `GET`; the guards pinned at the commit | Letterboxd mode `cloudflare` at its epoch; the legacy `ratings_sync_*` entry fenced; one writer | any false part of the proof (`handover_not_proven`); `handover_changed` | `drain`, wait for effects, `close_admission` (external), `complete`, then the rollback operators (see below) |
| E | Binding and cron | one deployment (below) | account cron count, the schedules and Workflows reads before and after | exactly four crons, the first three unchanged; the Letterboxd Workflow registered | any difference of the existing three; a plan limit; a window of 16:30 to 17:00 Madrid | redeploy without the cron and the binding; the mode and rows stay |
| F | Canary, then four slots | nothing is run by hand | the read model, two Events per slot, the monitor, the 17:00 EPG and Discovery health | one natural slot observed, then the four slots of a day | a missed or failed slot; an EPG or Discovery regression; a duplicate Event | stop new slots (`drain` then close), keep the last good snapshot, hand the writer back by the reverse order |
| G | Retirement | a separate owner decision after stabilization | none | the follow-up card | none | none |

## E in detail: the activation deployment

The code is already in `main` and dormant. What the deployment changes is configuration only, in ONE reviewed commit that the owner approves before it is deployed:

1. `wrangler.jsonc`: add the Workflow registration `{"name": "iptv-letterboxd", "binding": "LETTERBOXD_WORKFLOW", "class_name": "LetterboxdWorkflow"}` and add `"30 * * * *"` as the FOURTH expression of `triggers.crons`, keeping the existing three unchanged and in order (a Wrangler deploy REPLACES the cron triggers with this array). The Worker dispatches `30 * * * *` to the Letterboxd `ensure` and to nothing else (`LetterboxdSync.CRON`).
2. `tests/cron-schedule-simulation.mjs` pins exactly three crons and must be updated in the same commit to pin four, with the fourth being `30 * * * *`.
3. `docs/reference/feature-flags.md` and `docs/runbooks/deployment.md`: the binding is not a flag; record the fourth cron and the Workflow. No new flag is introduced.
4. **Before the deploy:** the preflight above, run inside a window outside 16:30 to 17:00 Madrid and not at a tick boundary (minute 29 to 31 UTC) so no `ensure` tick is mid-flight. **After the deploy:** `GET` the schedules (exactly four, the first three with unchanged `created_on`), `GET` the Workflows list (the Letterboxd Workflow present), and one natural `ensure` tick observed in the read model.
5. The mode must already be `cloudflare` (D2) or the tick does nothing (`external`). With a binding but a mode that is not `cloudflare`, a firing creates no instance.

## Rollback

- **Before D2** nothing writes the Letterboxd side: stop at the last read-back step. B is ignored while the marker is `epg`; C1 backs out with `--release-abort`.
- **After C2 (data rollback), in this order:** `drain` (wait for the effects drained on a natural slot), `close_admission` toward `external`, wait for the drain of the instances, `complete` toward `external`, then `hold-rollback`, `export-rollback`, `fence-root-rollback`, `revert-authority`, `release-rolled-back`. The legacy Ratings entry stays fenced by the Watchlist state until the marker is `epg`/`open`; only then is the Ratings executor re-opened through its own route. Each step is its own GO.
- **After E:** remove the fourth cron and the binding by a deployment of the previous configuration (the three existing crons stay), then the reverse order above for the data. Code rollback alone does not revert D1 rows, R2 objects, markers, the mode row, slots, outbox rows or Events.
- **Generation changes.** Every marker transition that bumps the generation invalidates earlier pins: a GO is only valid for the generation named in it, and the status is read again before each command.

## Offline evidence that backs each holdpoint

The offline matrix (the four authority combinations, an EPG run in flight at the marker flip with a failing mirror, a 16:30 run delayed past 17:00, a stale snapshot, an unknown admission, concurrent Discovery and Ratings admissions, T21 and T24, the two independent Events) and the resource measurements are listed with their honest scope (surrogate versus Cloudflare runtime) in the dated evidence of the QA slice, linked from the [Letterboxd Sync runbook](letterboxd-sync.md) when it is delivered. Until then this plan is not complete for a GO.

## Do not

Do not run any command of this page without the owner's GO for that operation. Do not deploy the activation commit before D2 is read back. Do not delete the legacy schedule before acceptance. Do not combine two authority cutovers in one window. Do not force a run to hurry the acceptance.
