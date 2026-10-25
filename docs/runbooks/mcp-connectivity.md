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


## Diagnosing a stalled EPG continuation

Use this when the continuation stays `paused / epg_committed` with `remainingChunks: 12` after a published generation, as in [AIR-69](https://trello.com/c/FlcWZX7W). Everything below is a read; none of it starts a chunk, a sync or a task.

1. Read the Worker log first: with the Cloudflare Observability connector (or the dashboard's Workers Logs), filter the `iptv` Worker for messages containing `"event":"epg_continuation"` in the window around the scheduled call. Each step produces two lines with the same `id`: `phase: entered`, then `completed` or `failed`. This is the arrival evidence; the ring below is a convenience view of the same entries.
2. Call `epg_pipeline_status` (or `GET /api/enrichment/pipeline/status`) and read `continuation` and `continuationDiagnostics.recent` (newest first, at most 20 entries; `recorded.entered: false` in a log line means the ring never got that entry, and 20 later steps evict an entry).
3. Find the entries around the time the external Scheduled Task should have called `epg_sync_step` after the EPG commit. The commit itself is the entry with `branch: epg_commit` and `discovery.reason: epg_committed`.
4. Read the table:

| What the log and the ring show after the commit entry | Meaning | Next safe step |
| --- | --- | --- |
| No `entered` log line with `caller: mcp` and `route: /api/sync/epg` in the retention window, and no ring entry | No request reached the Worker handler. This does not say where it stopped: a call rejected by Cloudflare Access (`401`/`403`), dropped by the client or never sent leaves the same absence | Check the Scheduled Task's own execution history and prompt, then the Access logs for `/mcp` in that window |
| No ring entry but an `entered` log line exists | The call arrived; the ring write failed or the entry was evicted | Read the log pair for that `id`; `recorded` on the outcome line says which write failed |
| `branch: run_mismatch`, `httpStatus: 409` | The call arrived with a `runId` that is not the current `sync.json` run; `runIdShape: invalid` means it was not even a server-generated id | Compare the task's `runId` with `epg_status` |
| `entered` log line without a `completed`/`failed` line of the same `id` (or a ring entry stuck at `phase: entered`) | The call arrived and was interrupted before a response was formed | Look at the Worker invocation in the same window (CPU limit, exception); `diagnostic.branch` says how far it got |
| `phase: failed` | The handler threw; `error.code` classifies the cause (`storage`, `upstream`, `timeout`, `publish_conflict`, `resolver_busy`, `invalid_input`, `unknown`) | Fix the cause before any retry; the message itself is only in the Worker exception, never in the entry |
| `branch: continuation`, `diagnostic.branch: lease_live` | Another chunk held the resolver lease; the contract answered `busy / wait` and nothing was overwritten | Wait for `nextCatchUpAt`; a lease that never expires is a separate defect |
| `diagnostic.branch: contract` with `decision.nextAction: wait` or `stop` | The stored continuation already said wait or stop; `decision.hardWait` tells whether `force` would have been ignored too | Read `entry.reason` and `entry.nextCatchUpAt` |
| `diagnostic.branch: missing_secret` | `TMDB_API_READ_ACCESS_TOKEN` was unset in that invocation | Verify the Worker variable; a deploy with `keep_vars` does not remove it |
| `diagnostic.branch: chunk` with `chunk.stage: error` | The chunk ran and failed; `chunk.error` classifies the cause; the continuation is `error` with a catch-up time | Fix the cause; the next call after `nextCatchUpAt` resumes |
| `diagnostic.branch: chunk` with `saved.owned: false` | The chunk ran but another hop had replaced the continuation meanwhile; this call's result was not stored | Read the owner hop's entry (`saved.hopId`) |
| `continuation.stage: running` in pipeline status with `continuationHealth.status: live` (`diagnostic.health.status: live`, `branch: lease_live`) | A writer holds the resolver lease; `leaseHop` says whether it is the record's own hop or another one | Wait until `continuationHealth.leaseExpiresAt`; the record is not an orphan yet |
| `continuation.stage: running` with `continuationHealth.status: orphaned` | The writer's lease expired without a checkpoint and the hop has been silent for a whole lease TTL. The likely cause is an interrupted invocation, but a failed lease release, checkpoint write or diagnostics write leaves the same picture: record the cause as an inference. `chunkCompleted` says whether a status marked with this hop's id was saved; `resumeBudget` is what the next step resumes with | One ordinary explicit `epg_sync_step` recovers it; no lease reset, R2 edit or forced call is needed or allowed. A caller that reads only the raw `continuation.stage` will not make that call by itself; teaching the external scheduled caller to read `continuationHealth` is a separate owner-approved change |
| `diagnostic.branch: chunk` or `orphan_settled` with `recovery.action: settled` | The orphan was settled from the hop-marked chunk status under the dead hop's id (`recovery.orphanHopId`), then the step continued as usual (`chunk`) or reported the settled contract (`orphan_settled`, for example `chunk_budget` / `wait`) | Nothing; the series continues from the correct remaining budget |
| `recovery.action: resumed` | No status marked with the orphan's hop id was found (the chunk had not finished, another hop wrote the last status, or the status predates hop markers); the step ran the chunk again with the hop's full budget | Nothing; decisions already saved for that chunk were reused, at most one extra chunk was spent |
| `diagnostic.branch: chunk` with `saved.write: write_conflict` | The chunk ran, but both conditional writes of its checkpoint were rejected while the record still named the hop; the checkpoint is reported as not stored and the record stays `running` | The next explicit step settles it from the hop-marked status; nothing is repeated |
| `chunk.stage: error` with `chunk.error: resolver_busy` and `saved.write: other_hop` | A hop that stalled past the lease TTL tried to write after a replacement had taken the lease; the renewal before the write failed and the chunk aborted without touching storage | Nothing; the replacement's checkpoint stands |
| `diagnostic.branch: generation_conflict` | The orphan belonged to another published generation; it was closed as `programme_changed` / `stop` without running a chunk | Wait for the next EPG commit, which queues discovery for the current generation |
| `diagnostic.branch: record_changed` | The continuation moved between this call's read and its write (a concurrent step settled or opened it); the call released its lease and wrote nothing | Read the entry of the hop named in `saved.hopId`; call again after `nextCatchUpAt` |
| `diagnostic.branch: chunk` with `saved.owned: true` and `remainingChunks` decremented | The step worked as designed | Nothing; the next call continues the series |

5. Record the finding on the card with the entry `id`, `at`, `branch` and `diagnostic.branch`. The entry holds codes, UUIDs, timestamps and counts only, never tokens, titles, messages or payloads.

Deleting or editing `epg/resolver-continuation-diagnostics.json` is a production write and needs approval; it is never needed, the ring overwrites itself. The same holds for `epg/resolver-continuation.json` and `epg/resolver-lease.json`: an orphaned `running` record is recovered by the next ordinary `epg_sync_step`, not by editing or deleting either object. Running that step on production is a writer call and needs its own approval like any other discovery step.

## Rollback

Revert the change on `main` and let GitHub Actions deploy it; `/mcp` then returns the generic `404`. Removing the two variables makes `/mcp` return `503` immediately, which also requires approval because it publishes a version. Disabling `IPTV MCP` is an Access change and needs approval. It leaves `/mcp` closed (see Authorization). None of these steps touches R2 or Scheduled Tasks.
