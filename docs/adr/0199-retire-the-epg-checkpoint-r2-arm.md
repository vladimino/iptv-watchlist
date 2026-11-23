# ADR 0199: The R2 arm of the EPG checkpoint is retired for production; recovery is roll-forward in D1

**Status:** Accepted  
**Original decision date:** 2026-11-22  
**Recorded at:** 2026-11-22  
**Approval source:** [owner decision, option A approved on 22 Nov 2026, recorded in the AIR-551 card](https://trello.com/c/YAVPlcAe#comment-6b032ac86f439fb88caed8be) and on [PR #906](https://github.com/vladimino/iptv-watchlist/pull/906#issuecomment-7083117664), after the [independent follow-up review](https://github.com/vladimino/iptv-watchlist/pull/906#pullrequestreview-6013510587) that presented options A and B. The preparation was authorized by the AIR-551 card comment of 22 Nov 2026 16:19 UTC.  
**Related work:** [AIR-551](https://trello.com/c/YAVPlcAe); [ADR 0185](0185-epg-checkpoint-d1-authority.md) (decisions 7 and 8); [ADR 0162](0162-d1-only-authority-retire-rollback-toolchain.md); [ADR 0189](0189-h0-checks-compatible-deployment-not-version-equality.md); the [cutover evidence](../evidence/d1-migration/air-551-checkpoint-cutover-2026-11-21.md) and the [H5 evidence](../evidence/d1-migration/air-551-h5-natural-run-2026-11-22.md); the [EPG checkpoint runbook](../runbooks/epg-checkpoint-d1.md)  
**Supersedes:** None. It executes the retirement that ADR 0185 decision 7 reserved ("the R2 arm stays in code only until AIR-551 retires it after acceptance; afterwards recovery is roll-forward in D1") and replaces the data-rollback procedure of that decision for production.  
**Superseded by:** None

## Context

The EPG run checkpoint (`sync.json`) and the watchlist ingest status (`watchlist-ingest.json`) became D1 rows on 21 Nov 2026 (marker `epg_checkpoint_authority` `d1` / `open` / generation 2) and the first natural run on D1 on 22 Nov 2026 completed with the rows as the only writer and the frozen R2 objects unchanged (H5, accepted). Until now the Worker still served the R2 objects when the marker said `r2`, or when the tables were absent below schema 30, and the operator carried a four-command data rollback (hold, export to R2, revert the marker to `r2`, release). That arm was kept only as the rollback target of the cutover.

After the first run on D1 the frozen R2 objects are stale by a full run and growing. A rollback to them would resurrect a past checkpoint, and the marker `r2` is the only way production could ever read them again. The other domains that left R2 were retired the same way ([ADR 0162](0162-d1-only-authority-retire-rollback-toolchain.md)).

## Decision

1. **Production serves the two keys only at marker `d1`.** `readAuthority` in `src/epg-checkpoint-d1.js` answers `closed` for marker `r2` and for tables absent (whatever the schema version says), as it already did for every other unreadable state. `closed` refuses every read and write of the two keys (`epg_checkpoint_unavailable`) and never reads or writes R2. `d1` with writes `held` keeps its meaning (reads serve, writes refuse).
2. **The explicit local stand-in is unchanged.** `EPG_CHECKPOINT_DB_OPTIONAL=standin`, never set in production, keeps serving the R2 objects for development and for the offline tests of the unchanged R2 code path. The code of that path stays because the stand-in uses it; deleting it is a cleanup that needs no production decision and is not part of this record.
3. **The four rollback commands of the operator are retired at the command line.** `--hold-rollback`, `--export-rollback`, `--revert-authority` and `--release-rolled-back` refuse with `retired_after_h6` once their arguments are complete, because a rollback that ends at marker `r2` would leave production closed. The offline suite still exercises their logic through `execute`. `status` stays and the executed forward commands stay as the record of the cutover.
4. **Recovery is roll-forward in D1.** A defect is fixed by a new Worker version; a data defect by a fenced, owner-approved operation on the D1 rows or by a Time Travel restore ([D1 authority recovery runbook](../runbooks/recovery/d1-authority-and-time-travel.md)). A code rollback reverts no row or marker and must not go back to a version that predates the cutover (it would read the stale R2 objects).

Not decided and not authorized: deleting or modifying the frozen R2 objects, removing the operator's rollback code, any Cloudflare binding or setting, any production write or run. Merge and deploy authorize none of them.

## Alternatives considered

- **Keep the R2 arm and the rollback toolchain until a later cleanup (option B of the review).** Rejected by the owner on 22 Nov 2026: the retained path serves a stale checkpoint if the marker is ever set to `r2`, and the plan of AIR-551 (step H6) is to retire it after acceptance.
- **Delete the R2 arm entirely, including the stand-in.** Rejected: the stand-in is the local development and test path and is not a production route.
- **Keep the rollback commands but make the Worker serve R2 at marker `r2`.** That is the arm being retired.

## Consequences

- A marker that is not `d1` is now an outage with a typed error (visible in `epg_status` and the route errors) instead of a silent serve of stale data. The failure is loud and recoverable by the owner-approved fenced operation; it cannot corrupt data.
- The emergency capability "restore the checkpoint to the R2 objects and run from R2" no longer exists in production. The owner accepted this on 22 Nov 2026. Measured residual risk of the D1 path that the H5 evidence could not read (Worker CPU and memory per invocation, the largest film entry, D1 round trips per step) is unchanged by this record.
- `published_epg_authority` certification still has a branch for a checkpoint marker that is not `d1`; it is reachable only through the local stand-in.

## Recovery and migration boundary

Merging and deploying this change writes nothing and changes no marker. It is reversible by a code change (restore the previous `readAuthority` and the four commands) as long as the marker is `d1`; it does not restore any data. Any production operation keeps its own owner approval.

## Evidence

- **Original decision:** the AIR-551 card comment of 22 Nov 2026 16:19 UTC (H6 preparation) and the owner decision of the same day (option A).
- **Implementation:** the pull request that adds this record (`src/epg-checkpoint-d1.js`, `scripts/epg-checkpoint-production.mjs`, offline tests, documentation).
- **Dated verification:** offline tests only (the full core suite). No production observation is part of this record.
- **Uncertainty:** per-invocation Worker CPU and memory, the largest film entry and D1 round trips per step on the D1 path are not measured.

## Follow-ups

Removal of the unused R2 code path and of the operator's rollback code, deletion of the frozen R2 objects and the cleanup of the remaining Cloudflare settings are separate owner decisions, if wanted.
