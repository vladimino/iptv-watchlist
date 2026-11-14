# AIR-469: `caller_reported parse_error` with empty `issues` (RCA, 14 Nov 2026)

Read-only analysis of `main` at `f314b339`. No production write, run, retry, Task change or model execution was performed. All times UTC unless stated.

## Scope and evidence limits

- Run `cc70c949-b61d-4e1e-818b-63d7a9b02697` (batch runner v2, `manifestSize=5`), about 07:00 Madrid (06:00 UTC) on 14 Nov 2026.
- Facts about the run come from the AIR-469 card (owner-verified production readout). This session could **not** re-read them: `prediction_film_diagnostics` for both films failed with an MCP OAuth token error ("could not issue a new access token right now"), and no exact-key R2 read was attempted. Status of every production-side column below is therefore "as reported on the card, not re-verified here".
- The caller payload of the two films was never persisted (see telemetry gap). Nothing below reconstructs it.

## Per-film table

| Film | Run | Stored outcome | Provenance | `validation` | `inputDigest` | Cause status |
| --- | --- | --- | --- | --- | --- | --- |
| `tmdb_957601` | `cc70c949` | `failed`, `submitted.outcome=validation_failure`, retryable `parse_error` | caller (`reportedBy=caller`) | `stage=caller_reported`, `issues=[]` | not re-read (stored in `run.submitted`) | Worker rejection: **disproved** by code path. Client-side reason: **not proven** (no trace) |
| `tmdb_192305` | `cc70c949` | same | caller | same | not re-read | same |

## What the code proves

1. `src/enrichment.js` (batch submit, ~line 2311): an item `{filmId, failure:{kind}}` for a film without a fresh stored prediction sets `validationStage='caller_reported'`, `reportedBy='caller'`, `issues=[]` and throws `Reported malformed model response`. The Worker never inspects any content in this branch; the result is indistinguishable by design from a client that gave up. `failure` carries only `kind`; the contract has no field for a reason, so an empty `issues` is the only value this path can produce.
2. A real Worker schema rejection takes different branches (`fingerprint_schema`, `fingerprint_missing`, `prediction_schema`, `assessment_schema`) with `reportedBy='worker'` and non-empty `issues` from the closed vocabulary. A `caller_reported` record therefore proves that the Worker validator was **not** the failing component for these two films.
3. `docs/reference/scheduled-task-prompts/hourly-predictions-batch-v2.md` step 7 instructs the client: after at most one re-preflight, "a film that still has issues: submit as `{filmId,failure:{kind:'parse_error'}}` and do not hide the reason"; a film that does not fit a request even alone is also sent as `parse_error`. The prompt asks to record `failureReason` (`insufficient_metadata`, `insufficient_knowledge`, `json_unparseable`, `other`) only in the dry-run A/B result, not in the production submit. The production path has no place to carry it.
4. Prompt step 3б says limited or blocked research is **not** `parse_error` (grounded `plotMechanics` from metadata, unknown execution quality, uncertainty in confidence). That rule lives only in prompt prose; nothing in the contract or Worker distinguishes it from a malformed response.

## Normative contract vs observed behaviour

| Aspect | Contract | Observed |
| --- | --- | --- |
| `parse_error` meaning | Malformed or schema-invalid model output ([enrichment reference](../../reference/api/enrichment.md)) | Two films reported by the client with no schema evidence |
| `caller_reported` `issues` | Empty by definition | Empty; no reason is available to the operator |
| Retry | Retryable with backoff, counts to `format_error_storm` (5 consecutive) | `formatFailureStreak=2`; the two films are dropped from this run and wait for backoff |
| Research uncertainty | Must not be `parse_error` (prompt 3б) | Possible but unproven that it was mapped there |

Candidate client-side causes consistent with the code and prompt, **none proven**: (a) preflight (`prediction_batch_validate`) still returned issues after the single permitted re-preflight and the client chose `failure`; (b) the group request exceeded 56 KiB and a film was sent as failure; (c) the client could not form valid JSON; (d) limited or blocked research was treated as a format failure. The sibling successful items in the same run (`tmdb_220`, `tmdb_444193`, `tmdb_497984`) show that the Worker validators accepted well-formed objects in that run.

## Telemetry gap

The Worker records neither the preflight verdict history nor why the client chose `failure`. Preflight (`prediction_batch_validate`) is read-only and stores nothing, so even a Worker issue list seen by the client at 06:00 UTC is gone. Without a client trace the cause of the two failures cannot be classified between (a) to (d). No payload is reconstructed here.

## Offline fixtures (proposed, not added in this card)

Existing coverage: `tests/prediction-batch-submit.mjs` asserts `validation.stage==='caller_reported'` for a failure item, and `tests/submit-validation.mjs` covers Worker stages. Missing and proposed for the implementation card, all without live writes:

- failure item with a caller reason code accepted, stored and surfaced in `run.failures`, `retry.validation` and diagnostics, with `issues` still `[]`;
- failure item whose reason is `research_limited` is rejected or mapped to a normal prediction path (see below);
- an invalid object is still rejected by the Worker and never accepted through the `failure` item;
- one `failure` item does not prevent the valid films of the same batch from committing.

## Recommendation

Smallest safe change, split by layer:

1. **Observability (Worker, additive contract change).** Allow `failure.reason` from a closed enum (`preflight_issues`, `json_unparseable`, `request_too_large`, `research_limited`, `other`) plus optional `failure.preflight.issues[{path,code}]` copied from the last `prediction_batch_validate` verdict (same vocabulary check as existing `validation.issues`). Store under `validation` with `reportedBy=caller`; keep `parse_error` retry semantics and never accept content through it. Without it, a future RCA hits the same gap.
2. **Prompt only (owner approval for meaning).** `research_limited` or `blocked` research must produce a normal prediction with `unknown` execution and lower confidence, not a failure item; allow exactly one re-preflight (already stated), and report the last verdict's `issues` in `failure.preflight`.
3. **No change** to closed-schema validators, Taste Profile, quality gate or batch remainder handling (valid films already continue).

Risks: a new enum is a contract extension and needs a documentation update of `docs/reference/api/enrichment.md` and the prompt; a client that over-reports `research_limited` could hide quality loss, so diagnostics should count reasons. Rollback: the field is optional and ignored by older clients; remove the prompt rule to revert behaviour. Production stays paused until a separate owner GO.

## Proposed implementation card

"Predictions v2: caller failure reasons and research-limited handling". Acceptance: payload rejected only for real closed-schema errors; a caller `failure` carries a closed-enum reason and optionally the last preflight issues, stored and visible in diagnostics; invalid output never bypasses the Worker; valid films in the batch continue; no blanket replacement of `parse_error` by success; tests as listed above; owner approves prompt and contract meaning before any Task re-enable.
