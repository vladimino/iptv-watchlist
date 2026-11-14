# AIR-486: repeated `batch_start` and lost ownership after AIR-471 (read-only RCA)

**Capture:** 14 November 2026, four natural hourly slots 20:00–23:00 Europe/Madrid (19:00–22:06 UTC). Times below are **UTC** unless a column says Madrid (UTC+1 that evening).
**Code:** production Worker `iptv` as deployed from `main` after [AIR-471](https://trello.com/c/rFBAixZe) (offline D1 131→82). This capture does not identify the exact git SHA of the live isolate.
**Sources (read-only):** exact-key GET of R2 `enrichment/run-diagnostics/<runId>.json` and `enrichment/runs/<runId>.json` with the snapshot Object-Read credential (bucket default `iptv`); prefix list of `enrichment/run-diagnostics/` last-modified in the window; Worker `iptv` `prediction_step_timing` events via the telemetry query endpoint (POST that only reads); repository code of `batchStartWork` / `batchPersistRun` / `settleExpiredDiagnostics`. No Scheduled Task mutation, MCP prediction writer, lease reset, retry, flag, D1 write or R2 write. Run and request ids are shortened to 8 characters. No film id, payload, prompt or Access token is recorded.
**Not read this capture:** ChatGPT Task registry (no authorized connector in this session); IPTV MCP was unavailable (`namespaceStatus: error` during live discovery). Registry claims in the Trello card are **self-report of an earlier reader**, labelled as such.
**Verdict:** AIR-471 did **not** make production `batch_start` fast. Four of four real starts still took 65–149 s Worker `wallMs`. The remaining cost is **proven on the Worker persist path**: stage `persist` 56.6–128.2 s with **244–248 R2 operations**, of which **214–217** are class `r2:diagnostics` (about 10 MiB of object bodies; the step timer records GET body bytes on `bytesOut`). Preflight plus lease revalidation is 6–16 s. The ~60 s second start is **still a separate HTTP request** with `leaseRefused: 1` and `liveLeaseAgeMs` 58.7–65.9 s; it is **not** a Worker retry. A hard 60 s platform timeout is **contradicted** by the 21:00 slot (`wallMs` 148.8 s, no second start, owner continued). Lost ownership still coincides with the second start (2 of 2); slots without it completed. Caller identity of the second request remains unproven. The owner design GO of 15 Nov 2026 implemented the persist move in the same card; that code is recorded in [the offline follow-up](air-486-batch-start-settle-move-2026-11-15.md), not in this capture.

## 1. Four-slot matrix

Nominal slots are hourly `:00` Europe/Madrid. `startedAt` is the diagnostics row. `wallMs` is the Worker step-timing line (includes work before the run exists). Diagnostics `elapsedMs` is the recorded `start` step only. Arrival is `log timestamp − wallMs`.

| Slot (Madrid) | Run | Arrival (UTC) | `requestId` | Worker `wallMs` | Diag `elapsedMs` | HTTP | Lease | First submit | Terminal | Duplicate start |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 20:00 | `15b11fee` | 19:04:48 | `5ff80868` | 64.876 s | 55.227 s | 200 `produced` | acquired 19:04:52, expiry 19:19:52 | none | `interrupted` / `lease_expired` (settled by next start; run `completedAt` 20:02:12) | `42843db9` arrival 19:05:54, `already_running`, `liveLeaseAgeMs` 65881, `requestId` `a27a3f49`, 5.117 s |
| 21:00 | `c6b2c3d7` | 20:00:34 | `85a560e6` | 148.849 s | 125.496 s | 200 `produced` | 20:00:45–20:23:36 | 20:06:23 | `manifest_spent`, created 2 / failed 3 (caller-reported); `startResult` `recovered_stale_lease` | **none** |
| 22:00 | `72c30cda` | 21:01:20 | `edc101a7` | 74.541 s | 62.335 s | 200 `produced` | 21:01:26–21:21:57 | 21:04:28 | `manifest_spent`, created 5 / failed 0 | **none** |
| 23:00 | `b5422b3e` | 22:04:55 | `6cd6f830` | 67.591 s | 56.512 s | 200 `produced` | 22:05:00–22:20:00 | none | still `running` in diagnostics at capture; lease TTL 15 min, no submit step | `8a2f6a65` arrival 22:05:55, `already_running`, `liveLeaseAgeMs` 58746, `requestId` `4aff1a60`, 5.207 s |

Provenance of each cell:

- Run id, lease times, submit/complete steps, `startResult`, counts, HTTP, `elapsedMs`, `outcome=produced`, `delivery=unconfirmed`, `observedBy=server`: **server-observed** (R2 diagnostics / run objects).
- `wallMs`, stages, `notes` (`manifestFilms`, `preflights`, `refreshRounds`, `scannedFilms`, `leaseRefused`, `liveLeaseAgeMs`), R2/D1 class counts: **server-observed** (Worker logs).
- Duplicate start as an independent request: **server-observed** (second diagnostics row + second timing line with a different `requestId`).
- Whether the client received the first body: **unknown** (`delivery` is always `unconfirmed`).
- Task invocation id / registry last-run for 23:00: **unknown here**; Trello card text (not re-read) said the saved report was already `already_running` of another owned run. That is **self-report**, not this capture.
- External scheduler duplicate vs client retry vs lost response: **unknown**.

Every refused second start is `trigger: scheduled`, `startResult: already_running`, no lease, 0 D1 writes (`rowsWritten: 0`), 6 R2 ops. The answer names the live holder (`batchTurnedAway` returns `{status:'already_running', runId: live.runId}`). The v2 prompt tells the caller not to adopt that `runId` and to end without `prediction_complete`.

## 2. Stage-level latency (the four real starts)

`refreshRounds: 0` on all four; `preflights: 2`; `scannedFilms: 10` (5+5). Queue refresh is not the cost. `turned_away` on a **successful** start is the cheap live-lease miss (123–306 ms) before acquire.

| Run | `wallMs` | persist ms | persist R2 / D1 | `r2:diagnostics` n / ms | R2 n / ms | D1 n / statements | manifest films / bytes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `15b11fee` | 64.9 s | 56.6 s | 235 / 91 | 214 / 33.7 s | 244 / 47.4 s | 158 / 194 | 5 / 44745 |
| `c6b2c3d7` | 148.8 s | 128.2 s | 239 / 95 | 217 / 79.8 s | 248 / 105.4 s | 162 / 202 | 5 / 44745 |
| `72c30cda` | 74.5 s | 64.1 s | 235 / 91 | 214 / 34.8 s | 244 / 51.9 s | 158 / 194 | 5 / 44671 |
| `b5422b3e` | 67.6 s | 58.1 s | 235 / 91 | 214 / 34.0 s | 244 / 49.6 s | 158 / 194 | 5 / 44110 |

Two preflights together are 5.9–15.6 s (D1 film pointer/fingerprint reads), not the minute-scale stall. `persist` is 87–86 % of `wallMs`.

Code path in persist (`batchPersistRun`): writer lease → `settleExpiredDiagnostics` (R2 list of up to 100 keys under `enrichment/run-diagnostics/`, GET each body, PUT when the row still looks lease-expired) → `deliverPendingEvents` → recover previous run → `savePredictionRun` / diagnostics checkpoint. The prefix held **492** keys at capture. The AIR-471 offline fixture had no such corpus, so its R2 budget stayed 48.

**Fact:** production `batch_start` after AIR-471 is still Worker-bound and is dominated by R2 diagnostic-history I/O inside `persist`. **Fact:** D1 call count fell versus AIR-468 (210–224 → 158–162) and did not bring `wallMs` under 30 s. **Not proven:** the exact split of the 214 diagnostics ops between list-page GETs, expired PUTs and the current run’s checkpoints (the class has no sub-op in the log). **Not claimed:** a production p95.

The 21:00 persist (128 s, 217 diagnostics ops, 79.8 s in that class) is the same shape as the 65 s starts, slower per call, not a different stage graph.

## 3. What is proven or refuted

| Claim | Class |
| --- | --- |
| Four natural starts after AIR-471 have `wallMs` 65–149 s; all `status` 200, `outcome=produced` | **Fact** (logs + diagnostics) |
| Persist holds almost all of that time; `r2:diagnostics` ≈ 214 ops / ~10 MiB bodies | **Fact** (logs). Mapping to `settleExpiredDiagnostics` is **code-derived** (that function is the only start-path walker of the diagnostics prefix) |
| AIR-471 offline R2=48 does not describe production | **Fact** (this capture vs [AIR-471 evidence](air-471-batch-start-latency-2026-11-14.md)) |
| Second start is a second HTTP request ~59–67 s after the first arrival, answered `already_running` with `leaseRefused: 1` | **Fact** |
| A hard 60 s timeout of every in-flight `batch_start` | **Refuted** by `c6b2c3d7` (148.8 s, no second start) and `72c30cda` (74.5 s, no second start). Same as AIR-468’s 96 s success |
| Lost owner iff a second start landed in that slot | **Fact** on this N=4 (2/2 with duplicate abandoned; 2/2 without duplicate completed). Same coincidence as AIR-468 |
| Prompt rule (`already_running` → stop, do not adopt, no complete) explains the abandoned lease | **Hypothesis H2** consistent with both nights; no client trace |
| Client HTTP timeout/retry at ~60 s | **Hypothesis H1**; cannot be a *universal* hard limit (refuted). Can still be a sometimes-applied client/tool retry |
| Second independent Task or scheduler double-fire | **Hypothesis H3**; not evidenced here; Trello said only Task A was enabled (**self-report**) |
| First response lost in transit | **Not shown**; `delivery=unconfirmed` is default |
| Worker schema/code error on start | **Not supported**; every start `produced` HTTP 200 |
| Existing stored predictions were rewritten by this RCA or by abandoned starts | **Fact they were not written by this capture.** Abandoned slots have `firstSubmitAt` null and no submit step. Completing slots created 2 and 5 films respectively (server counts). No backfill or lease reset was performed |

AIR-468 compared: retry cadence still ~60 s on the failing slots; two stalling slots (20:00, 23:00); one 125 s (diag) / 149 s (wall) **successful** start; AIR-471 reduced D1 and added stage fields, which is how persist/`r2:diagnostics` is now attributable. The ownership-loss mechanism is unchanged.

## 4. Telemetry gaps and the cheapest way to close them

| Gap | Why it matters | Least-risk way to get it |
| --- | --- | --- |
| Task invocation id ↔ Worker `requestId` | Distinguishes scheduler duplicate from same-invocation retry | Read-only Task registry last-run (authorized operator). Worker already logs `requestId`; the Task would need to echo it in the saved report (prompt/contract change, separate GO) |
| Client receipt of the first `batch_start` body | Distinguishes lost response from ignored response | Caller `receivedRequestId` on a later `complete`/`fault` (AIR-88). Abandoned runs never complete, so the ack never arrives — a structural gap until an idempotent start or a continue-on-own-lease path exists |
| Sub-ops inside `r2:diagnostics` | Confirms list-page GET vs PUT vs checkpoint | One extra closed `ops` breakdown already on the timer (`get`/`put`/`list`); observation only |
| Whether the second caller is the same Task process | H1 vs H3 | One owner-approved natural invocation that logs call start/end locally (no payloads) |

## 5. Completion, lease safety, predictions kept

- Failed slots never recorded a `heartbeat` or `submit` step. `lastHeartbeatAt` on those rows is the lease acquire (same as AIR-468).
- `c6b2c3d7` recovered `15b11fee` as `recovered_stale_lease` without adopting a foreign live `runId` and without a manual reset. That is the existing start writer.
- At capture, `b5422b3e` was still `running` with lease expiry 22:20:00 UTC (23:20 Madrid); this card does not settle it.
- Created predictions: 2 (21:00) + 5 (22:00). Abandoned slots created 0. No prompt change.

## 6. Fix decision pack (not implemented here)

Ranked. Owner design GO required before an implementation card. No unauthorized adoption of a live `runId`. No lease reset.

| # | Change | Latency | Lease / idempotency | Risk |
| --- | --- | --- | --- | --- |
| **1 (recommended)** | **Take diagnostic-history settlement off the `batch_start` HTTP critical path.** `settleExpiredDiagnostics` must not GET a page of up to 100 R2 bodies before the manifest is returned. Keep at most: recover the single `recoveredRunId` (already loaded), write this run’s diagnostics row, deliver pending events if that stays cheap. Options that preserve AIR-415 settlement: `waitUntil` after the response; D1-only projection of expired runs (prediction domain is already D1); HEAD/metadata instead of full GET; skip a page whose keys are already `interrupted`. Fixture **must** include ≥100 diagnostic objects so the budget cannot regress silently. | Expected: drop persist from 56–128 s toward the remaining ~8–16 s of preflight+lease+run save. Production p95 &lt;30 s remains a later AIR-451 measurement, not a promise | Unchanged lease, CAS, `queue_changed`, no foreign adoption | Low–medium. Must not skip durable settlement forever; bound one page per later start or post-response work. Tests: 100+ stale rows, recovered previous run, no extra GET of the prefix on the response path |
| 2 | Early `already_running` before preflight (AIR-471 deferred this) | Saves 3–8 s on the **refused** start only; does not save the owner of the first start | Keep refusal precedence for missing profile / snapshot / catalog-held | Low; does not stop abandoned slots |
| 3 | Idempotent `batch_start`: same caller key + same trigger within the live lease returns the **existing** manifest instead of `already_running` | None for the first call; converts a lost/retrying owner into a continuation | **Requires a caller-supplied key** (not body-hash). Foreign Task must not adopt. **ADR 0122 change** | Medium. Separate atomic card after (1) |
| 4 | Prompt-only: on `already_running`, if `runId` equals a start this invocation already received, continue | None | Uses today’s answer field `runId` of the holder. Unsafe if the first response was **not** received (the caller never owned the id in memory) and the prompt currently forbids adoption | Weak alone; only helps the retry-after-success case, not lost-response |

**Out of scope / rejected here:** inflating the Task prompt; manual backfill of the two abandoned manifests; resetting the 23:00 lease; changing Scheduled Task enablement (separate owner GO, including whether Task A stays on overnight).

### Follow-up implementation card (draft acceptance)

One atomic Worker card after owner design GO:

- Production-shaped fixture: ≥100 `enrichment/run-diagnostics/` objects on the persist path; assert `r2:diagnostics` on a current-queue `manifestSize=5` start stays at checkpoint/recover scale, not O(page).
- Scenario tests: duplicate start ~60 s (`already_running`, `leaseRefused`, `liveLeaseAgeMs`, no adoption); start `wallMs` of the first request not blocked on the 100-key GET; lost first response (second caller has no runId) still cannot take the lease; lease expiry recovered by the next start; `manifest_too_large` / `queue_changed` unchanged; bounded manifest.
- Timing line keeps stage names; add `get`/`put`/`list` on `r2:diagnostics` if needed; no film ids.
- Independent review, exact-HEAD CI, 240 s shard gate. No production writer, Task edit or deploy authorization in that card beyond ordinary code merge.

## 7. Not done

No Scheduled Task, MCP or Worker write; no `run_now`; no lease reset; no retry; no flag. IPTV MCP down this session. Task registry not read. Cloudflare logs retain a limited window. Exact isolate SHA not proven. `bytesOut` on GET bodies is an instrumentation label, not proof of 10 MiB written.
