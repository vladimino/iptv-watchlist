# Experimental MCP endpoint

Worker `iptv` serves a remote MCP server at `https://iptv.vladimino.workers.dev/mcp`. Cloudflare Access application `IPTV MCP` authenticates every request with Managed OAuth, and the Worker verifies the signed Access JWT. The same endpoint exposes two connection probes and a narrow set of EPG and prediction tools. Those tools call the existing Worker functions. They do not accept a URL, an R2 key, or an API path, and they do not generate fingerprints or predictions: ChatGPT does that and submits the result.

Publishing this Worker does not start sync or prediction and does not enable Scheduled Tasks. A tool writes to R2 only when an authorized caller invokes it. Enabling the two production tasks is [AIR-62](https://trello.com/c/CU71gW4c), after the lease check in [docs/deployment.md](deployment.md). The isolated production write/read/cleanup test is still a separate approved operation; `probe_echo` does not replace it.

The endpoint lives in the existing Worker. There is no second Worker, no new binding, no Durable Object, and no KV namespace.

## Architecture

```text
ChatGPT (custom MCP server, OAuth)
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

`probe_read` and `probe_echo` do not read or write R2. Every other tool returns `structuredContent.httpStatus` plus the JSON body of the existing HTTP contract. `httpStatus` 409 is a runner result, not a transport failure: `already_running` means stop and do not adopt that `runId`. `400`, `404`, `503`, and `5xx` set `isError`.

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
| `epg_sync_start` | yes | `POST /api/sync/start`. No arguments. |
| `epg_sync_step` | yes | One `POST /api/sync/metadata` or `POST /api/sync/epg` for the given `runId`. A completed EPG step schedules the AIR-60 continuation internally. |
| `prediction_start` | yes | `POST /api/enrichment/start` with `scope: watchlist_all` and `mode: queued`. `trigger` is `scheduled` or `manual`. |
| `prediction_next` | yes | `POST /api/enrichment/next` with `batchSize: 1`. |
| `prediction_submit` | yes | `POST /api/enrichment/submit` for exactly one film. The Worker validates the fingerprint and prediction. |
| `prediction_heartbeat` | yes | `POST /api/enrichment/heartbeat` |
| `prediction_complete` | yes | `POST /api/enrichment/complete` |

Prerequisite for every tool is [AIR-58](https://trello.com/c/BB01YN2f) (this Access check). `epg_sync_step` depends on [AIR-60](https://trello.com/c/UO0YqoWw) for resolver continuation. [AIR-62](https://trello.com/c/CU71gW4c) is the downstream decision to run the scheduled tasks. [AIR-49](https://trello.com/c/YNaLFwtW) (D1) is independent and unused here.

Write tools are annotated `readOnlyHint: false`. `enrichment_status` is too, because the HTTP status route can persist a recovered stop event. `epg_sync_start` and `epg_sync_step` are `openWorldHint: true` because they fetch Letterboxd, the configured EPG source, or TMDB. A wrong argument returns a tool result with `isError: true` and does not call the domain function. An unknown tool returns JSON-RPC error `-32602`. The response never contains the caller's identity.

The caller repeats `epg_sync_step` until `stage` is `complete`, and repeats `prediction_next` / `prediction_submit` until the runner returns `mustComplete` or the queue is empty. One MCP call is one existing step. ChatGPT generates the fingerprint and prediction; the Worker only validates and stores them.

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
2. **Redirect URI for dynamic client registration.** ChatGPT registers itself through DCR. Access accepts only redirect URIs on the Managed OAuth allow-list (Advanced settings → Allowed redirect URIs). Add the exact callback that ChatGPT shows in the connector form. It is either `https://chatgpt.com/connector/oauth/<callback_id>`, or `https://chatgpt.com/connector_platform_oauth_redirect` when the authorization server advertises RFC 9207 issuer identification (`authorization_response_iss_parameter_supported: true`). Prefer the exact URI to a `/*` wildcard. Without this entry, registration or the authorization redirect fails.
3. **RFC 8707 resource indicator.** Access Managed OAuth rejects `/authorize` without `resource` (`invalid_target`). ChatGPT sends the `resource` value from the protected-resource metadata on both the authorization and token requests. That value must be exactly `https://iptv.vladimino.workers.dev/mcp`, with no trailing slash, and the ChatGPT server URL must be the same string.
4. **Discovery reachability on a path-scoped application.** `IPTV MCP` covers only `/mcp`, while `All Workers` covers the rest of the hostname, including `/.well-known/*`. Cloudflare documents that Access serves the challenge and `/.well-known/oauth-authorization-server` for a Managed OAuth application. It does not document which application answers well-known URLs outside the protected path. The 401 challenge must point to metadata that Access serves without an `All Workers` login redirect. Verify this with step 1 of the procedure below. If any discovery URL returns an HTML login page or a `302`, discovery is blocked. Stop and choose a fix with the owner. Possible options, each needing approval and a check against current Cloudflare documentation: an additional `IPTV MCP` destination for the metadata path, or a dedicated hostname for the same Worker that `IPTV MCP` covers entirely.
5. **Authorization-server metadata.** It must include `registration_endpoint`, `code_challenge_methods_supported` with `S256`, and `token_endpoint_auth_methods_supported` with `none`. If it does not advertise `client_id_metadata_document_supported`, choose DCR in ChatGPT, not CIMD.

## Connecting ChatGPT

Prerequisites: this change is merged and deployed, both variables are set, and every Access requirement above is confirmed.

1. In ChatGPT on the web, add a custom MCP server ([OpenAI guide](https://developers.openai.com/api/docs/guides/custom-mcp-server)). The workspace must allow custom MCP servers.
2. Server URL: `https://iptv.vladimino.workers.dev/mcp`. Authentication: OAuth. Leave the client ID and secret empty so ChatGPT uses dynamic client registration.
3. Copy the callback URL shown in the form. The owner adds it to the `IPTV MCP` Allowed redirect URIs (requirement 2) before continuing.
4. Create the server and sign in through the Cloudflare Access page with the owner identity.
5. Refresh the tools. The list must be exactly `probe_read`, `probe_echo`, `epg_status`, `epg_pipeline_status`, `enrichment_schema`, `enrichment_profile`, `enrichment_runner`, `enrichment_queue`, `enrichment_status`, `epg_sync_start`, `epg_sync_step`, `prediction_start`, `prediction_next`, `prediction_submit`, `prediction_heartbeat`, and `prediction_complete`.

## Safe verification procedure

These checks contact production only through Cloudflare Access and the two probes. None of them reaches R2. Run them only with the owner's approval. Never paste tokens, JWTs, or cookies into logs, issues, or chats.

0. Local: `npm ci`, `npm test`, `npm run build`.
1. Unauthenticated discovery. Access answers these requests; they never reach Worker code.

   ```bash
   curl -sS -o /dev/null -D - -X POST https://iptv.vladimino.workers.dev/mcp \
     -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
     --data '{"jsonrpc":"2.0","id":1,"method":"ping"}'
   ```

   Expect `401` with `WWW-Authenticate: Bearer … resource_metadata="…"`. Fetch that `resource_metadata` URL with `curl -sS`: expect JSON whose `resource` is exactly `https://iptv.vladimino.workers.dev/mcp` and which lists `authorization_servers`. Fetch `<issuer>/.well-known/oauth-authorization-server` for that issuer and check requirement 5. Record whether `authorization_response_iss_parameter_supported` is `true`. Any HTML, `302`, or `403` here means discovery is blocked (requirement 4). Stop.
2. Connect ChatGPT as described above.
3. In a chat, ask ChatGPT to call `probe_read` from this server. Expect `status: ok`, `storage: not_accessed`, `sideEffects: none`.
4. Ask it to call `probe_echo` with a marker such as `mcp-probe-2026-10-19`. Expect the identical text back.
5. Repeat step 1. The unauthenticated request must still get `401` from Access.

Leave Scheduled Tasks and the EPG and prediction tools out of this smoke test. Calling `epg_sync_start`, `epg_sync_step`, or any `prediction_*` tool against production writes R2 and may call Letterboxd, the EPG source, or TMDB. That is an AIR-62 operation and needs its own approval. Do not use `/api/*` routes, the dashboard, sync, enrichment, or prediction as MCP checks either. Some `GET` routes can write (see `README.md`).

## Next stage: unattended Scheduled Tasks

The goal of this integration is unattended ChatGPT Scheduled Tasks that call the Worker. This change proves only the interactive connection. Scheduled Tasks stay disabled. Creating or enabling any task, even a probe-only one, is a separate change that needs approval. A probe-only task does not resume sync or prediction. Before any writer resumes, the lease check in [docs/deployment.md](deployment.md) still applies.

Acceptance criteria, checked after the safe verification procedure passes:

1. A dedicated probe-only Scheduled Task calls `probe_read`, then `probe_echo` with a per-run marker such as the run timestamp. Several consecutive real scheduled runs return matching results, with no confirmation prompt and no sign-in.
2. The runs span longer than the Access token lifetime. ChatGPT must then renew the access token with its refresh token, unattended. Access re-evaluates the `IPTV MCP` policy on every refresh.
3. Throughout the same period, an anonymous request (procedure step 1) still gets `401` from Access.
4. Revocation, with separate approval: remove the owner from the `IPTV MCP` policy or revoke the owner's Access sessions. Once the current access token expires, the next scheduled run must fail to authorize. Restoring access must require a new interactive sign-in. Also record what happens when the grant session expires.
5. Disable or delete the probe tasks afterwards unless their continued schedule is approved.

`probe_echo` proves an authenticated MCP HTTP POST round trip. It does not prove a write to storage followed by a read back. To close the unattended-authorization task, a separate write, read, and cleanup test is needed. It must target an isolated temporary key, for example under a dedicated prefix, clean up explicitly, and leave production state untouched. That test needs its own design and approval. A key in bucket `iptv` is still a production R2 write, and this change adds no such tool.

## Limitations

- Probe tools do not touch R2. The EPG and prediction tools can, and only when an authorized caller invokes them. Exercising those tools on production, including an isolated write/read/cleanup, needs its own approval. Enabling Scheduled Tasks is AIR-62.
- No SSE, sessions, server-to-client requests, `list_changed` notifications, resources, prompts, or batches. Clients that support only `2026-07-28` are not supported.
- The origin allow-list is fixed in code: the Worker's own origin and `https://chatgpt.com`.
- Managed OAuth is in open beta. The end-to-end flow between ChatGPT and Access has not been exercised from this repository, because no production requests were made. Treat the safe verification procedure as the acceptance test for the interactive connection, and the next-stage criteria as the acceptance test for unattended runs.
- The first request after a cold start fetches Access signing keys from the team domain. If they are unreachable, the endpoint returns `503`.

## Rollback

Revert the change on `main` and let GitHub Actions deploy it; `/mcp` then returns the generic `404`. Removing the two variables makes `/mcp` return `503` immediately, which also requires approval because it publishes a version. Disabling `IPTV MCP` is an Access change and needs approval. It leaves `/mcp` closed (see Authorization). None of these steps touches R2 or Scheduled Tasks.
