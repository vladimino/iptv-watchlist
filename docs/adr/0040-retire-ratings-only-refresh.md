# ADR 0040: The owner-triggered ratings-only refresh is retired; its route answers 410 Gone and no flag can reopen it

**Status:** Accepted  
**Original decision date:** 2026-10-29  
**Recorded at:** 2026-10-29  
**Approval source:** Owner decision recorded on [AIR-92](https://trello.com/c/yP6I0sjp) on 2026-10-29 to retire the temporary ratings-only FULL/REPAIR web refresh in its current scraping form; ADR 0040 explicitly Accepted by owner in conversation on 2026-10-29; Mermaid rendering visually approved in the same decision  
**Related work:** [AIR-92](https://trello.com/c/yP6I0sjp); [AIR-85](https://trello.com/c/NVS7Ywdq) preflight; [AIR-64](https://trello.com/c/WTnyO8bX); [ADR 0018](0018-letterboxd-last-good-ratings.md); [ratings contract](../reference/integrations/letterboxd-ratings.md)  
**Supersedes:** The refresh-route part of [ADR 0018](0018-letterboxd-last-good-ratings.md) ("the rating refresh has its own opt-in flag"); the last-good rule of ADR 0018 stays in force  
**Superseded by:** None

## Context

AIR-64 added `POST /api/enrichment/ratings/refresh`, an owner-triggered full scan of the public Letterboxd films list (and a repair of named film ids), behind the off-by-default variable `RATINGS_REFRESH`. It held its own lease, staged an immutable generation under `enrichment/ratings/generations/`, projected the view index and moved `enrichment/ratings/published.json`.

The AIR-85 preflight found the films list answering HTTP 403 with an anti-bot page on page 2. The route was designed never to get past that challenge, so the capability cannot do its job in its current form. Meanwhile ratings reach the view index through the EPG commit's films-list read, the per-film lookup, the owner edit and, with `LETTERBOXD_FACTS=on`, the fact records. A switch that only gates a route that cannot succeed is an operational trap: setting it invites a production request that writes a lease and status for nothing. A read through `feature_flags` on 2026-10-29 05:16 UTC showed `RATINGS_REFRESH` absent.

## Decision

1. **The route is gone, not gated.** `POST /api/enrichment/ratings/refresh` (and any other method on that path) answers `410 Gone` with `{"error":"gone"}` and a short pointer to the remaining ratings paths. The check runs first in the enrichment router, before the body is parsed, so the request makes no Letterboxd call, takes no lease and reads, lists or writes no stored object.
2. **No variable reopens it.** The refresh, lease, scan, staging, projection, pointer and recovery code is removed together with `ratingsEnabled`. `RATINGS_REFRESH` stays in the `feature_flags` registry as retired (`effective: null`, issue `retired` when a binding exists), like `SCORED_RESOLUTION`, so a stale binding is visible.
3. **Stored state stays readable.** `GET /api/enrichment/ratings/status` keeps its contract and reads the stored status, published pointer and pending generation; `enabled` is always `false`. The integration footer keeps `manualRefreshEnabled: false`.
4. **Nothing else changes.** The EPG commit's films-list read, its last-good behavior on 403, the per-film lookup, the owner edit, the ratings seed, the fact records and the view-index projection are unchanged.

Not decided here: removing the Worker binding, deleting `enrichment/ratings/` objects, a replacement source of ratings (a CSV import, an account export, a new schedule or admin route). Each needs its own card, decision and approval.

## Alternatives considered

- **Keep the flag as a permanent operational gate.** Rejected in the AIR-92 owner decision: the gated capability is blocked by the anti-bot page, and the gate keeps a production write path alive for an operation that cannot succeed.
- **Return 404.** The card allowed 404 or 410. 410 says the route existed and was withdrawn on purpose, which matches the retired flag in the readout.
- **Remove the route without a dedicated answer.** Rejected: an unknown `/api/enrichment/` path falls through the router, and the explicit early answer is what the regression test pins.

## Consequences

- No production request can start a ratings-only scan, whatever the bindings say. A client that still calls the route gets a clear 410.
- About 190 lines of lease, scan and recovery code leave `src/enrichment.js`; the status read and the seed remain.
- A `pending.json` left by an interrupted refresh is no longer finished. It is reported as `pendingGenerationId` and does not affect the view index.
- The status document freezes at the last state the refresh wrote; `lastSuccessAt` there is historical.

## Recovery and migration boundary

Code only, reversible by a revert, which restores the AIR-64 route behind the still-unset `RATINGS_REFRESH`. The deploy changes no binding and no R2 object. Removing a leftover binding or deleting stored ratings objects is a separate owner-approved operation. This record authorizes no production request.

## Evidence

- **Original decision:** owner decision on AIR-92, 2026-10-29.
- **Implementation:** `src/enrichment.js`, `src/feature-flags.js`, `tests/ratings-refresh.mjs`, `tests/feature-flags.mjs`.
- **Dated verification:** `feature_flags` read of 2026-10-29 05:16 UTC (binding absent); the post-deploy read-only check is a follow-up.
- **Uncertainty:** none known about stored objects; their contents were not read for this change.

## Follow-ups

After deployment, a read-only check that `feature_flags` lists `RATINGS_REFRESH` as retired and that `GET /api/enrichment/ratings/status` still answers. A production request to the retired route is not part of that check.
