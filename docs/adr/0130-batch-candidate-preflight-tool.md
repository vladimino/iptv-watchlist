# ADR 0130: A read-only batch preflight tool, prediction_batch_validate, runs before prediction_batch_submit

**Status:** Accepted
**Original decision date:** 2026-11-12 (Product Owner decision after checkpoint C6)
**Recorded at:** 2026-11-12
**Approval source:** owner decision / executor handoff on the [AIR-450 card](https://trello.com/c/VPd21Y9d), 12 Nov 2026, 22:26 Madrid ("добавить пакетный read-only preflight перед prediction_batch_submit")
**Related work:** [AIR-450](https://trello.com/c/VPd21Y9d); [ADR 0122](0122-prediction-batch-runner-v2-dual-protocol.md); [ADR 0129](0129-fingerprint-source-fields-derived-from-evidence.md); the single-candidate `prediction_validate` of AIR-152
**Supersedes:** None. It refines one statement of ADR 0122, that validation happens once, at submit, so that no `prediction_validate` call is needed: the batch protocol gains an optional, read-only, group-level preflight, while the validation at submit stays authoritative and unchanged.
**Superseded by:** None

## Context

AIR-450 checkpoints on one frozen manifest showed the typical failures of generated payloads reach the Worker only at submit: C4 (size 10) 9 of 10 `would_write`; C5 (100 films) 35 of 100, 65 `caller_reported parse_error` from a synopsis-only heuristic; C6 stopped after the first group, 9 of 10 with `fingerprint.evidence.execution.stakes invalid_ref` (metadata was the only evidence of an execution-quality claim) and one reported `parse_error`. The Worker's validator is correct, the ban on metadata-only execution quality is correct and the source fields are derived (ADR 0129). The weakness is the unreliable model payload, discovered only after the submit call, when the run has already spent the generation. The single-film `prediction_validate` exists but is one call per film and was excluded from the experiment to keep the call count measured.

## Decision

Add one MCP tool, **`prediction_batch_validate`**, for batch runner v2 clients: a pure, read-only check of **1 to 10 candidates** per request, called after generation and before `prediction_batch_submit`.

- **Items.** `{filmId, fingerprint?, prediction?, metadata?}` with a closed key set. A `prediction_only` film sends only `prediction`; `metadata` (the film's `modelMetadata`) is passed only when the fingerprint evidence cites `metadata:*` tokens, as in `prediction_validate`. At least one of `fingerprint` and `prediction` is required.
- **Same rules, no copy.** Each candidate is judged by the same code as `prediction_validate`: `fingerprintIssues` over the ADR 0129 derivation, and `predictionIssues`; a shared helper serves both tools, so there is one implementation. Parity with `prediction_validate` and with the dry run of `prediction_batch_submit` is tested.
- **Per-item results.** `results[]` in request order, each bound to its `index` and `filmId`, with `valid`, `itemIssues` (a defect of the item itself: not an object, missing or bad `filmId`, unknown key, wrong type, neither object), and per object `{checked, issues[{path, code}]}` from the closed vocabulary. A defect in one item never fails the others. The answer also carries `success`/`valid` (true only when every item is valid), `contractVersion`, `counts`, `storage: "not_accessed"` and `sideEffects: "none"`.
- **Whole-request refusals** (tool errors, nothing checked): more than 10 or no items, an unknown top-level key, a repeated `filmId`, or a request over 56 KiB (57,344 bytes, the group limit of `batch_submit`; the MCP inbound limit is 64 KiB). The refusal tells the caller to split the group and never echoes the payload.
- **No I/O, no state.** It reads and writes no R2 or D1, run, lease, queue, profile, model, TMDB or EPG, answers without a storage binding, is annotated `readOnlyHint: true` and is registered in the read-side-effect audit.
- **What it does not check.** The frozen manifest, `inputHash`, the live profile, the run, the epoch and the film's eligibility or current fingerprint: those stay with `prediction_batch_submit`, which remains the only authoritative check and is unchanged. A candidate valid here is not refused at submit for its fingerprint or prediction **content**; it can still be refused for any of the state checks.

Protocol for the proposed v2 prompts: generate the group, preflight it, correct only what real knowledge or a really used source supports (never an invented ref, never `model_knowledge` or `web_research` without a basis, never a metadata-only execution-quality claim such as `stakes`), at most one re-preflight of the corrected films, report any film that still has issues as `failure.kind: parse_error` without hiding the reason, then submit. The extra call is accepted; its cost is measured, not assumed, and the dry-run result records it (`calls[].kind`, `films[].preflight`).

Not decided: any Scheduled Task, run, activation or checkpoint (C7), the live v5 Task, flags, or a saving of model quota (none is claimed without measurement).

## Alternatives considered

`prediction_validate` once per film: ten calls per group instead of one, and previously excluded from the experiment to keep the count measured. Relying on the submit validation alone: the failures are found only after the generation is spent. Moving the preflight into `batch_submit` as a dry-run flag: it would take the gate, the lease epoch and the manifest, none of which the preflight needs, and it would blur the write-free guarantee. The owner chose a separate group-level tool.

## Consequences

A client can find the typical content failures of a group in one cheap call before it submits. One more tool, one more registered read tool (the audit lists 16), one shared helper. A request of ten realistic candidates is about 44 KB and the answer about 1.6 KB (measured offline, [evidence](../evidence/prediction/air-450-batch-preflight-2026-11-12.md)); the MCP result carries the answer twice (`text` and `structuredContent`). A preflight that passes can still be refused at submit for state reasons, which the prompts keep handling.

## Recovery and migration boundary

Code, schema and documentation only; no data, flag or migration. Reverting removes the tool; submit and `prediction_validate` are unchanged. Deploying it authorizes no run, dry run, Task or checkpoint.

## Evidence

- **Original decision:** the AIR-450 owner decision of 12 Nov 2026 (above).
- **Implementation:** the AIR-450 batch preflight pull request; [offline measurement](../evidence/prediction/air-450-batch-preflight-2026-11-12.md).
- **Uncertainty:** the real model quality gain and the Codex quota effect of the extra call are not measured; the first owner-approved checkpoint with the preflight is what shows them.

## Follow-ups

The next checkpoint and the full A/B stay under [AIR-450](https://trello.com/c/VPd21Y9d).
