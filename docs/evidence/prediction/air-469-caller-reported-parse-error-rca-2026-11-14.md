# AIR-469: `caller_reported parse_error` with empty `issues` (RCA, 14 Nov 2026)

Read-only analysis of `main` at `f314b339`. No production write, run, retry, Task change or model execution was performed. All times UTC unless stated.

## Scope and evidence limits

- Run `cc70c949-b61d-4e1e-818b-63d7a9b02697` (batch runner v2, `manifestSize=5`), about 07:00 Madrid (06:00 UTC) on 14 Nov 2026.
- The retry records of both films were re-read on 14 Nov 2026 about 08:59 UTC through the read-only `prediction_film_diagnostics` MCP tool. Run-level facts (`manifestSize`, sibling films, `formatFailureStreak`) are still taken from the AIR-469 card and were not re-read; `inputDigest` was not re-read (it lives in `run.submitted`, outside that tool; no authorized exact-key read was performed).
- The caller payload of the two films was never persisted (see telemetry gap). Nothing below reconstructs it.

## Per-film table

| Film | Run | Stored outcome | Provenance | `validation` | `inputDigest` | Cause status |
| --- | --- | --- | --- | --- | --- | --- |
| `tmdb_957601` | `cc70c949` | retry `parse_error`, scope `item`, attempts 1, failed 06:04:31Z, retryAt 07:04:31Z (verified) | caller (`reportedBy=caller`, verified) | `stage=caller_reported`, `issues=[]` (verified) | not re-read | Worker **submit-time** rejection: not observed (bypassed by the caller `failure` item). Preflight rejection: client self-reports `fingerprint.evidence too_few`, original response not retained. Cause: **supported by self-report, not independently proven** |
| `tmdb_192305` | `cc70c949` | retry `parse_error`, scope `item`, attempts 1, failed 06:05:00Z, retryAt 07:05:00Z (verified) | caller (verified) | same (verified) | not re-read | same |

Both films currently have no fingerprint and no prediction (`fingerprint_missing`, `prediction not_recorded`), lane `hot`, `eligibleNow=true`; the retryAt has passed, so they wait for the next run.

## What the code proves

1. `src/enrichment.js` (batch submit, ~line 2311): an item `{filmId, failure:{kind}}` for a film without a fresh stored prediction sets `validationStage='caller_reported'`, `reportedBy='caller'`, `issues=[]` and throws `Reported malformed model response`. The Worker never inspects any content in this branch; the result is indistinguishable by design from a client that gave up. `failure` carries only `kind`; the contract has no field for a reason, so an empty `issues` is the only value this path can produce.
2. A real Worker schema rejection at submit takes different branches (`fingerprint_schema`, `fingerprint_missing`, `prediction_schema`, `assessment_schema`) with `reportedBy='worker'` and non-empty `issues`. A `caller_reported` record proves only that `batch_submit` received a caller `failure` item and did not inspect a candidate in that branch. It does **not** disprove a refusal at the earlier read-only `prediction_batch_validate` boundary, whose response is not retained.
3. `docs/reference/scheduled-task-prompts/hourly-predictions-batch-v2.md` step 7 instructs the client: after at most one re-preflight, "a film that still has issues: submit as `{filmId,failure:{kind:'parse_error'}}` and do not hide the reason"; a film that does not fit a request even alone is also sent as `parse_error`. The prompt asks to record `failureReason` (`insufficient_metadata`, `insufficient_knowledge`, `json_unparseable`, `other`) only in the dry-run A/B result, not in the production submit. The production path has no place to carry it.
4. Prompt step 3б says limited or blocked research is **not** `parse_error` (grounded `plotMechanics` from metadata, unknown execution quality, uncertainty in confidence). That rule lives only in prompt prose; nothing in the contract or Worker distinguishes it from a malformed response.

## Normative contract vs observed behaviour

| Aspect | Contract | Observed |
| --- | --- | --- |
| `parse_error` meaning | Malformed or schema-invalid model output ([enrichment reference](../../reference/api/enrichment.md)) | Two films reported by the client with no schema evidence |
| `caller_reported` `issues` | Empty by definition | Empty; no reason is available to the operator |
| Retry | Retryable with backoff, counts to `format_error_storm` (5 consecutive) | `formatFailureStreak=2`; the two films are dropped from this run and wait for backoff |
| Research uncertainty | Must not be `parse_error` (prompt 3б) | Possible but unproven that it was mapped there |

