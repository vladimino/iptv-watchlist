# Ratings on a watchlist removal event: when they arrive (AIR-379)

**Captured:** 2026-11-10 (UTC), read-only. `ratings_sync_status` and `epg_status` of the IPTV MCP (both report `sideEffects: none`), and direct R2 GETs of the stored `events/items/` objects with a read-only key. No Worker HTTP route, no write, no Ratings, EPG, Discovery or TMDB run, no D1 write. Only counts and time offsets were kept: no film title, id or rating value is recorded here.

**Method.** All 516 stored events were read. The 19 `watchlist` events that report removals (31 removed films in total) were measured: for each removed film that carries a rating, the offset between the event `at` and that film's `ratingObservedAt`. **`ratingObservedAt` on an event film is stamped when the removal queue settles the reference, not when the rating became known**, so these offsets measure the settlement latency of the queue and say nothing by themselves about whether the fact existed at publication. For the six distinct rated films the fact record in D1 was then read (read-only `SELECT` of `ratings_document`) to see when the rating observation was stored and from which source.

**Result.**

| Measure | Value |
| --- | --- |
| Watchlist events with removals / removed films | 19 / 31 |
| Removed films with a rating today | 7 (six distinct films) |
| Removed films with no rating today | 24 (no fact exists; the removal need not be a viewing) |
| Queue settlement offsets of the 7 ratings, hours after the event | 0.0, 0.6, 0.6, 0.6, 1.1, 24.0, 41.9 |
| Of the six films: fact stored **before** the event | the one removal event written under the aligned 17:00 schedule (8 November): yes, two export observations (26 October and 8 November 13:55 UTC), the event is at 16:01 UTC |
| Of the six films: fact stored **after** the event | the removals of 31 October to 3 November, written while the Ratings run came after the EPG run (17:30 Madrid): the Diary observation was ingested by that later Ratings run, 0.6 to 1.1 hours after the event |

On 9 November the Ratings run took 5 seconds (16:00:48 to 16:00:53 UTC) and the EPG run published at 16:15:26 UTC. The Ratings logical due time had been aligned to the EPG one (17:00 Madrid) before that.

**Reading.** The offsets of the old schedule were real: Ratings ran after EPG, the fact did not exist at publication, and the event was settled about an hour later. Under the aligned schedule the Ratings run finishes before the EPG commit, so a rating that Diary shows by 16:00 UTC is stored when the event is written. The single aligned-schedule event shows the other face of the problem: its rating **was already stored** (from the owner's export), the event was published without it because the commit did not read stored facts, and the removal queue reached it only at the next daily Ratings run (24.0 hours). The commit now reads the stored facts, which would have shown that rating at the first display. A rating that Diary shows only after the Ratings run of the day (the window between about 16:00 and the event write) is not stored at publication and is settled by the next daily run; that window is small when ratings are entered earlier than the run.

**Limits.** One event of the aligned schedule is a single observation, not a distribution. The 24 films without a rating are not evidence of a missing rating: a removal can be an expiry or an owner action. Only events that are still stored were measured, and only the six rated films were looked up in D1. The fix of the same delivery is covered by `tests/watchlist-event-ratings.mjs` (synthetic data); no production run of the new code has been observed.
