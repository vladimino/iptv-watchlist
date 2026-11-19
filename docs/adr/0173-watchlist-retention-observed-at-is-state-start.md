# ADR 0173: `film_retention.observed_at` is the start of the current watchlist state; a scan watermark orders observations

**Status:** Accepted
**Original decision date:** 2026-11-18
**Recorded at:** 2026-11-18
**Accepted on:** 2026-11-19
**Approval source:** Product Owner chat decisions of 18 November 2026 on [AIR-532](https://trello.com/c/mGPwomMX): (1) keep the stored `observed_at` while the watchlist state is unchanged and change it only when the Film leaves or returns; (2) after the independent review of [PR #771](https://github.com/vladimino/iptv-watchlist/pull/771) found that this loses the ordering guard, keep the delta and add a single-row scan watermark. After the complete ADR was presented to the Product Owner on 19 November 2026, the owner explicitly accepted it in chat ("Принимаю ADR 0173"). The approval and its scope were recorded in the [AIR-532 decision log](https://trello.com/c/mGPwomMX) on that date, following the independent technical review of PR #771.
**Related work:** [AIR-532](https://trello.com/c/mGPwomMX); incident context [AIR-420](https://trello.com/c/J0dit94i); [ADR 0086](0086-durable-watchlist-film-retention.md)
**Supersedes:** None (refines the observation clock of ADR 0086 decision 1)
**Superseded by:** None

## Context

On 18 November 2026 `seal_finalize_scan` took 44m02s over 34 executions at `UNIT_CAP=12`. Every daily scan carries a new `observedAt`, and the producer planned a write whenever it was newer than the stored one. An unchanged watchlist therefore rewrote `film_retention` and bumped `canonical_revision` for every listed Film. The offline benchmark (`scripts/bench-watchlist-retention.mjs`, sqlite D1 stand-in) measured 389 D1 round trips and 24 write batches per 12-Film slice for an unchanged day.

If an unchanged scan simply stops writing, `film_retention.observed_at` becomes the start of the state, and `retainFilm` still uses it as the stale-event watermark (it accepts an observation only if it is newer than the stored one). The independent review of PR #771 showed the consequence: `true` at 10 Nov, an unchanged confirmation at 18 Nov (no write), then a delayed `false` dated 15 Nov is accepted, because 15 Nov is later than 10 Nov, although the 18 Nov scan proved `true`. The same hole opens for an older pending receipt that is reconciled after the newer scan. A state-start clock cannot also be the latest-seen watermark.

## Decision

1. `film_retention.observed_at` is the time the **current** `watchlist` boolean was first observed, not the time of the latest scan that confirmed it, **for every transition recorded after the migration is applied**. Rows that exist before the apply inherit the old rule (every scan overwrote `observed_at`), so they hold the latest pre-activation confirmation, not the original transition time; the migration does not backfill or reconstruct that history. An inherited timestamp is not a state start until a later exit or re-add writes a known transition, and no "longest stay on the watchlist" reading is valid from inherited rows.
2. **A scan watermark orders observations.** Migration `0025` adds `film_retention_scan`: one row (`id = 1`) with the observation time of the newest complete scan whose retention work was admitted. It only moves forward (a trigger refuses a lower value) and is never deleted. A complete scan observes every listed Film, so an observation older than the watermark is stale for every Film.
3. The producer reads the watermark once per slice. The first slice of a scan advances it to the scan's observation time in one fenced batch (marker generation asserted): one write per scan, not one per Film. A slice whose observations are older never moves it back.
4. `planRetention` treats an observation older than the watermark as stale (no receipt, no write), and a scan that repeats the stored boolean as a no-op (no row, no receipt, no revision; `observed_at`, `evidence_json` and `request_id` stay). A first observation, an exit and a re-add are written as before by `retainFilm`, with the same marker generation, per-Film revision fence, receipt and monotonic rule.
5. `retainFilm` (when the producer passes `watermark: true`) adds one assertion to the same fenced batch: the observation must not be older than the watermark. A late observation that passed the plan before a newer scan advanced the watermark therefore fails that batch, writes nothing, and ends stale on the retry. A receipt left pending by an older scan is superseded by revalidation (the plan is stale), never replayed.
6. **Before the table exists the previous behaviour stays, and only then.** With the schema genuinely below 25 nothing could order a late observation, so only an identical row is a no-op and every newer scan rewrites `observed_at`. Deploying the code before the migration is therefore safe, and the migration is a separate owner-approved production operation. **At schema 25 or later a missing or unreadable watermark table is a damaged schema: the producer fails closed** (`film_person_unavailable`, nothing written) and never falls back to row-only ordering.
7. **The guard also lives in the database.** Migration `0025` adds two triggers on `film_retention` that abort a write that contradicts the stored boolean with an observation newer than the stored row but older than the watermark. They hold for any writer, including a Worker rolled back to code that does not read the watermark, so a routine code revert after the apply cannot reopen the stale-overwrite hole. The abort fails the fenced batch closed (nothing written, `film_person_unavailable`, the slice stops).
8. Not decided: no change to membership (`watchlist_film`), published EPG, programme or Discovery, to the Discovery lease, or to the completion clock.

## Ordering guarantee, stated exactly

- Enforced in three places: the plan (stale vs the watermark), the write batch assertion, and, independent of the code version, the database triggers.

- Within one Film, a newer-than-stored observation of a different boolean is applied only if it is not older than the newest admitted scan (the watermark); equal is allowed. This holds in the plan and again inside the write batch.
- The watermark never moves backwards (statement and trigger) and is advanced only under the marker fence.
- Not guaranteed: an observation of the same boolean never refreshes `observed_at`, so `observed_at` says nothing about the last confirmation. The last confirmation is the watermark (for every Film at once).

## Alternatives considered

- Keep rewriting `observed_at` on every scan: keeps the ordering but one fenced write per listed Film per day; rejected by the owner for this card.
- Enforce order only in code (units live only inside their own scan): closes the paths of the shipped callers but not the database, so it is "by construction", not "by data"; the reviewer asked for a guarantee that holds in the data. Rejected by the owner in favour of the watermark row.
- A per-Film confirmation column: brings back one write per Film per scan. Not chosen.

## Consequences

An unchanged day writes one row (the watermark) plus nothing per Film. A scan no longer proves freshness of a Film's retention row; the watermark does, for all Films together. A migration (`0025`) and its production apply are new operational steps. A late scan is dropped as stale for all Films at once, which is correct because scans are complete observations.

## Recovery and migration boundary

**Before the apply**, a code revert changes nothing about the data. **After the apply**, a code revert is safe because of decision 7, not because the row is harmless: the reverted producer rewrites `observed_at` every scan again (observations at or after the watermark are allowed) and does not advance the watermark, which then only lags; a late contradictory observation is refused by the database. Known limits: (a) a Film merge whose retired and surviving retention rows carry different booleans with an observation older than the watermark is refused (it needs an owner decision); (b) a late *first* observation of a Film with no retention row is not covered by the guard (no confirmed state is overwritten; the new code refuses it in the plan). Rolling back the migration itself is not provided (`schema_contract_no_downgrade`; dropping the guard would reopen the hole) and needs its own owner plan. Migration `0025` was applied to production D1 `iptv` on 19 November 2026 under a separate, operation-specific owner GO; the preconditions and readback are in [the apply record](../evidence/d1-migration/air-532-0025-apply-2026-11-19.md) and [the apply runbook](../runbooks/film-person-0025-apply.md). **Code deploy alone did not activate the no-op performance benefit; the schema apply enables it, but the actual improvement still requires natural-run verification.** This ADR and its implementation authorize no production write, migration, flag or Task.

## Evidence

- **Original decisions:** owner chat decisions of 18 November 2026 on [AIR-532](https://trello.com/c/mGPwomMX)
- **ADR owner acceptance:** explicit "Принимаю ADR 0173" on 19 November 2026 after presentation of the design, alternatives, inherited timestamp caveat and rollback limitations; recorded in the [AIR-532 decision log](https://trello.com/c/mGPwomMX). This is architecture acceptance, not production SLA acceptance.
- **Review:** [independent technical PASS after the P1/P2 fixes in PR #771](https://github.com/vladimino/iptv-watchlist/pull/771#pullrequestreview-5970441857) (including the scan ordering and code-rollback guards)
- **Implementation:** `migrations/0025_film_retention_scan_watermark.sql`, `src/film-admission.js` (`readRetentionWatermark`, `advanceRetentionWatermark`, `retainFilm`), `src/canonical-rated-admission-producer.js` (`planRetention`, `applyRatedAdmissionRetention`), regression block in `tests/canonical-rated-admission-producer.mjs`
- **Dated verification:** offline benchmark, see [the before/after report](../evidence/orchestration/air-532-retention-read-batching-before-after-2026-11-18.md); not a production measurement. Migration `0025` applied to production on 19 Nov 2026 with a verified readback ([apply record](../evidence/d1-migration/air-532-0025-apply-2026-11-19.md)); no natural run has used it yet
- **Uncertainty:** production per-slice latency and the share of platform idle time are not measured

## Follow-ups

Natural-run verification of the applied protocol; read batching and the Discovery lease question stay under the same card.
