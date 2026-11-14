# Prediction assessment contract (Accepted architecture; implemented in code, no caller yet)

**Status: architecture accepted 2026-11-13; implemented in the Worker code by the single ADR 0132 delivery PR, with no caller.** The Product Owner approved [ADR 0132](../../adr/0132-prediction-assessment-artifact.md) after independent review (approval on [AIR-450](https://trello.com/c/VPd21Y9d)). The code is live only once that PR is merged and deployed; even then nothing sends an assessment: no Scheduled Task, A/B run, live Web Search test, backfill or production prediction write is authorized by it, and the real A/B stays an owner gate. The behavior before this change is in the [offline evidence](../../evidence/prediction/air-450-assessment-current-state-2026-11-13.md); the measured sizes of the implementation are in the [implementation evidence](../../evidence/prediction/air-450-assessment-implementation-2026-11-13.md).

## What it is

A per-film diagnostic artifact for later analysis of the Taste Profile and of Predictions: the grounds of the rating and of P(4.0+), concrete signals and risks against the profile, uncertainties, and, only where really done, the sources actually used, with the prediction date and the model identity and version, keeping what the Worker confirms apart from what the caller reports or leaves unavailable. It is **not** an input to any rule: it never changes a prediction, a freshness verdict, a queue, a retry or a compatibility decision, and a generator must never put a personal rating in it.

## Where it travels (v2 only)

An optional `assessment` object on an item of `prediction_batch_submit` (a sibling of `prediction`, **not** inside it), validated identically in `prediction_batch_validate` and the `dryRun: true` submit. Nothing else accepts it:

- **`prediction_validate`** (the single-film tool) does **not** take an assessment, so a green result of that tool can never be read as permission to persist one.
- **The v5 `submit`** takes no assessment and never persists one. Through MCP an item with an undeclared key (including `assessment`) is already refused as a tool error. The HTTP route of the v5 `submit` does not check item keys today: an `assessment` key there would be ignored and the call would still succeed. Closing that (an undeclared item key is a refusal on that route too) is part of phase 1 below, so that "accepted" never silently means "dropped".
- `prediction_batch_validate` states in its description and answer that its assessment verdict applies to the v2 submit only; the answer carries `assessment {checked, issues}` per item beside `fingerprint` and `prediction`.

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
| `research` | `{status, attempts?}`, see below | what research was done, including what produced nothing |
| `sources` | 0 to 6 of `{kind, ref, usedFor, access?}`, see below | only sources that were **used**: usable evidence |
| `conflicts` | 0 to 2 of `{topic, positions, handling}`, see below | material disagreement between used sources, kept visible |
| `model` | `{status: reported, id: text 1 to 80, version?: text 1 to 40, effort?: text 1 to 20}` or `{status: unavailable}` | the model identity as the caller can state it; required, so an unknown identity is explicit |

The whole object has an approved **serialized cap of 3,000 bytes of UTF-8 JSON** (issue `too_large`); individual field bounds do not guarantee that the combined object fits. Unknown keys are rejected with `unknown_field`. The approved validation issue vocabulary consists of `required`, `invalid_type`, `invalid_enum`, `too_few`, `too_many`, `empty`, `too_long`, `invalid_ref`, `too_large` and the new `unknown_field` for undeclared fields; issues use `assessment.*` paths, at most 20 per item, and never echo a value. The Worker validates shape and consistency only: it fetches nothing and verifies neither that a source exists, nor that it was read, nor how completely.

### Research status, source access quality and conflicting evidence

All of this is **caller-reported**. The Worker never claims that a source was accessible or read.

- **`research.status`** (required): `not_attempted`; `attempted_blocked` (every attempt failed to open or read anything); `attempted_no_findings` (pages were read but nothing relevant was found); `attempted_found` (usable sources exist, so `sources` is non-empty). The consistency rule: `attempted_found` requires at least one `sources` item with `kind: web_research`; the other statuses forbid one.
- **`research.attempts`** (0 to 4 of `{outcome: blocked | unreadable | irrelevant, ref?: https URL, note?: text 1 to 100}`): the attempts that did **not** yield usable evidence. A blocked or unreadable page is recorded here, never in `sources`, so a page the caller could not open is never represented as evidence. `ref`, when given, follows the same URL rule as a source.
- **`sources[].access`** (required when `kind` is `web_research`, forbidden otherwise): `full_text` (the content was read in full), `partial_text` (part of it was read), or `search_snippet` (only a search-result excerpt was available; the page itself was not opened). A snippet is never to be described as read. A source of kind `metadata` or `model_knowledge` has no `access`.
- **`conflicts`** (0 to 2): a material disagreement between used sources, traceable and not averaged. Each `{topic: text 1 to 120, positions: 2 to 3 of {source: integer index into sources, author?: text 1 to 80, stance: text 1 to 160}, handling: kept_unresolved | weighted | not_relied_on}`. Position `source` indices must be valid. An index may repeat (several independent reviews on one page URL) only when every position naming it carries `author`, and the authors are distinct after trimming and case folding ([ADR 0143](../../adr/0143-assessment-conflict-position-author.md)); `author` is caller-reported, never verified, and must be an identity actually found in the source reviews, not invented. Positions with distinct indices need no `author`. Without distinguishable authors keep the disagreement in `ratingBasis`/`uncertainties`. Duplicate `sources(kind,ref)` stay forbidden. a position naming a `search_snippet` source stays visible as such. There is no numeric blending field: the disagreement and the way it was handled are recorded, and the assessment's own `uncertainties` carry what remains unknown.

The client-side research protocol (film identity, metadata-only baseline, execution-focused gaps, a bounded web-search budget and independently authored used criticism, then a taste-based assessment before fingerprint and prediction) lives in the proposed batch v2 Scheduled Task prompt and the separate dry-run procedure, **not** in this schema: the 2 and 3 budgets and any source whitelist are not storage constraints, and the schema stays generic (up to 6 sources, 4 attempts). Quota use and the availability of web search inside a Scheduled Task are to be measured, not assumed.

## What the Worker stores (confirmed against reported)

One immutable R2 object per prediction version:

```
enrichment/films/<filmId>/predictions/assessments/<predictionSha256>.json      (create-only)
{
  objectVersion: 1, filmId, predictionSha256, predictionKey,
  confirmed:      {recordedAt, runId, trigger, predictionGeneratedAt, tasteProfile:{version, hash}, fingerprintHash, assessmentSha256},
  callerReported: {model, research, sources, conflicts},   // as sent (positions[].author included); unverified; model is {status:'unavailable'} when the caller could not say
  assessment:     {ratingBasis, probability4PlusBasis, tasteSignals, risks, uncertainties}   // research, sources, conflicts and model are kept under callerReported
}
```

`<predictionSha256>` is the checksum of the prediction version object the assessment belongs to (the existing `predictions/versions/<sha256>.json`). The Worker sets everything under `confirmed` itself; `assessmentSha256` is the checksum of the canonical caller `assessment`. The prediction record, version body, bundle mirror, D1 pointer and display document and the view index are **unchanged**: no pointer, no field, no new hash. Nothing is written to D1.

## Write order, idempotency and failure

1. The prediction version object, then the assessment object (both create-only and orphan-safe), then the guarded D1 commit. A committed prediction therefore has its assessment when one was sent; a failure before the commit leaves at most unreferenced objects.
2. **Digest.** The item's `inputDigest` includes `assessmentSha256` **only when an assessment is sent**, so every existing digest and replay is unchanged. The same body replays; a **different** assessment for a film this run already settled, or for a version that already has an assessment object, is `conflict` and nothing is overwritten (today a different extra payload is a silent replay, see the evidence).
3. **Replay completes.** A replay of the same body writes a missing assessment object (an interrupted earlier call) and answers as before.
4. The per-film result gains `assessment`: `written`, `present` (the identical object already existed), `not_sent`, or `not_applicable` (the film was `already_current`, `needs_regeneration` or a failure item: an assessment is never attached to an existing version or without a prediction). A storage failure on the assessment object before the commit is the film's recoverable `storage_error`, replayed with the same body.

## Dry run, preflight and the published contract

`dryRun: true` validates the assessment and reports `assessment: would_write` without any write, lease, run, queue or storage effect; its zero-write isolation test covers the new field. `prediction_batch_validate` takes the same optional `assessment` and reports `assessment.*` issues beside `fingerprint` and `prediction` (the single-film `prediction_validate` does not, see above); the 56 KiB request bound includes it. `enrichment_schema` publishes `contract.assessment` (version, bounds, serialized cap, `required: false`). `PREDICTION_PROMPT_VERSION`, the fingerprint versions and freshness are unchanged.

## Exposure and privacy

An assessment can echo the Taste Profile and is private user context. It is not written to, or derived into, the view index, the D1 display document, the bundle, Events, the public film shape or any log; `prediction_film_diagnostics` and other MCP reads show only presence, size and `assessmentSha256`. Analysis reads R2 through the existing controlled read-only snapshot export, whose inventory gains the new prefix; no new read endpoint is approved. Assessments are retained together with the linked immutable prediction history: no separate automatic cleanup timer is introduced. Any future history deletion must account for linked assessment objects, under a separately approved deletion procedure.

## Size and the group limit

A group request is bounded at 56 KiB (57,344 bytes; the MCP inbound limit is 64 KiB). Measured headroom for ten items: about 1.67 KB per film beside rich fingerprints (40,653 bytes measured), about 5.3 KB per film for `prediction_only` items. With the approved cap of 3,000 bytes a group of ten rich films (about 40.7 KB plus up to 30 KB) usually exceeds the bound and is split into two submit calls by the existing guidance; a `prediction_only` group fits. This separates the generation size from the submit size; it changes the number of MCP calls and is to be measured, not assumed. A cap near 1.5 KB would keep rich groups of ten whole at the price of a thinner assessment and little room for source access and conflict records.

## Compatibility

Optional at first. A version without an assessment object is "no assessment", never an error or a stale verdict; legacy versions stay without one, and a later backfill would write objects beside them without touching history (a separate owner decision). Making it required, and the flag or version that would do so, are separate decisions.

## Implemented behavior (as delivered)

- **Validator** `assessmentIssues(assessment, metadata)` in `src/enrichment.js`; the contract is published as `contract.assessment` and `unknown_field` joins `contract.issueCodes`. The cap is checked first and alone (`assessment too_large`). Paths: `assessment.<field>`, `assessment.sources.access`, `assessment.research.status`, `assessment.research.attempts[.ref|.outcome|.note]`, `assessment.conflicts.positions[.source|.author|.stance]`, `assessment.model.<field>`; list items are reported at the list, not by index. Codes used beyond the table: an `access` on a non-`web_research` source is `invalid_enum`; a duplicated `(kind, ref)` source or a repeated conflict position source whose authors are not distinct is `invalid_ref` (a repeated source without an `author` on every such position is `assessment.conflicts.positions.author required`); a conflict position index that is not an integer is `invalid_type` and one outside `sources` is `out_of_range`; `attempted_found` without a `web_research` source is `assessment.sources too_few`, and any other status with one is `assessment.research.status invalid_enum`; `not_attempted` with attempts is `assessment.research.attempts too_many`. A `metadata:*` source ref must name a token the film's metadata really holds (the same rule as fingerprint evidence).
- **Where checked.** `prediction_batch_validate` (per item `assessment {checked, issues}`, part of `valid`), the dry-run submit (stage `assessment_schema`, status `would_write`, `not_sent` or `not_applicable`, zero writes) and the real submit (an invalid assessment fails only its film as `validation_failure` with stage `assessment_schema`, retryable by the existing policy, nothing stored for it). `prediction_validate` and the v5 `prediction_submit` refuse the key; the v5 HTTP route and the batch route answer `400` with `unknown_field` for any undeclared item key.
- **Object.** `writePredictionAssessment`: create-only `put` with `onlyIf etagDoesNotMatch '*'`; on a collision the existing object is read and accepted as `present` only when its `confirmed.assessmentSha256` and `predictionSha256` equal the request's, otherwise the film is `conflict` and nothing is overwritten. A concurrent writer of the same body therefore ends `written` for one and `present` for the other.
- **Crash window.** When the commit exists but the run record lost the result, the replay recomputes the digest (with `assessmentSha256`), writes a missing object (`written`) or confirms an existing one (`present`) and settles the film as before.
- **Not added (by design).** `prediction_film_diagnostics` and the other MCP reads were **not** extended: no read path to the object exists beyond the controlled read-only R2 snapshot export, whose full-bucket listing and verified manifest already include the new prefix (no code change, no new endpoint). No D1 index, backfill, retention timer or `required: true`.

## Prerequisite: close the unknown-key hole

Today the prediction validator ignores keys outside the six model fields and both submit paths copy the whole object into the version body, the D1 display document, the bundle and the view index. Before any assessment is stored, validators must reject undeclared keys in `prediction` (the derived `confidenceAssessment` stays stripped) in both protocols, with `unknown_field` at the rejected field path. The v5 HTTP route must also reject undeclared top-level item keys with `unknown_field` instead of silently dropping them; v5 MCP already rejects undeclared keys. Valid legacy payloads containing only the six declared model fields remain compatible. A live v5 Task prompt change is neither required by this decision nor authorized here; test the actual caller shape before shipping the stricter validator.

## Implementation phases (the single delivery PR carries phases 1 to 4)

1. Close the unknown-key persistence (validator, tests, v5 and v2), including undeclared item keys on the v5 HTTP route.
2. The assessment schema, `contract.assessment`, validator and preflight (no storage).
3. The write path, digest rule, statuses and exposure guards; the dry-run isolation test.
4. Prompts, the dry-run private result and report fields (presence, size, issue counts per size; never content).
5. Optional: a D1 index over the objects, a backfill, `required: true`.

## Tests the implementation would carry

Closed-key and bound validation per field with every issue code; the serialized cap; `sources` rules (metadata token present, URL rule, duplicates); `access` required for `web_research` and forbidden otherwise; the `research.status` consistency rules and that a blocked page can only be an attempt; conflict positions (valid indices, bounds, repeated index with distinct authors, legacy distinct indices without author); the absence of `assessment` from `prediction_validate` and its refusal on the v5 paths; parity between `prediction_validate`, `prediction_batch_validate`, the dry run and the real submit; zero writes of the dry run with an assessment; the write order with a fault before and after each write; replay completes a missing object; a different assessment is `conflict`; digests of items without an assessment unchanged; no assessment content in the view index, D1 display, bundle, Events or public shape; the unknown-key closure on both protocols; legacy versions without an object; the group split at the 56 KiB bound.

## Deferred decisions and delivery gates

The following are **not** authorized by ADR acceptance: making assessments mandatory; backfilling legacy versions; creating an analytic D1 index; treating caller-reported model identity as platform-confirmed; adding a purge timer or exercising any deletion; editing or running Scheduled Tasks or production prediction writers. Future changes need separate decisions and suitable tests. The approved initial contract is variant B, `optional` v2 only, private R2 sidecar with controlled export, 3,000-byte cap, source access and conflict evidence, and explicit `unknown_field` rejection. Before implementation is delivered, independently verify the v5 HTTP compatibility boundary, correct index exclusion, digest/replay behavior, group-splitting behavior and zero-write dry-run isolation.
