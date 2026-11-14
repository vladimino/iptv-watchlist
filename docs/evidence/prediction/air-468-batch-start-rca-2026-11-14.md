# AIR-468: batch v2 `batch_start` latency, second start attempts and lost run ownership (read-only RCA)

**Capture:** 14 November 2026, 09:00–10:00 Europe/Madrid (08:00–09:00 UTC). All times below are **UTC** unless a column says Madrid (UTC+1 on that date).
**Code:** `main` at `f314b339` (ADR 0122 / ADR 0136 batch runner, AIR-463 `manifestSize`).
**Sources (read-only):** exact-key and prefix `GET`/list of R2 `enrichment/run-diagnostics/` and `enrichment/runs/` with the read-only snapshot key; Worker `iptv` `prediction_step_timing` log lines through the telemetry query endpoint (a POST that only reads); repository code. No Scheduled Task, MCP prediction tool, lease, retry, flag, D1 or R2 write was used. Run and request ids are shortened to 8 characters; no film id, payload or prompt text is recorded here.
**Verdict:** Slow `batch_start` is **proven Worker-side** and is mostly redundant R2/D1 work. The second start about 60 s after the first is **proven to come from the caller side of the Worker** (an independent request, not a Worker retry), but whether it is a client tool-call timeout/retry or another trigger is **not proven**. Every run that received that second start lost its owner; no run without it did. The exact post-start stop of the owner is **unverifiable without caller traces**.

## 1. Timeline (nominal slots are Madrid, hourly `:00`)

`startedAt` is the diagnostics `startedAt`; `request` is the step's response time minus the Worker's `wallMs` (so it includes the preflight that runs before the run exists). Lease TTL is 15 min.

| Slot (Madrid) | Run | Request arrival (UTC) | Worker `wallMs` | Lease acquired | First heartbeat | First submit | Complete | Result | Second start |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 01:00 | `210bf9b5` | 00:00:39 | 47.6 s | 00:00:41 | +12 s after start | 00:02:55 | 00:04:23 | `manifest_spent`, 5 created | none |
| 02:03 | `4d8adfef` | 01:03:20 | 96.2 s | 01:03:27 | none | 01:06:06 | 01:09:03 | `manifest_spent`, 5 created | none |
| 03:04 | `7f34ef33` | 02:04:00 | 103.5 s | 02:04:07 | none | none | none | `lease_expired` (found 03:01) | 02:05:00, `already_running` |
| 04:00 | `fd50113c` | 03:00:10 | 77.7 s | 03:00:15 | none | none | none | `lease_expired` (found 04:04) | 03:01:11, `already_running` |
| 05:03 | `df32796a` | 04:03:13 | 92.3 s | 04:03:20 | none | none | none | `lease_expired` (found 04:56) | 04:04:13, `already_running` |
| 05:55 | `3d44e082` | 04:55:48 | 101.4 s | 04:55:54 | none | none | none | `lease_expired` (found 06:01) | 04:56:48, `already_running` |
| 07:00 | `cc70c949` | 06:00:36 | 79.7 s | 06:00:42 | +13 s after start | 06:03:24 | 06:05:52 | `manifest_spent`, 3 created, 2 caller-reported failed | none |
| 08:01 | `dd36dedc` | 07:01:12 | 73.8 s | 07:01:17 | none | none | none | still `running` in storage, lease expired 07:16 (projects as `blocked`) | 07:02:13, `already_running` |

Notes. The slot label follows the card's naming where the actual start was a few minutes off the nominal hour (`3d44e082` started 5 min before 06:00 Madrid; the others up to 4 min after). Every server diagnostic step is `outcome=produced`, HTTP 200, `delivery=unconfirmed`, `observedBy=server`: the Worker formed an answer and cannot know whether it was received. The `already_running` second starts are separate diagnostics rows, each answered by the Worker in 5.7–8.6 s, naming the first run's lease.

## 2. What the measurements prove

**A. The second start arrives 60.3–61.0 s after the first, every time.** First request arrival to second request arrival: `7f34ef33` 60.3 s, `fd50113c` 60.6 s, `df32796a` 60.5 s, `3d44e082` 60.8 s, `dd36dedc` 61.0 s. This is a tight ~60 s interval, not a Worker timer (the Worker has no retry or second-request path; `batchStartRoute` only answers `already_running` via `batchTurnedAway`). It is an independent HTTP request, accepted while the first was still running and holding the lease. **Fact:** a second request, ~60 s after the first. **Not proven:** that it is a client timeout; it could also be a re-issued tool call, another trigger or a second consumer.

