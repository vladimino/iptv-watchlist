# Authentication and MCP request boundary

**Scope:** owner-only remote MCP authentication and tool invocation. Sources: [MCP contract](../reference/api/mcp.md), [MCP implementation](../../src/mcp.js), [deployment runbook](../runbooks/deployment.md), [ADR-0004](../adr/0004-mcp-access-boundary.md).

```mermaid
sequenceDiagram
    autonumber
    actor Client as ChatGPT MCP client
    participant Access as Cloudflare Access: IPTV MCP
    participant Worker as Worker /mcp
    participant JWKS as Access JWKS
    participant Handler as Allowlisted tool handler
    participant R2 as R2 bucket iptv
    Client->>Access: Connect /mcp without session
    Access-->>Client: Authentication challenge and OAuth discovery
    Client->>Access: Managed OAuth owner authentication
    Access-->>Client: Authorized Access credentials
    Client->>Access: POST /mcp with Access session
    Access->>Worker: Forward protected request and signed Access JWT
    Worker->>JWKS: Retrieve/cached public signing keys if needed
    JWKS-->>Worker: Signing keys
    Worker->>Worker: Verify signature, issuer, audience, time, identity
    alt JWT invalid or identity rejected
        Worker-->>Client: Reject request
    else JWT valid
        Worker->>Worker: Validate protocol and tool allowlist
        alt Read-only probe
            Worker-->>Client: Probe result (no R2 access)
        else Authorized EPG or prediction tool
            Worker->>Handler: Narrow tool arguments only
            Handler->>R2: Read/write per tool contract
            R2-->>Handler: Result
            Handler-->>Client: MCP JSON-RPC response
        end
    end
```

Cloudflare Access protects the `/mcp` endpoint under the separate **IPTV MCP** application with Managed OAuth and owner-only policy. The Worker also independently verifies the Access JWT, including the application audience. The remainder of the Worker stays behind `All Workers`; `/mcp/` is not the exact MCP route.

MCP uses stateless Streamable HTTP with JSON replies. `probe_read` and `probe_echo` do **not** access storage. Other tools have explicitly defined side effects: some diagnostics read R2 and some status operations may perform recovery writes. EPG and prediction writer tools can change R2, **but only if invoked**. They cannot accept arbitrary URLs, API paths or R2 keys. Neither GitHub deployment nor enabling a connection starts a prediction run.

An Access JWT must not be forwarded into an internal continuation hop or exposed in logs. Policy, application audience and live authorization are deployment settings, **not** a code-only test result. External ChatGPT Scheduled Tasks have separate state and approvals. See [MCP operations](../runbooks/mcp-connectivity.md) and [scheduled tasks ADR](../adr/0005-external-chatgpt-tasks.md).
