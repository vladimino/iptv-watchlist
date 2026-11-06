# EPG event not matching the published generation after a retry (AIR-359)

Captured 2026-11-06 (UTC) from the repository only. **No production read or write, EPG run, retry, R2 or D1 action was made.**

## Cause

`epgSync` created `run.events` (the watchlist event and the `epg` event) only when `run.events` was absent, from the first scan of the run, and saved them to `sync.json`. If that attempt failed before the published pointer moved (a storage fault in the generation copy, a killed invocation, a seal that did not complete) and the run was retried, the next invocation scanned the feed again, produced a report with a new `updatedAt` and new counts, published it, and `finishSync` then wrote the saved events of the first scan. The journal therefore held an `epg` entry at the first scan's time with its counts, and none for the generation that was actually published. This matches the observation in the card (an entry at 17:03 and none at 21:54 Madrid on 5 November). The production objects were not read here; the match rests on the reproduction below.

## Reproduction (fixture)

`tests/epg-event-publication.mjs` (R2 publication) and `tests/epg-event-publication-d1.mjs` (sealed D1 publication: staging interrupted before any pointer move, a retry that rescans, stages, seals in bounded steps and publishes through the real `finishSync`) run the real Worker code against in-memory stores and local sqlite stand-ins. The R2 fixture: the first scan fails at the generation copy (pointer unmoved, no event written), the feed then carries three shows instead of one, and the retry in the same run publishes. Before the fix the `epg` event carried the first scan's `at` and counts; after it the event matches the published report.

## Fix

Rebuild the events for the scan being published when the saved `epg` event is for another scan; keep a watchlist event whose removal hand-over already references its key; rebuild an `epg` event that disagrees with the published report in `finishSync`. See [events reference](../reference/domain/events.md).

## Limitations

The D1 fixture stubs the published-EPG module (`currentGeneration`, `publishGeneration`, document reads) and the ledger plan; the sealed ledger transfer, the stage and `sealStep` are real. A watchlist event that reports a removal keeps the first scan's time (its key is referenced by the removal hand-over). No production event was inspected or corrected.
