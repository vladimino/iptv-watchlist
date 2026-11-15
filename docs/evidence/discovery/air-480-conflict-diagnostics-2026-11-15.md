# AIR-480 typed `discovery_conflict` diagnostics (offline)

CapturedAt: 2026-11-15 (UTC). Code SHA of this delivery is the merge commit of the diagnostics PR. No production read or write.

## Scope

Offline classification of Discovery Authority errors after a natural-run series stored `error: unknown` while the thrown `Error` message was `discovery_conflict`. Method: unit and sqlite D1-stand-in tests in `tests/discovery-conflict-diagnostics.mjs` and `tests/continuation-diagnostics.mjs`. Production UNIQUE table and `failedAt` phase are **not** identified here.

## Result

- `diagnosticErrorCode` keeps allowlisted `error.code` / `Error(code)` messages (`discovery_conflict`, `discovery_fence`, …). A title-bearing UNIQUE string without a typed code stays `unknown`.
- `failed()` sets `failureKind` `unique_constraint` plus `failureConstraint` `unique.<table>` when `commit()` sees D1 UNIQUE; other `discovery_conflict` is `input_invariant`; `discovery_fence` is `fence`. Table names are matched longest-first so `discovery_observation_show` is not collapsed to `discovery_observation`.
- `advanceDiscovery` catch stores those fields; `chunkSummary` and `continuationAfterChunk` copy them. A paged chunk whose `assignObservationSlots` throws a shaped UNIQUE error records `failedAt: replay_assignment`.
- `workflowStepRecoverable` stays false for `discovery_conflict` and `discovery_fence`; true for `discovery_unavailable`.
- Duplicate-identity `upsertAdmissions` in one map is `input_invariant`. A second film id with the same TMDB identity is `refused: identity_conflict` (not thrown). A film-id UNIQUE whose identity owner is absent rethrows `unique_constraint` / `unique.discovery_admission`.

## Limits

Does not prove which UNIQUE or phase fires on production series 83 / run `0e4a5f90…`. Does not change CAS, slot uniqueness, timeouts or backoff. Does not swallow UNIQUE. Does not authorize a manual chunk. AIR-480 remains open; AIR-374 stays blocked.

## Verdict

**Offline diagnostics only.** Natural-run acceptance needs a later hourly chunk whose checkpoint shows typed `error`, `failedAt` and `failureKind`.
