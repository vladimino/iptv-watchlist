# ADR 0160: Delete the retired EPG diagnostic canary code, tooling and tests

**Status:** **Accepted** (2026-11-17; owner decision recorded on [AIR-521](https://trello.com/c/krZ9c6Ni): the owner finally abandoned the EPG diagnostic canary; delivery is an ordinary code/docs PR through independent review)
**Original decision date:** 2026-11-17
**Recorded at:** 2026-11-17
**Approval source:** Owner's decision to abandon the canary, recorded in the AIR-521 card text; infrastructure retirement was accepted under [AIR-457](https://trello.com/c/InwLNuYs) ([PR #714](https://github.com/vladimino/iptv-watchlist/pull/714), [PR #715](https://github.com/vladimino/iptv-watchlist/pull/715)).
**Related work:** [AIR-521](https://trello.com/c/krZ9c6Ni), [AIR-457](https://trello.com/c/InwLNuYs); [ADR 0121](0121-epg-diagnostic-rehearsal-design.md), [ADR 0124](0124-epg-diagnostic-canary-run-contract.md), [ADR 0139](0139-epg-diagnostic-chunked-replay-dataset.md), [ADR 0159](0159-detach-epg-diagnostic-runtime.md)
**Supersedes:** Decision 2 of [ADR 0159](0159-detach-epg-diagnostic-runtime.md) only (keep the inert modules, the operator script and their tests). Decisions 1, 3 and 4 of ADR 0159 stand.
**Superseded by:** None

## Context

ADR 0159 removed the canary's bindings, route and Workflow class but kept the modules inert. The owner has since abandoned the canary for good and the diagnostic D1, EU R2 bucket and Workflow were deleted (AIR-457 evidence). The modules stayed in `build.mjs`, so the deployed bundle still carried about 80 KB of code that nothing can reach, plus four test suites, a provisioning script and two diagnostic migrations that exist only to maintain it.

## Decision

1. Delete `src/epg-diagnostic.js`, `src/epg-diagnostic-run.js`, `src/epg-replay.js`, `scripts/epg-diagnostic-provision.mjs`, `diagnostic-migrations/` and the suites `epg-diagnostic-context`, `epg-diagnostic-provision`, `epg-diagnostic-run` and `epg-replay-dataset`. Remove their concatenation and the `runEpgDiagnosticWorkflow` export from `build.mjs`, so the deployed Worker no longer contains them.
2. `tests/epg-diagnostic-bindings-ready.mjs` stays as the regression guard and now also fails if a canary file returns, if a canary identifier appears in `src`, `scripts` or `public`, or if the **built** `dist/server` bundle carries one.
3. The offline-fixture marker that `discoveryLedgerMode` read as `epgDiagnostic` is renamed `offlineLedgerFixture`. Behaviour is unchanged: the Worker has no such binding, production always runs `bounded`, and `full` / `frozen` exist only on offline fixtures. `DISCOVERY_LEDGER_MODE` is not reactivated.
4. `scripts/epg-path-a-feasibility.mjs` and `scripts/epg-path-a-workerd.mjs` do not import or depend on any canary module (they drive the unchanged production `stageSealedGeneration` and `planDiscoveryLedger` offline), so they and their tests are kept as standalone seal memory tools; their history stays in the AIR-470 evidence.
5. ADR 0121, 0124 and 0139 keep their text and evidence as history. Their **design is no longer a contract of any code**: the modules they describe no longer exist. `docs/runbooks/epg-diagnostic-canary.md` is marked non-executable.

Not decided: any Cloudflare, D1, R2, Task, flag or Access change. The permanent D1/R2 API tokens are out of scope.

## Alternatives considered

Keeping the inert modules (ADR 0159 decision 2): rejected by the owner as unsupported dead code once the canary was abandoned. Moving the code to an archive directory: not documented as requested; git history preserves it.

## Consequences

Smaller Worker bundle (5,058,997 to 4,979,165 bytes in `dist/server/index.js`, about 79.8 KB), four fewer suites, no diagnostic provisioning surface. Reinstating a canary would be a new design and ADR, not a revert of a flag.

## Recovery and migration boundary

Code rollback returns the old inert modules to `main`. It does not restore deleted diagnostic resources and does not authorize provisioning. This ADR authorizes no operation.

## Evidence

- **Original decision:** [AIR-521](https://trello.com/c/krZ9c6Ni)
- **Implementation:** the AIR-521 pull request
- **Dated verification:** offline tests and the build size diff above; post-merge read-only bundle smoke recorded on the card
- **Uncertainty:** none known about shared consumers; the inventory found none outside the deleted files

## Follow-ups

None planned for the canary.
