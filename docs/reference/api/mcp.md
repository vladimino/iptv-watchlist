# MCP endpoint — transport, tools and security contract

Worker `iptv` serves a remote MCP server at `https://iptv.vladimino.workers.dev/mcp`. Cloudflare Access application `IPTV MCP` authenticates every request with Managed OAuth, and the Worker verifies the signed Access JWT. The same endpoint exposes two connection probes and a narrow set of EPG and prediction tools. Those tools call the existing Worker functions. They do not accept a URL, an R2 key, or an API path, and they do not generate fingerprints or predictions: ChatGPT does that and submits the result.

Publishing this Worker does not start sync or prediction and does not enable Scheduled Tasks. A tool writes to R2 only when an authorized caller invokes it. [AIR-62](https://trello.com/c/CU71gW4c) separately restored the two external ChatGPT Scheduled Tasks on 21 October 2026. A deploy does not control their enablement, and additional writer runs or task changes require separate approval. See [deployment.md](../../runbooks/deployment.md) and check live task state. Any isolated production write/read/cleanup test would require separate explicit approval; `probe_echo` does not replace it.

The endpoint lives in the existing Worker. There is no second Worker, no new binding, no Durable Object, and no KV namespace.

## Architecture

```text
ChatGPT (custom MCP server, OAuth) or Claude (claude.ai custom connector, OAuth)
  -> Cloudflare Access application "IPTV MCP" (path /mcp, Managed OAuth, owner-only policy)
       answers unauthenticated requests itself: 401 challenge, OAuth discovery, DCR, /authorize, /token
  -> Worker "iptv": src/mcp.js
       1. verifies the signed Cf-Access-Jwt-Assertion (signature, issuer, audience, time, identity)
       2. validates the Streamable HTTP request
       3. answers JSON-RPC: initialize, notifications/initialized, ping, tools/list, tools/call
```

`src/worker.js` routes only the exact path `/mcp` to `mcpRoute`. Every other path, including `/mcp/`, keeps its existing behaviour, and `/api/*` is unchanged. Access application `All Workers` still protects all other paths.

### Transport

- Streamable HTTP, single endpoint, `POST` only. Every response is one JSON object (`Content-Type: application/json`). The server never opens an SSE stream.
- Stateless: no `Mcp-Session-Id`. `GET` and `DELETE` return `405` with `Allow: POST`. That is the documented response when a server offers no standalone SSE stream and no sessions.
- Protocol versions `2025-11-25` and `2025-06-18` (the `initialize`-based era). `initialize` echoes a supported requested version and otherwise answers `2025-11-25`. Every later message, including `notifications/initialized` and `ping`, must carry a supported `MCP-Protocol-Version` header. Without sessions, the header is the server's only record of the negotiated version. Under the 2025-11-25 transport rules a missing header means `2025-03-26`, which this server does not support, so it gets `400`. `probe_read` reports the version from that header.
- A `2026-07-28` request (stateless era) gets `400` with JSON-RPC code `-32600`, not the modern `-32022`. Under the MCP backward-compatibility rules, a dual-era client treats that as a legacy server and falls back to `initialize`. A client that supports only `2026-07-28` cannot connect.
- Batches, client-sent JSON-RPC responses, malformed JSON, invalid UTF-8, non-JSON `Content-Type` (`415`), an `Accept` header that excludes JSON (`406`), and bodies over 64 KiB (`413`) are rejected. Notifications get `202` with no body.
- A browser `Origin` header must be the Worker's own origin or `https://chatgpt.com`. Any other origin gets `403`. Server-to-server requests without `Origin` are accepted once the Access JWT is valid.

The protocol is implemented directly in `src/mcp.js` instead of through the MCP TypeScript SDK. The build in `build.mjs` concatenates source files without a bundler or runtime npm dependencies. The SDK would add a bundler, dependencies, and Node compatibility flags to the deploy artifact, all for four JSON-RPC methods. `tests/mcp.mjs` exercises the protocol over real HTTP requests through `worker.fetch`.

### Tools

`probe_read` and `probe_echo` do not read or write R2. `prediction_queue_overview`, `prediction_film_diagnostics`, and `prediction_pending` read a fixed set of stored objects and return that diagnostic with `httpStatus: 200`. They do not call an HTTP route, list storage, or write. Every other tool returns `structuredContent.httpStatus` plus the JSON body of the existing HTTP contract. `400`, `404`, `409`, `503`, and `5xx` set `isError`, and the body stays in `structuredContent` so the caller can still read `Run id mismatch`, `lease_lost`, `busy`, or `Queue not empty`. `already_running` is HTTP 200: stop and do not adopt that `runId`.

| Tool | Writes | What it calls |
| --- | --- | --- |
| `probe_read` | no | Fixed diagnostic report. `storage: not_accessed`. |
| `probe_echo` | no | Returns `text`, 1–200 characters. |
| `epg_status` | no | `GET /api/status` |
| `epg_pipeline_status` | no | `GET /api/enrichment/pipeline/status` |
| `enrichment_schema` | no | `GET /api/enrichment/schema` |
| `enrichment_profile` | no | `GET /api/enrichment/profile` |
| `enrichment_runner` | no | `GET /api/enrichment/runner` |
| `enrichment_queue` | no | `GET /api/enrichment/queue/status` |
| `enrichment_status` | recovery only | `GET /api/enrichment/status`, including an undelivered stop event |
| `prediction_queue_overview` | no | Existing queue, profile, view index, programme, discovered films, and published generation. No HTTP route. See [prediction diagnostics](prediction-diagnostics.md). |
| `prediction_film_diagnostics` | no | The same snapshot plus that film's fingerprint and prediction. No HTTP route. [AIR-98](prediction-diagnostics.md). |
| `prediction_pending` | no | One page of the same queue snapshot. No HTTP route. [AIR-98](prediction-diagnostics.md). |
| `epg_sync_start` | yes | `POST /api/sync/start`. No arguments. |
| `epg_sync_step` | yes | One `POST /api/sync/metadata` or `POST /api/sync/epg` for the given `runId`. After `stage` is `complete`, each call runs one discovery chunk or reports why it did not, and the response carries `diagnostic` (see Continuation diagnostics). |
| `prediction_start` | yes | `POST /api/enrichment/start` with `scope: watchlist_all` and `mode: queued`. `trigger` is `scheduled` or `manual`. |
| `prediction_next` | yes | `POST /api/enrichment/next` with `batchSize: 1`. |
| `prediction_submit` | yes | `POST /api/enrichment/submit` for exactly one film. The Worker validates the fingerprint and prediction. |
| `prediction_heartbeat` | yes | `POST /api/enrichment/heartbeat` |
| `prediction_complete` | yes | `POST /api/enrichment/complete`. Optional `fault` is caller-reported and only valid with an external or systemic `reason`. A normal completion rejects it. See [run diagnostics](run-diagnostics.md). |

All MCP tools require the [Cloudflare Access and Worker JWT validation](#authorization) described below. `epg_sync_step` follows the [discovery continuation contract](#discovery-contract-for-scheduled-tasks). External Scheduled Tasks orchestrate EPG and predictions independently of deployment; D1 is not the authoritative data source for these tools.

Write tools are annotated `readOnlyHint: false`. `enrichment_status` is too, because the HTTP status route can persist a recovered stop event. `epg_sync_start` and `epg_sync_step` are `openWorldHint: true` because they fetch Letterboxd, the configured EPG source, or TMDB. A wrong argument returns a tool result with `isError: true` and does not call the domain function. An unknown tool returns JSON-RPC error `-32602`. The response never contains the caller's identity.

The caller repeats `epg_sync_step` until `stage` is `complete`. It then reads `discovery.nextAction`: `continue` means call `epg_sync_step` again now with the same `runId`; `wait` means do not call before `discovery.nextCatchUpAt`; `stop` means discovery is finished until the next EPG commit. `ratingsPending` does not mean retry Letterboxd; a separate ratings-refresh workflow handles that follow-up. One call is one metadata batch, the EPG commit, or one discovery chunk. A separate request does not guarantee a new isolate. The caller repeats `prediction_next` / `prediction_submit` until the runner returns `mustComplete` or the queue is empty. ChatGPT generates the fingerprint and prediction; the Worker only validates and stores them.

### Discovery contract for Scheduled Tasks

`epg_sync_step` returns this object once the programme commit has happened. The external EPG caller should branch on `nextAction` and not infer it from `ratingsPending` or from `stage` alone.

| `discovery.nextAction` | When | What the caller does |
| --- | --- | --- |
| `continue` | EPG commit (`state: paused`, `reason: epg_committed`, `remainingChunks: 12`), or a chunk finished with candidates and budget left | Call `epg_sync_step` again now with the same `runId` |
| `wait` | `chunk_budget`, `backoff`, `busy`, or `error` before `nextCatchUpAt` | Do not call before `discovery.nextCatchUpAt` |
| `stop` | Backlog finished, programme changed, or nothing to resolve | Do not call until the next EPG commit |

`discovery.state` is `paused`, `running`, `complete`, `error`, or `busy`. A finished response is not left `running`. `remainingChunks` counts chunks still allowed in the current series. The field list and the lease rules are in [ENRICHMENT_API.md](enrichment.md#epg-resolver--hotcold-pipeline-v2).

### Continuation diagnostics

Every `epg_sync_step` that reaches `POST /api/sync/epg`, and every discovery resolve request, is one **step entry** with two channels. The Worker log gets one structured line per phase (`{"event":"epg_continuation", …}`): `entered` before any storage access, then `completed` or `failed`, both with the same `id`. The ring `epg/resolver-continuation-diagnostics.json` (newest first, at most 20) gets the same entry written best effort with `phase: entered` before the step and replaced by the outcome after it. `epg_pipeline_status` returns the stored ring as `continuationDiagnostics`; reading it writes nothing. The log line is the arrival evidence; the ring is a convenience view that can miss an entry (write failure, eviction after 20 later steps), so an absent ring entry means *no persisted evidence*, not *no call*.

| Field | Meaning |
| --- | --- |
| `id`, `at`, `durationMs` | Entry identity, time the step was entered, wall time |
| `phase` | `entered`, `completed` (a response was formed, including 4xx) or `failed` (the handler threw) |
| `caller` | `mcp` (this endpoint), `http` (`/api/sync/*`, `/api/enrichment/discovery/resolve`) or `internal` (`DiscoveryContinuation`) |
| `route`, `runStage` | Route taken (`other` outside the known three) and the server's `sync.json` stage at entry (`metadata`, `epg`, `complete`, `other`) |
| `runId`, `runIdShape` | The caller's `runId` only when it has the server-generated UUID shape, else `null`; `runIdShape` is `uuid`, `invalid` or `null` (not sent) |
| `branch` | `run_mismatch`, `stage_mismatch`, `metadata`, `epg_commit`, `continuation`, `resolve`, `invalid_limit`, `no_programme`, `not_found` |
| `httpStatus`, `error` | HTTP status of the formed response; on a failed step `error.code` (`storage`, `upstream`, `timeout`, `publish_conflict`, `resolver_busy`, `invalid_input`, `unknown`) and `error.name` (built-in error class, else `Error`). The thrown message is classified, never copied |
| `recorded` | Result of the best-effort ring writes: `entered` and `outcome` are `true`, `false`, or `null` when the route is not persisted. The stored entry can only carry `entered`; the final log line carries both |
| `discovery` | The `discovery` contract the response carried: `state`, `nextAction`, `reason`, `remainingChunks`, `programmeRunId`, `nextCatchUpAt`, `retryAt` |
| `diagnostic` | The `advanceDiscovery` trace, also returned in the step response: `branch` (`report_only`, `lease_live`, `contract`, `missing_secret`, `lease_lost`, `chunk`), `entry` (continuation record before), `lease` (`none`, `expired`, `live`), `decision` (`run`, `budget`, `force`, `hardWait`, `nextAction`), `hopId`, `budget`, `chunk` (`stage`, `checked`, `remaining`, `added`, `variantPending`, `retryAt`, `programmeRunId`, `error` as an error code), `saved` (continuation record after, with `owned: false` when another hop had taken the continuation) |

Every string field is drawn from a closed vocabulary: stages and states (`idle`, `paused`, `running`, `complete`, `error`, `busy`, `partial`, `programme_changed`, `awaiting_epg_discovery`, `backoff`, `missing_secret`), `nextAction` (`continue`, `wait`, `stop`), `reason` (`epg_committed`, `scan_committed`, `busy`, `chunk_budget`, `backoff`, `programme_changed`, `idle`, `missing_secret`, `error`, `discovery_failed`); a value outside its list is recorded as `other`, and a `reason` outside the list (an error continuation keeps the thrown message as its reason) is classified into the error codes above. Ids (`runId`, `programmeRunId`, `hopId`) are kept only in UUID shape, times only when they parse, counts only as finite numbers. No tokens, cookies, identities, raw payloads, titles or messages can enter an entry or a log line. The metadata route is logged but not persisted. Recording an outcome does not retry, dispatch or change the resolver; the interpretation table is in [the connectivity runbook](../../runbooks/mcp-connectivity.md#diagnosing-a-stalled-epg-continuation).

## Authorization

Cloudflare Access is the OAuth authorization server and the gate. The Worker issues no OAuth tokens, publishes no protected-resource or authorization-server metadata, and sends no `WWW-Authenticate` header. Cloudflare documents that Managed OAuth replaces the application's `401` behaviour, so a competing challenge from the origin would only confuse clients.

With Managed OAuth, ChatGPT sends an opaque bearer token (`oauth:…`) to Access. Access resolves it to the owner's identity, re-checks the Access policy, and forwards the request with a signed RS256 JWT in `Cf-Access-Jwt-Assertion`. The Worker trusts only that header, after verifying:

- `alg` is `RS256`, and `kid` names a key from `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`. Keys are cached for up to an hour. An unknown `kid` triggers at most one refresh per 30 seconds.
- The RSASSA-PKCS1-v1_5 SHA-256 signature is valid.
- `iss` equals `MCP_ACCESS_TEAM_DOMAIN` exactly.
- `aud` contains `MCP_ACCESS_AUD`, the AUD tag of `IPTV MCP`. A token minted for `All Workers` has a different AUD and is rejected.
- `exp` is present and not past; `nbf` and `iat`, when present, are not in the future. The allowed clock skew is 60 seconds.
- `sub` is a non-empty user identity. Service-token assertions, whose `sub` is empty, are rejected.

The Worker ignores the `CF_Authorization` cookie, `Cf-Access-Authenticated-User-Email` and other identity headers, and the client's own `Authorization` header.

Failures are closed and generic:

| Condition | Response |
| --- | --- |
| `MCP_ACCESS_TEAM_DOMAIN` or `MCP_ACCESS_AUD` missing or malformed | `503`, JSON-RPC `-32603` "MCP authorization is not configured" |
| Signing keys unreachable or unusable | `503`, JSON-RPC `-32603` "Access signing keys are unavailable" |
| Any missing or invalid assertion | `403`, JSON-RPC `-32001` "Forbidden" |

Authorization runs before method, header, and body checks. A caller without a valid assertion learns nothing else about the endpoint. The Worker answers `403` instead of `401`: an assertion mismatch is a server-side configuration problem, and re-running OAuth cannot fix it.

If `IPTV MCP` is disabled or deleted, `/mcp` falls under `All Workers`. That application's JWT carries a different AUD, so the Worker keeps returning `403`.

## Configuration

| Variable | Value | Secret |
| --- | --- | --- |
| `MCP_ACCESS_TEAM_DOMAIN` | `https://<team>.cloudflareaccess.com`, the Zero Trust team domain | No |
| `MCP_ACCESS_AUD` | Application Audience (AUD) tag of Access application `IPTV MCP` (Zero Trust → Access controls → Applications → `IPTV MCP`) | No |

Set both as plain-text variables on Worker `iptv` (Workers & Pages → `iptv` → Settings → Variables and Secrets). They are not committed, following the repository rule that runtime values live in Cloudflare. `wrangler.jsonc` has `keep_vars: true`, so a GitHub deploy keeps dashboard variables. Until both are set, `/mcp` returns `503` behind Access.

Saving a variable publishes a new Worker version. That is a production environment change and needs the owner's explicit approval. No other configuration is involved: the R2 binding `BUCKET` is unchanged, and no secret is added. The probe tools ignore `BUCKET`. The EPG and prediction tools use it only when called.

## Cloudflare Access requirements

This repository change does not modify Cloudflare Access. Each item below must be confirmed by the owner, and any change needs separate approval. Do not add Bypass or Everyone policies, service-token shortcuts, or exceptions to `All Workers` to make discovery work.

1. **`IPTV MCP` application.** Destination `iptv.vladimino.workers.dev/mcp`, owner-only Allow policy, Managed OAuth on. Cloudflare recommends a short access-token lifetime (5–15 minutes) with a longer grant session (1–2 weeks) for agents.
2. **Redirect URI for dynamic client registration.** ChatGPT and Claude register themselves through DCR. Access accepts only redirect URIs on the Managed OAuth allow-list (Advanced settings → Allowed redirect URIs). The working `IPTV MCP` allow-list permits the connected ChatGPT server through the path wildcard `https://chatgpt.com/connector/oauth/*` and, since 25 October 2026, the claude.ai custom connector through `https://claude.ai/api/mcp/auth_callback`. No exact ChatGPT callback was recorded in the UI. An exact callback, `https://chatgpt.com/connector/oauth/<callback_id>` or `https://chatgpt.com/connector_platform_oauth_redirect` when the authorization server advertises RFC 9207 issuer identification (`authorization_response_iss_parameter_supported: true`), is preferable once ChatGPT shows one. Tightening the allow-list is a separate Access change and is not part of this repository change.
3. **RFC 8707 resource indicator.** Access Managed OAuth rejects `/authorize` without `resource` (`invalid_target`). ChatGPT sends the `resource` value from the protected-resource metadata on both the authorization and token requests. That value must be exactly `https://iptv.vladimino.workers.dev/mcp`, with no trailing slash, and the ChatGPT server URL must be the same string.
4. **Discovery reachability on a path-scoped application.** `IPTV MCP` covers only `/mcp`, while `All Workers` covers the rest of the hostname, including `/.well-known/*`. Cloudflare documents that Access serves the challenge and `/.well-known/oauth-authorization-server` for a Managed OAuth application. It does not document which application answers well-known URLs outside the protected path. The 401 challenge must point to metadata that Access serves without an `All Workers` login redirect. Verify this with step 1 of the procedure below. If any discovery URL returns an HTML login page or a `302`, discovery is blocked. Stop and choose a fix with the owner. Possible options, each needing approval and a check against current Cloudflare documentation: an additional `IPTV MCP` destination for the metadata path, or a dedicated hostname for the same Worker that `IPTV MCP` covers entirely.
5. **Authorization-server metadata.** It must include `registration_endpoint`, `code_challenge_methods_supported` with `S256`, and `token_endpoint_auth_methods_supported` with `none`. If it does not advertise `client_id_metadata_document_supported`, choose DCR in ChatGPT, not CIMD.


## Limitations


- Probe tools do not touch R2. The EPG and prediction tools can, and only when an authorized caller invokes them. Exercising those tools on production, including an isolated write/read/cleanup, needs its own approval. Scheduled task rollout was AIR-62; new invocations or modifications need separate approval.
- No SSE, sessions, server-to-client requests, `list_changed` notifications, resources, prompts, or batches. Clients that support only `2026-07-28` are not supported.
- The origin allow-list is fixed in code: the Worker's own origin and `https://chatgpt.com`.
- Initial October 19–20 interactive MCP probes did not establish unattended access. [AIR-62](https://trello.com/c/CU71gW4c) subsequently accepted scheduled EPG/prediction runs on October 21; on October 24 both external recurring tasks remained enabled with recent executions. These dated checks do not prove current OAuth health or unspecified security/revocation test results.
- The first request after a cold start fetches Access signing keys from the team domain. If they are unreachable, the endpoint returns `503`.



For approved operator procedures see [MCP connection and verification](../../runbooks/mcp-connectivity.md), and for the original unattended-authorization checklist see [the AIR-62 historical record](../../archive/superseded/mcp-air-62-checklist.md).
