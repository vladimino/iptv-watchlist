# AIR-131 group assign, offline tests and visual QA

20 November 2026 (UTC). Offline only: D1 stand-in (sqlite), no production read or write, no TMDB call, no screenshots stored.

Scope: [ADR 0181](../../adr/0181-owner-confirmed-group-assign-of-selected-observations.md), `discovery_identity_group_assign@1`, routes `group-preview`, `group-confirm`, `group-execute`, `group-receipt`, page `/admin/identity/group`.

Tests: `tests/discovery-identity-group.mjs` (pure domain, backend, issuance, barrier, replay, drift, lease, budget, expiry, GET no-write) and `tests/admin-identity-group-page.mjs` (page, entry links).

Limits: no production identity or group POST was made; production behaviour is unproven until an owner-run action. Browser visual QA result is in the pull request.

## Owner UX acceptance fix (same day)

The owner rejected the first production page (empty required id field, English browser tooltip, no visible entry). The fix adds a permanent entry in the heading of `/admin/identity`, a start without an id (bounded EPG worklist and catalogue search by title, only a trusted TMDB id can start a group), controlled Russian inline validation (`novalidate`, `role=alert`, focus) and a Russian explanation of a missing basis or acknowledgement. No route, migration or D1 change.

Offline tests: `tests/admin-identity-group-page.mjs` (journey without an id, empty, failed and stale worklist, search success, empty and failure, untrusted and conflicting ids, escaping, invalid id and empty fields in Russian, no POST anywhere in the journey, no `required` or `pattern` in the HTML, the entry in the queue heading).

Real Chromium (stubbed API, English browser locale, no screenshots stored), 1280 and 390 px, keyboard (Tab, Enter, Space): the entry is visible on the first screen of `/admin/identity` at both widths; the group page opens on the worklist; an empty search, an empty basis, a missing acknowledgement and a non-numeric id each show their Russian message with focus on the field; the pick button works with Enter; no horizontal overflow; no page error; no POST.

The review of that fix added: the chosen EPG record's row key travels through the journey and is compared with the group candidates by observation key (absent, blocked with reasons, present and marked, never selected for the owner), and worklist rows show Russian status and reason text with a Russian fallback for unknown codes (tests for both, including a preview that returns only another observation).

Limits: no production request or write was made.
