# Prediction assessment contract (Proposed draft)

**Status: a proposed contract for review, not accepted and not implemented.** It specifies the design of [ADR 0132](../../adr/0132-prediction-assessment-artifact.md) (Proposed). Nothing here is live: no tool, schema, object or field named below exists yet, no run, dry run, Scheduled Task or deployment is authorized, and every number is a draft the owner may change. Facts about today's behaviour are in the [evidence page](../../evidence/prediction/air-450-assessment-current-state-2026-11-13.md).

## What it is

A per-film diagnostic artifact for later analysis of the Taste Profile and of Predictions: the grounds of the rating and of P(4.0+), concrete signals and risks against the profile, uncertainties, and, only where really done, the sources actually used, with the prediction date and the model identity and version, keeping what the Worker confirms apart from what the caller reports or leaves unavailable. It is **not** an input to any rule: it never changes a prediction, a freshness verdict, a queue, a retry or a compatibility decision, and a generator must never put a personal rating in it.

## Where it travels (v2 only)

An optional `assessment` object on an item of `prediction_batch_submit` (a sibling of `prediction`, **not** inside it), validated identically in `prediction_batch_validate`, `prediction_validate` and the `dryRun: true` submit. The v5 `submit` takes no assessment.

```
{filmId, fingerprint?, prediction, assessment?}      // or {filmId, failure:{kind}}
```

## The `assessment` object (caller content, closed key set)

| Field | Type and bounds | Meaning |
| --- | --- | --- |
| `assessmentVersion` | const `1` | schema of this object |
| `ratingBasis` | text, 1 to 700 characters | the grounds of `predictedRating`: premise, execution, decision logic, payoff |
| `probability4PlusBasis` | text, 1 to 400 | the grounds of `probability4Plus` (the value itself is only in `prediction`; it is not repeated) |
| `tasteSignals` | 0 to 5 of `{direction: supports \| against \| neutral, signal: text 1 to 220, anchor?: text 1 to 120}` | concrete signals against the Taste Profile; `anchor` names the profile statement it relates to |
| `risks` | 0 to 3 of `{risk: text 1 to 220, severity: low \| medium \| high}` | film-specific risks |
| `uncertainties` | 0 to 3 of text 1 to 220 | what is not known; an honest `unknown`, never `low` |
| `sources` | 0 to 6 of `{kind: metadata \| model_knowledge \| web_research, ref, usedFor: text 1 to 160}` | `ref` is a `metadata:*` token present in the film's metadata (as for fingerprint evidence), the string `model_knowledge`, or an `https` URL accepted by the same URL rule as evidence; `web_research` only for sources really consulted; the Worker fetches and verifies nothing; no duplicate `(kind, ref)` |
| `model` | `{status: reported, id: text 1 to 80, version?: text 1 to 40, effort?: text 1 to 20}` or `{status: unavailable}` | the model identity as the caller can state it; required, so an unknown identity is explicit |

The whole object is also bounded by a **serialized cap** (draft: 2,400 bytes of UTF-8 JSON, issue `too_large`); the field bounds are maxima, not a promise that every maximum fits together. No other key is accepted. Issues use the existing closed vocabulary (`required`, `invalid_type`, `invalid_enum`, `too_few`, `too_many`, `empty`, `too_long`, `invalid_ref`, `too_large`) with `assessment.*` paths, at most 20 per item, and never echo a value.

## What the Worker stores (confirmed against reported)

One immutable R2 object per prediction version:

```
enrichment/films/<filmId>/predictions/assessments/<predictionSha256>.json      (create-only)
{
  objectVersion: 1, filmId, predictionSha256, predictionKey,
  confirmed:      {recordedAt, runId, trigger, predictionGeneratedAt, tasteProfile:{version, hash}, fingerprintHash, assessmentSha256},
  callerReported: {model, sources},          // as sent; unverified; model is {status:'unavailable'} when the caller could not say
  assessment:     {ratingBasis, probability4PlusBasis, tasteSignals, risks, uncertainties}
}
```

`<predictionSha256>` is the checksum of the prediction version object the assessment belongs to (the existing `predictions/versions/<sha256>.json`). The Worker sets everything under `confirmed` itself; `assessmentSha256` is the checksum of the canonical caller `assessment`. The prediction record, version body, bundle mirror, D1 pointer and display document and the view index are **unchanged**: no pointer, no field, no new hash. Nothing is written to D1.

## Write order, idempotency and failure

