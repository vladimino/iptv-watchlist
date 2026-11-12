# AIR-450 batch preflight tool: measured offline cost and parity (12 Nov 2026)

**Status: offline measurement on the real MCP handler and the real Worker validators; no production read or write, no model call, no Scheduled Task.** It accompanies [ADR 0131 (Proposed)](../../adr/0131-batch-candidate-preflight-tool.md). The fixtures are synthetic; no film id, manifest, profile, fingerprint or prediction of the experiment appears here.

## Why

Checkpoints C4 to C6 of AIR-450 on one frozen manifest (size 10: 9 of 10 `would_write`; 100 films: 35 of 100, 65 reported `parse_error` from a synopsis-only heuristic; the first group of C6: 9 of 10 `fingerprint.evidence.execution.stakes invalid_ref`) showed that typical content failures of a generated group are found only after the submit. The Worker validator and the ban on metadata-only execution quality are correct; the payload was the weak part.

## What was measured (`tests/prediction-batch-validate.mjs`)

Ten realistic candidates (every general execution dimension concrete, each with model-knowledge and web-research evidence, mechanics with metadata and model knowledge, source fields omitted), `prediction_batch_validate`, 200 calls in process:

| Quantity | Value |
| --- | --- |
| Request | 44,262 bytes (limit 57,344; the MCP inbound limit is 65,536) |
| Answer | 1,593 bytes, sent twice by the MCP result shape (`text` and `structuredContent`) |
| Latency | median 3.87 ms, p95 5.34 ms |
| Storage calls | 0 (every R2 and D1 call was a fault in the test, and the whole D1 dump and R2 state were unchanged) |

These are in-process numbers on the CI-class machine, not production latency: a network round trip, the Access check and the ChatGPT tool-call overhead are not included. Ten fingerprints at the 12,000-character maximum exceed the request limit and are refused whole with the instruction to split the group.

## What was tested

Parity: for ten mixed candidates the per-object issues equal those of `prediction_validate`, and the dry run of `prediction_batch_submit` answers `would_write` exactly for the candidates the preflight passes and otherwise `validation_failure` with the preflight's issues of the first failing object (fingerprint, then prediction). A valid ten (full fingerprints with metadata, model-knowledge and web-research claims, and prediction-only films); nine films with the C6 shape (metadata-only evidence of `stakes`) each reporting exactly `fingerprint.evidence.execution.stakes invalid_ref`; partial, empty and null evidence; a supplied wrong aggregate not corrected; one wrong field with one omitted; invalid enums; item defects (not an object, missing or bad `filmId`, unknown key, wrong type, neither object) as their own `itemIssues` without echoing a value; whole-request refusals (no or more than 10 items, unknown top-level key, repeated `filmId`, over 56 KiB); the HTTP path with the Access JWT; the read-side-effect audit (16 read tools).

## Not established

Production latency, the real quality gain of a corrected group, the number of corrections a model makes within the single allowed re-preflight, and any effect on model usage or Codex quota: none is measured and no saving is claimed. A candidate that passes the preflight can still be refused at submit for state reasons (manifest, `inputHash`, profile, run, epoch).
