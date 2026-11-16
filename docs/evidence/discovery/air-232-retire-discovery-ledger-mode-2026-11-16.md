# AIR-232: retire `DISCOVERY_LEDGER_MODE` (offline code, 16 November 2026)

**Scope:** Offline implementation of [ADR 0155](../../adr/0155-retire-discovery-ledger-mode.md). No production write, no Cloudflare binding edit, no EPG or Discovery run.

**Method:** Code and tests on `origin/main` `7cc03162146c7d249e1544b636b74f2c36d80aa2` plus this delivery. Pre-change production readout is the owner-only MCP `feature_flags` capture recorded on [AIR-232](https://trello.com/c/L0cbxhu5) at 2026-11-16 18:57:56 UTC.

**Result:**

- Production `discoveryLedgerMode` returns `bounded` with the flag absent, `full`, `frozen` or `bounded`.
- An isolated `epgDiagnostic` env still selects `full` / `frozen` / `bounded`.
- `feature_flags` reports the name as retired (`effective: null`; a leftover set binding is `issue: retired`).
- Archive fences, drain cap, re-entry, write-once segments and the 409 scan/reconcile gates stay.

**Limits:** This file does not prove the post-deploy Worker, the leftover Cloudflare binding, or the next natural EPG publication.

**Verdict:** Offline GO for the code PR. Binding deletion and natural EPG readback remain AIR-232 acceptance, under a separate owner GO.