**B. The second start coincides perfectly with the lost owner, and latency does not.** Five of five runs with a second start never sent heartbeat, next, submit or complete. Three of three runs without it did. `wallMs` does not separate the groups: successful runs took 47.6, 96.2 and 79.7 s, failed ones 73.8 to 103.5 s. The 96.2 s success (`4d8adfef`) exceeded 60 s with no second start, so **a hard 60 s platform timeout is contradicted** by this slot; the card's 81 s step (`elapsedMs` of the diagnostics step; 96 s total `wallMs` in the log) shows the diagnostics step understates request wall time. Do not close the card with "a 60 s timeout".

**C. Why the owner stops is consistent with, but not proven to be, the prompt rule.** The v2 prompt says `already_running` is a safe loss of the slot: stop, no `prediction_complete`, no retry (`hourly-predictions-batch-v2.md`, lines 23, 72, 94). If one Task invocation's second `start` is that call, the Task ends on a run that is actually its own and leaves the first run's lease to expire. All five failed runs fit this, and none contradicts it. No client trace shows the sequence; it is a hypothesis.

**D. `batch_start` latency is on the Worker and is dominated by repeated reads.** Telemetry for the real starts (`wallMs` equals `busyMs` in every line, so no unattributed time):

| Start | `wallMs` | R2 ops / summed ms | D1 calls / summed ms | D1 statements |
| --- | --- | --- | --- | --- |
| `210bf9b5` | 47.6 s | 252 / 36.3 s | 224 / 20.0 s | 362 |
| `4d8adfef` | 96.2 s | 244 / 67.5 s | 210 / 50.4 s | 330 |
| `7f34ef33` | 103.5 s | 244 / 72.3 s | 210 / 56.6 s | 330 |
| `fd50113c` | 77.7 s | 248 / 54.5 s | 216 / 41.0 s | 344 |
| `df32796a` | 92.3 s | 192 / 61.0 s | 216 / 55.7 s | 344 |
| `3d44e082` | 101.4 s | 252 / 66.6 s | 224 / 58.7 s | 362 |
| `cc70c949` | 79.7 s | 248 / 50.1 s | 216 / 51.6 s | 344 |
| `dd36dedc` | 73.8 s | 244 / 52.3 s | 210 / 38.3 s | 330 |

For five films one start performs about 190–250 R2 operations and 210–224 D1 calls (330–362 statements). Of the R2 time 75–85 % is class `r2:other` (231–237 calls), which the fixed class vocabulary does not name; the code path that reads one film per call (`batchSelection` -> `readFilmsById` / `readFilmState`) is repeated by the preflight (`batchPreflight`), the post-refresh baseline, and the post-lease revalidation (`batchPreflight` again, then `buildBatchManifest`). Each film costs about 40–50 R2 calls per start. The slot with the lowest latency (47.6 s) has the same call counts as the slowest, so latency is per-call variance (R2/D1 round trips of roughly 0.15–0.3 s each), not a different code path.

**E. A refused second start is cheap but not free.** The `already_running` answer runs `batchPreflight` first (6 R2 ops, 51 D1 calls / 83 statements, 5.7–8.6 s) and checks the lease only afterwards.

## 3. Facts, self-report and hypotheses

| Statement | Class |
| --- | --- |
| Worker `batch_start` for five films takes 47–104 s; 190–250 R2 ops and 210–224 D1 calls per start | **Fact** (Worker telemetry) |
| Second start 60.3–61.0 s after the first on 5 slots, answered `already_running` with the first run's lease | **Fact** (diagnostics + telemetry) |
| Owners of the 5 runs with a second start never continued; owners of 3 runs without it did | **Fact** (diagnostics) |
| Caller is a client timeout and retry | **Hypothesis H1** (best fit for A and C; contradicted as a *hard* 60 s limit by the 96.2 s success) |
| Second start is a re-issued tool call by the same Task | **Hypothesis H2** (same observable as H1) |
| Second independent Task or Scheduler | **Hypothesis H3**; no evidence, only one hourly v2 Task A was enabled |
| Response of the first start was lost in transit | **Not shown**; `delivery=unconfirmed` is the Worker's default and proves nothing |
| Worker fault, schema or code error | **Not supported**; every step `produced`, HTTP 200 |

