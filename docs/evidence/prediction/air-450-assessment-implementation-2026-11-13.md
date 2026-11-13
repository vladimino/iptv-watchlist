# AIR-450: prediction assessment implementation, offline measurements and what is unverified (13 Nov 2026)

**Status: offline measurement on the real Worker code over a sqlite D1 stand-in and an in-memory R2; synthetic data only; no production read or write, no model call, no Web Search, no Scheduled Task.** It records what the [ADR 0132](../../adr/0132-prediction-assessment-artifact.md) implementation (one code-only PR) measured and what it could not. It authorizes nothing: the real A/B, any Task change, Web Search in a Task, a backfill and every production write stay owner gates.

## Measured (deterministic tests, `tests/prediction-assessment.mjs` and neighbours)

| What | Result |
| --- | --- |
| Assessment at the cap | a synthetic maximal assessment is 2,951 B of UTF-8 JSON (cap 3,000); one over the cap is `assessment too_large` and checked before any other rule |
| Stored object | a 924 B caller assessment became a 1,598 B R2 object (about 0.67 KB of Worker-confirmed envelope: lineage, hashes, version key); a cap-sized one is about 3.6 KB |
| Group of ten with full assessments (synthetic fingerprints of about 5.3 KB, 2,951 B assessments) | 89,331 B: refused whole by `prediction_batch_validate` (the 56 KiB bound, 57,344 B), nothing checked |
| The same films as five | 44,671 B: accepted, five valid |
| Write order | version object, then assessment object, then the guarded D1 commit (observed on the R2 put sequence); the D1 pointer is absent until both objects exist |
| Failure before the commit | an R2 fault on the assessment put leaves no D1 pointer and no assessment object, at most an unreferenced version object; the same body replayed completes (`created`, `written`) |
| Crash window | commit present, run record without the result: the replay recomputes the digest, writes a deleted object (`written`) and settles; a different assessment for that version is `conflict` and nothing is overwritten |
| Replay and conflict | the same body is `present` and `replayed`; a different assessment, or one added to a settled film, is `conflict`; stored objects are byte-identical afterwards |
| Privacy | a unique marker in the assessment text appears in no D1 table, R2 object other than the sidecar, bundle, view index, Event or log line |
| Dry run | validates the assessment, answers `would_write`, `not_sent` or `not_applicable`, writes nothing (also under the all-writes-fault isolation test); an invalid assessment is `validation_failure` at stage `assessment_schema` |
| Unknown keys | `prediction.<key>` and undeclared item keys on the v5 HTTP and batch routes are `unknown_field` with a sanitised path and no echoed value; only the six model fields reach the version body; existing valid payloads and every existing digest are unchanged |

## Not measured and not claimed

- **Production latency and R2 cost of the extra put** and any effect on the lease, gate or call budget: the stand-in has no network; the extra put is one create-only write per film with an assessment.
- **Model quota, token and wall-clock cost of the research and assessment step**: CI does not measure it; it is the content of the owner's real A/B.
- **Whether Web Search is available inside a Scheduled Task**: unconfirmed; the experimental prompt text handles its absence (`research.status` `not_attempted`) and claims nothing.
- **Real assessment size distribution**: only synthetic sizes were measured; a real model may produce far smaller or cap-sized objects.
- **Whether any production prediction record already carries extra keys inside `prediction`** (the pre-closure hole): not read; the closure only rejects new ones.
- **Rendering on GitHub** of the changed diagrams is recorded in the pull request, not here.

## Reproduce

```bash
node tests/prediction-assessment.mjs
node tests/prediction-closed-contract.mjs
node tests/prediction-dry-run-isolation.mjs
node tests/scheduled-task-prompt-v2.mjs
node tests/prediction-ab-report.mjs
```
