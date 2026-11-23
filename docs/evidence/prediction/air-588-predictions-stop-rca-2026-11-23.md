# AIR-588: RCA of the Predictions stop after long `batch_start`, 23 Nov 2026

**Card:** [AIR-588](https://trello.com/c/vyxbU1l0) (P0). **Capture:** 23 Nov 2026 20:00–22:30 UTC, plus a 7-day look-back to 16 Nov 2026 23:30 UTC. **Sources (L0, read-only):** Cloudflare Workers Observability for Worker `iptv` (telemetry query with `dry: true`: the `prediction_step_timing` and `mcp_tool_call` log lines and the per-invocation `POST /mcp` records), `git log` / `git diff` of `main`, and an offline replay on the real Worker code. **Not read:** the ChatGPT Scheduled Task run reports (the owner's ChatGPT account; not reachable from this session), D1 or R2 directly. **No production write, Task change, `run_now`, lease operation, flag or deploy** was made.

**Verdict.** The Worker behaved as specified in every failed run: each `batch_start` returned HTTP 200 with a stored seven-film manifest, a same-Task repeat got `start_pending`, readbacks got `manifest_pending` or the ready parts, and abandoned leases expired and turned other Tasks away as designed. **The proven mechanism of the stop is client abandonment**: from 20:33 UTC on, the Task (ChatGPT client) stopped calling the Worker shortly after a long start, so no run reached a heartbeat, hold or submit. The same Worker latency (89 s median, 83 % of starts above 60 s) had been absorbed by the client for at least 34 hours before. **What changed on the client at about 20:30 UTC is not established** from Worker telemetry. The Worker latency is the long-standing vulnerability that makes runs depend on how the client handles a tool call longer than about 60 s; its two main contributors are identified below.

## 1. What the failed runs did (Worker view)

Times are UTC; every run is one nominal slot. `start` is the long labelled `batch_start`; "re-init" is a new MCP `initialize` from the client (the ChatGPT connector opens one before each tool call).

| Run (card id) | Client calls | Worker answers | After |
| --- | --- | --- | --- |
| `04ea4741`, start 20:33:25 | `enrichment_runner` 20:33:22; start 20:33:25; re-init **20:34:25 (+60 s)**; same-Task start; `prediction_batch_manifest` ×3, 20:34:40–20:34:49 | repeat: `start_pending` after the 10 s join (request 11.7 s); readbacks `manifest_pending`; **first start 200 at 20:35:17** (111.9 s, request `c8ab0cd9`) | no call; lease expired; 20:43:01 another slot `already_running` |
| `81420641`, start 20:57:40 | `enrichment_runner` 20:57:37; start 20:57:40 | 200 at 20:59:21 (100.9 s, `821504d8`) | **no call at all** (no re-init at +60 s, no readback) |
| `c83c4a80`, start 21:16:42 | `enrichment_runner` 21:16:40; start 21:16:42 | 200 at 21:18:31 (108.9 s, `80083b17`) | **no call at all**; 21:28:06 another slot `already_running` |
| `59f745f7`, start 21:41:23 | `enrichment_runner` 21:41:21; start; re-init **21:42:23 (+60 s)**; same-Task start; one readback 21:42:40 | `start_pending` (12.2 s); `manifest_pending`; first start 200 at 21:43:17 (113.8 s, `aca175f5`) | no call; 21:58:01 another slot `already_running` |
| (after the card was written) start 22:21:16 | `enrichment_runner` 22:20:25; start 22:21:16 | 200 at 22:23:11 (114.1 s) | re-init 22:24:19; three ready readbacks (200) 22:24:21–22:24:26; **then no heartbeat, hold or submit** up to 22:29 UTC |

The last successful run, `ffae2f94` (start 20:17:09, 155.3 s, request `c422ef9c`), followed the same first steps as `04ea4741` (re-init at +60 s, `start_pending`, readbacks) but **kept reading every 7–8 s for 77 s** until the manifest was ready, then heartbeat, hold, submit and `manifest_spent`. The difference between a successful and a failed run is entirely in what the client did after the start, not in any Worker answer.

## 2. Before and after 20:30 UTC (same Worker latency, different client)

Full labelled starts that delivered a manifest, from 22 Nov 2026 12:00 to 23 Nov 2026 22:30 UTC; "OK" means a `batch_submit` with HTTP 200 before the next start (at most 15 min):

| Window | Starts | OK | Starts > 60 s | of them OK | Same-Task repeat (client timed out at +60 s) | of them OK | With queue refresh | p50 / p90 / max |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 22 Nov 12:00 – 23 Nov 20:30 | 120 | **118** | 99 | 98 | 18 | **18** | 79 | 89 / 122 / 179 s |
| 23 Nov 20:30 – 22:30 | 5 | **0** | 5 | 0 | 2 | **0** | 5 | 112 / 114 / 114 s |

- The latency did not change at 20:30 UTC. Starts of 140–179 s were followed by submits on 22–23 Nov; the client either waited for the answer or timed out at +60 s and recovered through `start_pending` and the readback.
- **Worker code did not change between the last success and the first failure.** The success ran on version `a669f447` (deploy of `5088a6a`), the first failure on `8071bbe2` (deploy of `ed3a90f` at 20:30:49 UTC); `git diff 5088a6a ed3a90f` touches only `docs/` and `migrations/README.md`. The production D1 migration 0037 (20:07 UTC) creates Watchlist membership tables and rebuilds `watchlist_effect`; the prediction start's D1 statement mix (486–493 calls, see below) is the same before and after it.
- The two earlier failures in the window (starts at 22 Nov 17:29 and 23 Nov 17:42 UTC) were isolated; the start of 20:33 UTC opens an unbroken series (the four runs on the card and the 22:21 UTC run).

## 3. Why the synchronous start takes 90–180 s

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

**The queue refresh runs on almost every start since 18 Nov 2026 ~21:20 UTC.** Before that (17–18 Nov) the labelled starts had `refreshRounds: 0`, about 163–177 D1 calls (against about 300–340 with a refresh at the same S5 size) and walls of 10–81 s; from 18 Nov 21:20 UTC (shortly after [AIR-529](https://github.com/vladimino/iptv-watchlist/commit/0dbd635d), "rebuild Prediction hot/cold when Discovery assigns shows inside the same EPG generation", merged 20:38 UTC) about two in three starts carry `refreshRounds: 1` with +15–45 s of `queue_refresh` and +5–17 s of `preflight_refreshed`. The settlement counter is 0 in these refreshes (`settledFilms: 0`) and no `priorityLagAccepted` is noted, so the trigger is the priority basis of `batchPreflight` (the AIR-529 same-generation Discovery assignment signature or the window transition), not stale films or a stale contract; the timing line does not record which of the two. Larger manifests add to `persist` and the three preflights (with a refresh on 22–23 Nov: S5 about 70–110 s, S7 about 85–155 s, S10 up to 179 s).

## 4. The offline replay

`tests/prediction-air-588-abandoned-start.mjs` (core suite) runs the production chain on the real Worker over the sqlite D1 stand-in and in-memory R2: a labelled seven-film start held at its manifest write; the same Task's repeat (`start_pending`, the one run and epoch); the MCP readback (`manifest_pending` as a successful `kind: pending` result); another Task's start (`already_running`, nothing assigned); the first start finishing with HTTP 200 and the stored manifest; a later readback and a later repeat returning the same manifest hash (what the 20:17 UTC run did); the client stopping (two more Tasks turned away, nothing committed); lease expiry (the next Task gets a new run with epoch + 1 and the **same** seven films offered again); a late submit of the abandoned run refused; the new run commits a film exactly once. It pins the Worker contract; it cannot reproduce why the client stops.

## 5. Not established, and what would establish it

1. **Why the ChatGPT Task stopped calling after about 20:30 UTC**, including in the two runs with no call at all after the start and the 22:21 run that read three ready parts and stopped. The Task run reports (ChatGPT, owner account) for the slots 21:30, 21:45/22:00 (the 20:57 UTC start), 22:15, 22:41 and 23:20 Madrid are the evidence: the final message, whether a tool call was reported as a timeout or error, and whether the run ended by itself.
2. Which AIR-529 trigger (`shows_signature_changed` or `window_transition`) fires on each start; the timing line does not carry `priorityCause`.
3. The `index_ahead_of_queue` partial snapshot in `prediction_queue_overview` was not re-read here; it is a read-model consistency note and nothing above depends on it.

## 6. Options for the owner (no code is changed by this report)

- **A. Bring the synchronous start under the client's ~60 s bound, with margin (Worker code; recommended).** (A1) Request-scoped memoization of the repeated schema/authority probes (`sqlite_master`, `schema_contract`, authority markers) and fewer R2 lease writes in the start path: these calls took about 35 s of the 20:35 UTC start (the achievable saving is to be measured), no behavior change, no ADR expected. (A2) Take the AIR-529 same-generation rebuild off the start path (the start accepts the known priority lag, as AIR-542 already does after one rebuild, and the rebuild runs on the hourly tick or after a commit): about 25–60 s on most starts; it changes when hot/cold is re-ranked, so it needs an owner decision and an ADR amendment. A1 alone leaves starts around 60–90 s; A1 + A2 targets about 30–50 s, to be measured on the real worker path before and after. Backward compatible with the installed S7 prompts; rollback is a code revert.
- **B. Deferred start (ADR 0193, implemented, Proposed, dormant).** It removes the long tool call but keeps the client's polling of `manifest_pending`; the first natural deferred run on 21 Nov stopped polling 129 s before the manifest was ready ([evidence](air-573-first-deferred-run-2026-11-21.md)), the same client behavior seen here. Not recommended as the containment without evidence that the client keeps polling.
- **Not recommended:** a smaller `manifestSize` as a fix (S5 starts were already 75–100 s and the failures are not size-specific), or a prompt-only change (the installed prompt already orders the readback for up to 3 minutes).
