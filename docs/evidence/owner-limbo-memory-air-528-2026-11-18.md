# Owner Limbo page: `exceededMemory` on `/api/admin/limbo` and `/api/admin/identity-work`, RCA and fix, 18 November 2026

[AIR-528](https://trello.com/c/bj4JSgB9). Read-only. Sources: Cloudflare Workers Observability for the Worker `iptv` (per-request outcome, CPU and wall time, 18 November 2026 22:03 to 22:06 UTC), read-only object sizes of the R2 bucket `iptv` (LIST only, no body), one read-only aggregate `SELECT` of the production D1 `iptv`, the code at `main` `4804767`, and an offline reproduction on synthetic, production-shaped fixtures (`scripts/footer-memory-profile.mjs`, the harness of the [footer memory RCA](footer-status-oom-rca-2026-11-17.md)). No POST, no write, no production request to the two routes.

## Observation

On the live owner page `/admin/limb` both reads answered `503` with a non-JSON body, so the page showed `http_503`. The Worker log of the same minutes says why:

| Request (18 Nov, UTC) | Outcome | CPU | Wall |
| --- | --- | --- | --- |
| `GET /api/admin/limbo?limit=25&attention=now` 22:03:49 | `exceededMemory`, status 503, «Worker exceeded memory limit.» | 2.4 s | 38.5 s |
| `GET /api/admin/identity-work?limit=25` 22:03:47 | status 502 (the isolate was reset under it) | 2.6 s | 36.9 s |
| `GET /api/admin/limbo?limit=25&attention=now` 22:05:38 | `exceededMemory`, 503 | 3.2 s | 49.4 s |
| `GET /api/admin/identity-work?limit=25` 22:05:38 | `exceededMemory`, 503 | 2.7 s | 49.4 s |

The two routes are started by the page at the same time and fail at the same millisecond: they share one isolate (limit 128 MB). A response that is not JSON is Cloudflare's own page for a killed isolate, not the route's `storage_unavailable` or `programme_unavailable` body, which is why `identityWorkLimbo`'s handled-error path never ran. Few seconds of CPU against 37 to 49 s of wall means the requests spent their time waiting for storage while holding memory. The log kept no earlier request of the two routes (retention), so no earlier success can be compared.

Production state read on 18 November: R2 `enrichment/view-index.json` 12.45 MB, `prediction-queue.json` 1.50 MB, published programme (R2 mirror) 5.74 MB. D1: **9,944** active observations with a decision that the Limbo reads as unresolved (6.9 MB of observation payload and 3.0 MB of decision payload in total, 397 with a terminal reason). The D1 observation index reads at most `INDEX_CAP` = 3,000 of them.

## Root cause

1. **One statement per observation (the trigger).** `DiscoveryAuthority.readObservationIndex` (D1 mode, unkeyed read) selected up to 3,001 observations with their decisions and then, for each, awaited a separate `SELECT` of its shows, after a SHA-256 of its decision. With 9,944 candidates the cap is always reached: **3,000 sequential D1 round trips per read**, every selected row (payload and decision JSON, then parsed) held for the whole walk. At a few milliseconds per round trip that is the 37 to 49 s of wall in the log.
2. **The same load twice at once (the amplifier).** `/api/admin/limbo` and `/api/admin/identity-work` both start from `adminLimboLoad`, and the page started both at once. Each request held its own complete copy of the programme, the dictionaries, the queue, the view index and the observation index, each for tens of seconds. The status footer the page also polls ran in the same isolate (its own request is heavy: [footer RCA](footer-status-oom-rca-2026-11-17.md)).

Not proven and not claimed: that one request alone would fit. The offline numbers below say a single read fits comfortably; the live margin additionally includes data larger than the fixtures (the real programme and view index are 2x and 1.1x the fixture sizes) and the memory a workerd isolate keeps beyond the V8 heap, which a Node run does not model.

## Reproduction

`scripts/footer-memory-profile.mjs --build` now also builds 3,000 observations with decisions and shows (`OBS`, default 3000) and puts the owner-review and Discovery programme markers in the production state (`d1`, run set); `--path` / `--paths` measure other routes, several at once as the page did, or one after the other with `--sequential`. Deployed bundle `dist/server/index.js`, Node, hard heap cap; smallest `--max-old-space-size` (2 MB step) at which every request answers 200, over a 21 MB baseline. The in-process D1 has no round-trip latency, so the statement count is the measure of the wall time the live page lost, not the heap.

| Case | D1 statements | Smallest cap |
| --- | --- | --- |
| before: `limbo` alone | 3,079 | 53 MB |
| before: the page's two requests at once | 6,153 | 80 MB |
| before: footer + the two requests | 6,395 | 94 MB |
| after: `limbo` alone | 117 | 53 MB |
| after: the two requests at once, two independent loads | 229 | **82 MB** |
| after: the two requests one after the other (the page now) | 229 | **58 MB** |
| after: footer + one Limbo load | | 75 MB |
| after: footer + the two requests at once | | 100 MB |

Two readings follow. Chunking the show reads removes the round trips (3,079 to 117 for one read) but does not lower the heap: the rows were always held. The memory amplifier is two independent loads alive together (80 to 82 MB against 53 to 58 MB). An earlier version of this change joined overlapping loads in the Worker (a shared in-flight Promise) and reported 60 MB for the pair; that is withdrawn: workerd gives no guarantee that two requests receive the same `env` object, and a Promise holding R2 and D1 I/O started in one request is exposed to the cross-request I/O rules, so the offline Node harness (one `env`, no I/O context) proves nothing about it.

## Fix

- `readObservationIndex` reads the shows of the listed observations in statements of `BIND_CAP-20` keys (80), grouped by observation and ordered by `ordinal`: about 38 statements for 3,000 observations instead of 3,000. The keyed read is unchanged. This removes the 37 to 49 s of wall that kept both loads alive.
- The page no longer has the two reads in flight together. The identity list waits for the Limbo read the page started first (success or failure), and a Limbo read that starts while the list loads waits for it (`iwAfterLimbo`, `iwIdle`, `limboRead`, and the show-more page request `onLimboMore`, which is dropped if a refresh, a filter or another page moved the view while it waited). The Worker is unchanged in this respect and depends on no cross-request state.

Tests: `tests/discovery-authority.mjs` (statement count, chunk width at most 100, show order and grouping, keyed read), `tests/admin-identity-work-page.mjs` (no identity request while the Limbo read is pending, a failed Limbo read does not hold the list, `iwIdle` waits for a loading list and resolves at once otherwise, `limboRead` and the show-more request wait for the list, an obsolete show-more request is not sent, a failed one does not hold the list back) and the nightly `owner-limbo-memory-production-size` in `tests/footer-memory.mjs` (the sequential pair under a 66 MB cap and at most 400 statements; the concurrent pair fails that cap).

## Limits and open acceptance

Offline figures on synthetic data in Node; they show the removed round trips and the memory of the page's own two reads, not the live isolate's margin: the real programme and view index are 2x and 1.1x the fixture sizes, and workerd keeps memory beyond the V8 heap. No workerd or Miniflare run was made. Two reads of these routes that overlap for another reason (two tabs, another client) are still two independent loads (82 MB on the fixtures); bounding what one load holds (the parsed view index and the observation records) is the next step if the live log still shows overruns, not a higher limit. Acceptance is a read-only look at the live page after deploy (owner Access session) and, in the Worker log, `ok` outcomes with wall time of seconds for both routes. No R2 or D1 write, flag, Task or cleanup was involved; the 98-object R2 cleanup stays gated on its own owner GO.
