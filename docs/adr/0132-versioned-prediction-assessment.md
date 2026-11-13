# ADR 0132 (proposed): Versioned prediction assessments accompany predictions into R2

**Status:** Proposed for Product Owner review. This is a documentation/design proposal, NOT approval of a production writer, data migration, prompt switch or Scheduled Task.
**Proposed:** 2026-11-13
**Context:** [AIR-450](https://trello.com/c/VPd21Y9d), [ADR 0122](0122-prediction-batch-runner-v2-dual-protocol.md), [ADR 0131](0131-batch-candidate-preflight-tool.md), [ADR 0038](0038-durable-rating-and-prediction-lineage.md).
**Owner intent:** Keep the model's researched explanation of *why* it made a particular personal prediction so that later analysis can compare Taste Profile matching, research quality, revisions and eventual personal ratings.

## Problem

Existing immutable prediction versions preserve \`predictedRating\`, \`probability4Plus\`, \`confidence\`, \`matchSignals\`, \`mainRisk\`, prompt/profile/fingerprint identities and \`generatedAt\`; fingerprints may preserve a claim-level evidence map. They do not preserve film-specific research findings, the model's critical taste comparison, independent probability rationale, material uncertainties or trustworthy model provenance. AIR-450 A50/B50 compact reports dropped even the full fingerprint/prediction payloads, making semantic quality review impossible. In B50, \`probability4Plus\` was mechanically mapped from the predicted rating and an original film identity was reported incorrectly.

## Proposed decision (owner intent accepted; storage details for review)

1. Add optional \`assessment\` to a successful \`prediction_batch_submit.items[]\` and to the v5 \`prediction_submit\` item. It accompanies the actual \`prediction\` and, when required, \`fingerprint\`. It is forbidden on \`failure\` items. The caller generates the assessment *concurrently with the prediction*, before preflight or submit; it is not a retrospective explanation.
2. The payload includes bounded source-level research and independently written rating rationale. The Worker validates the shape and identity but does not assert that URLs, reviews, semantic interpretations or quality claims are true. An absent assessment is valid for legacy callers during compatibility rollout. New research-enabled tasks may require it under their own approved task contract.
3. Persist an accepted assessment as a **create-only, content-addressed R2 sidecar for that film and that one prediction version**, not a mutable \`assessment.json\` and not a view-index blob. Proposed key: \`enrichment/films/<encoded-film-id>/predictions/assessments/<assessment-sha256>.json\`. Store \`assessmentR2Key\` and \`assessmentSha256\` on the committed prediction record; those two fields also become part of its existing immutable prediction version body. A later prediction refers to its own assessment. Older version bodies have neither field and remain valid.
4. Use the Worker-assigned prediction \`generatedAt\` as the authoritative save/commit timestamp. The immutable assessment body repeats that timestamp and film/profile/fingerprint/run identity as server-attested association. Actual model completion time, if supplied, is optional \`clientReportedCompletedAt\` and MUST NOT be misrepresented as a verified server time. There is no independent model execution timestamp when the platform does not provide one.
5. Caller supplies \`model\` identity and provenance: \`provider\`, \`modelId\`, optional \`modelVersion\`, \`reportedBy: "caller"\`. If the Scheduled Task cannot access an exact runtime model/version, retain \`null\`. The Worker cannot prove which model the ChatGPT harness actually used; it attests only to received fields. Distinguish this identity from existing server-owned \`predictionPromptVersion\`, \`fingerprintPromptVersion\`, Taste Profile version and assessment schema version.
6. **Safety of live writes:** a successful new prediction must not become the authoritative D1 pointer before the assessment sidecar and immutable prediction version body exist and match their hashes. Write order: validate (incl. size) -> derive final server-assigned metadata -> create-only assessment sidecar (verify identical bytes on existing key) -> create-only immutable prediction body containing the assessment pointer -> guarded D1 pointer commit -> existing view/index/checkpoint sequence. A crash before the D1 commit can leave only unreferenced immutable R2 objects, never a live prediction pointing at missing assessment bytes. Do not overwrite history, update any old assessment, or add a new R2 write on an \`already_current\` result. A replay must be idempotent and must not silently add/replace an assessment to an already-settled prediction.
7. \`inputDigest\` for new \`batch_submit\` requests includes the canonical digest of the caller's \`assessment\` (or \`null\`) in addition to the existing fingerprint/prediction/failure tuple. An identical retry is a replay, a changed assessment for the same settled run/film is a conflict. Validate and preserve the existing gate, lease, epoch and checkpoint logic. A D1/R2 failure must not acknowledge a new assessment as committed.
8. **Dry-run isolation stays absolute:** \`prediction_batch_validate\` (optional \`assessment\` property) and \`prediction_batch_submit(dryRun: true)\` validate the exact same assessment contract but perform zero R2/D1 writes and do not persist any research trace, even into a separate "trial" R2 namespace. Their result reports per-item assessment validity and approximate bytes, not the full private assessment. AIR-450 persists complete A/B private result records *outside* this Worker under the owner's private experimental storage with explicit owner retention. Do not let this PR create or run a Scheduled Task.
9. No automatic public API, film-page or view-index exposure of the full assessment. Future owner-only analytical reads can join the existing historical prediction version pointer to its assessment pointer and verify both SHA-256 digests. Older predictions return \`assessment: null\`, not an inferred explanation. Link actual ratings only in read-only *post-hoc* quality analysis; no actual rating enters model generation.
10. Keep model output, profile, review paraphrases, URL provenance and any personal taste in owner-only storage. Never post source bodies or assessments to public GitHub/Trello; report only sanitized aggregates. Record brief original analytical summaries, not full copied review text, and retain provenance. R2 retention matches immutable prediction version lineage; any cleanup policy requires a separate approval.

## Assessment v1 payload shape (proposal)

See [prediction assessment contract draft](../reference/api/prediction-assessment.md). The \`assessment\` field is a **closed** object; server-owned \`generatedAt\`, \`filmId\`, \`runId\`, \`profileHash\` and \`fingerprintHash\` are *not client-supplied*. Summary:

- \`schemaVersion: 1\`
- \`model: {provider, modelId, modelVersion, reportedBy: "caller"}\`; \`modelId\` and \`modelVersion\` nullable, no invented model build.
- \`research: {sources[], findings[], unknowns[]}\`: each source has a stable local ID and real URL if externally accessed; each finding paraphrases a substantive observation and names IDs of actually read sources. Model-only knowledge uses an explicit \`basis: "model_knowledge"\`, never a fake citation.
- \`tasteAssessment: {positiveDrivers[], negativeDrivers[], anchorComparisons[]}\` as concrete concise explanations tied to this film.
- \`ratingRationale: {whyThisRating, whyNotHigher, whyNotLower, probabilityRationale, mainUncertainty}\`. Do **not** duplicate the numeric rating/probability in this object: the submitted \`prediction\` is authoritative, so explanations cannot silently drift from another copy.
- Optional \`clientReportedCompletedAt\` UTC ISO timestamp, explicitly unverified.
- Proposed strict upper bound **4096 UTF-8 bytes per assessment** and bounded lengths/counts on arrays. The exact accepted ceiling requires real offline payload measurements; never truncate meaningful fields silently to pass.

## Alternatives considered

**Put assessment directly inside the immutable prediction body.** Simpler atomicity and no new R2 object, but adds large private, unstructured analytical text to every read/replication of a prediction pointer/version (and possibly the D1 index) and changes the projection surface. Rejected in favor of an owner-only R2 sidecar plus a small pointer.

**Mutable \`enrichment/films/<id>/assessment.json\`.** Simpler read but loses original rationale when predictions are recalculated; incompatible with immutable history and post-hoc evaluation. Rejected.

**Always persist trial assessments to R2, even under dry-run.** Violates AIR-450's strict zero-write guarantee and contaminates production data. Rejected.

**Make assessment mandatory for all current callers.** Breaks v5 and historical compatibility. Rejected for initial delivery; require it only in an explicitly approved research-enabled caller.

## Testing and owner acceptance

- Offline contract fixtures: missing/valid/invalid assessment, unknown model version, mismatched film provenance, fake URL and malformed source reference, failed prediction, \`already_current\`, old record without assessment, per-item batch failures.
- Prove dry-run and preflight zero-write isolation with R2/D1 writes faulted, including invalid assessment and retries.
- Immutable sidecar SHA parity, duplicate create-only readback, collision fail-close, crash before/after sidecar and version write, conflict on changed assessment, \`submit_in_flight\`/lease/gate loss, replay after D1 commit but before checkpoint; existing projection and v5 behavior unchanged.
- Validate the combined request-size overhead: MCP \`prediction_batch_submit\` currently refuses a whole body >56 KiB (HTTP 64 KiB). A \`generationSize=10\` is not a guarantee that ten assessment-rich items fit one submit. The caller must split the **transport** batch on a size refusal without changing the ten-film model-generation batch or silently dropping assessments.
- Exact HEAD independent review, tests, build, merge/deploy and narrowly authorized read-only verification; no live predictions or Task activation merely to prove a deployment.
- Before production activation the owner reviews one real **private** ten-film research A/B, including actual source checks, explanation quality and byte/call costs. A hundred-film research trial remains a separate explicitly approved step.

## Documentation and implementation scope

Additive v5 and v2 submit/preflight contract, R2 immutable sidecar writer and read-side linkage, offline isolation tests, API references and runbooks. Update architecture diagrams for the new immutable R2 sidecar once implementation scope is approved; apply Mermaid render/review gates. Avoid D1 migration if the existing prediction record JSON can carry the two nullable pointer fields. Do not alter Taste Profile scoring, evidence semantics, the legacy Task, prompt version, flags or production writer authority as part of this *draft*.

**Still for owner review:** (a) sidecar versus inline body choice; (b) required/optional rollout; (c) hard 4 KiB assessment and research-source caps; (d) model-provenance fields; (e) whether research-run reports live only in private experimental documents until production adoption.
