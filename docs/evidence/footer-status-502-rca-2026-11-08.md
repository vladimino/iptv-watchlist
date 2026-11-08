# Footer status 502 (`GET /api/enrichment/footer/status`), RCA, 8 November 2026

[AIR-389](https://trello.com/c/DKDuJnkk). Read-only. Sources: Cloudflare Workers Observability for the Worker `iptv` (aggregates only, 5–8 November 2026, UTC), the code at `main` `dffed5f` (the deployed commit) and an offline reproduction on a local D1 stand-in. No production endpoint was called, nothing was written, and no payload, header, cookie or token is quoted here. Times are UTC.

## Observation

- Every one of the 25 requests logged for the path between 16:50 and 18:45 on 8 November answered **502**. The Worker outcome is `ok` (the Worker returned the response itself, it was not an exception, a limit or a platform error). CPU time is 26 ms or less per request and wall time 895 ms or less, so memory, CPU and time are not the cause.
- The failure is **older than AIR-389**. The path answered 200 until about 14:30 on 7 November and 502 from about 19:00 on 7 November, across several deployed versions of the Worker; 85 502 answers were logged before 16:50 on 8 November, before the AIR-389 change (PR #438) was merged at 16:59.
- The body the owner saw is 32 bytes of JSON.

## Root cause

1. The Worker's top-level `catch` turns any exception of a route into `502 {"error":"<message>"}`. A 32-byte body is `{"error":"` (10) + a message of 20 characters + `"}` (2). `discovery_incomplete` is exactly 20 characters.
2. `footerStatus` read the Discovery ledger without a guard (`ledgerStatusAggregates` → `DiscoveryAuthority.streamActiveLedger`). By the design of AIR-344 the status readers **fail closed** while the Discovery transfer is `loading` ("a held, loading or unavailable marker fails closed"), so that read throws `discovery_incomplete`, and the whole footer became a 502 for as long as the transfer stayed `loading`.
3. The message was **not read from a log**: the Worker did not log the error text. The identification rests on the body length, the timing and the offline reproduction below; the deployed log line added by this fix makes the next occurrence directly readable.

Reproduction (offline, D1 stand-in with a published generation and Discovery on D1): with the transfer `idle` the footer answers 200; with `UPDATE discovery_transfer SET state='loading'` it answered `502` with the body `{"error":"discovery_incomplete"}` (32 bytes).

## A second defect found on the way

`footerStatus` read `programme.json` (and, since AIR-389, `watchlist.json`) through `loadJSON`, which for a D1-published generation first runs `PublishedEpg.repairMirrors`, an **R2 write**. In the reproduction one footer GET put `programme.json` twice (in parallel), the generation copy and the other compatibility mirrors. The footer was therefore not a pure read, and AIR-389 doubled the repair. It is a separate defect: it did not cause the 502.

## Fix (one corrective PR)

- Every source of the footer is read behind a guard with a 10 s limit; a closed, failing or silent source is named in the optional `degraded` list and everything that needs it is unknown (`null`, shown as «нет данных»), never 0 or 100%. The Discovery ledger, catalog, authority markers and the other optional objects can no longer take the footer down.
- The programme and the watchlist of a D1 generation are read with SELECTs only, fenced at the pinned generation (`PublishedEpg.readDocumentAt`), with no mirror repair.
- The collection block is unknown without the catalog and the programme.
- The Worker logs one structured line for an unhandled route error: `event`, `method`, `path`, and `code`, `message` and the error class `name` **only when each is shaped like an internal code** (lower-case letters, digits and underscores, at most 64; the class name is letters only). Any other error text, which can carry a film id, a SQL statement, a path or a secret, is dropped (`null`). A test feeds ids, SQL, paths, tokens, library messages, a thrown string and a long text and asserts none of it reaches the log.
- A programme or catalog object that is simply absent, and a freshness rule that cannot be computed, no longer yield an authoritative zero or 100% coverage: the coverage and the new-film count are unknown and the cause is named in `degraded` (`programme_missing`, `catalog_missing`, `index_missing`, `profile_missing`, `freshness`). The new-film count additionally needs the programme, because its non-catalog-only films are part of the watchlist exclusion.
- Tests: `tests/footer-resilience.mjs` (a real D1-published generation with missing and stale mirrors: no R2 put or delete, no D1 write, no provider request; a ledger seal, a pending admission and a held cutover; failing and silent sources; absent programme or catalog; a failing and a hung freshness rule; the log line and its privacy boundary).

## Not done, on purpose

No production endpoint was called to confirm the message; no Discovery, EPG, TMDB, ratings or prediction run, lease reset, flag, schedule or storage change was made. Why the transfer has stayed `loading` since 7 November is a Discovery matter and is not decided here.
