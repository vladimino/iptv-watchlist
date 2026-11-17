# ADR 0157: Transferable staged batch items drained by the next run

**Status:** Proposed (code delivery; Product Owner architectural acceptance pending independent review of this revision)
**Original decision date:** 2026-11-17
**Recorded at:** 2026-11-17
**Approval source:** Owner BLOCK on PR #704 HEAD `b12b5bd2` (issue comment, 17 Nov 2026 ~10:06 Europe/Madrid). The earlier run-scoped hold recovery is **not** accepted.
**Related work:** [AIR-510](https://trello.com/c/01JAM4TP); [ADR 0131](0131-batch-candidate-preflight-tool.md); [ADR 0136](0136-prediction-batch-manifest-size-and-spent-complete.md)
**Supersedes:** None. Qualifies ADR 0131: `prediction_batch_validate` stays a pure preflight. Replaces the run-scoped hold recovery proposed earlier on this card.
**Superseded by:** None

## Context

The 16–17 Nov 2026 natural A/B/C/D series lost owned `batch_v2` runs as `external_termination` with `firstSubmitAt=null` after a passing preflight. A completed or terminated Task must not strand already validated, durably staged predictions. Recovery must happen on the **next normally scheduled run**, without Task A's `runId`, epoch or lease, and without owner-operated retry. The live A/B/C/D prompts do not call hold until a separate GO.

## Decision

1. **`prediction_batch_validate` stays read-only.** ADR 0131 is unchanged.
2. **`prediction_batch_hold` is a lease-authorized writer of a transferable stage.** Write requires the generating run's live lease and epoch and that the films are in that run's `selectedIds`. The object is `enrichment/batch-stage.json` (not `batch-hold/<runId>`). `origin.runId` (and origin profile/contract identities) is provenance only, not recovery authorization. Each staged row also binds `origin.filmInputHash` (plan + compact modelMetadata + stored fingerprint hash when prediction_only).
3. **Identity.** CAS-merge via `mergeStoredJSON`. Per-film `batchItemDigest`. Exact replay is identity; a different digest is `409 hold_conflict`. Caps: 10 items / 56 KiB.
4. **Next `prediction_batch_start` drains the stage** after it takes the new runner lease and before it returns the new manifest. Selection excludes staged ids **inside** hot/cold lane choice, so draining the last hot films still fills the new manifest from ready cold work. Fresh staged items are committed on the **new** run with the existing authoritative submit validators. Stale items (`stale_profile`, `stale_contract`, `stale_input`) and non-settled submit outcomes are dropped from the stage and are **not** left on `selectedIds`. Transient `blocked` / `storage_error` / lost submit gate leave remaining rows on the stage and omit them from `selectedIds`. Drops do not prevent selection of the next `manifestSize` eligible films. The start answer includes `drained` when counts are nonzero. Dry run does not drain. `already_running` and a non-owned drain gate do not drain and do not adopt staged ids.
5. **Manifest of B is the new films only.** Successfully drained film ids are prepended on the new run's `selectedIds` so `manifest_spent` includes them; they are not repeated in `films[]`.
6. **`prediction_complete({reason:'external_termination'})` remains HTTP 200** and releases the lease (live A/B/C/D compatible). The stage outlives that run. A's terminal Event does not count uncommitted staged films as created. B's Event counts B's commits (drained + newly submitted).
7. **`prediction_batch_submit({useHeld:true})`** remains for same-run recovery while the generating lease is still held. It loads the transferable stage filtered to this run's unspent `selectedIds`.
8. **MCP** `listChanged: true`, server `0.4.0`. No Task registry mutation.

Not authorized: Task prompt edits, live `prediction_batch_start` in production, lease reset, flags, R2/D1 operators.

## Required scenario

Task A validates and stages five submit-ready films, then terminates before submit. Task B's ordinary start commits those five without A's runId/epoch/lease, then delivers five **new** eligible films. After B submits those five: ten unique committed predictions, no stuck lease, no repeat of the first five, no double-counted terminal Event.

## Alternatives considered

- **Run-scoped hold keyed by runId/epoch; 409 until the same lease submits.** Rejected by the owner: a terminated Task would strand validated work.
- **Make `prediction_batch_validate` write.** Rejected: ADR 0131.
- **Auto-submit from `prediction_complete`.** Rejected: complete must not become a prediction writer.

## Consequences

Until a prompt GO, live Tasks never stage, so start is unchanged. After a caller stages, the next start drains automatically. One transferable R2 object.

## Recovery and migration boundary

Code and docs only. Leftover `enrichment/batch-hold/<runId>.json` keys from the unmerged earlier design are unused. No schema migration. Deploy authorizes no Task change.

## Evidence

- **Original FAIL:** [AIR-510](https://trello.com/c/01JAM4TP)
- **Owner BLOCK of run-scoped recovery:** GitHub PR #704 comment, 17 Nov 2026
- **Dated verification:** [offline tests](../evidence/prediction/air-510-hold-recovery-2026-11-17.md)
