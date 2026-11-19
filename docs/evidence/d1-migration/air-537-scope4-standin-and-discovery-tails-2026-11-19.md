# AIR-537 slice 4: stand-in, producer skip and Discovery D-1 tails, audit and decision brief, 19 November 2026

**Trello:** [AIR-537](https://trello.com/c/wbe7jjNs). **Basis:** [AIR-79 final retirement audit](air-79-final-retirement-audit-2026-11-18.md), scope item 4; earlier slices: [1](air-537-discovery-installer-retirement-2026-11-18.md), [2](air-537-film-person-operator-tooling-retirement-2026-11-18.md), [3](air-537-enrichment-projector-retirement-2026-11-19.md). **Captured:** 19 November 2026 (UTC) on `main` `98aa110`. Static audit only: no code change, no production read or write, no recovery, no run.

## Verdict

Nothing in scope item 4 can be removed without an owner decision, and this slice removes nothing. Every tail the audit named is **reachable in production only through the explicit local stand-in family** (`*_DB_OPTIONAL=standin`, never set by `wrangler.jsonc`) or is a live fail-closed guard. They are one question, not several: *is the local stand-in family a kept developer and test contract?* The default is `retain`; the decision brief is at the end.

## What the callgraph proved

- The Film/Person marker is `d1`/`open`; there is no SQL path back to `r2` or `prepared` ([ADR 0162](../../adr/0162-d1-only-authority-retire-rollback-toolchain.md)). `readAuthority` in `src/discovery-authority.js` returns a non-`ready` gate **only** for `DISCOVERY_DB_OPTIONAL=standin` on a database where the domain is not installed; in every other state (missing binding, broken install, marker not `d1`/`open`, `held`) it throws `discovery_unavailable`. `src/film-person-authority.js` has the same shape: `FILM_PERSON_DB_OPTIONAL=standin` answers `legacy` (R2 allowed) only for a domain that is not installed.
- The stand-in family has five domain flags in `src/` (`FILM_PERSON_DB_OPTIONAL` 2 reads, `DISCOVERY_DB_OPTIONAL` 3, `PUBLISHED_EPG_DB_OPTIONAL` 3, `METADATA_CACHE_DB_OPTIONAL` 2, `OWNER_REVIEW_DB_OPTIONAL` 2), all set together by `scripts/local-dev.mjs` and by the shared test helper `tests/local-standins.mjs`; `PREDICTION_DB_REQUIRED` and `RATINGS_DB_REQUIRED` are separate switches outside this audit. `FILM_PERSON_DB_OPTIONAL` appears in 10 tests, `METADATA_CACHE_DB_OPTIONAL` in 8, `DISCOVERY_DB_OPTIONAL`, `PUBLISHED_EPG_DB_OPTIONAL` and `OWNER_REVIEW_DB_OPTIONAL` in 2 each.

## A. Film/Person stand-in and producer skip tails

| Symbol or path | Callers | Production reachability and behaviour | Disposition |
| --- | --- | --- | --- |
| `FILM_PERSON_DB_OPTIONAL` (`src/film-person-authority.js`, `scripts/local-dev.mjs`) | `readAuthority`, local dev, 10 tests | Never set in the deployed configuration; production without the table or with a broken marker is refused. | **Retain** (owner gate 1). |
| `legacy()` gate with `r2Allowed:true` (`src/film-person-authority.js`) | the stand-in branch | Only produced for an uninstalled domain under the stand-in. | **Retain** with the stand-in. |
| `r2Allowed` in `src/worker.js` (the R2 read guard) | the Worker | **Live fence**: it refuses an R2 read unless the marker allows it, so at `open` the guard answers `film_person_not_open_read` and at `held` `film_person_held`. | **Retain** (live fail-closed guard). |
| `r2Allowed` in `src/canonical-writer-route.js` and `src/canonical-producers.js` (`projectorFence`) | `writerRoute` and every producer | The branch names a `projector` writer that no longer exists; reachable only for `legacy`/`r2`/`prepared`, none of which production can be in. `held` and unreadable markers do **not** take it: they throw `film_person_held` / `film_person_unavailable`. | **Retain** (semantics behind owner gate 1); the label is stale, see the brief. |
| `routeOf` returning `{open:false}` and `SKIPPED = {state:'skipped',reason:'projector_is_writer'}` (`src/canonical-producer-chain.js` 11 call sites, `src/canonical-producer-store.js` 9) | every producer flow | The skip is taken only when `writerRoute` is not `canonical`, i.e. never at `open`. It is a no-write guard for the non-open states the stand-in can produce. The reason string appears in 14 `src/` modules and 3 tests and in no UI or monitor contract found. | **Retain**: not removable by name, it is the write guard of a live code path. |
| `routeSkipMs` and its per-binding cache (`src/canonical-discovery-admission-producer.js`) | `admitDiscoveryFilms`, 1 test | Caches the skip decision so a closed route does not re-read the marker on every admission; idle at `open`. | **Retain** with `SKIPPED`. |
| `canonicalMirrorsWritable` and the frozen R2 mirror fences | EPG and Film/Person paths | Live. | **Retain**, unchanged. |

## B. Discovery D-1 R2 key families

The four keys are used as **key-name façades**: `loadJSON(env,'epg/resolver-lease.json')` and the others are intercepted by `DiscoveryAuthority.routeRead`/`routeWrite` (`src/discovery-authority.js`) and served from D1; R2 is read or written only under the stand-in. The names are therefore not dead literals.

| Key | Readers and writers on `main` | Production reachability | Disposition |
| --- | --- | --- | --- |
| `epg/resolver-lease.json` | `src/discovery.js`, `src/discovery-workflow.js`, `src/monitor.js`, `src/discovery-authority.js` (D1 lease), `scripts/published-epg-production.mjs` (operator read), `scripts/r2-snapshot-export.mjs` (`FENCE_KEYS`), `src/offline-importer.js` (family), 26 tests | D1 lease; the R2 object is a frozen copy. | **Retain**: live façade plus read-only operator and offline consumers. |
| `epg/resolver-continuation.json` | `src/discovery.js`, `src/admin/discovery-recovery.js`, `src/monitor.js`, `src/enrichment.js` (status), `src/discovery-authority.js` (D1 continuation), 32 tests | D1 continuation; also read by the fast recovery cron path ([ADR 0174](../../adr/0174-discovery-only-fast-recovery-cron.md)). | **Retain**. |
| `epg/discovery-workflow.json` | `src/discovery-workflow.js`, `src/discovery.js`, `src/discovery-authority.js` (D1 workflow row), 7 tests | D1 workflow state. | **Retain**. |
| `epg/discovery-resolution.json` (decisions map) | `src/discovery-authority.js` (D1 decisions), `src/enrichment.js` (read only when the D1 authority is not ready), `src/admin/discovery-recovery.js` (R2 branches), `src/offline-importer.js`, 50 tests | D1 decisions; the R2 object is frozen at the cutover. | **Retain**: frozen mirror and offline importer consumers; the R2 write branches are in section C. |

## C. Admin recovery writers with an R2 variant

`src/admin/discovery-recovery.js` has three owner capabilities. For each, the route first reads `DiscoveryAuthority.readAuthority(env)`: `if(gate.ready)` it runs the D1 path, otherwise the legacy R2 path. **Production is always `ready` or refused**, so the R2 variants run only under `DISCOVERY_DB_OPTIONAL=standin`.

| Capability | D1 path (live) | R2 variant (stand-in only) | Disposition |
| --- | --- | --- | --- |
| `discovery_reconsider` (DR) | `drConfirm` (gate branch at 313) and `drExecuteD1` through `DiscoveryAuthority.putIntent`/`ownerDecision` | `drConfirm` R2 branch and `drExecute` R2 branch: put of `admin/actions/discovery_reconsider/v1/<key>.json`, CAS put of `epg/discovery-resolution.json`, observation manifest CAS in `drRefreshIndex` | **Retain** (owner gate 2). |
| `discovery_identity_correct` (DI) | `diConfirm` (gate branch at 609) and `diExecuteD1` | `diConfirm` R2 branch and `diExecute` R2 branch: action receipts, CAS put of `epg/discovery-resolution.json` (line 784), shard and manifest CAS in `diCommitShard`/`diRetarget`/`diInsertRecord` | **Retain** (owner gate 2). |
| `catalog_policy_exclude` (PE) | `peExecute` and `pePreview` already **refuse** (`unknown_authority`) unless the gate is `ready` | none | Already D1-only; **retain**. |

These are the four R2 write variants of the audit (DR confirm and execute, DI confirm and execute). None is reachable from the hourly cron, the fast recovery cron or the Workflow; they are owner-only routes behind Cloudflare Access. Removing them leaves production behaviour unchanged but removes the local-development and test recovery path for those capabilities.

## Owner decision brief

**The question** (one decision covers gates 1 and 2): is the `*_DB_OPTIONAL=standin` local stand-in family a kept developer and test contract?

- **Option A, retain (default, nothing changes).** Keep the stand-ins, the skip contract and the R2 admin variants. Cost: dead-in-production branches stay, and the skip reason `projector_is_writer` keeps naming a writer that no longer exists. Risk: none. Rollback: n/a.
- **Option A2, retain and rename only the label.** Change the reason string to a neutral name (for example `film_person_route_not_open`) in the 14 modules and 3 tests. Production never emits it at `open`. Risk: low but it is a contract string; every consumer found is in `src/` and tests. Rollback: revert.
- **Option B, retire the Film/Person stand-in.** Remove the `legacy()` branch, `FILM_PERSON_DB_OPTIONAL`, the `projector` writer branch, `routeOf {open:false}`, `SKIPPED` and `routeSkipMs`; any non-open state refuses like `held`. Local dev and the 10 tests move to a `d1`/`open` marker fixture. Cost: about 20 call sites and 10 tests; real authority semantics of non-open states change, so it needs this owner decision first. Rollback: revert.
- **Option C, retire the whole stand-in family together with the R2 admin variants.** Option B plus the four DR/DI R2 variants and the other four domain stand-ins; local dev would need D1 fixtures for every domain. Largest change and the largest test churn; production unchanged.

**Recommendation:** A now, then A2 as a small separate change; decide B or C only if the stand-in family stops being used for local development, because the cost is mostly test and local-dev rework, not production risk.

## Not changed

Production, flags, bindings, Access, Scheduled Tasks, schedules, D1 and R2 data, `readMarker`, `transitionAuthority`, the `open`/`held` fences, the Discovery Workflow and fast recovery cron, protected admin routes, R2 mirrors and the observation archive. No recovery was invoked.
