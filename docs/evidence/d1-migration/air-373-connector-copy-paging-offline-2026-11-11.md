# AIR-373: connector copy paging, wall-clock guard and `pad`, offline tests

**Captured:** 2026-11-11, local runs of `node tests/film-person-connector.mjs` and `node tests/film-person-connector-mutation.mjs`, then the full `npm test` and `npm run build`. **Method:** a second sqlite file that plays production D1 (the migrated schema built once, then copied) holding 12 rows of about 90 KB in `published_epg_document` followed by tables of small rows (2,100 each in `canonical_revision` and `film`); a fake connector (`cloudflare.request` over that file) that records every request and moves an injectable clock; the generated `fn-copy.js` text run unchanged, with only the `Date` it reads supplied by the test. **No production access of any kind**: no R2, no D1, no Cloudflare API or connector, no IPTV MCP.

**Result:** three defects of the connector-path tool ([`scripts/film-person-connector-run.mjs`](../../../scripts/film-person-connector-run.mjs), merged in PR #501) found by an operator run through the Cloudflare API connector on 11 Nov 2026 are fixed in the generated function text and the loader's input tolerance. The gate modules, the recorder, `captureProjectorInputs`, `runParity`, the pinned constants, the required statement set and every rule of what counts as verified are unchanged.

## The defects and the fixes

| Observed on 11 Nov 2026 | Fix | Test |
| --- | --- | --- |
| The `copy` cursor `{i,after,limit}` carried the halved page size across tables. After `published_epg_document` (about 60 KB a row) every later table (`film`, `person_alias`, `film_person_credit`, `projection_state` and the rest) was read in pages of 31 or 62 rows, so the call timed out at 60 s (3 times); the operator edited `CURSOR.limit` by hand | The page size is per table: reset to `PAGE_ROWS` whenever the function moves to the next table. The cursor keeps its shape `{i,after,limit}`; `limit` is now that table's own size and a cursor inside a large table resumes with it. A missing or non-positive `limit` means `PAGE_ROWS` | the queries per small table are at most `ceil(rows / PAGE_ROWS) + 2`; the table after the large one starts at `PAGE_ROWS`; a cursor with `after` 0 always carries `PAGE_ROWS`; a cursor inside the large table carries a reduced `limit` and the next call reads from exactly its `after` with exactly its `limit`; the copy is whole (row counts and `rowid` sums equal) |
| No wall-clock guard; the connector's `execute` times out after 60 s per call | `copy` stops after the current page once `WALL_CLOCK_MS` (40 s) has passed since the call started, if it has at least one chunk, and returns the chunks so far with the cursor. The result is an ordinary `data` result (cursor not `null`, `done` false) that `load` accepts. `TOOL_TIMEOUT_MS` (60 s) and the reason are named and commented. `resync` is a fixed small number of requests with no paging and has no guard | with a clock that advances 7 s a request, no call makes more than the pages up to the first one that crosses 40 s, every partial result is valid and loads, and the copy is whole; at full speed the same copy is one call |
| A result below the connector's inline threshold is returned inline and not saved to a file, so the operator wrapped the function and added a padding field | `parseResult` drops a top-level `pad` field, so `load`, `verify` and `seal` ignore it. The runbook describes the wrapper; the generated functions add no padding | a result with a 200,000-character `pad` parses to the identical value (also inside the MCP text wrapper); a padded copy of every data file loads into the same copy; a padded check verifies identically; padded T0, T2 and release seal to the identical report |

The runbook ([connector path](../../runbooks/film-person-baseline.md#connector-path-offline-code-nothing-executed)) also records the other operational facts of 11 Nov 2026: calls per copy, the quiet window the run needs, and the projector lease that can be written only through `d1_database_query`.

## Test and mutation results

Wall time on the development container (4 CPUs, Node 22), each file alone: `tests/film-person-connector.mjs` 2.7 s (was 2.2 s), `tests/film-person-connector-mutation.mjs` 27.8 s. In the parallel `npm test`: the mutation check 58.4 s; the connector test was not among the slowest files; the whole suite (317 files, 6 jobs, unsharded) 154.7 s and passed. `npm run build` passed. The CI gate is 180 s per shard; the GitHub runner times of this change are in the PR.

Mutants: 115 in all, every one killed, none broken: 64 of the gate, 6 of the recorder and 45 of the tool (6 new: page size reset per table; cursor `limit` resumes its own table; the wall-clock guard; the wall clock starts at the call; the wall-clock budget stays below the 60 s limit; `pad` ignored). Two further changes were considered and not added as mutants because they are equivalent: removing the "at least one chunk" condition of the guard (the clock has not run out at the first page) and halving only for a page that is not the last (the next-table reset follows it).

## Not proved

- Nothing was run against the real connector. That the page size, the 40 s guard and the 8 MB budget are right for the real connector's timing and result-size limit, and that the fix removes the timeouts of a real copy, are not observed.
- The guard checks the clock between pages: one page that itself takes longer than about 20 s still times out. A table of rows too large for one page at the budget still stops with `row_too_large`.
- The connector's inline threshold was not measured. The `pad` length of 200,000 characters is the operator's value of 11 Nov 2026.
- The operational facts in the runbook are the operator's observations of one run.

Architecture impact: none - the offline tool's generated text, its loader tolerance and documentation only; no topology, persistence, trust boundary or runtime change.

Card: [AIR-373](https://trello.com/c/ugu3sQmp).
