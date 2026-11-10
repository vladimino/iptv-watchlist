# AIR-414: EPG mirror reconciliation moved off GET (offline)

**Date:** 2026-11-10 (UTC)  
**Scope:** code and tests on the AIR-414 branch; no production Worker, R2 or D1 write.  
**Method:** read the GET call sites, `PublishedEpg.repairMirrors`, `EpgOrchestration.ensure` and the GET/HEAD audit baseline; change those paths; run the local suite.  
**Trello:** [AIR-414](https://trello.com/c/GJefgNm8)

## Result

- GET/HEAD helpers (`loadJSON`, `epgPublication`, `adminD1Programme`) no longer call `PublishedEpg.repairMirrors`.
- `currentGeneration()` returns `mirrorWatchlistEtag`. An aligned `repairMirrors` writes nothing.
- `EpgOrchestration.ensure` runs `reconcileMirrors` on every hourly tick, including when the daily publication is not due. It skips a live step lease, a switching mode, a held cutover and an unreadable lease.
- The GET/HEAD audit baseline entries `epg-mirror-repair-pin`, `epg-mirror-repair-presentation` and `mcp-prediction-overview-pin` are deleted; mixed entries no longer list the mirror marker. Remaining GET writers are the ratings-seed overlay and prediction run/event recovery.

## Limits

Not a production observation. Deploying the change would start the light reconcile on the existing `0 * * * *` cron; that deploy is not this report and authorizes no extra EPG, TMDB or discovery run.

## Verdict

Offline contract for AIR-414 holds in tests. Production lag after deploy is not measured.
