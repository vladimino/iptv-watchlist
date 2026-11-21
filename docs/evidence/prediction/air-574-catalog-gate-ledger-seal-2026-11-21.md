# AIR-574 false `catalog_gate` during an EPG ledger seal

> Dated sample, 21 November 2026 (UTC). See [evidence registry](../README.md). Not a current operational authorization.

[AIR-574](https://trello.com/c/ZyUoLRki) removes a false refusal at the start of Predictions batch v2.

## Observed (from the card's read-only RCA, not re-run here)

Natural Task start at about 16:05 UTC (17:05 Madrid): HTTP 503 `prediction_catalog_held`, `cause=discovery_incomplete`, 0 films. Worker timing `prediction_step_timing` for request `9db4b9eb-0567-4fd8-a378-3c17f24fc4ac`: `preflight` selected 5 eligible films, then `catalog_gate` refused (`refreshRounds=0`, `settledFilms=0`). The EPG Workflow was publishing at the time.

## Cause (code)

`catalogHeldCause` refused whenever `transfer === 'loading'`. The preflight reads by-id admissions through `DiscoveryAuthority.readAdmissionsById`, which already tells a `loading` **ledger seal** (safe) from a catalog replacement (`discovery_incomplete`). The global gate did not, so it turned away a start whose trusted selection had just been read.

## Change

`catalogHeldCause` now returns `discovery_fence` for a held cutover (defensive: `readAuthority` refuses a real held cutover earlier, see the follow-up), `discovery_incomplete` for `loading` that is not a ledger seal (`loadingIsLedgerSeal`, now exported), and nothing for a ledger seal. Every read keeps its own fence; the lease-time preflight still repeats them.

## Review follow-up (exact HEAD 1fc040a)

The by-id reader now closes the `routeRead` read fence (programme, transfer epoch, seal classification; generation-only progress stays open). The real held cutover answers `502 discovery_unavailable` (ADR 0162), not the 503; the contract pages say so. `main` (AIR-573, keyed start claim) was merged and the regression covers keyless and keyed starts with five films.

## Offline verification (local SQLite stand-in, no production access)

`tests/prediction-start-diagnostics.mjs`, real Discovery rows instead of a stubbed gate:

- a pending admission under `loading` (catalog replacement): 503 `prediction_catalog_held`, no lease, run, Event or queue change;
- a pure ledger seal: `batch/start` returns `running` with the 2 selected films, `submit`, replay and `complete` work under the seal;
- the same test fails on the previous code with `cause=discovery_incomplete` (reproduces the RCA).

`tests/prediction-start-ledger-seal.mjs` (keyless and keyed, five films, real rows): positive start/submit/replay/complete under a seal; refusal with no run, live lease, manifest, Event or queue change for a pending admission, a non-seal `loading`, and a real held cutover; a genuinely revoked admission settles out under a seal; a deterministic tear of the by-id read (replacement, ABA, programme change; committed and seal bases; during preflight and during the queue refresh) refuses with `discovery_fence` and settles nothing; generation-only progress stays open. It fails without the fence. The stubbed `discovery_fence`/`discovery_incomplete` cases are unchanged. Not done: production acceptance, which needs a natural start during an EPG seal (read-only).
