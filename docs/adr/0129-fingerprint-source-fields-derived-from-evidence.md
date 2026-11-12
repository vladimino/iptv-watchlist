# ADR 0129: The Worker derives fingerprint.sourceBasis and fingerprint.sourceRefs from valid evidence when the caller omits both

**Status:** Accepted
**Original decision date:** 2026-11-12 (Product Owner chose variant 1 and the `failureReason` diagnostic in the AIR-450 chat)
**Recorded at:** 2026-11-12
**Approval source:** owner decision in the AIR-450 session of 12 Nov 2026 (reply "вариант 1, failureReason тоже делай" to the executor's integration proposal), after the [AIR-450 handoff of 12 Nov 2026, 20:39 Madrid](https://trello.com/c/VPd21Y9d)
**Related work:** [AIR-450](https://trello.com/c/VPd21Y9d) (checkpoint C3); [ADR 0122](0122-prediction-batch-runner-v2-dual-protocol.md); the optional evidence map of AIR-46 and AIR-335 ([enrichment reference](../reference/api/enrichment.md#fingerprint-evidence))
**Supersedes:** None. It refines one rule of the AIR-46 evidence contract for the case where the two derived fields are omitted; the AIR-46 rule stays for every supplied value.
**Superseded by:** None

## Context

A fingerprint that carries `evidence` must also carry `sourceBasis` and `sourceRefs` equal to the aggregate of that map (mechanics in list order, then the 13 general dimensions, then the genre dimensions; first-seen unique bases and refs, refs capped at 8; one basis keeps its name, more than one is `mixed`). The Worker has always computed that aggregate to check the two fields, and rejects a disagreeing value instead of rewriting it.

The AIR-450 scheduled dry-run checkpoint C3 (generation size 10, ten films of one frozen manifest) got ten `validation_failure`, five of them `fingerprint_schema` with `fingerprint.sourceRefs invalid_ref`: the generator had put `sourceBasis` `metadata` with an empty `sourceRefs`, a legal shape before the evidence map existed. The same evidence is valid when the two fields are spelled out correctly. Reproduced offline on the real validator: a metadata-only mechanic with `sourceRefs: []` gives `fingerprint.sourceRefs invalid_ref`; `mixed` with correct refs gives no issue. The failure is a mechanical bookkeeping step asked of a language model, not a lack of evidence, and it was discovered only after submit. The other five failures of C3 (`caller_reported parse_error`) are not explained by this and are handled separately.

## Decision

When `fingerprint.evidence` is present and **both** `sourceBasis` and `sourceRefs` are omitted, the Worker sets them from the aggregate it already computes, before validation and before the content hash, in every path that accepts a fingerprint: `prediction_validate`, the v5 `submit`, the v2 `batch_submit` and its dry run. The stored fingerprint therefore always carries both fields; the immutable body and the content hash are those of the spelled-out form.

Invariants:

- **A supplied value is never rewritten.** If either field is present, nothing is derived and a disagreeing value is rejected exactly as before (`fingerprint.sourceBasis invalid_enum`, `fingerprint.sourceRefs invalid_ref`). One omitted field with the other supplied stays a rejection.
- **Only a valid map derives anything.** An invalid map (missing claim, forbidden or unproven ref, metadata-only quality claim, extra key, empty map) derives nothing; its own issues are reported, and the two omitted fields are not reported as missing on top of them. The Worker adds no basis, ref or claim the evidence does not contain, and never softens an evidence rule.
- **No version change.** `FINGERPRINT_SCHEMA_VERSION`, `FINGERPRINT_PROMPT_VERSION`, `PREDICTION_PROMPT_VERSION`, the transition registry, the batch and submit limits, `pin` and the v5 protocol are unchanged. A caller that still sends the aggregate (the live v5 Task) is unaffected.
- **Discoverable.** `enrichment_schema` states the rule under `contract.fingerprint.evidence.sourceFields`; the Task prompts stop asking the model to compute the aggregate.

Not decided: any activation, Task change or production run. The model-side causes of the other failures of C3 are not claimed to be fixed by this ADR.

## Alternatives considered

Discussed in the AIR-450 session: (2) a deterministic helper executed inside the ChatGPT Scheduled Task, which needs a code runtime the Task may not have and cannot be proved from the repository; (3) stronger prompt wording alone, which is probabilistic; (4) calling `prediction_validate` before each submit, which adds one MCP call per film and changes the measured method. The owner chose the Worker derivation because it removes the failure class for every client without any code execution in the Task.

## Consequences

A fingerprint with a valid map can no longer fail on the two derived fields when the generator omits them, in the experiment and in production alike. The Worker's contract grows one additive, documented behaviour; the cost is one more rule in the validator and its tests (a differential test against an independent reference over a seeded sweep, the C3 regression, every submit path, the content hash of the omitted and spelled-out forms). A frozen manifest taken before the change carries the previous `contract.schema` text, which still lists the two fields among the required ones; the dry-run and scheduled prompts therefore tell the model explicitly not to send them. Rolling the Worker back restores the earlier strict rule; fingerprints already stored keep both fields and stay valid.

## Recovery and migration boundary

Code only, no data write, flag or migration. Revert the change to restore the strict rule. Deploying it authorizes no run, dry run, Scheduled Task or sample.

## Evidence

- **Original decision:** AIR-450 owner decision of 12 Nov 2026 (above).
- **Implementation:** the AIR-450 source-derivation pull request; [sanitized evidence](../evidence/prediction/air-450-source-derivation-2026-11-12.md).
- **Uncertainty:** whether the ten C3 failures other than `invalid_ref` come from missing metadata, missing knowledge or the group size; the `failureReason` field of the private dry-run result is added to tell them apart at the next owner-approved checkpoint.

## Follow-ups

Next owner-approved checkpoint (C4, a short diagnostic on the same frozen manifest) and the full A/B stay under [AIR-450](https://trello.com/c/VPd21Y9d).
