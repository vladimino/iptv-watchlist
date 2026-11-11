# AIR-438: where a prediction `next` and `submit` spend their time, and which batch size can raise throughput

**Captured:** 11 November 2026 (UTC). **Method:** code reading of `main` at `d84e5c5`, an inert timing instrument added by this change, an offline profile of the real Worker code on an in-memory R2, and read-only production reads (`enrichment_status`, `enrichment_queue`, `prediction_queue_overview`, `enrichment_runner`, `enrichment_profile`, Workers Observability through the Cloudflare API connector). No prediction run, Scheduled Task, flag, lease or writer was touched.

This record decides nothing. It supports one next card (section 7). Production telemetry from the instrument does not exist yet: the Worker that logs it is not deployed when this is written, so every statement about *production* milliseconds below comes from the earlier [AIR-437 RCA](https://trello.com/c/70fpQ40J) reads, and every statement about *storage calls and bytes* comes from the offline profile.

## 1. What the instrument is

Each `next` and `submit` writes one log line `prediction_step_timing` ([contract](../../reference/api/prediction-runner.md#step-timing-line-air-438)). The Worker's environment is replaced for the length of the step by a copy whose R2 bucket and D1 database time every call and forward it unchanged. No call is added, reordered, retried or awaited differently, and a failure of the timing code is swallowed. [`tests/prediction-step-timing.mjs`](../../../tests/prediction-step-timing.mjs) proves:

- the same scripted run with the instrument, without it, and with a logger that throws gives the same answers, the same stored records and the same R2 calls;
- the calls counted in the lines are exactly the calls the steps made;
- calls in parallel are a union (`busyMs`), not a sum, the overlap is reported, and the rest of the wall time is `unattributedMs`;
- the line holds no film id, key, SQL text, body or model output, and its R2 class vocabulary is closed while a D1 class is a table name read from static SQL text, bounded to 60 characters and 40 classes;
- the overhead of the bucket wrapper is about 5 to 10 microseconds per timed `get` plus body read in an in-memory harness (0.0057 to 0.0069 ms against 0.0016 to 0.0017 ms without it, across runs); the D1 wrapper and the object proxy were not benchmarked.

What it cannot see: CPU time (not available inside the Worker without a call; and because the Workers clock may advance only across I/O, synchronous compute may read as close to zero, so `unattributedMs` is awaits and scheduling and may understate compute until the first production lines show otherwise), the bytes of a streamed body, the time a D1 statement spends inside D1 (only its round trip), and anything the caller does between calls.

## 2. The exact chain that fixes the batch sizes

There are three different batch sizes, and today they are 12 (5 for a cold-only backlog), 1 and 1.

| Size | Where it is decided | Value in production |
| --- | --- | --- |
| **Selection batch S**: films a run selects and keeps | `MAX_PREDICTION_BATCH = 20` (`src/enrichment.js`); `adaptivePredictionBatch` gives the backlog itself up to 4, 8 up to 15, 12 under 100, else 20, then `min(size, usageCap)` where `usageCap` is **12 when `capacity.remainingPercent` is unknown**, 4, 8 or 20 by usage, and **at most 5 while no hot film is outstanding** (a cold-only backlog); `start` takes `min(plan, body.batchSize)` and ignores `batchSize: 4` from a scheduled trigger; `start` refuses `batchSize` above 20 | **12 while hot films are outstanding** (5 for a cold-only backlog): the runs read on 11 November report `adaptivePlan.reason = backlog_usage_unknown_conservative_cap_12`, `usageKnown: false`; that reason string stays the same when the cold-only cap lowers the size to 5 |
| **Next request r**: items one `next` hands to the model | HTTP `next` accepts `batchSize` 1 to 20; the MCP tool `prediction_next` always sends `batchSize: 1` (`src/mcp.js`) | **1** |
| **Submit batch s**: items one `submit` takes | HTTP `submit` accepts 1 to 10 items; the MCP tool `prediction_submit` accepts exactly one (`src/mcp.js`) | **1** |
| Model generation batch g | `enrichment_runner` publishes `modelBatching: {enabled: false, readyFingerprintsPerCall: 1}`; the runner contract and the hourly prompt require `prediction_validate` on each film's exact objects before its submit | **1** |

So one film costs one `next`, one `prediction_validate`, one `submit`, whatever S is. The live Scheduled Task prompt is not readable by this session; the repository's [operational contract](../../reference/scheduled-tasks.md#hourly-predictions) is the source for what it requires.

## 3. Offline profile: what a step asks of storage

`node scripts/prediction-batch-profile.mjs` runs `start`, `next` and `submit` through the real Worker code with the instrument and prints counts and bytes (call counts repeat exactly; byte sizes repeat to within a few bytes, from the length of timestamps). It runs on an **R2 stand-in with no D1**. Production routes the published programme and the prediction-domain tables through D1; those calls are not in these counts and are what production telemetry must measure.

**Storage calls and R2 bytes per step, one item, 130-film queue:**

| Selection S | `next` calls | `next` R2 bytes | `submit` calls | `submit` R2 bytes |
| --- | --- | --- | --- | --- |
| 1 | 33 | 133,839 | 41 | 178,927 |
| 5 | 41 | 136,235 | 41 | 181,042 |
| 10 | 51 | 139,237 | 41 | 183,692 |
| 12 | 55 | 140,435 | 41 | 184,750 |
| 20 | 71 | 145,227 | 41 | 188,982 |

- **`next` costs 31 fixed calls and 2 more per selected film** (a fingerprint and a prediction read for every film of the selection, at every step; fit exact, residual 0). `submit` does not depend on S.
- **A fixed step is already heavy:** at S=12 a `next` makes 8 lease operations, 5 run-record, 2 latest-run, 3 queue and 9 further calls (run diagnostics and events among them); a `submit` makes 9 lease, 4 run-record, 4 queue and 4 view-index operations plus the film writes.
- **The stored queue moves whole, several times per step, and its size follows the number of films, not the batch** (S=12, r=1, s=1):

| Films in the queue | `next` queue bytes | `submit` queue bytes | Calls (unchanged) |
| --- | --- | --- | --- |
| 130 | 110,607 | 147,249 | 55 / 41 |
| 1,000 | 828,375 | 1,104,272 | 55 / 41 |
| 3,000 | 2,478,375 | 3,304,273 | 55 / 41 |
| 9,257 (a synthetic queue at the production film count, not an observed production payload) | 7,642,296 | 10,189,501 | 55 / 41 |

About 830 bytes per film **on this fixture** (130 films on an R2 stand-in, extrapolated linearly; 9,257 films gives 7.6 and 10.2 MB). That is an extrapolation, not a production measurement. Production stores the queue under a budget of 900,000 characters (`PREDICTION_QUEUE_CHARS`, `dict1`-encoded above it), so the document read from D1 is at most about 0.9 MB on the wire per move; the in-memory document the Worker parses and writes back is larger. What the code does is move the whole document three to four times per step; what that costs in Cloudflare milliseconds is not known until production telemetry exists.
- **Items that share a step share its fixed cost** (3,000-film queue, S=12, next r=10, submit of s items):

| s | `submit` calls | `submit` bytes | Calls per film (`next` + `submit`) | Bytes per film |
| --- | --- | --- | --- | --- |
| 1 | 41 | 3,341,803 | 96 | 5,850,033 |
| 5 | 125 | 6,817,323 | 36 | 1,865,111 |
| 10 | 230 | 11,392,668 | 29 | 1,390,090 |

A `submit` of one item is 49 % fixed in calls (20 of 41) and 73 % in bytes; each added item costs 21 calls and, at the 130-film queue, 107 KB (view-index merge and film writes per item). A `next` makes the same number of calls for 1 item as for 20 (r does not change them).

**Selection beyond 20.** `start` refuses it, so 50, 100 and 500 cannot be executed. The measured line extrapolates to `next` calls of 131, 231 and 1,031 and nothing for `submit`. Whether a Worker invocation may issue that many concurrent storage calls (Cloudflare documents per-invocation subrequest and connection limits; they were not tested here) is unknown. The extrapolation is a line through five measured points, not an execution.

## 4. Production observations the model is checked against

From the AIR-437 reads (runner status and Workers Observability, 11 November 2026):

| Run (UTC) | Worker version | `next` wall | `submit` wall | CPU per step | Cycle per film |
| --- | --- | --- | --- | --- | --- |
| `6ad5062e` 07:01–07:27 | `89864acf` | 16 s | 18–20 s | 0.5–1.4 s | 70–75 s (about 49 films/h) |
| `3bfcac84` from 08:19 | `de2ca3b3` | 40–60 s | 40–44 s | 0.5–0.8 s | 120–130 s (about 28 films/h) |

Between the caller's `next` answer and its `submit` request lie 28–34 s of model generation, `prediction_validate` and tool-call handshakes; no `POST /mcp` of the 07:05–07:25 window other than `next`/`submit` lasted over 3 s except one of 9.7 s, so validate is bounded above by a few seconds per call but is not measured separately.

## 5. Throughput model (assumptions named, not measured)

`scripts/prediction-batch-profile.mjs` holds the model (`SCENARIOS`, `filmsPerActiveHour`). The model is **calibrated** on the two observed regimes (its `Wn0`, `Ws0` and the 24 s model time come from them), so its agreement with them (about 29 films/h in the slow regime against 28 observed, 54 in the fast regime against 49) is a consistency check, not a validation; `tests/prediction-batch-profile.mjs` keeps it within 15 % of them. Every other row is a scenario analysis with invented multipliers (`m`, the `nScale` rule, the fixed share `f`), not a predictor, and `g` is set equal to `r` (the number of items one `next` hands out).

Per film: `T = m*G + o*(1/g + 1 + 1/s) + Wn(S)/g + Ws(s)/s`, with model time `G = 24 s` per film, `m` its multiplier for a batched call (0.8 best, 1.0 likely, 1.1 worst: a shared prompt may shorten it, longer outputs lengthen it), tool-call overhead `o` of 4 s (6 s worst), `Wn` the `next` wall scaled by the selection batch (best: the film reads run fully in parallel and cost nothing; worst: proportional to the 31 + 2S calls), and `Ws` the `submit` wall with the fixed share measured in section 3. Regimes: best uses the fast walls (16 and 19 s), likely and worst the slow ones (45 and 43 s).

**Films per active hour** (a run that is working; per *scheduled* hour multiply by the share of the hour in which a run works, which is not yet measured after AIR-431 and is at most 1):

| Configuration | Best | Likely | Worst |
| --- | --- | --- | --- |
| today: S=12, g=1, s=1 | 54 | 29 | 27 |
| S=20, g=1, s=1 | 54 | 28 | 25 |
| S=20, g=2, s=2 | 76 | 41 | 36 |
| S=20, g=5, s=5 | 100 | 58 | 50 |
| S=20, g=10, s=10 | 112 | 67 | 57 |
| S=50, g=10, s=10 (not accepted by `start`) | 112 | 64 | 53 |
| S=100, g=10, s=10 (not accepted) | 112 | 60 | 47 |
| S=500, g=10, s=10 (not accepted) | 112 | 39 | 25 |

Calls per film fall from 96 to 29 and bytes per film by a factor of 4 between s=1 and s=10 on the stored-queue fixture. Tokens: the answer of every `next` carries the whole taste profile (about 12.5 KB of text, from `enrichment_profile`; the token count was not measured) plus the metadata of its items, so batching r films per `next` pays the profile once per r films instead of once per film. Cost per film for a model call that generates several films is not estimated: no model data exists.

**What the matrix shows.** Raising the selection batch alone does nothing for throughput and, beyond what `next` reads in parallel, lowers it: the measured per-film storage reads grow with S. The lever is sharing a `next` and a `submit` among several films, and even at the largest sizes the model tries (g=10 and s=10 on S=20; the HTTP contract allows r up to 20 and s up to 10) it gives 57 to 112 films per active hour, not 100 or more with confidence. A figure above 100 per hour needs the best-case assumptions on every line. This is not an SLA.

## 6. Risks of batching, by dimension

- **Partial failure and replay.** With g films in a model call and an interrupted caller, up to g films of model work are lost and the run keeps no checkpoint for them. Small submit chunks inside a larger generation batch keep the checkpoint: submit each film (or chunks of at most five) as soon as it validates; the Worker already submits idempotently (`already_current`, per-film `retryable_failure`).
- **Validate.** `prediction_validate` stays per film on the exact object that will be submitted; a batched model call returns g objects and g validate calls. The model's quality when it writes several films in one answer is **not known**; no model run was made.
- **Hot urgency and fairness.** `next` fills free slots from the queue before each step, but films already selected stay in the batch until submitted. At 70–130 s per film a selection of 500 holds a film for 10–18 hours; urgent films that arrive in that time (rank 0 expires within 24 h) wait. The measured `next` cost grows with S for no benefit.
- **Lease.** 15-minute TTL renewed by heartbeat and by checkpoints; one step takes seconds to a minute, so a larger batch does not threaten the lease unless a single model call outlasts 10 minutes (the contract already requires a concurrent renewal).
- **Payload.** A `next` answer of 20 items is 12,421 bytes in the fixture (profile excluded from growth: 300 bytes per item); a 10-item `submit` request is 11,173 bytes. Neither is near an HTTP limit; context and output token limits of the model for g films in one answer were not measured.
- **Queue and view-index writes.** Each item of a `submit` re-reads and rewrites the view index (4 operations per item in the fixture) and each step moves the stored queue; both are compare-and-swap protected and unchanged by the instrument. A larger `submit` raises the window in which a competing writer can conflict (up to five attempts per write).
- **Profile or programme change between batches.** `next` and `submit` already check the profile hash and the runner contract on every call and answer 409; a longer batch only lengthens the window.

## 7. Recommendation

1. **Keep `selectionBatchSize` at the plan's value (12 while usage is unknown and hot films are outstanding, 5 for a cold-only backlog, at most 20) and do not raise it.** It does not raise throughput and each film in it adds two storage reads to every `next`.
2. **Introduce `modelGenerationBatchSize` and `submitBatchSize` as two separate parameters, starting at 1 and 1.** The measured fixed cost per step makes sharing the lever; the unknown is model quality, so the first change is a *controlled quality experiment* with g=2 and s=2 against a paired baseline, validate per film unchanged, not a switch. Cap `submitBatchSize` at 5 so a crash loses at most five films of checkpoint.
3. **Separately from batching, the stored queue (and the view index) are candidates for not moving whole through every step.** On the fixture this is the largest fixed cost the offline profile found, and it is independent of any batch size; whether it is the largest in production (where the stored queue is at most about 0.9 MB encoded) is a hypothesis for the telemetry below to confirm or reject. A card that reads the queue once per step and avoids the per-item view-index rewrite would have the smallest effect on the model's behaviour; its expected effect per film is not established.
4. **Next atomic card (offline, owner approval for any contract change):** after two natural runs have produced `prediction_step_timing` lines, decide between (a) reducing whole-document movement per step, (b) exposing `submitBatchSize` up to 5 in `prediction_submit` and `batchSize` in `prediction_next`. The contract change in (b) alters the runner contract and the hourly prompt and needs the owner's decision and likely an ADR.

## 8. Telemetry gate (not passed)

The acceptance of AIR-438 requires at least two natural Prediction runs after the deploy, read without starting anything, with p50 and p95 of the stages of `next` and `submit` by deploy version and batch size. This record cannot state them. The query:

```
POST /accounts/{id}/workers/observability/telemetry/query   (read only)
needle: "prediction_step_timing", timeframe: since the deploy, filters: service = iptv
```

Group by `step`, `$workers.scriptVersion.id`, `notes.items`/`notes.selected`, and take p50 and p95 of `wallMs`, `busyMs`, `unattributedMs`, `r2.busyMs`, `d1.busyMs` and of `classes.<class>.ms`. The card moves to Verification with this gate named until it is read.

## 9. Not known

D1-routed read and write costs per step in production; the split of wall time between the whole-queue document, the view index and the leases; CPU per stage; the model time per film and its dependence on batch size; the quality of a multi-film answer; Cloudflare's per-invocation call limits at selection batches above 20; the live Scheduled Task prompt text.
