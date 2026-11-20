# AIR-131 group assign, offline tests and visual QA

20 November 2026 (UTC). Offline only: D1 stand-in (sqlite), no production read or write, no TMDB call, no screenshots stored.

Scope: [ADR 0181](../../adr/0181-owner-confirmed-group-assign-of-selected-observations.md), `discovery_identity_group_assign@1`, routes `group-preview`, `group-confirm`, `group-execute`, `group-receipt`, page `/admin/identity/group`.

Tests: `tests/discovery-identity-group.mjs` (pure domain, backend, issuance, barrier, replay, drift, lease, budget, expiry, GET no-write) and `tests/admin-identity-group-page.mjs` (page, entry links).

Limits: no production identity or group POST was made; production behaviour is unproven until an owner-run action. Browser visual QA result is in the pull request.
