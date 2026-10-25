# MCP connection, safe probes and recovery

> **Operator procedure — not production authorization.** Never invoke writable MCP tools, change Access, secrets or Scheduled Tasks without an action-specific owner approval. Protocol, tool schemas and trust boundaries: [MCP reference](../reference/api/mcp.md).

## Connecting ChatGPT

The connector is connected. The 19–20 October 2026 `probe_read` and `probe_echo` calls confirmed only interactive Managed OAuth, not unattended refresh or successful production work. [AIR-62](https://trello.com/c/CU71gW4c) subsequently accepted scheduled EPG and prediction operations on 21 October. On 24 October both external recurring tasks were observed enabled with recent execution timestamps. These dated observations do not guarantee today's authorization or job success.

After a new MCP tool deployment, refresh the connected ChatGPT tools if their cached schema is stale. The list must be exactly `probe_read`, `probe_echo`, `epg_status`, `epg_pipeline_status`, `enrichment_schema`, `enrichment_profile`, `enrichment_runner`, `enrichment_queue`, `enrichment_status`, `prediction_queue_overview`, `prediction_film_diagnostics`, `prediction_pending`, `epg_sync_start`, `epg_sync_step`, `prediction_start`, `prediction_next`, `prediction_submit`, `prediction_heartbeat`, and `prediction_complete`. Do not call writer tools against production without action-specific owner approval, even though AIR-62 has been completed. The three prediction diagnostic tools are read-only; the production check for them is the procedure in [AIR-98](../reference/api/prediction-diagnostics.md), after this deploy.

To connect a replacement server, use the same URL and OAuth with an empty client ID and secret, and sign in as the owner. The current allow-list already permits a ChatGPT connector callback under `https://chatgpt.com/connector/oauth/*` (requirement 2).

## Connecting Claude

Claude Code cloud sessions reach `/mcp` through a claude.ai custom connector, not through a local MCP configuration. Settings → Connectors → Add custom connector: name `IPTV MCP`, URL `https://iptv.vladimino.workers.dev/mcp` exactly (the client sends it as the RFC 8707 `resource`), empty client ID and secret (DCR). The connector's callback, `https://claude.ai/api/mcp/auth_callback`, must be on the `IPTV MCP` allowed-redirect list (requirement 2). The claude.ai account email plays no part: the identity in the Access JWT is the one used at the Cloudflare Access login, so the owner signs in there with an identity the owner-only policy admits. Connectors are read when a session starts; an already running session can pick a new connector up after reconnecting. On 25 October 2026 the connected Claude client listed exactly the 19 tools above, `probe_read` returned `authorization: cloudflare-access-jwt-verified`, `storage: not_accessed`, protocol `2025-11-25`, and `probe_echo` returned its marker. The same boundaries apply to Claude as to ChatGPT: writer tools and `enrichment_status` only with an action-specific owner approval.

The repository's `.claude/settings.json` pre-approves only `probe_read` and `probe_echo` from this server for cloud sessions; every other tool call still prompts the owner. The same file pre-approves read-only tools of the official Cloudflare MCP servers (`https://mcp.cloudflare.com/mcp` and `https://observability.mcp.cloudflare.com/mcp`) used to verify live Worker, Access and log state; the Cloudflare API `execute` tool, which can write, is deliberately not on that list.

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
2. Use the connected ChatGPT server described above.
3. In a chat, ask ChatGPT to call `probe_read` from this server. Expect `status: ok`, `storage: not_accessed`, `sideEffects: none`.
4. Ask it to call `probe_echo` with a marker such as `mcp-probe-2026-10-19`. Expect the identical text back.
5. Repeat step 1. The unauthenticated request must still get `401` from Access.

Leave Scheduled Tasks and writer MCP tools out of this connectivity smoke test. `epg_sync_start`, `epg_sync_step`, `prediction_start`, `prediction_next`, `prediction_submit`, `prediction_heartbeat`, and `prediction_complete` may write R2 or advance a run; AIR-62 completion is not permission for extra production calls. In contrast, `prediction_queue_overview`, `prediction_film_diagnostics`, and `prediction_pending` are read-only tools, suitable for separately authorized diagnostic checks. Do not use `/api/*`, the dashboard or synchronization as connectivity probes; some `GET` routes have side effects (see [README](../../README.md)).


## Rollback

Revert the change on `main` and let GitHub Actions deploy it; `/mcp` then returns the generic `404`. Removing the two variables makes `/mcp` return `503` immediately, which also requires approval because it publishes a version. Disabling `IPTV MCP` is an Access change and needs approval. It leaves `/mcp` closed (see Authorization). None of these steps touches R2 or Scheduled Tasks.
