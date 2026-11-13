# ADR 0132: A per-film prediction assessment is stored as its own immutable R2 object beside each prediction version (proposed)

**Status:** Proposed (a draft for independent review and the Product Owner's decision; **not accepted**, not an effective decision)
**Original decision date:** not decided (proposed 2026-11-13)
**Recorded at:** 2026-11-13
**Approval source:** none for the architecture. The owner stated the intent and asked the executor to prepare a contract and, if architecturally significant, an ADR for review (handoff on the [AIR-450 card](https://trello.com/c/VPd21Y9d), 13 Nov 2026, 08:52 Madrid). The same handoff says the choice of details is **not** predetermined by the closed, unapproved pull request #584, which this document does not use as a source.
**Related work:** [AIR-450](https://trello.com/c/VPd21Y9d); [ADR 0122](0122-prediction-batch-runner-v2-dual-protocol.md); [ADR 0129](0129-fingerprint-source-fields-derived-from-evidence.md); [ADR 0131](0131-batch-candidate-preflight-tool.md); [ADR 0045](0045-retire-prediction-version-objects-switch.md) (immutable version objects); [ADR 0078](0078-d1-authoritative-prediction-domain.md); the derived `confidenceAssessment` of AIR-336
**Supersedes:** None
**Superseded by:** None

## Context

The owner wants the per-film `assessment` to become a full diagnostic artifact passed at `submit` and linked to the stored prediction version in R2: the grounds of the rating and of P(4.0+), concrete signals and risks against the Taste Profile, uncertainties, and, where really done, the sources or reviews actually researched; plus the prediction date and the model identity and version, distinguishing what is confirmed from what is unavailable. The purpose is later analysis of the quality of the Taste Profile and of Predictions, not only faster mechanical matching.

What the code does today ([evidence](../evidence/prediction/air-450-assessment-current-state-2026-11-13.md)): the prediction validator checks only the six model fields and **ignores unknown keys**; both `submit` paths store the **whole** submitted `prediction` object, so an extra payload reaches the immutable version body, the D1 `display_json`, the bundle mirror and the shared `view-index.json`; the replay digest ignores it (a different extra payload with the same six fields is a silent replay, not a conflict); a dry run accepts it unchecked. Freshness does not depend on extra keys. An immutable version is the prediction record without its pointer fields, hashed by its canonical bytes; the record is the unit of history. Group requests are bounded at 56 KiB (the MCP inbound limit is 64 KiB); ten items with rich fingerprints measured 40,653 bytes, leaving about 1.67 KB per film, and ten `prediction_only` items leave about 5.3 KB per film.

## Proposed decision

Everything below is a proposal; each point is open to change by the owner. The [contract draft](../reference/api/prediction-assessment.md) specifies it.

1. **Storage: a separate immutable object, joined by key (alternative B below).** One create-only R2 object per prediction version, `enrichment/films/<id>/predictions/assessments/<predictionSha256>.json`, where `<predictionSha256>` is the checksum of the prediction version object the assessment belongs to. The prediction record, the version body, the bundle, the D1 pointer and display document and the view index are **not** changed: no pointer, no field, no hash change. The assessment is neither in D1 nor in any index or public or event surface.
2. **Input.** An optional `assessment` on a submit item (a sibling of `prediction`, not inside it), a closed schema with explicit length and count bounds and a serialized cap, and the same validator in `prediction_batch_validate`, the dry run and `batch_submit`. The v5 `submit` is unchanged apart from closing unknown keys (point 6).
3. **Provenance split.** The Worker records and confirms: `recordedAt`, `runId`, `trigger`, the profile identity, the fingerprint hash and the prediction checksum. The caller reports, and the object marks as `caller_reported`, the model identity and version (or `unavailable`) and the research sources it names; the Worker verifies neither and fetches nothing.
4. **Order, idempotency, failure.** The version object, then the assessment object (both create-only, orphan-safe), then the guarded D1 commit; a committed prediction therefore has its assessment if one was sent. The replay digest includes the assessment checksum only when an assessment is sent (existing digests do not change); a different assessment for the same version is a `conflict`, never an overwrite; a replay of the same body completes a missing object.
5. **Compatibility.** Optional first (`contract.assessment.required: false`, published in `enrichment_schema`); an absent object is "no assessment", never an error; old versions stay without one. Whether it becomes required, and a backfill, are separate owner decisions. `PREDICTION_PROMPT_VERSION` and freshness are unchanged.
6. **Close the unknown-key hole first.** Independently of the assessment, the prediction validator rejects keys outside the six model fields (and the stripped `confidenceAssessment`), so that nothing unvalidated is copied into the version body, D1 or the view index. This is a separate, earlier implementation step (the issue code and v5 behaviour are open questions in the contract draft).
7. **Exposure.** No assessment content in the view index, D1 display, bundle, Events, the public film shape, `prediction_film_diagnostics` or any MCP read (presence, size and checksum only); analysis reads R2 through the existing read-only snapshot export, with its inventory extended for the new prefix. Retention and deletion are open questions.
8. **Dry run and preflight.** `dryRun: true` validates the assessment and writes nothing, as it does for the prediction; `prediction_batch_validate` (and `prediction_validate`) accept the same optional `assessment` with `assessment.*` issue paths.

Not proposed and not authorized: any implementation, deployment, Scheduled Task, run or checkpoint, a D1 migration, a change of the v5 Task, flags, or a claim about model quality, tokens or quota.

## Alternatives considered

- **A. Inline in the prediction record (`prediction.assessment`).** Simplest, one write, covered by the version hash. But it copies the payload into the view index, the D1 display document and the bundle mirror unless every projection strips it (today none does); it becomes part of the version identity, so the same prediction with another assessment is a different version and an assessment cannot be added to an existing version without rewriting history; its lifetime and size are tied to the hot documents.
- **B. A separate create-only object keyed by the prediction version checksum (proposed).** The record and the hot indexes stay as they are; the link is deterministic and verifiable (the key and the body both carry the checksum); legacy versions are simply without one and could be backfilled later without touching history; its size cap is independent. Costs: a second R2 write and a crash window handled by the write order and replay rule above; no D1 index, so analysis uses the R2 export or a per-film prefix list.
- **C. A separate object plus a pointer field on the prediction record.** The link is visible from the record, but the pointer is part of the version body, so the assessment becomes part of the version identity as in A, and it must be written first; no late attach.
- **D. A D1 table or JSON column.** Queryable, but needs a migration, an authority marker and a mutable-state decision for what is an immutable analytic artifact, and widens the D1 write path; it can be added later as an index over B.
- **E. The run record or the Events log.** Transient and not tied to a version; rejected.
- **For the size problem.** (i) a cap that keeps a group of ten rich films within 56 KiB (about 1.5 KB per film), (ii) a larger cap (about 2.4 to 3 KB) with groups split into two submit calls when needed, which separates generation size from submit size, (iii) a second tool that uploads assessments after the submit (more calls, a window without assessment). The draft proposes (ii) with a serialized cap and states its cost; the owner chooses.

## Consequences (if accepted)

Quality analysis gets one reproducible, versioned artifact per prediction version with honest provenance, without enlarging the hot documents or changing prediction identity. Costs: a larger submit (groups of ten rich films usually need two calls), more model output and time per film (to be measured in the A/B, not assumed), one more R2 prefix to inventory and export, one more validator, and a stricter prediction validator that may refuse callers that send undeclared keys. The assessment text can echo the Taste Profile and is private user context.

## Recovery and migration boundary

Documentation only at this stage. If later implemented, rollback is reverting the code: objects already written stay in R2 (create-only, unreferenced by any record) and harm nothing; no data migration, flag, D1 change or Scheduled Task is involved. Any implementation, deployment or run needs its own approval after this decision.

## Owner decision gate

Before Accepted, the Product Owner reviews and decides, or changes: where the assessment lives (A to E), the schema and caps, the size strategy, the provenance split, required versus optional and any backfill, the unknown-key closure and its issue code, the exposure and retention rules, and the rollout phases. Only then is the status changed with an exact decision citation. The owner may reject the design.

## Evidence

- **Exploration:** the AIR-450 handoff of 13 Nov 2026, 08:52 Madrid.
- **Facts:** [what the submit paths do today with extra prediction content](../evidence/prediction/air-450-assessment-current-state-2026-11-13.md).
- **Uncertainty:** whether any production record already carries extra keys (not read); the real assessment size and its token, time and quota cost; real MCP and ChatGPT wall time.

## Follow-ups

The owner's decision, then the phased implementation named in the contract draft, each under its own approval, with [AIR-450](https://trello.com/c/VPd21Y9d) holding the experiment.
