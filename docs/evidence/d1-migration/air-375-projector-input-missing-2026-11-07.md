# AIR-375: the D1 enrichment projector failed `input_missing` on every run under D1 discovery authority

**Captured:** 2026-11-07 (UTC). **Method:** read-only. Workers Observability events of Worker `iptv` (4 to 7 November), a read-only listing of R2 object names, sizes and modification times under `epg/` (no object was read, no write), code reading and offline tests. No manual cron, no projector run, no D1 or R2 write, no flag or setting change. No object content, id of a film or secret appears here; generation ids are shortened to their first 8 characters.

## Symptom (facts)

`event: d1_enrichment_projection` is logged once per hourly cron firing (`37 * * * *`).

| Window (UTC) | Outcome | Published generation |
| --- | --- | --- |
| 2026-11-05 00:37 to 21:37 | `partial` every hour (22 firings) | before `5744aef7` |
| 2026-11-05 22:37 to 2026-11-06 17:37 | `failed`, `reason: input_missing`, `inputKey: epg/generations/5744aef7…/discovered-films.json` every hour (20 firings) | `5744aef7` |
| 2026-11-06 18:37 to 2026-11-07 17:37 | `failed`, `reason: input_missing`, `inputKey: epg/generations/307a3e1d…/discovered-films.json` every hour (24 firings) | `307a3e1d` |

The failure is therefore continuous, not a handoff race: no hourly run since 2026-11-05 22:37 UTC projected anything. (Limit: the event store returned 66 events for the whole span, all hours accounted for; events before 2026-11-05 00:37 were not listed here.)

## Where the missing object comes from (facts from the R2 listing)

Under `epg/generations/`, each generation published up to and including `7c1eaadb` (2026-11-04) holds `discovered-films.json`. The two generations published after the discovery authority became D1 have **no** `discovered-films.json`, while their `programme.json`, `watchlist.json` and `discovery-latest.json` exist:

- `5744aef7`: `watchlist.json` and `programme.json` written 2026-11-05 22:22 UTC (the [AIR-357 publication record](air-357-publication-2026-11-05.md) dates that publish at about 22:23 UTC); first failing firing 22:37 UTC, the next tick after that publish.
- `307a3e1d`: `watchlist.json` written 2026-11-06 17:56 UTC; first failing firing 18:37 UTC, the next tick.

The shared `epg/discovered-films.json`, `epg/discovery-resolution.json`, `epg/discovery-status.json` and `epg/resolver-continuation.json` exist in R2 but were last modified on 2026-11-04 between 20:37 and 20:39 UTC, the discovery cutover (the activation record is dated 2026-11-04): they are frozen copies, not live state.

## Cause (code reading, consistent with the facts)

- The key `epg/generations/<run>/discovered-films.json` is owned by the discovery authority (`ownsKey`, `GENERATION_KEY` in `src/discovery-authority.js`). `saveJSON` routes a write of that key to `routeWrite` and `replaceCatalog` (the D1 catalog) and returns, so under a ready D1 authority **no R2 object is created**. The published-EPG mirrors (`repairMirrors` in `src/published-epg.js`) write the pointer, the programme and the watchlist only, never the catalog.
- Every other reader goes through `loadJSON` or `DiscoveryAuthority.routeRead` (for example `catalogAvailableRoute` in `src/worker.js`). The projector alone read that key and the shared decisions with `env.BUCKET.get` (`d1EnrichmentRead` in `src/d1-enrichment.js`).
- AIR-363 added a guard for the seal-to-publish window (authority names another run than the pointer) and deliberately kept a missing copy outside the window a failed input. That guard is correct for the window and is unrelated to this steady-state failure: the authority names the published run, the guard passes, and the direct R2 read finds nothing.
- **Second finding, same read path:** `epg/discovery-resolution.json` exists in R2 but is frozen at the cutover. Had the catalog read been the only change, the projector would have continued on D1 catalog data together with decisions that stopped changing on 2026-11-04. Reading it directly was a stale-input defect hidden behind the first failure (the two reads run together and the missing catalog is reported).

Not established: whether the `partial` outcomes of 5 November before 22:37 UTC had their own cause (not investigated here); the effect of the 43-hour gap on what D1 holds (the projector writes only Films and Persons changed against R2; R2 stays authoritative for them, so no data was lost, only the D1 projection is behind and catches up in its normal bounded batches).

## Change

`src/d1-enrichment.js` only. While the discovery authority is a ready D1 authority, the catalog of the published generation and `epg/discovery-resolution.json` are read through `DiscoveryAuthority.routeRead`. An authority that is not D1 when the run begins keeps the R2 objects and a missing copy stays `input_missing`. A read that was D1-owned never falls back to R2: a route that is absent, or that answers `handled: false` because the authority moved away from D1 after the first read, defers as `authority_unavailable` (found in review: the first version fell back to the R2 copy and completed with stale decisions). Authority answers: a fence or a ledger seal in progress defers as `authority_unavailable`; an authority that no longer names the generation defers as `generation_pending`; a bounded or unreadable answer or a non-object value fails closed as `input_invalid` with the key; a null decisions answer is `input_missing`. A D1 authority without a finite generation defers as `authority_unavailable` before any read. What the authority looked like with the inputs (ready D1 mode, cutover, run and generation) is checked again by the guard right before the D1 write: a transition away from D1, another mode, cutover, run or generation, or an authority that cannot be read defers (`input_changed`, `generation_pending` or `authority_unavailable`, `inputKey: discovery_authority`) and nothing is written. The summary gains `discoveryGeneration`; the snapshot itself is not logged. No fallback to a root or stale copy, no empty substitute for a missing input, no change to the projection clocks, the lease or the monitor.

## Offline results

`tests/d1-enrichment.mjs` block 16: with an authority that answers and no R2 catalog, the run projects the same Films as the R2 catalog yields and reads neither routed R2 key, a retry converges; an authority that is not D1 still fails `input_missing`; fence and ledger-seal answers defer with no write and the projection state unchanged; bounded, unreadable and non-object answers fail `input_invalid`; a null catalog answer defers `generation_pending`, a null decisions answer fails `input_missing`; a generation that moves between the reads and the write defers `input_changed`, writes nothing, and the next run projects; an authority that stops handling the keys after the first read (with a stale R2 catalog and stale R2 decisions present), a route that is absent, a missing generation, and eight kinds of change between the reads and the write (away from D1, held, other mode, other cutover, other run, other generation, no generation, unreadable) each defer with zero D1 writes and no R2 read of the routed keys; an empty routed catalog is not a missing input; the projector and the monitor run under one `Promise.allSettled`. Removing the change fails the test with the production message (`input_missing: epg/generations/run-1/discovered-films.json`). Existing blocks, including AIR-363, pass unchanged.

## Not done, limits

- Production behavior after the change is not measured. After deploy the first hourly run should log `outcome: complete`, `partial` or `budget` (a bounded catch-up) instead of `input_missing`; that check is a read of Observability, not an operation.
- Nothing was written to repair the 43-hour gap: it closes by the normal hourly runs.
- Related, not changed here: the Finds owner-watched route in `src/worker.js` reads the same generation catalog key straight from R2 and so answers `film_not_in_catalog` for any film under a generation published after the cutover (code reading only, not exercised on production); and the projector's writer-idle check reads the discovery lease from R2 while the lease lives in D1 under the authority, so it does not see a live D1 lease (the generation check above covers the consistency of the cut). Both are suggested as separate cards.
