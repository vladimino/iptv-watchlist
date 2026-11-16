# ADR 0154: EPG orders Prediction work and does not authorize it

**Status:** Accepted  
**Date:** 2026-11-16  
**Approval source:** The Product Owner explicitly accepted the full ADR 0154 text reviewed on PR #694, HEAD `ddb2aae3`, on 16 November 2026 (Europe/Madrid); see the [recorded approval on AIR-511](https://trello.com/c/dPPtSZdp#comment-6afb4c9662ed96bfc94043ec) and [independent technical review](https://github.com/vladimino/iptv-watchlist/pull/694#pullrequestreview-5925283874). This acceptance does not authorize any manual production EPG, Discovery, Prediction, storage or Scheduled Task operation.  
**Related work:** [AIR-511](https://trello.com/c/dPPtSZdp), [ADR 0113](0113-prediction-runner-advances-persisted-queue.md), [ADR 0142](0142-epg-owned-generation-addressed-discovery-slots.md)  
**Supersedes:** The clause of [ADR 0113](0113-prediction-runner-advances-persisted-queue.md) decision 1 that treats a different programme run as an advance-gate failure (`programme_changed`)  
**Superseded by:** None

## Context

`prediction_batch_start` and the v5 start refused with HTTP 409 `No completed programme snapshot` while `sync.json` for the programme's `runId` was not `stage: complete`. `queueAdvanceGate` also refused a stored queue whose `programmeRunId` differed from the programme report, which forced a full rebuild or a dry-run `queue_stale` of cause `programme_changed`. On 16 November 2026 the natural Predictions runs stopped for that reason while a seal was unfinished, even though trusted Film admissions and a last-known queue were already stored. Personal scoring does not read showtimes (`modelMetadata` has no `shows`).

## Decision

1. **Eligibility and freshness** of a prediction depend on a trusted Film identity, watchlist membership where the cold lane requires it, and the taste profile, fingerprint and prompt contract. They do not depend on an EPG generation or on EPG sync completion.
2. **Urgency is optional.** Hot, soon and available order the queue only from a completed programme snapshot: there is no `sync` document, `sync.stage` is `complete`, or the published report is still a different run while a newer sync is unsealed. An unfinished seal that already rewrote `programme.json` to its own `runId` is not current availability. `next`, `submit` and `complete` do not rebuild the queue for a new programme id; a named refresh or a real batch start applies the new priority.
3. **Last-known priority.** While no authoritative snapshot is readable, a rebuild keeps per-film priority from a queue whose basis is completed (or was built before this record, so it has no basis) when the completed snapshot's own time is within 36 hours. That instant is `priorityAsOf`. A later rebuild copies it and does not move it. A carried queue that has no `priorityAsOf` is not renewed from `refreshedAt`. Past 36 hours every film is neutral (not hot). A new film can still be queued. Partial shows are not copied onto the films used for ranking. While the programme is unsealed, a film read for a manifest also comes from `watchlist.json`, so a watchlist member that is not in the partial programme and not a Discovery admission is not settled as missing.
4. **A new completed generation changes priority only.** It does not invalidate a fingerprint or a prediction and it does not drop `retries`, completed predictions or the pending work list except through the existing freshness and admission rules. `queueAdvanceGate` no longer returns `programme_changed`. A real `batch_start` refreshes priority when a completed snapshot names a different run than the queue (`priority` on `queue_changed` if that refresh does not settle before the manifest is fixed). A dry run does not rebuild and does not treat a programme id as staleness. Submit and complete still remove scored films from the stored completed queue while the live programme is an unsealed run of a different id. They do not write that settlement onto a queue a later completed publication has already rebuilt.
5. **Membership while the snapshot is not authoritative** is the stored `watchlist.json` when that document has a `films` array; otherwise the programme report's films. Catalog admissions stay the Discovery read already used by the queue rebuild. This record adds no writer and no second catalogue.

Fences that stay: owner identity, D1 prediction authority, Film admission, Documentary and concert exclusion, profile and contract compatibility, lease, epoch, CAS, input and manifest hashes, per-film submit, and the retry budget of 10.

## Alternatives considered

- **Keep the 409 until seal finishes.** Rejected. It stops scoring for a publication fault that does not change the model inputs.
- **Treat any stored shows as current indefinitely.** Rejected. Stale airtime would keep ranking films as hot after the snapshot is no longer the completed publication.
- **Rank from an unsealed programme object.** Rejected. Those shows are not a confirmed generation.

## Consequences

- An unsealed EPG run no longer blocks `prediction_batch_start` or v5 start. The runner can spend a stored queue and finish with `manifest_spent`.
- Priority can lag the newest completed publication until the next named refresh or a real batch start that sees that publication. Dry runs keep the stored order.
- Rollback is a Worker redeploy. The queue gains `priorityBasis` and may keep the previous `programmeRunId` during a seal. Existing rows stay readable. No migration.

## Evidence

- Offline tests: `tests/prediction-epg-independence.mjs`
- Dated note: [AIR-511](../evidence/prediction/air-511-epg-independent-scoring-2026-11-16.md)

## Follow-ups

Production acceptance is a natural Predictions run after deploy, recorded on AIR-511. This ADR authorizes no production write, flag change or Task edit.
