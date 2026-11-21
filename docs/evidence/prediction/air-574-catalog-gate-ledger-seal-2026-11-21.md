# AIR-574 false `catalog_gate` during an EPG ledger seal

> Dated sample, 21 November 2026 (UTC). See [evidence registry](../README.md). Not a current operational authorization.

[AIR-574](https://trello.com/c/ZyUoLRki) removes a false refusal at the start of Predictions batch v2.

## Observed (from the card's read-only RCA, not re-run here)

Natural Task start at about 16:05 UTC (17:05 Madrid): HTTP 503 `prediction_catalog_held`, `cause=discovery_incomplete`, 0 films. Worker timing `prediction_step_timing` for request `9db4b9eb-0567-4fd8-a378-3c17f24fc4ac`: `preflight` selected 5 eligible films, then `catalog_gate` refused (`refreshRounds=0`, `settledFilms=0`). The EPG Workflow was publishing at the time.

## Cause (code)

`catalogHeldCause` refused whenever `transfer === 'loading'`. The preflight reads by-id admissions through `DiscoveryAuthority.readAdmissionsById`, which already tells a `loading` **ledger seal** (safe) from a catalog replacement (`discovery_incomplete`). The global gate did not, so it turned away a start whose trusted selection had just been read.

## Change

`catalogHeldCause` now returns `discovery_fence` for a held cutover, `discovery_incomplete` for `loading` that is not a ledger seal (`loadingIsLedgerSeal`, now exported), and nothing for a ledger seal. Every read keeps its own fence; the lease-time preflight still repeats them.

## Offline verification (local SQLite stand-in, no production access)

`tests/prediction-start-diagnostics.mjs`, real Discovery rows instead of a stubbed gate:

- a pending admission under `loading` (catalog replacement): 503 `prediction_catalog_held`, no lease, run, Event or queue change;
- a pure ledger seal: `batch/start` returns `running` with the 2 selected films, `submit`, replay and `complete` work under the seal;
- the same test fails on the previous code with `cause=discovery_incomplete` (reproduces the RCA).

Held cutover and the stubbed `discovery_fence`/`discovery_incomplete` cases are unchanged. Not done: production acceptance, which needs a natural start during an EPG seal (read-only).
