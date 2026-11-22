# ADR 0195: The auxiliary prediction marker gets a pre-activation `closed` state that refuses every legacy write of the four R2 families before the object-store PUT

**Status:** Accepted (2026-11-22; owner approval of the **preparatory implementation only**, recorded on [AIR-554](https://trello.com/c/UrS1gflv) the same day after the [independent review of the proposed plan, PR 889](https://github.com/vladimino/iptv-watchlist/pull/889#pullrequestreview-6011478394); authorizes dormant code, schema text of the still-unapplied `0034` and offline tests, **not** a production apply, import, activation or Task change)  
**Original decision date:** 2026-11-22  
**Recorded at:** 2026-11-22  
**Approval source:** [AIR-554 owner comment "Одобрение подготовки D5"](https://trello.com/c/UrS1gflv) and the handoff comment of 22 Nov 2026 09:28 Madrid; the proposal is D5 of the [AIR-554 plan](../evidence/prediction/air-554-aux-cutover-plan-2026-11-22.md)  
**Related work:** [AIR-554](https://trello.com/c/UrS1gflv) (cutover, separate L3), [AIR-553](https://trello.com/c/ouMIBO00) (dormant implementation), [AIR-547](https://trello.com/c/99faXisC) (maintained docs)  
**Supersedes:** None  
**Amends:** [ADR 0194](0194-prediction-auxiliary-state-d1-checkpoint-and-outbox.md) decision 1 (the marker has a third mode; the invariant and every other decision of 0194 are unchanged)  
**Superseded by:** None

## Context

ADR 0194 decision 1 requires, before the marker flips to `d1`, that admission of **all** legacy writers of the four R2 families (held stage, run sources, persisted manifest, event delivery records and the outbox index) is closed, that in-flight old writes are drained or proven unable to land, and that a paused R2 write across the handover neither changes the imported state nor is acknowledged as delivered. It left the procedure to AIR-554 and prescribed no new control plane.

The AIR-554 plan proposed silencing the four Scheduled Tasks and comparing two R2 listings. The independent review found that insufficient: disabling Tasks does not fence a manual MCP or HTTP call, and identical listings prove a past state, not that no write will land later. Facts read from the code at `main` `b20a70f`: every writer of those families runs inside one request (`enrichmentRoute`) or one Workflow step (`runPredictionStartWorkflow`), including the lease-free skipped, delivery and acknowledgement paths; a legacy start writes the R2 `sources` object **before** the D1 run row; a request reads the marker once and keeps it for its lifetime.

Facts from the Cloudflare documentation (read 22 Nov 2026): an incoming HTTP request has **no hard wall-time limit** while the client stays connected; there is **no set time limit on an individual subrequest** (R2 and D1 calls included); `waitUntil()` extends execution up to 30 seconds after the response or disconnect; a runtime update lets existing requests run up to 20 minutes. The platform therefore gives **no ceiling** for a request that is already in flight.

## Decision

### 1. A third marker mode and its chain

`prediction_aux_authority.mode` is `r2`, `closed` or `d1`. The chain is `r2 → closed → d1`, plus `closed → r2` (the reopen) **only before an activation**. `d1` is reachable only from `closed`, so an activation cannot skip the close, and it stays one-way (nothing leaves `d1`, the row is never deleted). Every change of mode raises `generation`. A trigger (`prediction_aux_authority_chain`) enforces the chain in the schema, not only in the operator. The change is made in the **still-unapplied** `migrations/0034_prediction_aux_authority.sql`: no production schema is affected and no new migration number is spent.

`closed` is **not an authority and not unavailable**: the R2 objects remain the data and are still read; `readAuxAuthority` reports `mode: closed`, `ready: false`; `auxD1` gives no D1 branch. It is also not read as `r2` by any writer.

### 2. What `closed` refuses, and where

- **At the entry.** `batch/start`, `batch/hold`, `batch/submit` and `complete` (HTTP and MCP, the same route) answer HTTP 503 with `code: prediction_aux_closed` (`retryable: false`) before they start, for **every** caller. A `dryRun` start or submit writes nothing and is not refused; a heartbeat renews the lease only and is not refused; reads (manifest parts, status, events) keep serving from R2.
- **At the PUT.** The bucket a request or a Workflow step holds is wrapped once, after the request scope is built. A `put` or `delete` of a key of the four families first reads the marker **fresh** (never the request scope, so a request that read `r2` at its start still refuses at its own write) and fails with the typed error `prediction_aux_closed` unless the marker proves `r2` or proves the tables are not installed. `d1` refuses too: after the activation the Worker never writes these objects again. An unreadable marker, a partial table set or a missing row refuses as `prediction_aux_unavailable`, never as `r2`. The guard is the last awaited step before the PUT. This covers every present and future write path without a list of call sites.
- **Before migration 0034** the request-scoped read already proves the tables are not installed: the gate costs no D1 call. With the tables installed and the marker `r2`, each guarded PUT costs one read-only D1 round trip (measured, see the evidence), paid only between the apply of `0034` and the close.
- **Import.** The guarded import SQL asserts `mode = 'closed'` and empty tables: an import never runs while the old writers are admitted.

### 3. What the gate proves, and what it cannot

It proves: once the marker reads `closed`, no new write of the four families can start from any origin (Task, manual MCP or HTTP, Workflow step, the lease-free paths); the gate, the entry refusal and the schema chain are tested on the real Worker code, including a request that read `r2` at its start and is refused at its write.

It cannot recall a PUT that passed its marker read before the close: that PUT is one object-store subrequest, and the platform sets no time limit on it (see Context). The residual is therefore **not "none"**. It is bounded by what can be demonstrated:

1. no awaited work separates the marker read from the PUT call; the PUT is a single I/O-bound subrequest;
2. the cutover compares the listing of the four families (key, ETag, size) at the close (after a drain wait), at the export, immediately before the flip and after the flip; **any difference refuses the flip** (the operator's rule, AIR-554 Phase A); a late object seen before the flip is handled by the reopen (`closed → r2`) and a fresh export, never by a delta import;
3. after the flip every acknowledgement lives in D1, so a late R2 PUT can never mark an event delivered or change imported state; it can only sit in the frozen R2 copy that no reader consults, and it is detected by the post-flip listing;
4. a PUT that stays in flight longer than the whole interval from the close to the last pre-flip listing (the drain wait plus the export and import time, tens of minutes) would defeat 2; the platform does not exclude it, and it is accepted as a stated residual risk or rejected by the owner before the flip is released. If the owner does not accept it, the cutover stays No-GO.

A post-flip **delta import is not approved** as a recovery mechanism and is not introduced. Raising a TTL is not a remedy.

### 4. Not decided here

The production apply of `0034`, the production R2 export (needs its own credential authorization), the import, the close, the flip, the Task disable and re-enable, the drain-wait length (set from the rehearsal evidence), the cutover operator and the importer's input converter. Each needs its own reviewed change or owner authorization. This ADR authorizes none of them.

## Alternatives considered

- **Task silence plus matching listings (the first AIR-554 proposal).** Rejected by the independent review: it does not fence manual callers and a listing is not an exclusion.
- **Blocking `/mcp` in the Cloudflare Access policy for the window.** Excludes manual callers at the edge without code, but is an Access change (L3), drains nothing and must never weaken Access. Not chosen; remains possible as an extra, separately authorized layer.
- **A new in-flight request registry or lease for the lease-free writers.** A new control plane ADR 0194 declined, with its own failure modes. Not chosen.
- **Per-call-site checks instead of the bucket wrapper.** Misses any path not listed (the events paths alone are six). Not chosen.
- **A fourth mode `closing`, or a timeout on the closed state.** No evidence they add safety; not chosen.

## Consequences

- One more state to reason about, one more trigger, one new typed error. Tests: `tests/prediction-aux-closed.mjs` (chain, authority, entries, no R2 or D1 write at closed, the reopen, mid-request close, the residual landing and its detection, no R2 write at `d1`); the existing aux tests move to the chain `r2 → closed → d1` (the d1 generation in tests is now 2).
- Between the apply of `0034` and the close the PUT guard adds one read-only D1 call per guarded R2 write: 6.0 to 7.0 % of the D1 calls of the S10 to S5 offline cycles (the marker read alone is 4.2 to 4.3 %), see the [evidence](../evidence/prediction/air-554-aux-closed-gate-offline-2026-11-22.md); the aux budget test allows 8 %. At `closed` and `d1` nothing is written to R2 by these families.
- While `closed`, a run in flight cannot complete (its stop record is refused); its lease expires and the next start recovers it after the reopen or the activation. This is the intended drain.
- Code rollback is not state rollback: a Worker version older than this change does not know the state and must not run against a marker at `closed` or `d1`.

## Recovery and migration boundary

Reversible until an activation: the schema text and the code (a revert before `0034` is applied), and the state itself (`closed → r2`). Irreversible without a new owner operation: the activation (`d1`), as in ADR 0194. A deploy of this code is dormant: with the marker at `r2` or no tables the Worker behaves as before. This ADR authorizes no migration apply, import, marker change, Scheduled Task change, flag, binding, manual run or restore.

## Evidence

- [AIR-554 preflight and proposed plan](../evidence/prediction/air-554-aux-cutover-plan-2026-11-22.md) (D5) and the [independent review](https://github.com/vladimino/iptv-watchlist/pull/889#pullrequestreview-6011478394).
- Offline tests named above, on a sqlite D1 stand-in and an in-memory R2; no production call.
- Cloudflare documentation read on 22 Nov 2026: [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) (duration, subrequests, `waitUntil`, runtime updates).
