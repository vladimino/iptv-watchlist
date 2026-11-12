# AIR-446: limits and sizes behind the batch runner v2 contract

**Captured:** 12 November 2026 (UTC). **Method:** code reading of `main` at `dfd1a51` (`src/enrichment.js`, `src/mcp.js`), the [AIR-438 evidence](air-438-step-latency-and-batch-sizing-2026-11-11.md), and the Cloudflare documentation (Workers limits, read through the documentation search on this date). **Scope:** documentation only. No production read, prediction run, Scheduled Task, flag, lease or write was made. **Verdict:** supports [ADR 0122](../../adr/0122-prediction-batch-runner-v2-dual-protocol.md) (Proposed); it decides nothing.

Every size below marked *estimate* is arithmetic on named assumptions, not a measurement. The measurements that would replace them are in section 6.

## 1. MCP inbound limit (64 KiB)

`src/mcp.js` rejects a request body over `MCP_MAX_BODY_BYTES = 64 * 1024` (declared `Content-Length` first, then while streaming) with `413`, before the tool runs. The limit is on the **inbound** JSON-RPC body only; the response size has no Worker-side cap.

A `batch_submit` body is the sum of its items. AIR-438 measured a 10-item `submit` request of 11,173 bytes on the offline fixture (about 1.1 KB per item, a legacy fingerprint without `evidence`). A fingerprint with `evidence` (one to four items per asserted mechanic and execution dimension, with URLs for `web_research`) is larger. *Estimate:* 3 to 6 KB per item with evidence, so 10 items are 30 to 60 KB plus the envelope. The limit is therefore reachable at 10 items with long evidence, and the contract makes the caller split by halves on `413` (nothing was processed). Open decision D4.

## 2. `batch_start` response for 100 films

Fixed parts: the taste profile (about 12.5 KB of text, AIR-438) and the contract/schema (size not measured). Per film: `modelMetadata` (`id`, URIs, `title`, `original`, `year`, `genres`, `synopsis`, `directors`, `actors`, `runtime`, `src/enrichment.js` `modelMetadata`). AIR-438 measured about 300 bytes per item on a fixture with short synopses.

| Assumption | Per film | 100 films |
| --- | --- | --- |
| Fixture-like metadata | 0.3 KB | 30 KB |
| Real synopsis (400 to 1,000 characters) and credits | 1.2 to 2 KB | 120 to 200 KB |
| Real metadata plus a stored fingerprint (`prediction_only`, 2 to 4 KB each) | 3.5 to 6 KB | 350 to 600 KB |

At roughly 3.5 to 4 characters per token, 150 KB is about 40,000 tokens and 450 KB about 115,000 to 130,000. The last row is probably unusable as one tool result. This is why the contract bounds the whole serialized response by `maxManifestBytes` and, when 100 selected films do not fit, refuses (`manifest_too_large`) instead of shortening the manifest or any film (D1); it drops null fields. An initial 160 KiB is an unverified refusal guard, not proof that 100 films fit. Whether the ChatGPT connector truncates or rejects a large tool result is **not known**.

## 3. Worker work of one `batch_start`

The v5 `next` reads a fingerprint and a prediction state for every selected film (AIR-438: 2 operations per selected film, plus 31 fixed). A 100-film manifest therefore makes about 31 + 200 reads, plus the by-id admission read (chunks of 80, so 2 chunks), plus the lease, run and queue operations of a start. Cloudflare documents (12 November 2026): Workers Paid allows **10,000 subrequests per invocation** by default (up to 10 million, and subrequests to Cloudflare services such as R2 and D1 count), and a default **30 s of CPU per invocation** (up to 5 minutes; waiting on I/O is not CPU). Production CPU per v5 step on 11 November 2026 was 0.4 to 1.6 s ([AIR-441 evidence](air-441-d1-round-trips-2026-11-11.md)); the CPU of parsing and serializing a 100-film manifest and a 900 KB stored queue is **not measured**. Wall time is bounded by the slowest sequential D1 calls: v5 `next` took 16 to 60 s on 11 November. The contract's reads can run in parallel by film, so a 100-film start is not assumed to take 100 times a one-film start. Open decision D4 (`callBudgetMs`).

## 4. `batch_submit` of 10 items

AIR-438: 21 calls and about 107 KB per additional item on the R2 stand-in (a view-index merge and film writes per item), with 20 fixed calls. v2 advances the queue once per call and writes the view index per item as v5 does after the AIR-442 change, so a 10-item call is about 20 + 10 x 21 = 230 R2 calls offline, 230 being the offline `submit` measurement for 10 items in the AIR-438 table; D1 calls are additional and unmeasured. This is below the 10,000 limit by a wide margin; the binding constraints are wall time (`callBudgetMs`) and the 64 KiB body, not the subrequest count.

## 5. Lease and heartbeat

The runner lease is 15 minutes (`RUNNER_LEASE_TTL`), renewed by every `batch_submit` (as every v5 step) and by `prediction_heartbeat`. At `generationSize` 10 a model call may last several minutes; the existing rule (renew by heartbeat before long calls and at most every 10 minutes) is unchanged. A crashed caller is replaced after lease expiry. Two executions that overlap get `already_running` and stop; one never adopts the other's `runId`. Monitoring reads a v2 run like any run (status, diagnostics, Events footer); nothing is added to monitoring.

## 6. What would replace the estimates (each needs separate owner approval)

1. A read-only dry-run `batch_start` (no lease, no write) reporting `manifestBytes`, `manifestFilms`, the Worker's `wallMs`/`busyMs` and the platform `cpuTimeMs` for the invocation.
2. A dry-run `batch_submit` of 10 real fingerprints with `evidence` for the body size and the step timing line.
3. The tool-result size at which the ChatGPT connector truncates or rejects a result.
4. The A/B dry run (sizes 1 to 10, the same 100 films) for validation failure rate and prediction agreement against a g=1 baseline.

## 7. Not known

Model quality for several films per answer; real manifest bytes and tokens; production CPU and wall of a 100-film start and a 10-item submit; connector result-size behavior; the live Scheduled Task prompt text.
