# AIR-447: size and cost of the batch_start manifest on an offline fixture

**Captured:** 12 November 2026 (UTC). **Method:** (sizes are the size of the whole answer, measured as the Worker measures it before it sends it) the real Worker code (`src/enrichment.js`, `src/mcp.js`) on a sqlite D1 stand-in with the prediction domain in D1 mode and an in-memory R2, driven through `POST /api/enrichment/batch/start`. A throw-away script (not committed) built 100 films with realistic metadata and read the response size and the `prediction_step_timing` line; `tests/prediction-batch-start.mjs` asserts the refusal and the fitting case. **Scope:** offline only. No production read, run, Scheduled Task, flag or write. **Verdict:** supports the owner's decision on the manifest limit ([ADR 0122](../../adr/0122-prediction-batch-runner-v2-dual-protocol.md), D1); it decides nothing and it is not a production measurement.

## 1. Fixture

100 queued hot films. Metadata per film: a synopsis of 912 characters, three genres, six actors, one director, a runtime. The taste profile is the fixture's small one (the production profile is about 12.5 KB of text, [AIR-438 evidence](air-438-step-latency-and-batch-sizing-2026-11-11.md)). The stored fingerprint of the `prediction_only` case is the test fixture's: one plot mechanic, the execution dimensions, two mood labels, one strength and one risk, **no `evidence`**; a production fingerprint with `evidence` is larger. These numbers therefore bound the real manifest from below for the `prediction_only` case.

## 2. Manifest size (compact-1, bytes of the whole JSON response)

| Case | Films | Bytes | Per film | Against `maxManifestBytes` (160 KiB = 163,840) |
| --- | --- | --- | --- | --- |
| `fingerprint_and_prediction` (metadata only) | 100 | 141,205 | about 1.3 KB (the profile, schema and contract are about 11 KB of the total) | **fits** (86 %) |
| `prediction_only` (metadata and the stored fingerprint of the fixture) | 100 | 253,499 | about 2.4 KB (largest film 2,414 bytes) | **refused**, `manifest_too_large` |

For the second case, about 11 KB of fixed parts leave room for about 63 films at 2.4 KB each under 160 KiB. A manifest of 100 `prediction_only` films with real fingerprints would be larger still. The refusal is the contract: nothing is shortened, no run, no lease and no write is created (`tests/prediction-batch-start.mjs` compares the D1 dump and the R2 puts before and after). At roughly 3.5 to 4 characters per token, 141 KB is about 35,000 to 40,000 tokens and 253 KB about 63,000 to 72,000; whether the ChatGPT connector accepts a result of that size is **not known** ([limits analysis](air-446-batch-runner-limits-2026-11-12.md)).

## 3. Calls of one start (offline counts, not wall time in production)

| Case | `wallMs` (offline) | R2 operations | D1 round trips (statements) |
| --- | --- | --- | --- |
| Dry run, 100 films (read-only preflight and manifest) | 254 | 7 | 511 (917) |
| Real start, 100 films (preflight, start guards, lease, revalidation, run record, manifest) | 672 | 48 | 1,081 |

The read of each film's stored state dominates the D1 round trips (about 5 per film; the real start reads the films twice, in the preflight and again in the revalidation after the lease, which is why its round trips are about twice the dry run's). The offline clock includes no network latency, so production wall time cannot be derived from these numbers: 511 sequential round trips at a production D1 latency of several milliseconds would be seconds, and the reads of one chunk run in parallel in the code. Production wall, CPU and D1 cost of a 100-film start are **not measured**. Cloudflare documents (12 November 2026) 10,000 subrequests and 30 s of CPU per invocation by default on the Paid plan; one start makes about 1.1 thousand offline D1 round trips and 51 R2 operations.

## 4. What the numbers say for D1 (manifest limit)

- 160 KiB holds 100 films of metadata-only work with room to spare, and about 63 films when every film carries a stored fingerprint, before the fingerprints grow with `evidence`.
- The Worker refuses rather than shortens, as the contract requires, so a queue that is mostly `prediction_only` work gives `manifest_too_large` at 100 films under this limit and the owner decides: raise `maxManifestBytes`, lower `maxManifestFilms` (the Worker never lowers it by itself), or change the contract. Real `largestFilmBytes` and `bytes` come back in the refusal.
- Any change of the limit is a constant (`BATCH_RUNNER.maxManifestBytes`); it needs its own approval and a production dry-run measurement.

## 5. Not known

Production bytes and tokens of a 100-film manifest with the real profile and fingerprints with `evidence`; production wall, CPU and D1 cost; the connector's tool-result limit; how the model behaves with a 100-film context.
