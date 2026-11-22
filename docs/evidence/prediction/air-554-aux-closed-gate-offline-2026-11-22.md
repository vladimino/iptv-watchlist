# AIR-554: the auxiliary-state `closed` admission gate, offline evidence

22 November 2026 (Europe/Madrid) · [AIR-554](https://trello.com/c/UrS1gflv) · implements [ADR 0196](../../adr/0196-prediction-aux-admission-closed-state.md) (Accepted; amends [ADR 0194](../../adr/0194-prediction-auxiliary-state-d1-checkpoint-and-outbox.md) decision 1) as **dormant** code. Offline only: the real Worker code over a sqlite D1 stand-in and an in-memory R2, synthetic data. **No production call, no Scheduled Task, no model, no read of production R2.** The Cloudflare limits were read from the public documentation.

## What was built

- `migrations/0034_prediction_aux_authority.sql` (still unapplied to production): marker mode `r2` / `closed` / `d1`; trigger `prediction_aux_authority_chain` (`r2`→`closed`→`d1`, `closed`→`r2` only before an activation, every change of mode raises `generation`, `d1` reachable only from `closed`).
- `src/prediction-aux-d1.js`: `closed` read as `mode: closed`, `ready: false`, no D1 branch; `auxClosed`; `guardR2Write` (fresh marker read, typed `prediction_aux_closed`, never r2 on an unreadable marker).
- `src/enrichment.js`: the typed 503 refusal of `batch/start`, `batch/hold`, `batch/submit` and `complete` (not `dryRun`, not heartbeat, not reads); one wrapper of the bucket a request or Workflow step holds, so every put or delete of the four R2 families re-reads the marker before the PUT.
- `scripts/prediction-aux-d1-import.mjs`: the guarded import asserts `mode = 'closed'`.

## Tests (`tests/prediction-aux-closed.mjs`, plus the existing aux tests moved to the chain)

| Claim | Result |
| --- | --- |
| Schema chain: d1 only from closed, generation raised on each change, closed→r2 allowed, nothing out of d1, row never deleted | pass |
| `closed` reads `closed`, not r2, not unavailable, not ready; the gate lets r2 through, refuses closed (`detail: closed`) and d1 (`detail: d1`); an unreadable marker, a partial table set and a missing binding refuse as unavailable; schema 33 passes without a table read | pass |
| The gate reads the marker fresh: a request-scoped earlier `r2` read does not let a later PUT through | pass |
| Worker at closed: start, hold, submit and complete answer 503 `prediction_aux_closed`; **zero R2 object and zero D1 row, lease or run change**; `dryRun`, heartbeat and the manifest part read still answer; the reopen admits the writers again | pass |
| A request that read `r2` at its start and sees the marker move to `closed` mid-request is refused at its own source PUT: no R2 object of the families is written | pass |
| **Residual, as a test:** a PUT already past the gate does land after the close; the listing of the families changes, so a listing at the close and a later one detects it; a request started after the close is refused at the entry | pass |
| At `d1` a whole start writes no R2 object of the families | pass |

Mutation check: removing the gate before the bucket PUT makes the mid-request test fail ("its own write was refused"); restoring it passes.

## Cost (exact counts, offline cycles of the AIR-553 benchmark library; not Cloudflare latency)

| Cycle | Legacy D1 calls | Schema 33 with the module | Marker `r2` installed, without the gate | Marker `r2` installed, with the gate |
| --- | --- | --- | --- | --- |
| S5 | 302 | 302 (0 %) | +4.3 % | 323 (+7.0 %) |
| S7 | 372 | 372 (0 %) | +4.3 % | 396 (+6.5 %) |
| S10 | 450 | 450 (0 %) | +4.2 % | 477 (+6.0 %) |

R2 operations are unchanged (S5 100 puts in every r2 arm). Before migration 0034 the gate costs nothing (the request-scoped read already proves the tables are not installed). Once the tables are installed and the marker is `r2`, each guarded put pays one read-only D1 round trip; at `closed` and `d1` the families write nothing to R2. The aux budget test limit moved from 6 % to 8 % for this reason.

## What the platform allows (Cloudflare documentation, read 22 Nov 2026)

[Workers limits](https://developers.cloudflare.com/workers/platform/limits/): an incoming HTTP request has no hard wall-time limit while the client stays connected; there is no set time limit on an individual subrequest (R2 and D1 included); `waitUntil()` runs at most 30 seconds after the response or disconnect; a runtime update gives existing requests up to 20 minutes. **There is no platform ceiling for a request already in flight**, so the drain cannot be proven by a time bound alone. ADR 0196 states the residual and bounds it by listings and the flip refusal instead.

## Not covered here, on purpose

The cutover operator and its flip refusal on a changed listing, the scoped converter from the R2 snapshot manifest to the importer input, the scratch rehearsal on a real private export, the import size and batching, the baseline and the performance comparison: each is a separate step of the AIR-554 plan. Nothing here authorizes a production migration, export, import, close, flip or Task change.
