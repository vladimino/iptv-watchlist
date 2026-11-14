# AIR-487: repeated `caller_reported parse_error` without a claimed reason (RCA, 15 Nov 2026)

Read-only analysis. No production write, run, retry, Task change, lease reset or model execution. All times UTC unless stated.

- Code: `main` `00d3f162` (includes AIR-472 / PR #619).
- Production object: exact-key R2 GET `enrichment/runs/c6b2c3d7-7382-41ad-9a4e-cd45c198d929.json` (Object Read credential; last-modified 14 Nov 2026 20:09:11 GMT; 4743 bytes; ETag `efae6bb5dac1f1fd98f7dfb1f65fa3bd`). Sanitized fields only; no fingerprint, prediction or assessment bodies.
- IPTV MCP `prediction_film_diagnostics` was unavailable in this session (OAuth token issue). Current D1 queue retry rows were not re-read. The run object still holds the per-film failure and `submitted` identity written at the time.
- No Task completion report or caller payload is in this capture. The installed Task A prompt SHA is taken from the AIR-487 card (owner/Controller readback), not re-read from the Automations registry here.

## Scope

Natural hourly slot ~21:00 Europe/Madrid on 14 Nov 2026. Worker run `c6b2c3d7-7382-41ad-9a4e-cd45c198d929`, protocol `batch_v2`, `manifestSize=5`, `status=complete`, `stopReason=manifest_spent`. Selected (stored order): `tmdb_514684`, `tmdb_492618`, `tmdb_1094451`, `tmdb_11227`, `tmdb_262733`. Two created with assessments; three `caller_reported` `parse_error` with empty `issues` and no `validation.claimed`.

The question is whether the stored identity is `insufficient_evidence`, `preflight_validation_failed`, `json_unparseable` or `request_too_large`, and why AIR-472's claim fields are absent.

## Per-film table

| Film | Result | Provenance | `validation` | `inputDigest` (run.submitted) | Identity vs Worker formula | Fingerprint / prediction objects | Source access | Retry on the run record |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `tmdb_514684` | `failed` | caller (`reportedBy=caller`, `stage=caller_reported`) | `issues=[]`; no `claimed`; no `failure.reason` | `c2cf9bd49958ecb507e89a441fcacc85c290159826fade722a38a300f5b73de5` | **byte-equal** to the AIR-472 **legacy** digest `{filmId, fingerprint:null, prediction:null, failure:"parse_error"}` | both R2 keys **absent** | **not persisted** (no assessment on a failure item) | attempts 1; `failedAt` 14 Nov 20:05:02.836Z; `retryAt` 21:05:03.298Z (22:05 Madrid) |
| `tmdb_492618` | `failed` | caller | same | `67412d8c9b15ad69a8bd23605e90b53af5c7b8a478d9c9eadb5bc89ddc63fea3` | **legacy** (same formula, this `filmId`) | absent | not persisted | attempts 1; 20:05:21.510Z; `retryAt` 21:05:21.792Z (22:05 Madrid) |
| `tmdb_262733` | `failed` | caller | same | `b114b7735a0e7be74f974bc39759e3e56e67d53d61159ce2a29ef519023578ec` | **legacy** | absent | not persisted | attempts 1; 20:08:01.609Z; `retryAt` 21:08:01.962Z (22:08 Madrid) |
| `tmdb_1094451` | `created` | Worker accepted candidate | n/a | `987db6ba788727903e560509701f0d11c538ed7aa31649f370be2654246a8582` | candidate tuple (not a failure) | both present; assessment `written` | assessment persisted; body not opened in this RCA | `committedAt` 20:06:13.870Z |
| `tmdb_11227` | `created` | Worker accepted | n/a | `f3d5c8fbd452b9b41666de61d22b7e79f8467cf51e75ca046e53c84b6e4accf6` | candidate tuple | both present; assessment `written` | same | `committedAt` 20:07:09.734Z |

`counts`: created 2, failed 3, pending 0. `itemValidation.stages`: three `caller_reported` / `caller`. `formatFailureStreak=1` (the last film failed after two created items reset the streak). `batchCount=1` is the start selection, not the number of HTTP submits.

`committedAt` values are five distinct instants spanning 20:05:02Z–20:08:01Z. That is **five separate `prediction_batch_submit` calls of one item each**, not one mixed 5-item body. Failures therefore did not share a request with the created neighbours. `firstSubmitAt` 20:06:23.559Z is the first **created** submit (`src/enrichment.js` sets it only on `created`/`recalculated`), which is why it is after the first two failures.

Lease acquired 20:00:45.443Z, run created 20:02:19.357Z, completed 20:08:41.167Z. HEAD of `enrichment/run-diagnostics/<runId>.json`: missing.

## What the stored digest proves

`batchItemDigest` (`src/enrichment.js`) hashes `{filmId, fingerprint, prediction, failure}` after `canonical()`. For a failure item with neither `reason` nor `preflight`, `batchFailureDigestPart` is the **string** `failure.kind` (`"parse_error"`), the AIR-472 legacy identity. Recomputing that tuple for each of the three ids matches the stored `inputDigest` exactly.

The same formula with `failure: {kind:"parse_error", reason:<any of the four closed reasons>}` **does not** match. A stored successful claim is therefore **ruled out**. A Worker schema rejection of a candidate (`fingerprint_schema` / `prediction_schema` / `assessment_schema`) is **ruled out**: those branches set `reportedBy=worker` and non-empty `issues`.

What remains consistent with the bytes:

1. The caller sent `{filmId, failure:{kind:"parse_error"}}` on the **accepted** submit (no claim fields).
2. The caller first sent an **invalid** claim (unknown reason, extra keys, illegal path). `validateBatchSubmitBody` answers **HTTP 400** and writes nothing. Prompt step 7 then says: if `failure.reason` is refused, retry **once** as `{filmId,failure:{kind:'parse_error'}}`. That fallback produces **exactly** the stored identity. There is no 400 body in R2, so this path is **possible and not proven**.

AIR-469's morning films (`tmdb_957601`, `tmdb_192305`) had the same **stored** shape. That does not prove the same client-side cause. Those films had a later self-report of `fingerprint.evidence too_few`. This run has **no** equivalent Task trace in this capture.

## Canonical prompt vs Worker (AIR-472)

Canonical `docs/reference/scheduled-task-prompts/hourly-predictions-batch-v2.md`: 28172 characters, SHA-256 `fadb0e385cafbc1ebe0e0ffcd3d9f1bca8a9b0a214116c9c81deeb9bdce9a6c2`. The AIR-487 card states this text is installed on Task A. This session did not re-read the live registry.

- Step 3б: limited/blocked research is **not** `parse_error`; zero honest claims triggers one evidence-recovery pass, then a **claimed** failure, not a bare kind.
- Step 5: if an honest evidence map cannot be built **after** that pass, send failure via step 7 (with reason and preflight).
- Step 7: after at most one re-preflight, send `{filmId,failure:{kind:'parse_error',reason,preflight}}` with a closed `reason` and copied Worker issues (omit `preflight` if none). **Then** the explicit legacy fallback on Worker refusal of `failure.reason`.
- Dry-run prompt is **not** widened (`tests/scheduled-task-prompt-v2.mjs`): it still sends a bare `parse_error` for remaining issues.

Worker (AIR-472, already on this `main`): optional `failure.reason` / `failure.preflight.issues`; invalid claims 400 the **whole** body; a valid claim is stored as `validation.claimed` beside empty Worker `issues`; replay identity includes the claim; a candidate is never admitted through the failure branch. Offline proof: `tests/prediction-caller-failure-claim.mjs` and `docs/evidence/prediction/air-472-caller-failure-claim-offline-2026-11-14.md`.

**Trace gap:** the Worker records the **accepted** item only. It does not store `prediction_batch_validate` history, HTTP 400 claim refusals, or why the client chose `failure`. After a successful legacy fallback the run looks identical to a client that never attempted a claim. `reason` and `preflight.issues` are therefore missing from production telemetry by design whenever the stored digest is the legacy string.

## Reasons that cannot be assigned

| Closed reason | Proven for these three ids? |
| --- | --- |
| `insufficient_evidence` | **No.** Compatible with prompt 3б/5 if the client omitted the claim or fell back after 400. Not in the digest. |
| `preflight_validation_failed` | **No.** No stored `preflightIssues`. Five one-item submits do not by themselves prove a preflight ran. |
| `json_unparseable` | **No.** |
| `request_too_large` | **Unlikely as the accepted item:** a one-item legacy failure is tiny. An oversized **candidate** that was then replaced by a legacy failure is not visible. |
| Worker declined a **valid** claim | **No.** A valid claim would have a different digest and `validation.claimed`. |

Sibling created films show the Worker accepted well-formed fingerprints, predictions and assessments in the same run. That does not reconstruct the failed candidates.

## Offline fixtures (this PR)

`tests/prediction-caller-failure-claim.mjs` adds AIR-487 pins on the live Worker code (sqlite D1 stand-in, in-memory R2):

- the three production `inputDigest` values equal the legacy formula and not any claimed reason;
- HTTP 400 on an invalid claim writes nothing; a following legacy item stores empty `claimed` and the legacy digest;
- a mixed submit: three legacy failures plus a valid neighbour — the neighbour is created; failures stay `caller_reported`;
- `json_unparseable` and `request_too_large` claims store `claimed.reason` and a **different** digest;
- an invalid fingerprint candidate in the same batch is still rejected by the Worker schema (`reportedBy=worker`) and does not ride a sibling failure item.

Existing coverage kept: `tests/prediction-batch-validate.mjs` (`fingerprint.evidence too_few`), `tests/fingerprint-evidence.mjs`, `tests/prediction-batch-submit.mjs` (mixed outcomes).

## Fix proposal (not implemented here; needs owner GO)

Minimal, fail-closed, no validator relaxation, no automatic retry or Taste Profile change.

1. **Prompt (separate Task edit GO):** treat the legacy `{kind:'parse_error'}` fallback as a last resort only after a **corrected** claim still 400s, and require a closed `reason` on every production failure item. Do not strip a known reason to pass submit. Keep evidence-recovery; do not map `gateStatus=limited` to `parse_error`.
2. **Worker (separate code PR, if the owner wants a hard gate):** refuse a failure item that has `kind` but neither `reason` nor `preflight` on batch v2 (`400`, nothing written), with tests for mixed batches (one bad failure item must not 400 a whole mixed body **or** must — pick one and document it; today's code 400s the **whole** submit when any item's claim is invalid). Do not accept invalid fingerprints through this path.
3. **Telemetry (optional, later):** persist a bounded count of claim-400 vs legacy-failure accepts. Do not store payloads.
4. **Out of scope:** production `prediction_batch_start`/`submit`/`complete`, lease/retry writes, synthetic PASS runs, changing AIR-451/AIR-473 quality gates.

Rollback for (1) is restoring the previous Task text. Rollback for (2) is reverting the PR; optional fields today remain compatible with old clients.

## Verdict

**RCA:** the three films were accepted as **legacy caller `failure.kind=parse_error` items**. The AIR-472 claim contract was deployed and is exercised offline; this natural run **did not persist a claim**. The four closed reasons are **not determined**. A prompt-directed 400→legacy fallback is consistent and unproven. Neighbours in the run were not blocked.

**Implementation:** not in this delivery. Owner chooses prompt-only vs Worker-required `reason` as a later atomic PR.
