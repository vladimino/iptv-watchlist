# AIR-608 (A2): reviewable cutover operator, L3 plan proposal and dated L0 preflight (28 Nov 2026)

This page records the **offline** deliverable of card [AIR-608](https://trello.com/c/MSlOAAGR) and one dated, side-effect-free L0 read. It is **not** a production GO and it records nothing that was executed against production except the reads below. Times are UTC (Europe/Madrid is UTC+1). It describes what was true when read; the present state is always read live.

## What is delivered

- `scripts/letterboxd-admission-cutover-production.mjs`: the owner-only operator for the seven steps below. It wraps the delivered A1 mechanism ([`src/letterboxd-admission-documents-import.js`](../../../src/letterboxd-admission-documents-import.js): `inventory`, `planImport`, `importDocuments`, `verifyParity`, `rollbackImport`, [ADR 0222](../../adr/0222-letterboxd-import-coordination-documents-in-d1.md)) and the marker `letterboxd_admission_authority` (migration 0046). Default is read-only `status`. It follows the pattern of the Watchlist cutover operator (D1 REST adapter, `--target iptv`, `--confirm <command>`, pinned generation, one guarded batch, readback, no retry). It is imported by no Worker module and run by no deploy or Task.
- `tests/letterboxd-admission-cutover-operator.mjs` (core suite): the operator on the real migrations and the real import mechanism, a sqlite D1 stand-in and an in-memory R2 stand-in. No network.
- Documentation: the [baseline-import runbook](../../runbooks/letterboxd-baseline-import.md#import-coordination-documents-at-the-admission-cutover-adr-0222-target-not-current) now names the operator commands.

## The operator commands

| Command | Writes | Pins | What it does |
| --- | --- | --- | --- |
| `--status` | none | none | schema, marker, Ratings authority, pending facts, C2 `rated` scope, `H1_RULES` emptiness, and (with an R2 read credential) the frozen cohort: document count, manifest digest, blockers |
| `--parity` | none | none | `verifyParity` (R2 snapshot vs D1 byte for byte, key set, manifest) plus the pending facts |
| `--close` | marker row | `--expect-generation` | `r2 G -> closed G+1`, one guarded `UPDATE`; the trigger of migration 0046 enforces the chain |
| `--import` | D1 documents + manifest (last) | generation, `--expect-manifest-sha256` | refuses on a blocked plan, any pending fact or a digest that differs from the pin; then `importDocuments` (create-only, idempotent, divergent = stop) and an immediate parity |
| `--flip` | marker row | generation, manifest digest | full parity again, C2 `rated` active with a cutoff, `H1_RULES` empty; then **one** fenced batch: marker `closed` at G, manifest present, no pending `rated_admission_retention` receipt, C2 `rated` active, then `closed G -> d1 G+1` with `activated_at`. **Irreversible** |
| `--reopen` | marker row | generation | `closed G -> r2 G+1` (pre-flip rollback of the marker) |
| `--rollback-import` | D1 copies + manifest | generation | `rollbackImport` before the flip (marker `r2` or `closed`); refused after `d1` |

Pending facts that make `import` and `flip` a NO-GO (never repaired under `closed`): a rated candidate in `admitting`; a chunk `intent` without its `receipt`; an open `rated_admission_retention` receipt; a Diary entry with reason `linking`, `link_failed` or `lid_only_intent`; a plan with a blocked document (unparseable, oversized, unknown key) or a truncated listing. The report prints counts, key kinds, digests and generations only, never document text, film names, codes or ratings.

## L0 preflight (read-only, 28 Nov 2026 10:20-10:24 UTC; Cloudflare D1 `SELECT` and the IPTV MCP `feature_flags`)

| Fact | Read |
| --- | --- |
| Schema | `schema_contract.version` **55** |
| Admission marker | `letterboxd_admission_authority`: mode **`r2`**, generation **0**, `activated_at` NULL |
| Ratings authority | `d1` / `open`, generation 4756 |
| Pending `rated_admission_retention` receipts | **0** |
| C2 scope | `catalog_enrichment_scope`: only `rated`, activated, enabled, cutoff `2026-11-28T04:00:00.000Z`, bootstrap `done` |
| Moved documents already in D1 | **0** rows under `letterboxd/imports/` (no import has run) |
| Diary state | one part; **no** `linking`, `link_failed` or `lid_only_intent` marker in its body |
| Feature flags | the 25 registered flags read; none relevant to admission is set (`MONITOR` on and `MONITOR_TRANSPORT` telegram unchanged) |
| `H1_RULES` | empty in the code of this checkout (`eligibleTypes` empty, `idBlockMarker` null) |

**Not read, needs an exact approval first** (a wide production R2 inventory is outside L0 without it): the R2 listing of `letterboxd/imports/` (the frozen cohort digest, the chunk intents without receipt and the admitting candidates), the live Worker deployment version and its invocation logs, and the current Letterboxd/Ratings/Workflow leases. `--status` with an R2 read credential reads exactly the first of these (one paged `list` plus `get` of the moved families only) and writes nothing.

## Proposed L3 sequence, stops and holdpoints (for owner review; nothing here is approved)

0. **Pins**: reviewed `main` commit of this PR's merge, SHA-256 of the operator and of `src/letterboxd-admission-documents-import.js`, the manifest digest printed by `--status`, the marker generation. A changed pin is a new GO.
1. **Drain evidence** (Coordinator/owner, before `close`): deployed version is A1 or later at 100% of traffic with no invocation of an older version still running; no in-flight owner archive, baseline, rated identity, enrichment or replay request (telemetry, else an owner attestation); no active Letterboxd/Ratings/Workflow lease. A proven drain, never an elapsed timeout. **Holdpoint H-A.**
2. **`--close`** with the expected generation, readback of the marker. Wait for the proven step bound (an old writer's guarded batch is refused from the first moment; an R2 PUT that already passed its marker read finishes within the drained bound). **Holdpoint H-B.**
3. **`--status` (frozen cohort)**: blockers empty, plan not blocked, ETag and size pin recorded. Pending, unknown or drift = **NO-GO**; nothing is repaired under `closed`; recovery is `--reopen` under the approved plan. **Holdpoint H-C: owner accepts the residual risk and the exact manifest digest.**
4. **`--import`** with the digest. Create-only, idempotent; a divergent or partial result stops. Complete manifest last. Readback by `--parity`.
5. **Immediately before the flip**: `--parity` again (ETags re-pinned, no late R2 writer), pending facts, C2 `rated` active, exact generation. **Holdpoint H-D (final GO).**
6. **`--flip`**, one fenced batch, then an independent readback (marker `d1`, generation G+1, `activated_at`). After this: roll-forward only, no R2 fallback, no rollback, no old writer; `verified-films.json`, the moved coordination documents and `registry.json` are frozen historical evidence.
7. **Natural acceptance** (card goes to Верификация): a real Diary/Watchlist admission after the flip with the canonical D1 admission, evidence and operation-key receipt; no R2 writer; no old-key reservation; rating, facts and Watchlist unaffected; the rated enrichment (AIR-607) fires on the new signal. No forced admission, no Task, flag or Access change, no manual source fetch.

**Rollback**: before the flip only: `--rollback-import` then `--reopen` (R2 never changed, nothing is lost). After the flip: roll-forward on code that honours the marker; restoring R2 coordination needs its own owner-approved fenced procedure.

**Proposed GO wording**: «GO A2 (AIR-608): execute steps 2-6 of the plan on `main` `<sha>`, operator SHA-256 `<sha256>`, manifest digest `<sha256>`, marker generation `<G>`, with holdpoints H-B, H-C and H-D, stopping and reading back on any unexpected result, without retry or repair. I accept the residual risk recorded in H-C.»

## Known limits

- Offline proof only: the operator was never run against production, and the production R2 adapter (`createS3Store`) was exercised through the same `list`/`get` interface by the stand-in, not against the real bucket.
- Whether the live R2 cohort is clean (no admitting candidate, no chunk intent without receipt) is **unknown** until the approved `--status` read.
- Drain telemetry (deployed version split, invocation logs, leases) was not read here.
- C2 was shown by its scope row; the card's «активация и natural acceptance» of AIR-607 remains open and is not a blocker for A2.
