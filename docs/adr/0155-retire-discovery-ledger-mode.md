# ADR 0155: The EPG seal always runs the bounded discovery archive protocol, and DISCOVERY_LEDGER_MODE is retired

**Status:** Accepted  
**Original decision date:** 2026-11-04 (owner disposition `retire after Discovery cutover`); code retirement 2026-11-16  
**Recorded at:** 2026-11-16  
**Approval source:** explicit Product Owner disposition on [AIR-232](https://trello.com/c/L0cbxhu5#comment-6aeb2a90774af46a22cc7eb9) (4 Nov 2026) and the implementation kickoff on [the same card](https://trello.com/c/L0cbxhu5#comment-6afb532eb00ab4d090a728d2) (16 Nov 2026); this record authorizes no Cloudflare binding edit  
**Related work:** [AIR-232](https://trello.com/c/L0cbxhu5); prerequisites [AIR-222](https://trello.com/c/9Y4G9DG6), [AIR-320](https://trello.com/c/4cA5GlJn); archive protocol [ADR 0034](0034-bounded-discovery-ledger.md); drain cap [ADR 0112](0112-bounded-ledger-departure-budget.md); diagnostic canary [ADR 0121](0121-epg-diagnostic-rehearsal-design.md)  
**Supersedes:** [ADR 0034](0034-bounded-discovery-ledger.md) in part: the production Worker variable that selected `full` / `bounded` / `frozen`, the default that an unset binding meant `full`, and rollback R1 as a flag change to `frozen`. The archive objects, fences, payload parity, drain cap, re-entry and write-once rules stay  
**Superseded by:** None

## Context

ADR 0034 introduced a bounded active ledger and a write-once segmented archive behind `DISCOVERY_LEDGER_MODE`. Unset meant `full` (one growing ledger). `bounded` archived departures. `frozen` stopped archiving while keeping history. Once an archive existed, `full` acted as `frozen`.

By 16 November 2026 production Discovery is D1-authoritative (`d1` / `open`) and the live EPG seal already archives: owner-only `feature_flags` at 2026-11-16 18:57:56 UTC showed `DISCOVERY_LEDGER_MODE` `state=set`, `raw=bounded`, `effective=bounded`. Removing that binding from the then-current Worker would have made the next commit `full`/`frozen` and would have stopped archiving.

The isolated EPG diagnostic canary still needs `full`, `frozen` and `bounded` on its own env. That env is built from scratch and never reads the production Worker binding.

## Decision

1. The production EPG seal (`publishGenerationWithLedger` and `stageSealedGeneration`) always plans a **bounded** archive commit. `discoveryLedgerMode` returns `bounded` unless `env.epgDiagnostic` is present, in which case it honours the isolated env's `DISCOVERY_LEDGER_MODE` (`bounded`, `frozen` or `full`). A leftover production binding of any value, including `full` or `frozen` while `keep_vars: true` still holds it, does not change the seal.
2. `DISCOVERY_LEDGER_MODE` is retired in the `feature_flags` registry. The Worker never uses it as a production switch. A set binding is reported `issue: retired`, `effective: null`.
3. Unchanged: the archive prefix, pointer CAS, manifest/segment versions, `LEDGER_DRAIN_CAP`, re-entry, fences, generation documents, D1 Discovery authority, and the 409 answers of the non-archive-aware scan and canonicalization routes.
4. Stopping production archiving is a **code revert**, not a flag. After the leftover binding is deleted, a revert to code that still reads the switch also needs `DISCOVERY_LEDGER_MODE=bounded` restored first, or the next commit becomes `frozen`.

Not decided here: deleting the Cloudflare binding of Worker `iptv` (a separate owner-approved settings change and readback); deleting archive objects; changing D1 schema or authority.

## Alternatives considered

- **Retire now as frozen.** Rejected by the 4 November 2026 owner disposition and by the 16 November 2026 live binding: production already archives as `bounded`. Pinning `frozen` would have changed the next EPG commit.
- **Retain as a permanent operational gate.** Rejected: the archive protocol is the accepted production seal, not a one-off write that needs a durable switch. Diagnostic rehearsal already has its own isolated selector.
- **Delete archive readers with the flag.** Rejected: R2 archive history remains recovery and compatibility; D1 does not store the generation's `ledgerMode` or the R2 archive.

## Consequences

- One production seal path. A stale `full` or `frozen` binding cannot freeze the archive.
- Rollback of archiving is a code revert plus, after binding removal, a coordinated restore of `bounded` if that older code is redeployed.
- Offline tests and the diagnostic canary still exercise `full` and `frozen` behind `epgDiagnostic`.
- `feature_flags` no longer reports an effective ledger mode; pipeline status still reads `ledgerMode` from the published generation document.

## Recovery and migration boundary

Reversible by a code revert. Archive objects already written stay. This record authorizes no flag, binding, R2, D1, EPG, Discovery or Task operation. Binding deletion is a later owner step on AIR-232.

## Evidence

- **Original decision:** owner disposition on [AIR-232](https://trello.com/c/L0cbxhu5) (4 Nov 2026); implementation scope (16 Nov 2026).
- **Implementation:** `src/sources.js` (`discoveryLedgerMode`), `src/feature-flags.js`, `src/epg-diagnostic.js` (unchanged isolated selector), tests `tests/discovery-ledger-archive.mjs`, `tests/feature-flags.mjs`.
- **Dated verification:** owner-only `feature_flags` 2026-11-16 18:57:56 UTC: `state=set`, `raw=bounded`, `retired=false` on the pre-retirement Worker. Post-deploy readback of `retired=true` and later `state=absent` are acceptance steps, not this record.
- **Uncertainty:** who set production to `bounded`, and when, is not established by that GET.

## Follow-ups

Owner-authorized removal of the leftover Worker `iptv` binding `DISCOVERY_LEDGER_MODE`, then `feature_flags` `state=absent`. Natural EPG publication readback of bounded archive semantics.
