# AIR-571: Letterboxd Sync activation, D1 to F2 and the first natural slot after `open_schedule`

Date: 22 Nov 2026 17:42 UTC to 23 Nov 2026 09:32 UTC (Madrid is UTC+01:00). The operations after the Watchlist bootstrap and activation ([B, C1, C2 evidence](air-571-watchlist-bootstrap-and-activation-2026-11-22.md)). Every production operation below ran once, under its own owner GO on the card, with a fresh read-only preflight, an independent readback and no automatic retry; the operators were the existing owner-protected routes of the Worker (`POST /api/letterboxd/ratings/executor`, `POST /api/letterboxd/sync/mode`) behind Cloudflare Access, driven through the owner's Access login (the token and the login log were deleted after each use). Evidence only: nothing here authorizes a further operation.

## Result

**The Letterboxd Sync is the single Diary and Watchlist writer, on the four Madrid slots 04:30, 10:30, 16:30 and 22:30, and the schedule is open.** Mode `cloudflare`, epoch 1, revision 5, no canary hold; the legacy Ratings executor is `external` (epoch 2) and fenced; the Watchlist authority is `d1`/`open` at generation 3. Per the owner's acceptance decision of 23 Nov 2026 (one successful natural slot after `open_schedule` instead of four), the first such slot, `2026-11-23T1030`, finished cleanly. Open: the first natural daily EPG after the Watchlist switch (17:00 Madrid, 23 Nov 2026), Film admission of new ids in a natural slot, and the other three slots of the day, which are routine monitoring.

## Operations

