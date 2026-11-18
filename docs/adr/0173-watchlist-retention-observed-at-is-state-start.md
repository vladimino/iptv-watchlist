# ADR 0173: `film_retention.observed_at` is the start of the current watchlist state

**Status:** Proposed
**Original decision date:** 2026-11-18
**Recorded at:** 2026-11-18
**Approval source:** Product Owner chat decision of 18 November 2026 on [AIR-532](https://trello.com/c/mGPwomMX): keep the stored `observed_at` while the watchlist state is unchanged and change it only when the Film leaves (or returns). The ADR text itself awaits independent review.
**Related work:** [AIR-532](https://trello.com/c/mGPwomMX); incident context [AIR-420](https://trello.com/c/J0dit94i); [ADR 0086](0086-durable-watchlist-film-retention.md)
**Supersedes:** None (refines the observation clock of ADR 0086 decision 1)
**Superseded by:** None

## Context

On 18 November 2026 `seal_finalize_scan` took 44m02s over 34 executions at `UNIT_CAP=12`. Every daily scan carries a new `observedAt`, and the producer planned a write whenever it was newer than the stored one. An unchanged watchlist therefore rewrote `film_retention` and bumped `canonical_revision` for every listed Film. The offline benchmark (`scripts/bench-watchlist-retention.mjs`, sqlite D1 stand-in) measured 389 D1 round trips and 24 write batches per 12-Film slice for an unchanged day. The only reader of `retention.observedAt` in `src/` is `canonical-catalog-reader.js`, which returns it and does not interpret it.

## Decision

1. `film_retention.observed_at` is the time the **current** `watchlist` boolean was first observed, not the time of the latest scan that confirmed it.
2. The retention planner (`planRetention`) treats a scan that reports the stored boolean as a no-op: no receipt, no fenced batch, no revision bump, no change to `observed_at`, `evidence_json` or `request_id`.
3. A first observation, an exit (`true` to `false`) and a re-add (`false` to `true`) are written as before, by `retainFilm`, with the same marker generation, per-Film revision fence, receipt and monotonic `observed_at` rule (an older or equal observation is still skipped).
4. Consequence for analysis: for a Film with `watchlist=1`, the oldest `observed_at` is the longest continuous stay on the watchlist. Rows written before this change carry the time of the last pre-change scan, so that ordering is complete only for stays that start after deployment.
5. Not decided: no schema change, no backfill, no change to membership (`watchlist_film`), published EPG, programme or Discovery, and no change to `retainFilm` itself.

## Alternatives considered

Keep rewriting `observed_at` on every scan (the previous contract) and only batch reads: rejected by the owner for this card because it keeps one fenced write per listed Film per day.

## Consequences

An unchanged day writes nothing for retention. A scan no longer proves freshness of a Film's retention row; freshness of the watchlist is the published generation. A Film missing from a skipped day is still detected as an exit by the departed list. Bounded cost remains for reads, which later AIR-532 changes address.

## Recovery and migration boundary

Code rollback restores per-scan rewrites and is backward compatible: rows are the same shape. No production write, migration, flag or Task is authorized by this ADR.

## Evidence

- **Original decision:** owner chat decision, 18 November 2026, recorded on [AIR-532](https://trello.com/c/mGPwomMX)
- **Implementation:** `src/canonical-rated-admission-producer.js` (`planRetention`), regression block in `tests/canonical-rated-admission-producer.mjs`
- **Dated verification:** offline benchmark, unchanged day 389 to 173 round trips and 24 to 0 write batches per slice; not a production measurement
- **Uncertainty:** production runtime cursor, per-slice D1 latency and the share of platform idle time are not measured

## Follow-ups

Read batching and gate reuse under the same card.
