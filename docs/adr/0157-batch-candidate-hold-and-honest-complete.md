# ADR 0157: Persist validated batch items separately from the read-only preflight; refuse a blanket external_termination

**Status:** Proposed (code delivery; Product Owner architectural acceptance pending independent review)
**Original decision date:** 2026-11-17
**Recorded at:** 2026-11-17
**Approval source:** Implementation under [AIR-510](https://trello.com/c/01JAM4TP) after the 17 Nov 2026 08:07 Europe/Madrid production FAIL; this record is not a production GO
**Related work:** [AIR-510](https://trello.com/c/01JAM4TP); [ADR 0131](0131-batch-candidate-preflight-tool.md); [ADR 0136](0136-prediction-batch-manifest-size-and-spent-complete.md)
**Supersedes:** None. Qualifies ADR 0131: `prediction_batch_validate` stays a pure preflight. Qualifies ADR 0136: `external_termination` is not a truthful complete for an owned five-film `batch_v2` run that has not submitted and still has recoverable state.
**Superseded by:** None

## Context

The 16–17 Nov 2026 natural A/B/C/D series (prompts already carrying `prediction_batch_manifest`, Worker #703 at 100%) still lost 9 of 34 owned runs as `external_termination` with `firstSubmitAt=null`. Task B (`946948a1…`) validated all five films then lost the submit-ready objects. Task A (`fb56603c…`) lost the schema contract before preflight. The same `manifestHash` later succeeded on another slot. Connected MCP catalogs (including this session) still omitted `prediction_batch_manifest` after Worker deploy. ADR 0131 forbids I/O on `prediction_batch_validate`. Reinstalling the same Task texts is not a fix.

## Decision

1. **`prediction_batch_validate` stays read-only.** No runId, lease, hold or storage. ADR 0131 is unchanged.
2. **`prediction_batch_hold` is a separate writer.** After a valid preflight, the lease holder may persist 1–10 already generated items on `enrichment/batch-hold/<runId>.json` (epoch and `manifestHash` bound). Not a submit. Invalid extra keys refused. Films must be in `selectedIds`.
3. **`prediction_batch_submit({useHeld:true})`** loads that hold, re-validates authoritatively, and commits. `items` must be omitted. Dry-run is refused. Replay of the same held body remains the existing submit identity.
4. **Readback.** `prediction_batch_manifest` `part=hold` lists held filmIds; `part=item` returns one held object. Envelope/profile/contract/film parts are unchanged.
5. **Honest complete.** For a running `batch_v2` run, `reason: external_termination` is **409**:
   - `held_unsubmitted` when a hold still has unsubmitted films;
   - `client_state_lost` when `firstSubmitAt` is null and selected films remain.
   The caller may then recover, or complete with **`client_state_lost`** or **`manifest_unusable`**. Fault `failedStep` may be `validate`, `manifest` or `hold`.
6. **Tool discovery.** MCP `initialize` advertises `tools.listChanged: true` and server version `0.4.0`. Instructions name the batch v2 tool set at the front. A cached ChatGPT/Task catalog is still a client issue; this does not mutate Scheduled Tasks.

Not authorized: Task prompt edits, live `prediction_batch_start`, lease reset, flags, R2/D1 operators, or production hold/submit.

## Alternatives considered

- **Make `prediction_batch_validate` write the hold when `runId` is present.** Rejected: it would falsify `readOnlyHint` and ADR 0131.
- **Auto-submit the hold from `prediction_complete`.** Rejected: complete must not become a writer of predictions.
- **Keep accepting `external_termination` for lost buffers.** Rejected: it hid recoverable owned state as a Worker/external stop (AIR-510 FAIL).

## Consequences

A later owner-approved prompt can call hold after validate and `useHeld` after a lost buffer. Until that GO, a Task that only calls the old five tools still cannot persist items; complete will 409 instead of recording a false spent/external stop, so the lease remains until `client_state_lost` or expiry. One more write tool and one R2 object per run.

## Recovery and migration boundary

Code and docs only. Reverting removes the hold object writes; leftover `enrichment/batch-hold/` keys are unused. No schema migration. Deploy authorizes no Task change and no prediction run.

## Evidence

- **Original decision:** [AIR-510 FAIL comment](https://trello.com/c/01JAM4TP)
- **Implementation:** this PR
- **Dated verification:** [offline interruption tests](../evidence/prediction/air-510-hold-recovery-2026-11-17.md)
- **Uncertainty:** live Task tool discovery after `listChanged: true` is unproven until a natural slot

## Follow-ups

Owner GO to add `prediction_batch_hold` and `useHeld` to the live A/B/C/D prompts. Natural-series acceptance remains on AIR-510.
