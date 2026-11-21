# Letterboxd Sync cutover: read-only preflight, gaps and proposed L3 plan

Date: 21 Nov 2026, reads taken between 15:05 and 15:17 UTC (16:05 to 16:17 Madrid, UTC+01:00). Scope: [AIR-571](https://trello.com/c/b6UrtwUG), step 1 (L0 read-only inventory), step 2 (offline gap analysis) and step 3 (the L3 plan for the owner). **This page authorizes nothing.** No migration, bootstrap, marker switch, binding, cron, flag, Task, manual run or write was made. Code under review: `main` at `a24380c` (the dormant executor of [ADR 0186](../../adr/0186-letterboxd-sync-and-independent-watchlist-authority.md) is merged as `d6a7b10`, [AIR-570](https://trello.com/c/JSXgFWzp)).

## 1. What was read, and how (all read-only)

| Source | Statement or call | Writes |
| --- | --- | --- |
| Production D1 `iptv`, through the Cloudflare D1 query connector | `SELECT` only: `schema_contract`, `sqlite_master` names, one `SELECT *` per authority marker table | none (`changed_db: false`, `rows_written: 0` in every reply) |
| Cloudflare API, `GET` only | `/accounts/<id>/workers/scripts/iptv/schedules`, `/accounts/<id>/workflows` | none |
| Cloudflare documentation search | the cron trigger and Workflow limits pages | none |
| Trello and GitHub | card, comments, checklist; `main`, PR and CI state | none |

The owner-only MCP reads of the same afternoon (`probe_read`, `epg_status`, `ratings_sync_status`, `epg_pipeline_status`, `feature_flags`) are quoted from the card comment of 21 Nov 14:08 UTC and were not repeated.

## 2. Observed production state

| Fact | Value |
| --- | --- |
| `schema_contract.version` | **30** (`Schema v30: EPG checkpoint authority. Marker mode r2 until a separate activation.`). The tables `epg_checkpoint_authority`, `_body`, `_cas`, `_film`, `_receipt`, `_run` exist. The AIR-551 package of 12:04 UTC recorded schema 29, so the schema-only apply of 0030 happened after it |
| Tables of 0031, 0032 and 0033 | **absent**: no `watchlist_authority`, `watchlist_cas`, `watchlist_current` and siblings, no `epg_channel_*`, no `letterboxd_sync_*` or `letterboxd_slot*` (the single `watchlist_film` table is the older canonical Film membership, unrelated) |
| `epg_checkpoint_authority` | `mode r2`, generation 0, writes `open`: **the EPG checkpoint is still R2-authoritative** |
| `film_person_authority` | `d1`, `open`, generation 2 |
| `published_epg_authority` | `d1`, `open`, generation 515, programme run `984821d8-397f-488b-883f-9be48a9a84c1`, `finalized_run_id` equal to it, `finalized_at 2026-11-20T16:11:46.683Z` (a certified run) |
| `ratings_domain_authority` | `d1`, `open`, generation 4193 |
| Worker `iptv` cron triggers | exactly three: `0 * * * *`, `1-59/2 * * * *`, `24 3 * * *`. **No `30 * * * *`.** Identical to `wrangler.jsonc` |
| Workflows of the account | `iptv-discovery` 665 complete; `iptv-epg` 13 complete, 1 terminated; `iptv-ratings` 7 complete; `iptv-producer` **120 errored, 0 complete** (the known finding of the AIR-549 canonical Watchlist Film audit, PR 842: `step.do.bind(step)` before the first Workflow step). **No Letterboxd Workflow exists** |
| Card comment of 14:08 UTC | EPG idle with the previous run complete, next due 17:00 Madrid; Ratings idle, previous daily run finished, authority open; Discovery complete and settled; `MONITOR=on`, `MONITOR_TRANSPORT=telegram` |

Not read, and therefore not claimed: the exact deployed Worker version, Workflow instance liveness at the time of a future holdpoint, the content of the R2 `watchlist.json` mirror, the size of the Event backlog.

## 3. Verdict on the open question O1 (a fourth cron trigger)

The Cloudflare limits page gives the number of Cron Triggers per **account**: **5 on Workers Free, 1,000 on Workers Paid**. This Worker holds three. A fourth (`30 * * * *`) is therefore allowed on Paid, and on Free only while no other Worker of the account holds a cron. The plan type and the crons of other Workers were not read, so the verdict is **allowed, with the plan to be confirmed at holdpoint E** (a read-only `GET` of the account). Option E of the ADR (isolating `ensure` inside the hourly tick) stays the documented fallback and is not needed on this evidence.

## 4. Findings that decide the plan

1. **The prerequisite O4 is not met.** The EPG checkpoint marker is `r2` at generation 0. [AIR-551](https://trello.com/c/YAVPlcAe) has applied the schema only; its hold, import, activation and the **natural EPG run after the activation** are still ahead. ADR 0186 decision 8.3 requires them first, and the card checklist carries AIR-551 as incomplete. Until then AIR-571 may prepare, and nothing else.
2. **The migration chain has a cross-card dependency.** `0033` requires schema 32; `0032` is the EPG Channel authority of [AIR-561](https://trello.com/c/K98arHAG) (its apply belongs to its own card and its own owner GO); `0031` requires exactly 30, which production now is. The Letterboxd tables therefore cannot be applied before `0031` and `0032`. This needs an owner decision (section 7, D1).
3. **There is no operator for any of the production steps.** The repository holds the dormant repository, Workflow and ports; it does not hold: a schema apply with an inventory preflight for 0031/0033, the **bootstrap import** of the last good published Watchlist into snapshot version 1 with count, order and digest parity, the **marker hold, switch and release** of `watchlist_authority`, the **Letterboxd mode switch** (`close_admission` and `complete` exist as functions without any route or tool), the **Ratings close and drain proof** as an executed step, or the Workflow binding and cron change. AIR-551 shows the pattern that is needed (a fail-closed owner operator with a read-only default, a confirmation token per command and readbacks). Building these is code and tests, a separate card (section 7, D2).
4. **The handover proof is real, and refuses by default.** `letterboxdHandover` reads live state: the Ratings mode is `external` and drained, the legacy `ratings_sync_start`/`step` gate answers `external_writer_fenced` (true only while the Letterboxd mode is `switching`), the Watchlist authority is an open `d1`, the three ports exist. With the tables absent every item is false, so `complete` to `cloudflare` is refused today (`handover_not_proven`).
5. **`iptv-producer` is not healthy** (120 of 120 instances errored). The Letterboxd admission path does not use that Workflow (it calls the canonical rated-admission writers), but the "immediate join" of a new Film into the visible Watchlist needs a trusted identity and the producer is the path that attaches canonical Films to programme members. This is independent of AIR-571 and is a risk to the acceptance of the Film/Discovery criteria.

## 5. Offline coverage against the ADR 0186 matrix and the card

What the repository proves today, by file. "Static" means the source of the module is checked not to name EPG, Discovery or resolver state; "vm" means the real bundled Worker on the full migration chain with a fake Letterboxd.

| Scenario of the card or the ADR | Status | Evidence |
| --- | --- | --- |
| Four Madrid slots, DST forward and back, no missed or doubled slot, same-slot replay, duplicate cron | **covered** | `tests/letterboxd-sync.mjs` (slots), `ensure` under duplicate and concurrent ticks |
| Diary down with Watchlist up and the reverse; incomplete scan; both rate limited; no-op still emits both Events | **covered** | `tests/letterboxd-sync.mjs`, `-watchlist.mjs`, `-bundle.mjs` |
| Exactly two Events per slot, create-only keys, loss of one Event persisted and replayed, no third Event | **covered** | outbox tests in `-sync.mjs`, `GET /api/events` in `-bundle.mjs` |
| Half-star Ratings contract, removed film with its stored rating, no invented removal cause | **partly** | the Event contracts are covered; `explainedBy` is a field the payload may carry and is not produced by the current phases |
| Partial page abort deletes nothing, 1-for-1 swap, large removal published, page 1 changed on the repeat read | **covered** | `tests/letterboxd-sync-watchlist.mjs`, `-repository.mjs` |
| No page truncation, baseline parity of ids, order and digest | **gap** | the bootstrap import does not exist, so its parity cannot be tested (finding 3) |
| Unknown outcome of the promotion batch (T13), staging isolation (T20), effects journal order (T18, T19) | **covered by AIR-569** | `tests/watchlist-d1.mjs` |
| Old Ratings writer fenced, in-flight step refused by the epoch, rollback restores one writer (T17, T30) | **covered** | the gate and epoch tests in `-sync.mjs`, `letterboxd-sync-fence.mjs`, the in-flight mode flip in `-bundle.mjs` (zero stale mutations) |
| EPG pins the last committed snapshot, never calls Letterboxd, 6/12/18/24 h age, `watchlist_stale` only above 24 h | **covered in the Worker**, partly | `tests/watchlist-worker.mjs` (one read, no Letterboxd, refusals); the age table of T4 is the read model of `-sync.mjs` and the staleness helper of `watchlist-d1.mjs`, not one end-to-end test |
| 16:30 slot still running at 17:00, commit after the EPG read affects only the next EPG | **gap** | no test starts an EPG run while a Letterboxd instance holds an uncommitted promotion |
| The four combinations: EPG checkpoint `r2`/`d1` times Watchlist `epg`/`d1` | **gap** | `watchlist-worker.mjs` runs with the checkpoint tables present but never switches the checkpoint marker; `epg-checkpoint-*.mjs` never switch the Watchlist marker |
| An EPG run in flight when the Watchlist marker flips; failing R2 mirror at the flip (writer drain and fence) | **gap** | not tested; this is the scenario the card and the review call an AIR-571 L3 gate |
| Concurrent admission of one new id by Letterboxd Sync and Discovery or the ratings bridge (T1, T22 concurrent half) | **gap** | the ledger and the step are tested with a fake identity bridge; two real writers on one Film are not |
| A Letterboxd step neither waits for nor reads a Discovery lease or the EPG pause (T2) | **static only** | the source regex tests; no dynamic test holds a lease while a slot runs |
| Cloudflare CPU, wall and memory of a slot; D1 statements of a 700-row promotion | **unmeasured** | the sqlite stand-in has no budgets. AIR-551 measured its own batches on a scratch D1; nothing equivalent exists for the Watchlist promotion (an ADR 0186 open item) |
| Mirror reconcile and root `watchlist.json` standalone read (T21, T24) | **partly** | the readers are tested in `watchlist-worker.mjs`; the independent mirror reconcile writer named by the ADR (decision 1) is **not implemented** by AIR-569 or AIR-570 (the Event outbox and the effects are; the R2 mirror target, its retry and `mirror_stale` are not) |
| Four natural slots observed with two independent outcomes each | **not testable offline** | acceptance criterion F |

The last "partly" row is a real implementation gap and not a test gap: nothing in the repository writes the `watchlist.json` compatibility mirror from the current snapshot. Until it does, the root mirror stays what the EPG publication writes, and the "standalone mirror" semantics of ADR 0186 decision 8.6 are readable but not produced.

## 6. Proposed L3 plan (a table of holdpoints; nothing here is approved)

Each row needs its own explicit owner GO. A holdpoint is not started until the previous one has been read back. No row is started before the prerequisites of finding 1.

| # | Holdpoint | Actor and exact action | Readback and receipt | Stop condition | Rollback |
| --- | --- | --- | --- | --- | --- |
| P | **Prerequisites** | AIR-551 reaches Done: marker activated and at least one natural EPG run observed (ADR 0186 O4) | EPG checkpoint marker `d1`/`open`; a certified natural run after the activation | AIR-551 not Done | not applicable |
| A | **Schema** | One owner-run operator command per migration, only the missing ones, in order: `0031` (needs v30), then `0032` by its own card's GO, then `0033` (needs v32). Marker rows are inserted dormant: `watchlist_authority` as `epg`, the Letterboxd mode table empty | `schema_contract.version`; the table inventory of each file; the marker rows | any difference between the inventory and the file; a refused guard | the tables are additive and inert; a schema apply is not reverted, it stays dormant |
| B | **Bootstrap** | Import the last good published Watchlist (the `watchlist` part of the certified generation 515 or its successor) into snapshot **version 1**: no change, effect or ledger rows | count, ordered ids, list digest equal to a read of `GET /api/watchlist` taken at the same generation; `watchlist_current.version = 1` | any difference of count, order or digest; the generation moved between read and write | delete is not available: the import is idempotent by digest and the marker is still `epg`, so a wrong snapshot is ignored |
| C | **Watchlist marker** | Hold writes; switch `watchlist_authority` to `d1` with `generation + 1`; release. Before it: prove no EPG run is in flight, or drain it, and that the R2 mirror writer is closed (the failing-mirror scenario) | the marker rows; one natural EPG read of the snapshot; no second membership writer | an EPG run in flight; the mirror writer not closed; a snapshot that fails its digest | the owner data rollback of ADR 0186 decision 8.5 (close, hold, export the snapshot into the generation, readback, marker back to `epg` with `generation + 1`) |
| D | **Writer handover** | Close the Ratings `ensure` with the existing three-step mode switch to `external` and prove the drain; then `close_admission` to `cloudflare` for the Letterboxd mode (this fences the legacy `ratings_sync_*` entry), then `complete` | `letterboxdHandover` all true; the Letterboxd mode `cloudflare` at its epoch; Ratings mode `external` | any false item; a live Ratings instance | `close_admission` to `external`, `complete`; the legacy writer is admitted again |
| E | **Binding and cron** | A deployment that adds the `LETTERBOXD_WORKFLOW` binding and the cron `30 * * * *`; the account plan is read first (section 3) | `GET` of the schedules and the Workflows list | the plan does not allow a fourth cron; a fourth cron changes the existing three | redeploy without the trigger; the mode and the rows stay |
| F | **Canary, then four slots** | Nothing is run by hand. One natural slot is watched, then the four slots of a day, with the monitor, the two Events per slot and `GET /api/events` | per-slot read model, Events, the 17:00 EPG and Discovery health, the 24 h warning clear | a missed or failed slot; an EPG or Discovery regression; a duplicate Event | stop new slots (close admission), keep the last good snapshot, restore the legacy writer by D, keep the data |
| G | **Retirement** | A separate owner decision after stabilization: retire the daily Ratings scheduling contract and the ADR 0101 qualification, or keep them | the follow-up card | none | none |

No two authority cutovers share a window: B and C are not in the same window as the AIR-551 activation, and D is not in the window between 16:30 and 17:00.

## 7. Decisions the owner is asked for

- **D1 (migration order).** Apply `0031`, `0032` and `0033` in that order, each on its own GO, which makes AIR-571 wait for the apply of AIR-561's `0032` (its own card); or renumber the unapplied `0033` to follow `0031` directly, which changes a merged but unapplied file and the tests that pin the chain. Recommendation: the first, because the file is inert and the order is already pinned in main.
- **D2 (operator tooling).** Approve one implementation card for the owner-only operators of holdpoints A to E (schema apply with the inventory preflight, the bootstrap import with parity, the Watchlist marker hold, switch and release, the Letterboxd mode switch and the Ratings close proof, the binding and cron deployment guard), with the pattern of the AIR-551 operator. Recommendation: yes, before any GO.
- **D3 (the missing mirror writer).** Decide whether the independent `watchlist.json` mirror reconcile of ADR 0186 decision 1 is part of AIR-571's prerequisites (recommended: yes, a small implementation card, because the failing-mirror scenario needs its writer to drain) or a later slice with the root mirror left to the EPG.
- **D4 (adversarial tests).** Approve the offline tests of the gap rows of section 5 (the four combinations, an EPG run in flight at the marker flip, the failing mirror, a 16:30 run delayed past 17:00, a concurrent admission) as part of the same implementation card or its own.
- **D5 (measurements).** Approve a scratch-D1 measurement of the Watchlist promotion (700 rows) and one slot's Worker CPU and wall time before holdpoint E, in the manner of AIR-551's H-0a.

## 8. GO / no-GO

**Historical verdict at the time of the reads (15:05-15:17 UTC): No-GO for any production operation.** It is superseded only for the schema-only apply of `0031`, by the later owner GO of 15:23 UTC recorded in [the 0031 apply evidence](air-571-0031-apply-2026-11-21.md); every other operation stays No-GO. The reasons at the time: Reasons: the prerequisite AIR-551 cutover is not complete (finding 1), the migration order depends on a second card (finding 2), and the operators and the mirror writer do not exist (finding 3 and the last row of section 5). **GO** is asked only for the preparation work of D2 to D5 (repository code, tests, docs, a scratch measurement), none of which touches production.

## 9. Uncertainty

Reads were single point-in-time observations of production at about 15:10 UTC; a later cut can differ (the EPG run due at 16:00 UTC and any AIR-551 step). The cron limit is quoted from the documentation, not measured. The coverage table is a reading of the repository at `a24380c` and names a file only where this session ran it; a "covered" row means a test exists, not that production behaves so.