Candidate client-side causes consistent with the code and prompt (see the reviewer follow-up below for the one with evidence): (a) preflight (`prediction_batch_validate`) still returned issues after the single permitted re-preflight and the client chose `failure`; (b) the group request exceeded 56 KiB and a film was sent as failure; (c) the client could not form valid JSON; (d) limited or blocked research was treated as a format failure. The sibling successful items in the same run (`tmdb_220`, `tmdb_444193`, `tmdb_497984`) show that the Worker validators accepted well-formed objects in that run.

## Reviewer follow-up, 14 Nov 2026 (independent review of PR #611, HEAD `78e05cc4`)

Provenance: a client self-report from the saved ChatGPT Task A completion report of the 07:00 Madrid / 06:00 UTC invocation, run `cc70c949`, surfaced from prior run history by the reviewer. It is **not** an independently captured `prediction_batch_validate` response, and the current Task peek exposes only the later 08:00 Madrid invocation.

- The report states `fingerprint.evidence: too_few` at preflight for `tmdb_957601` and `tmdb_192305` and that unsupported evidence was not fabricated; three sibling films succeeded. The preflight-failure hypothesis (a) is therefore **supported by self-report**.
- Not retrievable: original candidate payload, per-item issue paths, retry sequence and timing. The full path matters: root `fingerprint.evidence too_few` means no parsed claim survived (`src/enrichment.js`: `claims.some(claim=>claim.items.length)` fails), whereas `fingerprint.evidence.*` `too_few` means an empty claim list or refs. The path is unknown here and the distinction is kept.
- Do not infer that research access was blocked or that every legitimate evidence source was exhausted.
- The installed Task A prompt (23,537 characters, byte-identical to the canonical file, Task disabled, per the reviewer's read-only registry comparison) sends `failure.kind=parse_error` whenever one re-preflight still has issues. Evidence insufficiency is thus classified as a generic format failure by prompt design. Falling back to `unknown` execution does not guarantee a valid object: a fingerprint with zero valid claims is rejected as `fingerprint.evidence too_few`.

## Telemetry gap

The Worker records neither the preflight verdict history nor why the client chose `failure`. Preflight (`prediction_batch_validate`) is read-only and stores nothing, so even a Worker issue list seen by the client at 06:00 UTC is gone. Without a client trace the cause of the two failures cannot be classified between (a) to (d). No payload is reconstructed here.

## Offline fixtures (proposed for the implementation card)

Existing coverage: `tests/prediction-batch-submit.mjs` (`caller_reported` for a failure item) and `tests/submit-validation.mjs` (Worker stages). Proposed, no live writes:

- fingerprint with zero valid evidence claims: `prediction_batch_validate` reports `fingerprint.evidence too_few` (root); a variant with an empty claim list or refs reports `fingerprint.evidence.<group>.<claim>` `too_few`; both stay rejected;
- a minimally supported fingerprint (at least one genuinely supported claim) validates;
- caller `failure` with a declared reason is stored and shown as a caller claim, and an invalid object still never bypasses the Worker;
- replay of the same film with a different reason or issue summary yields `conflict`, not an equal replay; legacy `failure:{kind}` payloads still replay as before;
- one failure item does not stop valid films in the same batch.

## Recommendation

1. **Fail closed with a precise reason, never invent evidence.** The next implementation must either build a truly supported minimal fingerprint where evidence exists, or declare a precise failure where it does not. No validator relaxation and no blanket conversion of research-limited cases to success.
2. **Contract extension (needs owner approval of the closed vocabulary).** Optional `failure.reason`, separating `preflight_validation_failed` / `insufficient_evidence` from `json_unparseable` / `request_too_large`, plus optional `failure.preflight.issues[{path,code}]` limited to the existing closed paths and codes, stored with `reportedBy=caller`. An echoed issue is a caller claim, not Worker telemetry, unless a correlated `prediction_batch_validate` request was observed.
3. **Replay identity.** `batchItemDigest` and the crash-window equivalence currently hash only `failure.kind`; they must include the reason and a deterministic, bounded issue summary, with replay and conflict tests and legacy compatibility. `format_error_storm` and retry classification are not changed silently.
4. **Prompt (separate owner GO).** Stop mapping a failed re-preflight to a bare `parse_error`; report the reason. Task activation, prompt mutation and live predictions stay outside this PR.

Risks: a contract extension updates `docs/reference/api/enrichment.md` and the prompt; diagnostics should count reasons so over-reporting stays visible. Rollback: the fields are optional and ignored by older clients.

## Proposed implementation card

"Predictions v2: caller failure reasons and evidence-insufficiency handling". Acceptance: payload rejected only for real closed-schema errors; a caller `failure` carries a closed-enum reason and bounded preflight issues, labelled `reportedBy=caller`; replay identity covers them; invalid output never bypasses the Worker; valid films in the batch continue; no blanket `parse_error` to success; owner approves vocabulary and prompt before any Task re-enable.
