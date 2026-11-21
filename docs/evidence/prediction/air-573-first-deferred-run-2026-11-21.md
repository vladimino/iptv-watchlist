# AIR-573: the first natural deferred S5 run, and a normal wait reported as a tool error

**Capture:** 21 November 2026, the natural `:45` Europe/Madrid slot (about 21:45–21:47 Madrid), as recorded by the Controller on the [AIR-573 card](https://trello.com/c/4pD66DLd#comment-6b02042256f0bbb5ce497619). **Quoted from that comment; this note adds no production read.** The offline regression is in `tests/prediction-batch-start-deferred.mjs` and `tests/prediction-batch-start-keyed.mjs`.  
**Scope:** [ADR 0193](../../adr/0193-deferred-batch-start-with-server-issued-key.md), the deferred start delivered in [PR #872](https://github.com/vladimino/iptv-watchlist/pull/872).  
**Verdict:** The deferred start itself worked; the Task did not obtain a manifest. **The reason the Task stopped is not established.** One contract defect is confirmed and fixed offline: a normal polling state was delivered to the caller as an MCP tool error.

## Observed (from the card)

| Fact | Value |
| --- | --- |
| Receipt | HTTP 200 in 4.683 s |
| Workflow instance | `dk-f4c3fdf560ce12bc311ce27c22a088e2`, phase `ready`, no errors, **134.679 s** from start to ready |
| What the Task saw | `prediction_batch_manifest` answered `manifest_pending` (HTTP 409); the Task stopped at 21:47:08, **129 s before the manifest was ready** |
| Result | 0 forecasts |

## What is and is not established

- **Established (code and offline):** `prediction_batch_manifest` mapped every HTTP 409 to an MCP tool result with `isError: true` (`mcpPayload`), including the normal, expected `manifest_pending`. A caller therefore received a routine wait as a failed tool call, in the same shape as `start_refused` or `lease_lost`.
- **Not established:** why ChatGPT stopped. No claim is made that the `isError` mapping is the cause; it is a defect of the contract that is fixed because it is wrong on its own, and the natural runs after the fix decide whether the Task now keeps polling. No prompt guard is added speculatively.
- **A measured production datum:** the preparation took 134.7 s in production, longer than the synchronous start the deferred protocol replaces took to answer (75–90 s), but it runs off the caller's path; the poll budget of the delta note (5 s, at most 3 minutes) covers it.

## The fix and its offline checks

Only the MCP tool changes: in the `prediction_batch_manifest` handler, the answer of the underlying read with HTTP 409 **and** `code: manifest_pending` becomes a successful tool result `{httpStatus: 200, kind: "pending", status: "manifest_pending", code: "manifest_pending", retryAfterMs: 5000}` (no `error`, no `isError`, no `structuredContent`, like the other manifest results). The underlying read (`ownedBatchManifest`), the lease, epoch, readiness, ownership, Workflow, queue, submit and the schedules are unchanged, and `mcpPayload` still treats every other 409 as an error. The synchronous keyed variant of the same tool has the same normal wait and the same mapping.

- Pending read after the receipt and before the preparation: non-error, `kind: pending`, `retryAfterMs` 5000, repeatable; it writes no D1 row, renews no lease, writes no record and dispatches nothing; the underlying read still answers `409 manifest_pending`.
- The state between the stored manifest and the readiness edit is the same successful pending.
- Real refusals keep `isError: true`: `start_refused`, `start_failed`, `unknown_run`, invalid arguments, an invalid part; the existing tests for them are unchanged.
- The Task path at S5 (receipt, envelope, heartbeat, five films, submit, replay, completion) is unchanged and passes.
- Mutation checks caught: mapping every 409 to a success, and leaving the pending an error.
- Compatibility with the installed prompt recorded in PR #875: its step 2a keys on the code `manifest_pending` and on `retryAfterMs`; the words "(409)" there are descriptive, and the result still carries `status` and `code` `manifest_pending` and `retryAfterMs`, so no prompt refresh or Task change is needed. A later prompt refresh may mention the successful `kind: "pending"` result for clarity.

## Not claimed

Recovery of Predictions, the reason the Task stopped, any production behaviour after the fix. The natural runs after deploy are the evidence: the Task continues to poll after a pending answer, receives the ready envelope, heartbeats and commits.
