# AIR-588: RCA of the Predictions stop after long `batch_start`, 23 Nov 2026

**Card:** [AIR-588](https://trello.com/c/vyxbU1l0) (P0). **Capture:** 23 Nov 2026 20:00–22:56 UTC, plus a 7-day look-back to 16 Nov 2026 23:30 UTC. **Sources (L0, read-only):** Cloudflare Workers Observability for Worker `iptv` (telemetry query with `dry: true`: the `prediction_step_timing` and `mcp_tool_call` log lines and the per-invocation `POST /mcp` records), `git log` / `git diff` of `main`, an offline replay on the real Worker code, and the Scheduled Task run reports of the 23:00, 23:15, 23:30 and 23:45 Europe/Madrid slots **as quoted by the owner** in [the PR review](https://github.com/vladimino/iptv-watchlist/pull/960#pullrequestreview-6030836359) (caller-reported; this session cannot read the Task reports itself). **Not read:** the Task reports of the earlier failed slots, D1 or R2 directly. **No production write, Task change, `run_now`, lease operation, flag or deploy** was made.

**Verdict.** The Worker answered as specified in every failed run: each `batch_start` returned HTTP 200 with a stored seven-film manifest, a same-Task repeat got `start_pending`, readbacks got `manifest_pending` or the ready parts, and abandoned leases expired and turned other Tasks away as designed. From 20:33 UTC no run reached a heartbeat, hold or submit (0 of 6), because the Task stopped calling the Worker after the start. **The stops fall into three different client-side patterns** (section 2): abandonment of the `start_pending` readback after a +60 s call timeout; no call at all after the start; and, in the two runs with Task reports, a start answer that the Task reports as **truncated** followed by **premature termination during the part recovery**. The same patterns, including part recovery after a long start, completed 118 times in the 120 starts of the preceding 32 hours. **Latency did not enter a new regime:** the post-onset median is 112 s for the first five failed starts (110.5 s with the sixth) against 89 s before, inside the earlier range (p90 122 s, maximum 179 s, 98 of 99 starts above 60 s successful). **Why the client behaves differently since about 20:30 UTC is not established**, and nothing here shows that a faster start alone would restore delivery.

## 1. What the failed runs did (Worker view, with the Task reports where quoted)

Times are UTC. `start` is the long labelled `batch_start`; "re-init" is a new MCP `initialize` from the client (the ChatGPT connector opens one before each tool call). Request ids are the Worker's.

| Run | Client calls | Worker answers | After | Task report (owner quote) |
| --- | --- | --- | --- | --- |
| `04ea4741`, start 20:33:25 | `enrichment_runner` 20:33:22; start; re-init **20:34:25 (+60 s)**; same-Task start; `prediction_batch_manifest` ×3, 20:34:40–20:34:49 | repeat: `start_pending` after the 10 s join (11.7 s); readbacks `manifest_pending`; **first start 200 at 20:35:17** (111.9 s, `c8ab0cd9`, 44,212 B) | no call; lease expired; 20:43:01 another slot `already_running` | not quoted |
| `81420641`, start 20:57:40 | `enrichment_runner` 20:57:37; start | 200 at 20:59:21 (100.9 s, `821504d8`, 43,251 B) | **no call at all** (no re-init at +60 s, no readback) | not quoted |
| `c83c4a80`, start 21:16:42 | `enrichment_runner` 21:16:40; start | 200 at 21:18:31 (108.9 s, `80083b17`, 42,596 B) | **no call at all**; 21:28:06 another slot `already_running` | not quoted |
| `59f745f7`, start 21:41:23 | `enrichment_runner` 21:41:21; start; re-init **21:42:23 (+60 s)**; same-Task start; one readback 21:42:40 | `start_pending` (12.2 s); `manifest_pending`; first start 200 at 21:43:17 (113.8 s, `aca175f5`, 43,389 B) | no call; 21:58:01 the next slot `already_running` | 23:00 Madrid slot reports foreign `already_running` (the only start near that slot is 21:58:01) |
| `fd4c0727`, start **22:21:16** (23:15 Madrid slot) | `enrichment_runner` 22:20:25; start; **no** re-init at +60 s | 200 at 22:23:11 (114.1 s, 43,926 B) | re-init 22:24:19; three ready readbacks (200) 22:24:21–22:24:26; no further call; 22:30:25 the next slot `already_running` | report completed 22:24:30: initial response **truncated**; envelope, profile and contract read; film-part recovery **not completed**; zero research, zero submits. 23:30 slot: foreign `already_running` |
| `32b2c67c`, start **22:45:12** (23:45 Madrid slot) | `enrichment_runner` 22:45:10; start; **no** re-init at +60 s | 200 at 22:46:52 (100.2 s, 44,109 B) | one ready readback (envelope) 22:46:56; no further call | report completed 22:46:58: response **truncated**; envelope received; remaining parts not verified; zero research, zero submits |

The last successful run, `ffae2f94` (start 20:17:09, 155.3 s, `c422ef9c`), followed the same first steps as `04ea4741` (re-init at +60 s, `start_pending`, readbacks) but **kept reading every 7–8 s for 77 s** until the manifest was ready and then read every part, heartbeat, hold, submit and `manifest_spent`. The reports are caller-reported observations: they do not prove a connector limit, and they say nothing about the four earlier failed runs.

## 2. Three failure patterns, against the same patterns before the onset

Full labelled starts that delivered a manifest, from 22 Nov 2026 12:00 to 23 Nov 2026 22:56 UTC. "OK" is a `batch_submit` with HTTP 200 before the next start (at most 15 minutes). The pattern is read from the Worker side: a same-Task repeat after a +60 s re-init (**call timeout**), no call after the start answer (**silent**), one or two ready readbacks after the answer, or three or more ready readbacks after the answer before the first heartbeat, hold or submit (**part recovery**, the step 2a path of the prompt for a truncated or unparseable start answer).

| Pattern after the start | Before 20:30 UTC: runs | OK | After 20:30 UTC: runs | OK |
| --- | --- | --- | --- | --- |
| Start answer used directly (no readback) | 42 | 41 | 2 (`81420641`, `c83c4a80`: silent) | 0 |
| One or two ready readbacks | 23 | 23 | 1 (`32b2c67c`) | 0 |
| Part recovery (three or more ready readbacks) | 37 | 36 | 1 (`fd4c0727`) | 0 |
| Call timeout at +60 s, `start_pending`, readback polling | 18 | 18 | 2 (`04ea4741`, `59f745f7`) | 0 |
| **All** | **120** | **118** | **6** | **0** |

- **Call timeout** (`04ea4741`, `59f745f7`): the long call was abandoned by the connector at +60 s; the Task repeated the start correctly, got `start_pending` and then stopped polling after one to three `manifest_pending` answers (12 s and 5 s after `start_pending`; the prompt allows 3 minutes).
- **Silent** (`81420641`, `c83c4a80`): no call of any kind after the start; there was no +60 s timeout, so the answer was either received or lost without a retry. No report is quoted, so which one is unknown.
- **Reported truncation, then premature termination during part recovery** (`fd4c0727`, `32b2c67c`): no call timeout; the Task reports a truncated start answer, began the part recovery and ended the run before reading the film parts (the reports completed 4 s and 2 s after the last readback). The same recovery completed in 36 of 37 runs before the onset.
- **Latency.** p50 / p90 / maximum of the start: 89 / 122 / 179 s before the onset (120 starts, 99 above 60 s); 112 s median for the first five failed starts and 110.5 s with the sixth (100–114 s). The failed starts lie inside the earlier range; no new latency regime is shown, and successful starts of 140–179 s happened the same day.
- **Worker code did not change between the last success and the first failure.** The success ran on version `a669f447` (deploy of `5088a6a`), the first failure on `8071bbe2` (deploy of `ed3a90f` at 20:30:49 UTC); `git diff 5088a6a ed3a90f` touches only `docs/` and `migrations/README.md`. The production D1 migration 0037 (20:07 UTC) creates Watchlist membership tables and rebuilds `watchlist_effect`; the prediction start's D1 call count (486–493) is the same before and after it.
- The two earlier failures in the look-back (starts at 22 Nov 17:29 and 23 Nov 17:42 UTC) were isolated; the start of 20:33 UTC opens an unbroken series.

## 3. Response size: what is measured and what is not

`manifestBytes` is the Worker's own measure of the serialized start answer (`batchBytes`), checked against the Worker cap `maxManifestBytes` = **256 KiB** (262,144 B); above it the start is refused with `manifest_too_large`, which did not happen.

| Window | Size | Starts | `manifestBytes` min / p50 / max |
| --- | --- | --- | --- |
| before 20:30 UTC | S5 | 78 | 37,659 / 39,435 / 41,991 |
| before 20:30 UTC | S7 | 21 | 41,884 / 43,488 / 45,309 |
| before 20:30 UTC | S8 | 8 | 44,495 / 45,663 / 47,666 |
| before 20:30 UTC | S10 | 13 | 48,298 / 49,735 / 52,679 |
| after 20:30 UTC | S7 | 6 | 42,596 / 43,926 / 44,212 |

- The failed answers are the same size as the successful S7 answers before the onset and smaller than the successful S10 answers (up to 52.7 KB), at about a sixth of the Worker cap.
- The MCP tool returns the start answer as **one** JSON text copy (`structuredContent` is removed for this tool since AIR-510), so the JSON-RPC body is the answer plus one level of string escaping; its exact byte count is not logged.
- **Not observable here:** any downstream limit of the ChatGPT connector or of the Task's working context, and the byte size of each part answer (`prediction_batch_manifest` logs the R2 read of the whole stored manifest, 44,109 B for `32b2c67c`, not the part it returned). A downstream truncation limit is therefore neither shown nor excluded; the reports' "truncated" is the caller's observation.

## 4. Why the synchronous start takes 90–180 s

Representative failed start, 20:35:17 UTC (`c8ab0cd9`): wall 111.9 s; 486 D1 calls (616 statements, 59 batches, 414,340 rows read, 105 written) for 126.7 s of D1 time; 91 R2 calls for 38.4 s.

| Stage | ms | D1 calls |
| --- | --- | --- |
| `preflight` | 11,242 | 47 |
| `settle_previous` + `catalog_gate` | 1,071 | 6 |
| **`queue_refresh`** | **28,135** | **188** |
| `preflight_refreshed` | 8,322 | 46 |
| `preflight_lease` | 9,054 | 47 |
| **`persist`** (exclusive of `event_delivery` 1,090 and `manifest_ready` 1,401) | **43,206** | **133** |

By class over the whole start: `sqlite_master` 51 reads (10.4 s) and `schema_contract` 50 reads (10.4 s), i.e. about 21 s of repeated schema and authority probes; `prediction_pointer` + `prediction_fingerprint` 136 reads (37.5 s) across three preflights; 14 R2 `lease` PUTs (14.6 s); `published_epg_show` / `published_epg_document` 12 reads (11.3 s).

**The queue refresh runs on most starts since 18 Nov 2026 ~21:20 UTC.** Before that (17–18 Nov) the labelled starts had `refreshRounds: 0`, about 163–177 D1 calls (against about 300–340 with a refresh at the same S5 size) and walls of 10–81 s; from 18 Nov 21:20 UTC (shortly after [AIR-529](https://github.com/vladimino/iptv-watchlist/commit/0dbd635d), "rebuild Prediction hot/cold when Discovery assigns shows inside the same EPG generation", merged 20:38 UTC) about two in three starts carry `refreshRounds: 1` with +15–45 s of `queue_refresh` and +5–17 s of `preflight_refreshed`. The settlement counter is 0 in these refreshes (`settledFilms: 0`) and no `priorityLagAccepted` is noted, so the trigger is the priority basis of `batchPreflight` (the AIR-529 same-generation Discovery assignment signature or the window transition), not stale films or a stale contract; the timing line does not record which of the two. Larger manifests add to `persist` and the three preflights (with a refresh on 22–23 Nov: S5 about 70–110 s, S7 about 85–155 s, S10 up to 179 s). This latency makes every run depend on how the client handles a long call; it is a standing exposure, not the shown trigger of the onset.

## 5. The offline replay

`tests/prediction-air-588-abandoned-start.mjs` (core suite) runs the Worker side of the chain on the real Worker over the sqlite D1 stand-in and in-memory R2: a labelled seven-film start held at its manifest write; the same Task's repeat (`start_pending`, the one run and epoch); the MCP readback (`manifest_pending` as a successful `kind: pending` result); another Task's start (`already_running`, nothing assigned); the first start finishing with HTTP 200 and the stored manifest; a later readback and a later repeat returning the same manifest hash (what the 20:17 UTC run did); the client stopping (two more Tasks turned away, nothing committed); lease expiry (the next Task gets a new run with epoch + 1 and the **same** seven films offered again); a late submit of the abandoned run refused; the new run commits a film exactly once. It pins the Worker contract; it does not reproduce a truncation or why the client stops.

## 6. Not established, and what would establish it

1. **Why the Task stops**: abandoning the readback after `start_pending`, making no call after the start, and ending during the part recovery after a reported truncation. The reports of the slots behind `04ea4741`, `81420641`, `c83c4a80` and `59f745f7` (21:30, 21:45/22:00, 22:15 and 22:41 Madrid) are not quoted; for `fd4c0727` and `32b2c67c` the reports name a truncation but not its cause or why the recovery stopped.
2. **Whether there is a downstream response limit** (connector or Task context) and its size; the Worker cap is 256 KiB and is not reached.
3. Which AIR-529 trigger (`shows_signature_changed` or `window_transition`) fires on each start; the timing line does not carry `priorityCause`.
4. The `index_ahead_of_queue` partial snapshot in `prediction_queue_overview` was not re-read here; nothing above depends on it.

## 7. Options for the owner (nothing is implemented; each needs a separate owner decision)

None of these is shown to restore delivery on its own: two of the six failures had no call timeout at all, and part recovery after a truncated answer used to succeed. Each would be judged by natural runs after delivery.

- **A1. Fewer repeated reads in the start path (Worker code).** Request-scoped reuse of the schema and authority probes (`sqlite_master`, `schema_contract`, authority markers) and fewer R2 lease writes; these calls took about 35 s of the 20:35 UTC start, and the achievable saving is to be measured on the real worker path. **Constraint:** the reuse must stop at every `forgetAuthority` boundary, so each fenced stage (refresh, lease, persist) still reads a fresh authority marker and lease epoch; no read fence may be served from an earlier stage. No behaviour change intended; ADR need to be checked against the fence design.
- **A2. Take only proven ordering drift off the start path (Worker code, ADR amendment).** When the only reason for the refresh is the AIR-529 same-generation assignment signature or the window transition, the start may accept the known priority lag (as AIR-542 already accepts it after one rebuild) and leave the rebuild to a named writer. **Constraint:** a real advance-gate failure (`queueAdvanceGate`: profile, contract, registry or recovery revision), stale or settled films, and an **unreadable** signature (`shows_signature_unreadable`) must still refresh or fail closed exactly as today. It changes when hot/cold is re-ranked, so it needs an owner decision and an amendment of the AIR-529 decision.
- **C. Compact ready-envelope transport (protocol and prompt change).** The start answers only the envelope of the already stored manifest (run id, epoch, `manifestHash`, the part list, limits), not the 44 KB answer, and the Task reads profile, contract and film parts through the existing `prediction_batch_manifest`. It reuses the stored manifest and parts, keeps fencing and ownership unchanged, and removes the large single answer the reports call truncated. It changes the Task protocol, so it needs an owner decision, an ADR and a prompt change through the Controller. A further variant, **incremental per-film consumption** (research and submit film by film as parts are read, instead of assembling the whole manifest first), is a larger prompt and validation change and is listed only as something to approve and validate separately.
- **B. Deferred start (ADR 0193, implemented, Proposed, dormant).** It removes the long call but keeps readback polling; the first natural deferred run on 21 Nov stopped polling 129 s before the manifest was ready ([evidence](air-573-first-deferred-run-2026-11-21.md)), the same client behaviour as the call-timeout pattern here. Not recommended without evidence that the client keeps polling.
- **Not recommended:** a smaller `manifestSize` as a fix (failures are not size-specific: larger S10 answers succeeded), or a prompt-only change to the readback (the installed prompt already orders polling for up to 3 minutes and the full part recovery).

No runtime, prompt, Task or production change is authorized by this report or by the review that shaped it; implementation waits for the owner's decision.
