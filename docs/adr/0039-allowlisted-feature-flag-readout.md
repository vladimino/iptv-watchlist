# ADR 0039: The owner reads registered feature flags through one MCP tool that names each binding and echoes only known tokens

**Status:** Proposed  
**Original decision date:** 2026-10-28  
**Recorded at:** 2026-10-28  
**Approval source:** not documented (proposed with the AIR-233 implementation; owner decision pending)  
**Related work:** [AIR-233](https://trello.com/c/8eUZ6gB7); [feature flag reference](../reference/feature-flags.md); [MCP contract](../reference/api/mcp.md); [ADR-0004](0004-mcp-access-boundary.md)  
**Supersedes:** None  
**Superseded by:** None

## Context

Runtime switches are plain-text environment variables on Worker `iptv`. `wrangler.jsonc` keeps dashboard variables (`keep_vars: true`) and declares no production values. The [feature flag reference](../reference/feature-flags.md) therefore carries a dated ledger whose rows are often owner readings or old observations. Agents have had no tool that shows the deployed value: the prediction diagnostics expose two compatibility modes, and the other switches were confirmed by the owner in the dashboard or by a separate Cloudflare API read.

The same environment holds secrets and configuration: `TMDB_API_READ_ACCESS_TOKEN`, `LETTERBOXD_USERNAME`, `EPG_XML_URL`, `MCP_ACCESS_TEAM_DOMAIN`, `MCP_ACCESS_AUD`, the `BUCKET` binding. A readout must not become a path to any of them, and a mistyped flag value must not carry a pasted secret out of the Worker.

## Decision

1. **A registry in code is the allowlist.** `src/feature-flags.js` lists every registered flag with its modes, default, accepted tokens, retired tokens and requirements on other flags. The retired `SCORED_RESOLUTION` stays in it so that a stale binding is visible. Adding a flag to the code means adding it to the registry and to the reference table; a test keeps the three in step with the governance checker's list.
2. **One read-only MCP tool, `feature_flags`.** It takes no arguments, reads each registered name with a direct property access and never enumerates `env`. It reads no storage, calls no network, writes nothing and answers without a bucket binding. It sits behind the existing `IPTV MCP` Access application and the Worker's JWT verification; no new route, binding or Access rule is added.
3. **Literal values only for known content.** A value is returned literally only when every part of it, after trimming, is one of that flag's accepted or retired tokens and it is at most 200 characters long. Any other value, including a non-string, is reported by shape only (`type`, `length`) with `redacted: true`, so a typo or a pasted secret never leaves the Worker. A near miss such as `On` is named as `case_or_whitespace` without echoing it.
4. **Effective mode from the consumer.** The tool computes the effective mode with the same function the runtime uses (`candidateDiscoveryMode`, `predictionCompatibilityMode`, `discoveryLedgerMode` and the others). Three consumers compare the exact string `on` inline (`LETTERBOXD_FACTS`, `LETTERBOXD_BASELINE_IMPORT`, `FINDS_WATCHED_MARK`); a test pins that comparison. Requirements on other flags are reported as `effectiveWithRequirements` and `unmetRequirements`.
5. **What the readout is and is not.** It shows the bindings of the Worker version that answered, at `readAt`. It does not show who set a value or when, it does not read the Cloudflare API, and for `DISCOVERY_LEDGER_MODE` it does not read storage, so it cannot say whether `full` currently acts as `frozen`.

Not decided here: setting, removing or changing any flag in production, a write route for flags, exposure of non-flag bindings, a Cloudflare API reader inside the Worker.

## Alternatives considered

- **Read the Cloudflare API settings** (as the AIR-210 preflight did). It shows every binding, secrets as names only, and needs an account token that the Worker does not hold. It stays the owner's or an agent's separate read; the Worker does not gain a Cloudflare credential.
- **Return every raw value of registered flags.** Rejected: a registered name can still hold a pasted secret.
- **Enumerate `env` and filter.** Rejected: the readout would depend on a filter being right; reading by name cannot reach an unregistered binding.
- **Extend the existing diagnostics per flag.** Rejected: each tool would carry its own subset, which is the situation this record ends.

## Consequences

- One call gives the deployed values and effective modes of every registered flag, including absent ones, and the ledger in the reference can cite it as a verified read.
- The registry is one more list to maintain; the parity test fails when a flag is added to the code or the reference without it.
- A connected client sees the tool after it refreshes its tool list.

## Recovery and migration boundary

The tool is code only and reversible by a revert. It changes no flag and no data. Calling it on production is a read under the existing MCP authorization; it is not approval for any flag change, which keeps its own owner approval.

## Evidence

- **Original decision:** this record, proposed with AIR-233.
- **Implementation:** `src/feature-flags.js`, `src/mcp.js`, `tests/feature-flags.mjs`.
- **Dated verification:** not recorded; the production read is a separate step after deployment.
- **Uncertainty:** whether Cloudflare exposes plain-text variables to the Worker exactly as typed in the dashboard (whitespace kept) is not verified on production.

## Follow-ups

A read-only production verification of the tool after deployment, and the reference ledger updated from that read.
