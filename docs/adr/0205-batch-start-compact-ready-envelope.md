# ADR 0205: A synchronous `batch_start` may answer the compact ready envelope of its stored manifest instead of the whole manifest

**Status:** Accepted  
**Original decision date:** 2026-11-24 (Europe/Madrid)  
**Recorded at:** 2026-11-24  
**Approval source:** The Product Owner's implementation GO on [AIR-588](https://trello.com/c/vyxbU1l0#comment-6b04c96acb544ab06006a57d), 24 Nov 2026 Madrid ("A1 + A2 + C утверждены"), with the C scope recorded at the top of the card description: "компактный ready-envelope (runId, epoch, manifestHash, part list, limits) поверх существующего immutable stored manifest и parts, совместимость старых клиентов, staged rollout. Полная проверка манифеста до submit сохраняется; incremental per-film consumption/submit до полной validation не разрешены этим GO. S7, taskId, ownership, retry semantics и расписание не менять." The GO covers code delivery; changing a live Task prompt to use the envelope needs a separate owner GO.  
**Related work:** [AIR-588](https://trello.com/c/vyxbU1l0); RCA [PR 960](https://github.com/vladimino/iptv-watchlist/pull/960) and its [evidence](../evidence/prediction/air-588-predictions-stop-rca-2026-11-23.md); AIR-510 (the stored manifest and `prediction_batch_manifest` parts); [ADR 0188](0188-idempotent-keyed-batch-start-and-early-start-claim.md); [ADR 0195](0195-scheduled-task-id-as-run-owner-label.md); [ADR 0193](0193-deferred-batch-start-with-server-issued-key.md) (Proposed, unchanged)  
**Supersedes:** None  
**Superseded by:** None

## Context

A `batch_start` answers the whole manifest (S7: about 43–45 KB of JSON, sent as one escaped text copy through MCP). In two of the failed runs of 23 Nov 2026 the Task reported that answer as truncated, began the part recovery of AIR-510 and ended before reading the film parts ([RCA](../evidence/prediction/air-588-predictions-stop-rca-2026-11-23.md), sections 1–3). The answer is far below the Worker's own cap (`maxManifestBytes` 256 KiB); a downstream limit of the connector or the Task context is neither shown nor excluded. The parts are already stored and served: `prediction_batch_manifest` reads `envelope`, `profile`, `contract` and `film` parts of the immutable stored answer.

## Decision

1. **An opt-in answer shape.** `POST /api/enrichment/batch/start` (and the MCP `prediction_batch_start`) accept `answer: "full" | "envelope"`; omitted means `full`, so every installed prompt and caller is unchanged. `envelope` is accepted only for a real synchronous start: with `dryRun` (nothing is stored) or `deferred` (a receipt is answered) the start is refused `400 envelope_needs_stored_manifest` before anything is written; another value is `400 invalid_answer`. `answer` is not a start argument: it is not part of the same-Task argument hash (ADR 0195), so a repeat with another `answer` is not `task_args_mismatch`.
2. **What the envelope is.** After the start has stored its manifest (the same persist, the same fences, the same answer object as a `full` start), it answers the readback envelope of that stored manifest, `{kind: "envelope", ...}` with every top-level field except `films`, `profile` and `contract` (`status: running`, `runId`, `protocol`, `lease` with `epoch` and `expiresAt`, `limits`, `manifestFormat`, `manifestHash`, `manifestSize`, `filmsSelected`, the queue counters, `drained` when present) and `parts` (`profile`, `contract`, then one `film` entry per selected film in manifest order), plus `answer: "envelope"` and `read: {tool: "prediction_batch_manifest", parts: ["profile", "contract", "film"]}`. It is byte-for-byte the envelope part `prediction_batch_manifest` serves for that run (with the two marker fields), so its size does not grow with the films' payload (offline S7: about 1.3 KB against a 13.8 KB fixture manifest).
3. **Same run, same identity.** The run, its `runId`, `epoch`, `manifestHash`, the stored manifest, the submit contract, ownership (`taskId`), retries and the schedule are unchanged. A same-Task repeat while the lease lives answers the same envelope when it asks for `envelope` (and the full stored manifest when it asks for `full`); `start_pending` is unchanged.
4. **Full verification before submit stays the caller's duty.** The caller reads `profile`, `contract` and every `film` part, checks each part's `runId` and `manifestHash` against the envelope, assembles the manifest in envelope order and only then researches and submits. Incremental per-film research or submit before the whole manifest is assembled and checked is **not** part of this decision.
5. **Rollout.** The Worker change is additive and inert until a prompt asks for `envelope`. Moving the four Tasks to it is a separate, owner-approved prompt change through the Controller (a candidate delta is kept under `docs/reference/scheduled-task-prompts/`, not installed by this decision).

## Alternatives considered

- **Keep the full answer only** (status quo): the reported truncations show the large single answer is the fragile step.
- **Incremental per-film consumption** (start research on the first film part before the rest): smaller working set, but a larger prompt and validation change; explicitly excluded by the GO and left for a separate decision.
- **Deferred start (ADR 0193)**: also answers small, but adds a Workflow preparation and long polling; not chosen (RCA option B).

## Consequences

- A Task that opts in receives about 1–2 KB from the start instead of 40–50 KB, then 2 + `filmsSelected` part reads (each about 0.4–7 KB offline; production film parts are larger), which the Worker already serves read-only.
- More MCP round trips per run (9 reads for S7), each a few hundred ms of Worker time.
- No change for any caller that does not send `answer: envelope`.

## Recovery and migration boundary

Code only: no schema, marker, flag, Task or schedule change. A revert removes the parameter; a prompt that already sends it would then get `400` from the old validation, so a revert must follow (not precede) a prompt rollback. No production operation is authorized by this ADR.

## Evidence

- **Original decision:** [AIR-588 owner GO](https://trello.com/c/vyxbU1l0#comment-6b04c96acb544ab06006a57d), 24 Nov 2026.
- **Implementation:** the AIR-588 implementation pull request (see the card).
- **Dated verification:** offline only: `tests/prediction-air-588-envelope.mjs` (parity of the assembled parts with the stored manifest, submit after assembly, repeat, compatibility, validation, size independence, MCP) and the [offline measurement](../evidence/prediction/air-588-start-latency-offline-2026-11-24.md).
- **Uncertainty:** whether the client completes the part reads more reliably than it handled the full answer is not established; natural runs after a separately approved prompt change are the evidence.

## Follow-ups

The candidate prompt delta and its owner-approved, staged installation; AIR-588 post-deploy verification.
