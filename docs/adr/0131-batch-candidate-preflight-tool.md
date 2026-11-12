# ADR 0131: A read-only batch preflight tool, prediction_batch_validate, runs before prediction_batch_submit (proposed)

**Status:** Proposed (a draft for the Product Owner's architectural review; **not accepted**, not an effective decision)
**Original decision date:** not decided (proposed 2026-11-12)
**Recorded at:** 2026-11-12
**Approval source:** none for the architecture. The owner agreed that a batch preflight is worth pursuing and allowed a reviewable implementation draft (handoff on the [AIR-450 card](https://trello.com/c/VPd21Y9d), 12 Nov 2026, 22:26 Madrid). That handoff called it an "owner decision"; the owner has since clarified, in the [pull request #576 comment](https://github.com/vladimino/iptv-watchlist/pull/576#issuecomment-6838249161), that agreeing to pursue the idea and allowing a draft is **not** approval of the final architecture or of this wording, and that the handoff must not be cited as such.
**Related work:** [AIR-450](https://trello.com/c/VPd21Y9d); [ADR 0122](0122-prediction-batch-runner-v2-dual-protocol.md); [ADR 0129](0129-fingerprint-source-fields-derived-from-evidence.md); the single-candidate `prediction_validate` of AIR-152
**Supersedes:** None. If accepted, it would refine one statement of ADR 0122 (validation happens once, at submit, so no `prediction_validate` call is needed); until then ADR 0122 stands as written.
**Superseded by:** None

## Context

AIR-450 checkpoints on one frozen manifest showed that the typical failures of generated payloads reach the Worker only at submit: C4 (size 10) 9 of 10 `would_write`; C5 (100 films) 35 of 100, 65 `caller_reported parse_error` from a synopsis-only heuristic; C6 stopped after the first group, 9 of 10 with `fingerprint.evidence.execution.stakes invalid_ref` (metadata was the only evidence of an execution-quality claim) and one reported `parse_error`. The Worker's validator is correct, the ban on metadata-only execution quality is correct and the source fields are derived (ADR 0129). The weakness is the unreliable model payload, discovered only after the submit call, when the generation is already spent. The single-film `prediction_validate` exists but is one call per film and was excluded from the experiment to keep the call count measured.

## Proposed decision

Add one MCP tool, **`prediction_batch_validate`**, for batch runner v2 clients: a pure, read-only check of **1 to 10 candidates** per request, called after generation and before `prediction_batch_submit`. This section is a proposal; every point below is open to change by the owner.

- **Items.** `{filmId, fingerprint?, prediction?, metadata?}` with a closed key set. A `prediction_only` film sends only `prediction`; `metadata` (the film's `modelMetadata`) is passed only when the fingerprint evidence cites `metadata:*` tokens, as in `prediction_validate`. At least one of `fingerprint` and `prediction` is required.
- **Same rules, no copy.** Each candidate is judged by the same code as `prediction_validate`: `fingerprintIssues` over the ADR 0129 derivation, and `predictionIssues`, through one shared helper. Parity with `prediction_validate` and with the dry run of `prediction_batch_submit` is tested in the draft.
- **Per-item results.** `results[]` in request order, each bound to its `index` and `filmId`, with `valid`, `itemIssues` (a defect of the item itself), and per object `{checked, issues[{path, code}]}` from the closed vocabulary. A defect in one item never fails the others. The answer also carries `success`/`valid`, `contractVersion`, `counts`, `storage: "not_accessed"` and `sideEffects: "none"`.
- **Whole-request refusals** (tool errors, nothing checked): more than 10 or no items, an unknown top-level key, a repeated `filmId`, or a request over 56 KiB (57,344 bytes, the group limit of `batch_submit`; the MCP inbound limit is 64 KiB). The refusal tells the caller to split the group and never echoes the payload.
- **No I/O, no state.** It reads and writes no R2 or D1, run, lease, queue, profile, model, TMDB or EPG, answers without a storage binding, is annotated `readOnlyHint: true` and is registered in the read-side-effect audit.
- **Validation boundary.** It does not check the frozen manifest, `inputHash`, the live profile, the run, the epoch or the film's eligibility or current fingerprint: those stay with `prediction_batch_submit`, which remains the only authoritative check and is unchanged. A candidate valid here is not refused at submit for its fingerprint or prediction **content**; it can still be refused for any state check.
- **Prompt protocol (draft).** Generate the group, preflight it, correct only what real knowledge or a really used source supports (never an invented ref, never `model_knowledge` or `web_research` without a basis, never a metadata-only execution-quality claim such as `stakes`), at most one re-preflight of the corrected films, report any film that still has issues as `failure.kind: parse_error` without hiding the reason, then submit. The extra call is proposed; its cost is to be measured, and the dry-run result records it (`calls[].kind`, `films[].preflight`).

Not proposed here and not authorized: any Scheduled Task, run, activation or checkpoint (C7), the live v5 Task, flags, or a claim of saved model quota.

## Alternatives considered

Only alternatives the executor considered; the owner has **not** chosen among them. (1) `prediction_validate` once per film: ten calls per group instead of one, and it was excluded from the experiment to keep the call count measured. (2) Relying on the submit validation alone: the failures are found only after the generation is spent. (3) A dry-run flag in `batch_submit`: it would take the gate, the lease epoch and the manifest, none of which a preflight needs, and it would blur the write-free guarantee. (4) A server-side repair or rewrite of invalid candidates: rejected in the draft because it would invent evidence the model did not provide (ADR 0129 derives only what the evidence already contains).

## Consequences (if accepted)

A client can find the typical content failures of a group in one cheap call before it submits. One more tool, one more registered read tool (the audit lists 16), one shared helper. A request of ten realistic candidates is about 44 KB and the answer about 1.6 KB (measured offline, [evidence](../evidence/prediction/air-450-batch-preflight-2026-11-12.md)); the MCP result carries the answer twice (`text` and `structuredContent`). A preflight that passes can still be refused at submit for state reasons, which the prompts keep handling. Cost on the model side (usage, Codex quota, time) and production latency are not measured.

## Recovery and migration boundary

Code, schema and documentation only; no data, flag or migration. Reverting removes the tool; submit and `prediction_validate` are unchanged. The implementation in the open pull request is a reviewable draft: it must not be merged or deployed as an accepted architecture before the owner's acceptance. Deploying it authorizes no run, dry run, Task or checkpoint.

## Owner acceptance gate

Before this ADR moves to **Accepted**, the Product Owner reviews the final text and decides, or changes, at least: the alternatives and trade-offs above, the MCP API surface (tool name, item shape, result shape, limits), the validation boundary (what the preflight deliberately does not check), the extra-call cost and the rollback. Only then is the status changed, with an exact citation of the owner's decision; independent code review, exact-HEAD CI and the normal merge and deploy pipeline follow. The owner may reject the design.

## Evidence

- **Exploration:** the AIR-450 handoff of 12 Nov 2026, 22:26 Madrid (owner-approved exploration and draft, not an architectural approval), and the clarification in the pull request comments above.
- **Implementation (draft):** the AIR-450 batch preflight pull request; [offline measurement](../evidence/prediction/air-450-batch-preflight-2026-11-12.md).
- **Uncertainty:** the real model quality gain, the Codex quota effect of the extra call and the production latency are not measured; the first owner-approved checkpoint with the preflight would show them.

## Follow-ups

The owner's review of this ADR, then the next checkpoint and the full A/B under [AIR-450](https://trello.com/c/VPd21Y9d).
