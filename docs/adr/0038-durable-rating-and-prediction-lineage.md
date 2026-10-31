# ADR 0038: Rating changes are kept in the Letterboxd fact record, and a prediction records the run and fingerprint it came from

**Status:** Accepted (owner decision 2026-10-28)  
**Original decision date:** 2026-10-28  
**Recorded at:** 2026-10-28  
**Approval source:** explicit owner acceptance of ADR 0038 in the AIR-12 delivery session, 2026-10-28, after the coordinator review of [PR #210](https://github.com/vladimino/iptv-watchlist/pull/210) (review 5687357082); architecture only, no backfill, flag, R2 or D1 write authorized  
**Related work:** [AIR-12](https://trello.com/c/kh3xGQSp), [AIR-262](https://trello.com/c/48ImXYoq), [AIR-263](https://trello.com/c/TEq1NFbA), [AIR-164](https://trello.com/c/iZzON44A); [ADR 0018](0018-letterboxd-last-good-ratings.md), [ADR 0023](0023-letterboxd-user-facts.md), [ADR 0024](0024-letterboxd-scan-summary.md), [ADR 0026](0026-historical-prediction-version-materialization.md); [gap matrix](../evidence/prediction/air-12-history-gap-matrix-2026-10-28.md)  
**Supersedes:** None. It extends the ADR 0023 fact record; its decision 6 (`replaced` as the one-level before-image) is unchanged  
**Superseded by:** [ADR 0067](0067-diary-recent-window.md) (Accepted 2026-10-31) in part: decision 1's claim that the observation id alone makes a history write idempotent. A later transition back to that same observation appends another entry. A retry of the transition just written still adds nothing, and the entry identity (observation id, apply or reverse, occurrence count) is unchanged.

## Context

The quality history (per-film history API, calibration) needs every real change of the owner's Letterboxd rating and the exact inputs of every prediction. The [gap matrix](../evidence/prediction/air-12-history-gap-matrix-2026-10-28.md) found, on `main` `1a4a3ac`:

- **Rating changes.** With `LETTERBOXD_FACTS=on` (production since 27 October 2026) a rating lives in the fact record `letterboxd/facts/films/<factKey>.json`, which keeps the current observation and one `replaced` level. A second change loses the first value. The older change log `enrichment/diagnostics/rating-observations.json` is appended only by the writers the facts gate replaced, and only while the diagnostic baseline exists; production shows its last entry on 25 October 2026. No durable record of a rating change is written today.
- **Prediction lineage.** The bundle `predictions.json` keeps the current record and every replaced one, and with `PREDICTION_VERSION_OBJECTS=on` each record is also an immutable object. A record names the fingerprint by hash and schema version but not by prompt version, which ADR 0035 made part of a fingerprint's identity, and it does not name the run or trigger that produced it, although both are known at submit.

## Decision

1. **Rating history in the fact record.** The record gains `ratingHistory`, an append-only list written by `applyObservation` in the same compare-and-swap as `rating`. An entry is added only when the effective rating (stored value or scan summary, whichever is greater) changes: `first_observed` when none was known, `changed` with the `previous` value otherwise. A confirmation of the same value, a repeated, older or absent observation adds nothing. A baseline-import rollback appends a `rolled_back` entry after the one it reversed. Entries are never rewritten; the observation id makes every write idempotent across retries and crash replays. Each entry carries `recordedAt`; its identity is the observation id, whether it applies or reverses it, and how many times that happened before in the list, so a rollback followed by a re-application is two events. A convergence of two records, and the overlay read during one, take the union of both lists by that identity, ordered by `recordedAt`; the merge is idempotent.
2. **The before-image and the projection are unchanged.** `replaced` stays the exact one-level rollback image (ADR 0023 decision 6); the view-index projection does not read the history. `rating-observations.json` stays the legacy writers' diagnostic log and is not written under the facts gate.
3. **Prediction lineage.** A new prediction record carries `fingerprintPromptVersion`, `runId` and `trigger` next to the existing fields; they are part of its immutable version body. Freshness rules and readers are unchanged; the reason for a recalculation stays derived from the two records.
4. **No backfill and no invented history.** Records written earlier keep no history or lineage; a reader treats the missing fields as unknown and never fills them from current data. A `first_observed` rating is not evidence of when it was given.

Not decided here: the read API (AIR-262), calibration metrics (AIR-263), any change of the prediction writer's order, lease or freshness, the D1 mapping beyond the backfill reading `ratingHistory`.

## Alternatives considered

- **Keep appending `rating-observations.json` from the facts writers.** Rejected: it is one growing object under a compare-and-swap shared by every writer, gated by an unrelated diagnostic baseline, and a write after the record's own compare-and-swap can be lost in a crash between the two.
- **One immutable object per observation under a separate prefix.** Rejected for now: written before the record it would describe an observation the merge may then refuse; written after, it can be lost; it needs a listing per film to read. The in-record list is atomic with the value it describes.
- **Derive history from `replaced`.** Rejected: one level only, by design.

## Consequences

- A rating's full change history is kept from the deployment on, in the same object and write as the value; a record grows by one small entry per real change.
- New prediction records are self-describing; their version objects hash slightly larger bodies. Old records stay valid and unchanged.
- Consumers must treat `first_observed` and missing lineage as unknown, which the reference contracts state.

## Recovery and migration boundary

Reverting the code stops new entries and fields; what was written stays in R2 and remains valid data. No flag, Scheduled Task, Access, R2 or D1 operation is authorized by this record; production verification after deploy is read-only and needs no write.

## Evidence

- **Original decision:** [AIR-12](https://trello.com/c/kh3xGQSp)
- **Implementation:** the AIR-12 pull request
- **Dated verification:** [gap matrix](../evidence/prediction/air-12-history-gap-matrix-2026-10-28.md), read-only production observations of 28 October 2026
- **Uncertainty:** the convergence merge is specified, but no convergence writer exists yet; its implementation must follow decision 1

## Follow-ups

[AIR-262](https://trello.com/c/48ImXYoq) reads the history; [AIR-263](https://trello.com/c/TEq1NFbA) computes quality from it.
