# AIR-450: what the submit paths do today with extra prediction content (13 Nov 2026)

**Status: offline measurement on the real Worker code over a sqlite D1 stand-in and an in-memory R2; no production read or write, no model call, no Scheduled Task.** It is the factual base of [ADR 0132](../../adr/0132-prediction-assessment-artifact.md) (Proposed) and of the [prediction assessment contract draft](../../reference/api/prediction-assessment.md). The fixtures are synthetic; nothing of the experiment's films, manifest, profile, fingerprints or predictions appears here.

## Question

The owner wants a per-film `assessment` (rationale, signals, risks, uncertainties, sources, date and model identity) to travel with `submit` and be linked to the stored prediction version in R2. Before choosing where it lives, what do the v5 `submit` and the v2 `batch_submit` already do with content beyond the six model fields (`predictedRating`, `probability4Plus`, `confidence`, `matchSignals`, `mainRisk`, `moodLabels`)?

## Findings (reproduced with a synthetic `assessment` object inside `prediction`)

1. **The validator ignores unknown keys.** `predictionIssues` checks only the six rule-table fields. A `batch_submit` item with an extra key inside `prediction` is `created`, with no issue.
2. **The whole submitted object is stored.** Both paths build the record as `{...item.prediction, filmId, generatedAt, tasteProfile*, fingerprint*, runId, trigger, confidenceAssessment}` (only a caller `confidenceAssessment` is stripped). A 3,078-byte extra payload was found, verbatim, in four places: the immutable version body (`enrichment/films/<id>/predictions/versions/<sha256>.json`), the D1 `prediction_pointer.display_json`, the mutable bundle mirror `enrichment/films/<id>/predictions.json`, and the shared `enrichment/view-index.json` (inside the entry's `prediction`). The public film shape of `worker.js` whitelists prediction fields and does not expose it.
3. **The replay digest ignores it.** `inputDigest` hashes the film id, the fingerprint hash and the six model fields. A second submit with the same model fields and a **different** extra payload answered `created` with `replayed: true` and left the first payload stored: the second is silently dropped, not a `conflict`.
4. **No size or content check.** A dry run with a 50 KB extra payload answered `would_write`. The only bound is the request size (the 56 KiB group guidance and the 64 KiB MCP inbound limit).
5. **Freshness is unaffected.** `freshness.state` depends on profile, fingerprint and prompt identities, not on extra keys, so extra content does not make a prediction stale.

Consequence: today an `assessment` sent inside `prediction` would be accepted without validation and copied into the hot view index and the D1 display document. No current prompt sends one, so no production record is known to be affected; whether any stored record carries extra keys was **not** read.

## Size headroom under the group limit (bytes, synthetic)

| Group of ten | Request bytes | Headroom under 57,344 | Per film |
| --- | --- | --- | --- |
| `prediction_only` items (a realistic prediction, 400 bytes each) | about 4,000 | about 53,000 | about 5,300 |
| items with rich fingerprints (measured in [AIR-448](air-448-batch-submit-size-and-cost-2026-11-12.md): 10 items, 40,653 bytes) | 40,653 | 16,691 | about 1,670 |

An assessment of about 1.5 KB per film fits a group of ten rich films unchanged; one of about 2.5 to 3 KB per film does not, so such a group is split into two submit calls (the existing guidance), which decouples the generation size from the submit size.

## Not established

Whether any production prediction record already carries extra keys; the real size of a model-written assessment; the token, time and quota cost of generating it; the real MCP and ChatGPT wall time. None was read or measured.
