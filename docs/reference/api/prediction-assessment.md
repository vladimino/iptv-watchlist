# Prediction assessment contract (draft, NOT active)

**Status:** Proposed; implementation and production activation not authorized by this document.
**Related:** [ADR 0132 proposal](../../adr/0132-versioned-prediction-assessment.md), [batch submit](prediction-runner.md#post-apienrichmentbatchsubmit), [fingerprint evidence](enrichment.md#optional-fingerprint-evidence), [AIR-450](https://trello.com/c/VPd21Y9d).

## Purpose and compatibility

A personal film prediction should preserve not only its model-generated numerical result and fingerprint but also *why* that result was chosen, including actual external research, review disagreements, strengths/weaknesses against the frozen Taste Profile, the independent probability rationale and explicit uncertainty. This is historical evidence for later owner-only quality analysis, **not** an instruction to increase a score or an assertion that a source is truthful.

- The caller submits an optional \`assessment\` **with** the \`prediction\`; \`assessment\` is not allowed on a failure-only item. A legacy caller may omit it and old prediction records remain valid.
- Both read-only \`prediction_batch_validate\` and \`prediction_batch_submit(dryRun: true)\` must validate this shape with no state writes. Live v2 \`prediction_batch_submit\` and v5 \`prediction_submit\` accept it only after the separately approved implementation. During the pilot, dry-run A/B assessment objects must remain in **private external experiment records**; Worker dry-run never saves them to R2.
- The existing \`prediction\` remains the sole numeric source for \`predictedRating\`, \`probability4Plus\` and \`confidence\`. Never copy those values into \`assessment\` as competing facts. An invalid assessment fails its specific film with a precise \`assessment.*\` issue; do not silently discard a submitted but invalid assessment.
- No change to fingerprint or prediction prompt/schema versions is implied. Version assessment separately as \`assessment.schemaVersion=1\` and keep all caller errors in a new assessment issue namespace.

## Proposed request object

Illustrative structure only (URLs and titles below are **not research evidence**). No film/user-specific records are included here.

\`\`\`json
{
  "assessment": {
    "schemaVersion": 1,
    "model": {
      "provider": "openai",
      "modelId": null,
      "modelVersion": null,
      "reportedBy": "caller"
    },
    "research": {
      "sources": [],
      "findings": [
        {
          "basis": "model_knowledge",
          "summary": "A film-specific observation, if genuinely known",
          "sourceIds": []
        }
      ],
      "unknowns": ["Unverified execution quality"]
    },
    "tasteAssessment": {
      "positiveDrivers": ["A concrete match to the frozen Taste Profile"],
      "negativeDrivers": ["A concrete risk"],
      "anchorComparisons": []
    },
    "ratingRationale": {
      "whyThisRating": "Film-specific explanation of the predicted level",
      "whyNotHigher": "Main ceiling for the prediction",
      "whyNotLower": "Countervailing evidence",
      "probabilityRationale": "Independent uncertainty analysis, NOT a rating-to-probability lookup table",
      "mainUncertainty": "What evidence could most change this estimate"
    },
    "clientReportedCompletedAt": null
  }
}
\`\`\`

The absence of a \`research.sources\` entry explicitly means the source was not accessed; model knowledge must not be disguised as \`web_research\`. If a source was read, its source object has \`{id,url,kind}\`, with a truthful HTTPS URL and \`kind\` one of \`plot_summary|critic_review|audience_review|other\`. Each \`research.findings[]\` entry must use \`basis: "web_research"|"model_knowledge"|"metadata"\`; \`web_research\` findings cite nonempty \`sourceIds\` of accessed sources, while non-web findings use an empty source list. Do not store whole copied reviews, screenshots, page HTML, private conversations or protected content.

## Bounds (proposal to verify by offline payload tests)

- Max 4096 bytes for the canonical UTF-8 \`assessment\` request object. It is an independent cap in addition to existing \`fingerprint\` size rules and the MCP envelope bounds. The Worker rejects oversized assessments per film; callers must not trim without reassessment.
- \`research.sources\`: 0–4, unique short IDs; each URL HTTPS, syntactically safe, max 500 characters. A URL being syntactically valid does **not** mean the source was read or its claims are verified.
- \`research.findings\`: 0–5 concise original paraphrases; max 240 characters each. \`sourceIds\`: 0–4 references within the supplied source list.
- \`research.unknowns\`, \`tasteAssessment.positiveDrivers\`, \`negativeDrivers\`, \`anchorComparisons\`: 0–4 short strings, up to 240 characters each.
- \`ratingRationale.whyThisRating\`, \`whyNotHigher\`, \`whyNotLower\`, \`probabilityRationale\`, \`mainUncertainty\`: required nonempty strings, max 400 characters each; no numeric score clones.
- \`provider\`: short known provider identifier or null, \`modelId\` and \`modelVersion\`: nonempty short strings or null. \`reportedBy\` is explicitly \`"caller"\`, not \`"worker_verified"\`. A Scheduled Task that cannot inspect its actual model ID/version MUST use null, never infer it from the visible product brand.
- \`clientReportedCompletedAt\`: null or UTC ISO 8601; always labeled *unverified*. \`generatedAt\` belongs to the Worker and is set at commit, never accepted in this request.
- Additional properties at every level are refused. Detailed JSON Schema and issue-code fixtures are implementation deliverables; this page defines the semantic wire contract for architectural review.

## Server normalization and persistence

For \`created\` or \`recalculated\` only:

1. Validate \`assessment\` and construct a canonical persisted body containing the caller's assessment, authoritative \`filmId\`, existing \`fingerprintHash\`, Taste Profile identity, \`runId\`, and the server's \`generatedAt\`. Do not accept caller-provided film identity or profile/hash claims. Model identity remains \`reportedBy:"caller"\`.
2. SHA-256 the canonical persisted JSON, write create-only to \`enrichment/films/<encoded-id>/predictions/assessments/<sha256>.json\`. When the key already exists, verify exact bytes or refuse.
3. Add \`assessmentR2Key\` and \`assessmentSha256\` to the prediction record. This record is itself hashed and stored with the existing create-only immutable prediction version writer.
4. Commit the authoritative D1 prediction pointer under the existing guard/lease/epoch fence only after both immutable R2 objects exist. Then use the existing view-index and run checkpoint path. Never update an old assessment; repeated same-body submit replays without duplicate writes.
5. On \`already_current\`, \`needs_regeneration\`, \`validation_failure\`, \`not_in_manifest\`, \`blocked\`, or \`deferred_budget\`, no assessment is persisted. Do not create a new immutable assessment for an unchanged prediction after the fact.

The new \`inputDigest\` includes a canonical hash of the submitted assessment or null, so a different assessment in a replay is not silently accepted. The assessment sidecar key is content-addressed and **does not** contain the prediction version SHA (avoids a circular hash); the prediction-version object carries its sidecar pointer and checksum. The owner-only reader verifies the two checksums before combining records.

## Read-side and analytical use

No default API/UI response grows a new large body. A future owner-authorized read path may resolve the assessment pointer for one immutable prediction version. Missing assessment pointers on legacy records return \`assessment: null\`; corruption returns a named unavailable status, never fabricated text.

Potential future metrics: percentage of predictions with a valid researched assessment, number of actually sourced findings per film, share of execution claims grounded beyond metadata, contradictions/unknowns recorded, individual versus template probability rationales, forecast errors by model/profile version and time. Later factual ratings are joined post-hoc, never supplied to the blind prediction generator.

## Dry-run invariant and experiment gate

\`prediction_batch_validate\` and \`prediction_batch_submit(dryRun:true)\` reject malformed assessments just as a live submit would, but **must not attempt any R2/D1 mutation**, checkpoint, lease, queue or history write. The caller privately persists its own full assessment/result data for the A/B comparison, including prompt/sample IDs and timestamped tool receipts. Do not install/enable any Scheduled Task as a consequence of editing this document.

The 56 KiB MCP submit-size limit remains. Research-rich candidate batches can exceed it; split the **API transport** payload, not the ten-film model-generation unit. Do not strip assessment or evidence merely to preserve one submit call.

## Test requirements before activation

Closed-object schema and bounds; model version null vs caller-reported; source-ID validation; real URL syntax without semantic overclaims; no duplicated numeric score; optional old records; v5/v2 parity; preflight and dry-run write-fault isolation; submit idempotency and changed-body conflict; R2 create-only/sha verification; crashes across each write boundary; lease/gate loss and replay; changed profile; 56 KiB body handling; private-only read semantics; unchanged current/history/index behavior; no prompt or production Task changes without explicit owner approval.