Unverifiable stages (no Worker or platform record exists): the moment the client dispatched each call; whether the client received the first response; the identity and run context of the second caller; what the model did after `already_running`.

## 4. Completion, lease safety and recovery

- The lease is taken before the manifest is persisted and answered; the first heartbeat of a successful run comes 12–13 s after the start response. Failed runs have `lastHeartbeatAt` equal to the start itself.
- A run without a heartbeat leaves its lease live for 15 min. The next hourly start then reports `recovered_stale_lease` (found at +49 to +65 min in the table), so each lost owner also blocks the following slot until expiry or the next natural start. Observed recovery: the next natural run recovers the previous `lease_expired` run without a manual reset, no adoption of a foreign `runId` and no duplicate commit.
- `dd36dedc` is still `running` in storage; its lease expired at 07:16. This card does not repair it.
- Throughput: of 30 nominal films in the six slots 03:00–08:00 Madrid, 3 were created. The 01:00 and 02:03 slots created 5 each.

## 5. Missing telemetry and the least risky way to add it (separate implementation)

1. **Caller receipt:** the Worker cannot tell when a client has given up. Record on the Worker, for `start`, the request's arrival time and the `cf-ray`/`X-Request-Id` of both the first and a refused second start, and log (not store) the time since the live lease's `startedAt` in the `already_running` row. This is observation only, one log field.
2. **Stage breakdown:** log `r2:other` by sub-class (`film_payload`, `film_state`, `admission`) and the count of preflights per start. Names only, no ids.
3. **Instrumented client run:** one owner-approved natural Task invocation with the model logging its own call start/response times (no data) would test H1/H2 directly.

## 6. Fix options (ranked, none implemented here)

| # | Option | Latency effect | Change location | Idempotency and lease | Quality and risk |
| --- | --- | --- | --- | --- | --- |
| 1 | **Make `batch_start` fast: one preflight, no repeated per-film reads** (cache the first selection, revalidate only the queue revision and manifest hash, batch the film reads) | Expected from ~75–100 s to well under 30 s; the refused start already shows one preflight costing 5.7–8.6 s | Worker only | Keeps the existing lease, guard and `queue_changed` revalidation | No change to research quality; needs deterministic call-count tests and a measured offline benchmark before any production claim |
| 2 | **Make a repeated start safe: if the live lease has the same trigger within its first minutes, answer with the live run's manifest (idempotent start) instead of `already_running`** | None, but converts a lost slot into a continuation | Worker and prompt contract | Needs a caller-supplied idempotency key so a foreign Task never adopts a run; adopting by body hash only is unsafe | Medium risk; breaks the ADR "do not adopt another runId" rule unless keyed; needs an ADR change |
| 3 | **Prompt-only: on a second `already_running` within the same Task invocation, re-read `prediction_queue_overview` and retry once after the lease** | None | Prompt | Uses existing safety rules | Weak: the first run's lease stays live 15 min, so the retry cannot succeed; not recommended alone |

Recommendation: first the telemetry of section 5 (item 1 and 2), then option 1 as the primary fix. Option 2 only with a separate ADR and owner decision.

## 7. Proposed next cards (for owner approval)

1. **Batch start: single-preflight manifest build and R2/D1 call-count budget** (option 1). Acceptance: offline fixture with a counting R2/D1 stand-in shows <= 60 R2 and <= 60 D1 calls for `manifestSize=5`; `manifestHash` and `queue_changed` behaviour unchanged; no new writer; exact-HEAD review and 3 green shards. Production acceptance only through natural hourly runs after a separate owner GO.
2. **Batch start: `already_running` observability** (section 5, items 1–2). Acceptance: `prediction_step_timing` carries the new fields on real and refused starts; no secret, id or payload in the line.
3. **Caller-side trace** (section 5, item 3), only with an owner-approved Task run.

## 8. Not done and limits

No Scheduled Task, MCP or Worker write, no `run_now`, no lease reset, no retry, no flag. Scheduled Task registry history and caller-side traces were not available to this session; the Task registry was not read. The Cloudflare logs hold only 7 days; the capture is dated. The `r2:other` split and the preflight count come from code reading plus counts; they were not re-measured offline.