1. The prediction version object, then the assessment object (both create-only and orphan-safe), then the guarded D1 commit. A committed prediction therefore has its assessment when one was sent; a failure before the commit leaves at most unreferenced objects.
2. **Digest.** The item's `inputDigest` includes `assessmentSha256` **only when an assessment is sent**, so every existing digest and replay is unchanged. The same body replays; a **different** assessment for a film this run already settled, or for a version that already has an assessment object, is `conflict` and nothing is overwritten (today a different extra payload is a silent replay, see the evidence).
3. **Replay completes.** A replay of the same body writes a missing assessment object (an interrupted earlier call) and answers as before.
4. The per-film result gains `assessment`: `written`, `present` (the identical object already existed), `not_sent`, or `not_applicable` (the film was `already_current`, `needs_regeneration` or a failure item: an assessment is never attached to an existing version or without a prediction). A storage failure on the assessment object before the commit is the film's recoverable `storage_error`, replayed with the same body.

## Dry run, preflight and the published contract

`dryRun: true` validates the assessment and reports `assessment: would_write` without any write, lease, run, queue or storage effect; its zero-write isolation test covers the new field. `prediction_batch_validate` and `prediction_validate` take the same optional `assessment` and report `assessment.*` issues beside `fingerprint` and `prediction`; the 56 KiB request bound includes it. `enrichment_schema` publishes `contract.assessment` (version, bounds, serialized cap, `required: false`). `PREDICTION_PROMPT_VERSION`, the fingerprint versions and freshness are unchanged.

## Exposure and privacy

An assessment can echo the Taste Profile and is private user context. It is not written to, or derived into, the view index, the D1 display document, the bundle, Events, the public film shape or any log; `prediction_film_diagnostics` and other MCP reads show only presence, size and `assessmentSha256`. Analysis reads R2 through the existing read-only snapshot export, whose inventory gains the new prefix; no new read endpoint is proposed. Retention and deletion are open (below).

## Size and the group limit

A group request is bounded at 56 KiB (57,344 bytes; the MCP inbound limit is 64 KiB). Measured headroom for ten items: about 1.67 KB per film beside rich fingerprints (40,653 bytes measured), about 5.3 KB per film for `prediction_only` items. With the draft cap of 2,400 bytes a group of ten rich films (about 40.7 KB plus up to 24 KB) usually exceeds the bound and is split into two submit calls by the existing guidance; a `prediction_only` group fits. This separates the generation size from the submit size; it changes the number of MCP calls and is to be measured, not assumed. A cap near 1.5 KB would keep rich groups of ten whole at the price of a thinner assessment.

## Compatibility

Optional at first. A version without an assessment object is "no assessment", never an error or a stale verdict; legacy versions stay without one, and a later backfill would write objects beside them without touching history (a separate owner decision). Making it required, and the flag or version that would do so, are separate decisions.

## Prerequisite: close the unknown-key hole

Today the prediction validator ignores keys outside the six model fields and both submit paths copy the whole object into the version body, the D1 display document, the bundle and the view index. Before any assessment is stored, the validator should reject undeclared keys in `prediction` (the derived `confidenceAssessment` stays stripped), in both protocols. Open: the issue code and path for a rejected key (the closed vocabulary has no "unknown field" code; reusing `invalid_type` at `prediction` or adding a code changes the contract), and whether the live v5 Task, which sends only the six fields, needs a transition.

## Proposed phases (each needs its own approval after the decision)

1. Close the unknown-key persistence (validator, tests, v5 and v2).
2. The assessment schema, `contract.assessment`, validator and preflight (no storage).
3. The write path, digest rule, statuses and exposure guards; the dry-run isolation test.
4. Prompts, the dry-run private result and report fields (presence, size, issue counts per size; never content).
5. Optional: a D1 index over the objects, a backfill, `required: true`.

## Tests the implementation would carry

Closed-key and bound validation per field with every issue code; the serialized cap; `sources` rules (metadata token present, URL rule, duplicates); parity between `prediction_validate`, `prediction_batch_validate`, the dry run and the real submit; zero writes of the dry run with an assessment; the write order with a fault before and after each write; replay completes a missing object; a different assessment is `conflict`; digests of items without an assessment unchanged; no assessment content in the view index, D1 display, bundle, Events or public shape; the unknown-key closure on both protocols; legacy versions without an object; the group split at the 56 KiB bound.

## Open questions for the owner

1. Storage: B as proposed, or A, C or D ([alternatives](../../adr/0132-prediction-assessment-artifact.md#alternatives-considered)).
2. The schema fields and caps, and the serialized cap (1.5 KB, 2.4 KB, other).
3. Optional first, and when or whether to require it; whether to backfill legacy versions.
4. The unknown-key closure: issue code, and v5 treatment.
5. The model identity: what counts as `reported`, and whether a platform-supplied identity may later be marked confirmed.
6. Retention and deletion of assessment objects, and who may read them.
7. Whether a D1 index is wanted later.
