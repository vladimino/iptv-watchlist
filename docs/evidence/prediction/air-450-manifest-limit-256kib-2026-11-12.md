# AIR-450 batch_start manifest ceiling: 160 KiB to 256 KiB (12 Nov 2026)

**Status: measured and owner-approved change of one constant. No production operation is part of this page.** The change raises `BATCH_RUNNER.maxManifestBytes` of the whole serialized `batch_start` answer from 160 KiB (163,840) to 256 KiB (262,144). It is the D1 adjustment [ADR 0122](../../adr/0122-prediction-batch-runner-v2-dual-protocol.md) reserved for the owner after a measurement ([addendum](../../adr/0122-prediction-batch-runner-v2-dual-protocol.md#addendum-2026-11-12-manifest-ceiling-raised-to-256-kib-air-450)). Everything else is unchanged: `maxManifestFilms` 100, the compact-1 manifest, `pin` and snapshot rules, the queue, the lease, D1/R2 authority, `batch_submit` 1 to 10 items, the 56 KiB submit guidance and the 64 KiB inbound MCP limit. There is no feature flag and no automatic shortening, skipping or replacing of films: an answer over the new ceiling is still `409 manifest_too_large`.

## Why

An owner-run bounded canary of AIR-450 (12 Nov 2026, Madrid) made one read-only `prediction_batch_start(dryRun, pin: 100 eligible ids)` and got `409 manifest_too_large` with `bytes` 239,968, `limit` 163,840, `films` 100, `largestFilmBytes` 3,265. The sample was not shortened or replaced, no start was repeated, nothing was frozen, submitted or generated, and nothing was written. At 256 KiB that same answer fits with 22,176 bytes to spare. The AIR-447 offline fixture of 100 `prediction_only` films with stored fingerprints (253,499 bytes) fits with 8,645 bytes to spare, so 100 larger fingerprints can still be refused, as the fail-closed contract intends. No film id, manifest, profile, fingerprint or prediction appears on this page.

## What the ceiling means on the wire

Measured offline on the real Worker code and MCP handler (`mcpCallTool`) with 100 synthetic films over a sqlite D1 stand-in and an in-memory R2 (`flowWorld`); synopsis lengths chosen to land in the range of the canary, with quote characters so the escaping is exercised:

| Answer (HTTP body of `batch_start`) | Same answer as an MCP `tools/call` result (JSON-RPC body) | Ratio |
| --- | --- | --- |
| 198,422 bytes | 415,912 bytes | 2.10 |
| 240,222 bytes | 503,112 bytes | 2.09 |
| 250,622 bytes | 524,712 bytes | 2.09 |

The factor is the existing result shape of `mcpPayload` in `src/mcp.js`: the same payload is sent once as the `text` content (a JSON string, so every quote and backslash is escaped) and once as `structuredContent`. A manifest at the ceiling (262,144) is therefore about 550 KB on the MCP wire. That shape is not changed here (the handoff keeps the transport as is). It is also why a client that feeds only one of the two parts to the model sees about half of these bytes.

## Platform limits checked

- **Cloudflare Workers.** The [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) state "Response body size: No enforced limit" (the CDN cache limits do not apply to this uncached `POST`), 128 MB memory per Worker and, for HTTP requests, 30 s CPU by default. A 256 KiB answer, built once by `JSON.stringify` of an object already in memory, is far inside all three. No Cloudflare limit below 256 KiB was found.
- **The inbound MCP request limit** (64 KiB, `413` before any processing) concerns the request, not a tool result, and is unchanged. `batch_start` takes a small request; `batch_submit` keeps its 56 KiB group guidance.
- **The ChatGPT connector and model context are not documented here and were not measured.** There is no published hard limit for an MCP tool result in that client, and an absent explicit limit is not a guarantee. Whether a result of 240 to 262 KB reaches the model intact, and what it costs in context, is **unproven** until a real owner-approved freeze answers (the AIR-446 estimate of 3.5 to 4 characters per token puts 250 KB at roughly 65,000 to 70,000 tokens if only the `text` part is used). Nothing was bypassed and no tool result was truncated in this change; if a later freeze finds a client-side limit below the ceiling, that is a new blocker for the owner, not something this change hides.

## Verification (offline, in the repository)

`tests/prediction-batch-start.mjs`: the advertised limits are 262,144; a 100-film answer between 163,840 and 262,144 bytes is delivered whole (profile, contract with its schema, every film's metadata unshortened, hash) by the dry run and by the real start with the same films in the same order, and the dry run writes nothing (D1 dump and every R2 object unchanged); an answer of exactly 262,144 bytes is delivered and one of 262,145 is `409 manifest_too_large` with `bytes` 262,145 and `limit` 262,144; an answer over the ceiling refuses with the same code and the new limit and writes nothing (queue, run, lease, film, Events), also for a dry run with a 100-id pin; a single film over the ceiling is refused; the runner contract still says pipeline 5, `maxBatchFilms` 20, model batching off and `batchRunner` with only `maxManifestBytes` changed, and a v5 `start` is not a v2 run.

## Not done here

No production dry-run freeze (the canary's 100-id freeze is **not** repeated), no model generation, no Scheduled Task, no sample or limit change after a further refusal, no feature flag. After review, merge and deploy, only the code blocker is considered fixed, confirmed by a read-only `enrichment_runner` showing `maxManifestBytes` 262,144. A new freeze, any canary and the full A/B each need the owner's own decision.
