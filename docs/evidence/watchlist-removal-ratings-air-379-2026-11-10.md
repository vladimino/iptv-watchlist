# Ratings on a watchlist removal event: when they arrive (AIR-379)

**Captured:** 2026-11-10 (UTC), read-only. `ratings_sync_status` and `epg_status` of the IPTV MCP (both report `sideEffects: none`), and direct R2 GETs of the stored `events/items/` objects with a read-only key. No Worker HTTP route, no write, no Ratings, EPG, Discovery or TMDB run, no D1 write. Only counts and time offsets were kept: no film title, id or rating value is recorded here.

**Method.** All 516 stored events were read. The 19 `watchlist` events that report removals (31 removed films in total) were measured: for each removed film that carries a rating, the offset between the event `at` and that film's `ratingObservedAt`.

**Result.**

| Measure | Value |
| --- | --- |
| Watchlist events with removals / removed films | 19 / 31 |
| Removed films with a rating today | 7 |
| Removed films with no rating today | 24 (no fact exists; the removal need not be a viewing) |
| Ratings observed **before** the event time | 0 of 7 |
| Offsets of the 7 ratings, hours after the event | 0.0, 0.6, 0.6, 0.6, 1.1, 24.0, 41.9 |

The three events of 31 October to 3 November, written while the Ratings run came after the EPG run (17:30 Madrid), got their ratings 0.6 to 1.1 hours later. The Ratings logical due time was then aligned to the EPG one (17:00 Madrid). On 9 November the Ratings run took 5 seconds (16:00:48 to 16:00:53 UTC) and the EPG run published at 16:15:26 UTC. The one removal event of the aligned schedule (8 November, 16:01 UTC) got its rating 24.0 hours after the event, from the next daily Ratings run: the references to its removal reached the queue after that day's Ratings run had ended, and the queue is worked only inside a Ratings run.

**Reading.** At the first display the event never carried a rating in this sample, so a film the owner had rated was always listed among the unconfirmed removals until the queue was settled. The later enrichment (`settleRemovalRefs` through the `writeEvent` merge) works and creates no duplicate. A rating stored before the publication is now put on the event by the commit (stored facts only). A rating that no stored fact holds at the publication still waits for the next daily Ratings run.

**Limits.** One event of the aligned schedule is a single observation, not a distribution. The 24 films without a rating are not evidence of a missing rating: a removal can be an expiry or an owner action. Only events that are still stored were measured. The fix of the same delivery is covered by `tests/watchlist-event-ratings.mjs` (synthetic data); no production run of the new code has been observed.
