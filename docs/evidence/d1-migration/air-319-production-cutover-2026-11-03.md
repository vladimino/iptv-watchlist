# AIR-319: D1 published EPG production cutover, 3 November 2026

**Verdict, observed at approximately 2026-11-03 07:38 UTC:** **D1 schema and authority activation confirmed by operator; partial independent smoke checks PASS; full acceptance PENDING.** This report authorizes no writes, extra sync, discovery, retry, task change, or next migration.

## Approved operator execution

The [AIR-319 handoff, 08:08 Madrid](https://trello.com/c/pQL8NUTC#comment-6ae9889676deb75637f0a289) reports distinct prior owner approvals for these actions:
- Around 06:23 UTC, initial `--apply` refused before SQL due to a live resolver lease. The later permitted attempt applied schema v8; marker remained `r2/open`, generation 0, null programme run.
- Around 06:30 UTC, `--load` copied the existing programme/watchlist generation into D1: generation 1 and watchlist generation 1, still `r2/open`.
- Around 06:57 UTC, after acknowledging producer drain and verifying idle leases, `--activate --confirm activate --target iptv --producers-drained` succeeded. Operator readback: `published_epg_authority.mode=d1`, `cutover=open`, `generation=1`, `watchlist_generation=1`, `programme_run_id=71820185-3cc1-4303-b674-14293dca938b`. At 07:08 UTC the operator confirmed the unchanged marker, idle sync/resolver/projector, and restored `D1_ENRICHMENT_WRITE=on`. No `0009`, revert or hold-recovery operation was performed.

These are **operator-reported D1 SQL results**, not a second direct coordinator query.

## Independent limited readback

The coordinator's existing owner-only IPTV MCP tools returned:
- `epg_status`: HTTP 200, stage `complete`, remaining 0, failures 0, same run id; its timestamp `2026-11-02T16:14:18.313Z` precedes activation.
- `epg_pipeline_status`: the same programme run id and `generationConflict=false`. R2 Discovery continuation was `orphaned` with an expired lease after an interrupted chunk; this is a separate discovery finding, not proof of D1 EPG publication failure.
- `prediction_queue_overview`: the same published run id, consistent true, partial false, 3011/3011 current predictions (100%).
- `feature_flags`: D1_ENRICHMENT_WRITE on; DISCOVERY_EXECUTOR absent, effective external.
- Already-opened production homepage and `/admin/health` browser tabs last opened after activation (about 07:20 UTC) displayed generation prefix `71820185` and 397 programme films. This is UI snapshot evidence, not raw HTTP document parity or independent D1 SQL mode verification.

The daily EPG Scheduled Task was enabled for 17:00 Europe/Madrid. Its last recorded attempt was scheduled for 2 November and marked `failed` in the ChatGPT task registry, while the corresponding Worker EPG state was `complete` with zero EPG failures; the stored task result described an incomplete/waiting Discovery continuation. These are distinct outcomes. The last published EPG run is **before** the D1 cutover, so the first naturally scheduled post-cutover EPG publish is **not yet verified**.

## Safety and outstanding acceptance criteria

The current Worker `src/worker.js` uses `PublishedEpg.repairMirrors` for `GET /api/programme` and `GET /api/watchlist`. In D1 mode, `src/published-epg.js` may repair R2 compatibility objects and update D1 mirror metadata. These HTTP GETs are not guaranteed read-only. The coordinator did **not** invoke them as unauthorized acceptance probes, so no direct document equality or pin-consistency acceptance can be claimed. A separate explicitly permitted bounded inspection or operator-produced read-only result is required, with any possible mirror repair acknowledged.

Do not close AIR-319 until: (1) the first natural post-cutover EPG commit publishes an actual new D1 generation, (2) coherent programme/watchlist/show/availability and relevant consumers are checked without stale R2 fallback or mixed generations, (3) technical documentation/evidence are accepted, and (4) any observed discovery continuation concern is dispositioned appropriately without unauthorized recovery. Preserve the readback limits in the final report.

This report has **no production writes**. It does not authorize 0009 (owner reviews), AIR-320 (Discovery D1 cutover), AIR-324 Workflow activation, manual EPG/sync, recovery, lease resets, or changes to R2/D1 flags or Tasks.
