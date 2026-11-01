# AIR-319 published EPG authority — local tests, 1 November 2026

**Scope:** local SQLite stand-in and a fake HTTP API. No production D1 write, no production R2 write, no migration apply, no import, no marker activation.

**Code:** branch `cursor/air-319-d1-published-epg`. ADR [0079](../../adr/0079-d1-authoritative-published-epg.md) is Proposed.

## What was run

`node tests/published-epg.mjs` and `node tests/published-epg-production.mjs`.

The publisher stand-in applies one `BEGIN`/`COMMIT` around `D1Database.batch`. That is the test's stand-in for the Worker binding, not a measurement of production D1 and not the backfill REST `{sql}` body. The production operator test answers HTTP from a local SQLite file. It does not open `iptv`.

## What held

- Schema v6 with the nine tables absent leaves `currentGeneration` null and refuses a publish (`published_epg_not_authoritative`). Schema v5 refuses `0008` and stays version 5, with no published table and no downgrade trigger. Schema v6 refuses `0008` the same way: the version stays 6 and nothing is created. Version 7 without the ten prediction-domain tables also refuses `0008` and creates nothing. Version 7 with those tables, then `0008`, sets version 8. A later `SET version = 7` is rejected. The metadata cache marker is still honored at version 8, including when it is set to `d1`. A bound database with no `schema_contract` fails closed. The local stand-in opt-out still reads as `r2`.
- A publish stores shows, an explicit empty show list, watchlist order, and `availableUntil`. It inserts no `film`, `candidate` or `watchlist_film` row. Replay of the same payload is a replay. A different payload for the same run is a conflict. A withheld generation does not move the pointer. A stale expected pointer rolls the commit back and the abandoned stage does not block a corrected retry. An old run's shows remain.
- A killed commit surfaces `published_epg_unavailable`. A second writer that still holds the claim is `published_epg_lease`. The same payload after the claim expires commits. Stage-row batches stay inside the statement cap. A show statement over the byte cap does not move the pointer.
- A failed mirror put leaves the D1 document readable. Repair rewrites the pointer, `programme.json` and `watchlist.json`, including after a put that dies on the watchlist alone. Activation refuses when the watchlist changes and the pointer does not, including a change after the source read and before the marker compare-and-swap; the mode stays `r2`. A watchlist that changes after the hold is committed is still the R2 object: the public read does not repair it, the marker returns to `r2` with `cutover` `open`, and a failed post-hold read leaves the hold and reports the D1 write. Revert repairs that watchlist and leaves the document. A production revert whose second mirror PUT fails reports `writeState` `partial` and leaves the mode at `d1`. The production `--revert --confirm r2` was exercised only against the fake HTTP API. It does not call Time Travel restore. `--apply` on version 5 sends nothing. `--apply` on version 6 sends nothing and creates nothing. `--apply` on version 7 without the prediction tables sends nothing. `--apply` on version 7 with all ten sets version 8 and `mode` `r2`. A second apply stops. Load then activate are separate commands. `GET /api/watchlist` after a D1 watchlist patch returns that membership. A patch between the two reads of `GET /api/programme` answers `published_epg_fence`. The offline script refuses a path segment `iptv`.
- With the marker armed, the enrichment dry run pins the D1 generation rather than a stale R2 pointer. The admin snapshot reads that same run and does not read the stale generation's programme object.

## What this does not show

Production D1 was not measured. Worker `batch` atomicity on Cloudflare was not measured. The backfill `{sql}` result is not this publisher's proof. No live programme was imported. The marker was not set to `d1` on `iptv`. Chunk sizes cited from [generation unit size, 26 October 2026](generation-unit-size-2026-10-26.md) are that note's synthetic local measurement, not a new production timing.

## Prior evidence used

- [Generation unit size](generation-unit-size-2026-10-26.md): one statement per show does not fit a D1 request. This publisher keeps the fixed-size commit from [ADR 0021](../../adr/0021-staged-atomic-generation-import.md).
- [Metadata cache cutover](air-313-metadata-cache-cutover-2026-11-01.md): the marker pattern. That cutover is the cache only. It is not an EPG apply.