| Step | UTC | Operation | Outcome |
|---|---|---|---|
| D1 | 22 Nov 17:42:57 and 17:43:12 | Ratings executor `close_admission` then `complete`, target `external` | `cloudflare` to `switching` to `external`, epoch 1 to 2, drain `verified`; run of that day finished, no live lease or instance |
| D2 | 22 Nov 18:02:43 and 18:02:55 | Letterboxd `close_admission` (pins epoch 0, revision 0) then `complete` with `slot 2026-11-23T1030` (pins epoch 1, revision 1) | `external` to `switching` to `cloudflare`, epoch 1, hold `canary:2026-11-23T1030`, one writer, legacy fenced |
| E | 22 Nov 18:13:50 (merge) and 18:16:20 (cron created) | [PR #911](https://github.com/vladimino/iptv-watchlist/pull/911), `wrangler.jsonc`: the Workflow `iptv-letterboxd` and the fourth cron `30 * * * *` | four crons (the first three with their original `created_on`), six Workflows; post-merge [run 45053872376](https://github.com/vladimino/iptv-watchlist/actions/runs/45053872376) success; the first `:30` tick answered `canary_hold`, delivered the root mirror and created nothing else |
| retarget 1 | 22 Nov 18:49:55 | `canary` to `2026-11-22T2230` (pins 1, 2), after [PR #913](https://github.com/vladimino/iptv-watchlist/pull/913) allowed an earlier target for a hold that cannot have been claimed yet (deployment `dbe9f72c`, post-merge [run 45056884646](https://github.com/vladimino/iptv-watchlist/actions/runs/45056884646) success) | revision 2 to 3, epoch unchanged |
| F1 (first) | 22 Nov 21:30:59 to 21:32:45 | natural slot `2026-11-22T2230`, instance `lbsync_20261122_2230_0` | slot `finished`, Ratings `finished`, Watchlist `committed` (snapshot v2, 394 films, no change of membership), reconciliation `done`, two Events delivered; **but** the causal effects `retention` and `removal_enqueue` of v2 stayed pending (see the defect) |
| fix | 22 Nov 22:05 (merge), 22:09:53 (deployment `4df83c15`, version `3f5b0c83`) | [PR #924](https://github.com/vladimino/iptv-watchlist/pull/924), resumable retention effect; the live script was read back and contains `retention-cursor` and `slicesPerCall` | post-merge [run 45075921293](https://github.com/vladimino/iptv-watchlist/actions/runs/45075921293) success |
| retarget 2 | 22 Nov 22:20:50 | `canary` to `2026-11-23T0430` (pins 1, 3) | revision 3 to 4 |
| F1 (repeat) | 23 Nov 03:30:59 to 03:38:54 | natural slot `2026-11-23T0430`, instance `lbsync_20261123_0430_0` | `finished`; Ratings `finished`; Watchlist `committed` (snapshot v3 `492275ae-450d-475e-8a91-d29880f41c2d`, 393 films, 1 removed: a film that the same run's Diary added with a rating, a real change); reconciliation `done`; two Events delivered 03:38:54Z; the pending v2 effects drained at the start of the slot and the v3 effects completed; `effects_drained_version` 3; the root mirror of v3 delivered by the 04:30 UTC tick |
| F2 | 23 Nov 04:38:43 | `open_schedule` (pins 1, 4); Time Travel bookmark before `00000b8f-00000086-0000512c-2cddd08a9f2c404957947b79013ec9ee`, after `00000b8f-0000008c-0000512c-f94e1a11a64f7dfc02569b99ccca28e7` | revision 4 to 5, hold removed, epoch unchanged, no extra run |

## The defect found by the first F1 and its fix

After the first natural slot the effects `retention` (attempts 1) and `removal_enqueue` (attempts 0) of snapshot v2 stayed pending and `effects_drained_version` stayed 1. Cause, reproduced offline with the real modules: the retention effect started from the first film on every call and handled at most 24 slices of 12 films (288), while its queue is the whole list (394 here, plus the departed), so for any list above 288 films every call ended `null`, and the drain, which runs before the scan, would have failed every later slot. The offline matrix had used stub writers. The fix keeps a resume point in the pending row's existing `receipt` column (`retention-cursor:<n>`), no migration; tests on the real repository and on the production numbers (394 films in two resumed calls) are in `tests/letterboxd-sync-effects.mjs`. In production the v2 retention completed on the next slot with attempts 3 in all (receipt `retention:lbrun-2026-11-22T2230-0:watchlist:394`), and the v3 retention with attempts 2 (the queue 394 is 393 listed and 1 departed), so the resumed path was exercised on real data.

## The first natural slot after `open_schedule`: `2026-11-23T1030`

Read-only receipt at 09:36 to 09:38 UTC (D1 `SELECT`s with `rows_written` 0, the Cloudflare API, `ratings_sync_status` and `epg_pipeline_status`):

- Slot `finished`/`done`, instance `lbsync_20261123_1030_0` `complete` (created 09:30:57Z, ended 09:32:15Z; the slot 09:30:59.726Z to 09:32:13.178Z), claimed by the natural `:30` tick with no hold; epoch 1. Ratings `finished`, Watchlist `no_change` (snapshot v3 unchanged, 393 films, freshness moved to 09:31:52Z), reconciliation `done`, no failure code, no quarantine.
- Exactly two Events, `ratings` and `watchlist`, `delivered` at 09:32:13.495Z with attempts 1, no duplicate, `eventsPending` 0, `overdueSlots` empty, `missedRecent` 0, `health` `healthy`, the Watchlist source not stale and without a warning.
- Effects of v3 `done`, `effects_drained_version` 3, no pending admission. The root mirror is `owed` for the new freshness token (the token is the snapshot id plus `last_success_at`, so a `no_change` scan that only moves the freshness is delivered too), the normal state until the next natural `:30` tick; it is not stale and has no failed attempt.
- One active writer (`letterboxdWriters` 1), the legacy Ratings entry `external` and fenced (epoch 2, `healthy`, no live lease); four crons and six Workflows unchanged; the Watchlist `d1`/`open`/3 and the published EPG `d1`/`open`/517 unchanged.
- Discovery `complete`, no recovery incident; the EPG programme run is the one of 22 Nov 2026 (`bf89ba90-07eb-46ac-9723-15d309517830`), the daily 17:00 Madrid run of 23 Nov is still ahead.
- Removal queue: `refIssues.event_missing` fell from 5 to 4 and `unresolved` from 5 to 4 (`removal.settled.resolved` 1): the entry of the removed film resolved in this run, so the counter did not keep growing.

## Not proven, limits

- The first natural daily EPG after the Watchlist switch (17:00 Europe/Madrid, 23 Nov 2026 = 16:00 UTC) reading the D1 snapshot; its result is the acceptance of the EPG side.
- Film admission of new ids and an added or removed film with an overdue 16:30 slot have no natural production receipt here; they rest on the offline adversarial tests and the earlier production receipts (the removal path above).
- Cloudflare runtime numbers (CPU, memory) and a Tier 1 scratch rehearsal were not measured or run; the observed wall time of a slot with a real change was about 8 minutes (03:30:59Z to 03:38:54Z) against about 1 minute 13 seconds without one. D1 `rows_written` of a changed promotion is a measurement (about 3 rows per member), not a gate, per the Workers Paid baseline.
- The three remaining slots of 23 Nov and 24 Nov 04:30 are routine monitoring and do not block acceptance (owner decision of 23 Nov 2026).

## Rollback

Not needed. Order if ever needed: `drain`; wait until `effects.drained` on a natural slot; `close_admission` toward `external`; the Watchlist data rollback of the [sync runbook](../../runbooks/letterboxd-sync.md); the Ratings executor back through its own route; the fourth cron and the Workflow registration removed by a deployment of the previous configuration. A code revert does not revert D1 state or the cron list; each step needs its own owner GO.

## Related evidence

[B, C1, C2](air-571-watchlist-bootstrap-and-activation-2026-11-22.md); [offline QA](air-571-offline-qa-2026-11-22.md); [GO packets and the scratch QA proposal](air-571-go-packets-and-scratch-qa-proposal-2026-11-22.md); the local Tier 0 harness `scripts/tier0-workerd-qa.mjs` ([PR #892](https://github.com/vladimino/iptv-watchlist/pull/892), [PR #895](https://github.com/vladimino/iptv-watchlist/pull/895)), whose results (real workerd D1 batch shape, the 100-parameter limit, 400 to 1,000 member promotions, compare-and-swap) are on the AIR-571 card.
