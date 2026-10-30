# ADR 0053: The Letterboxd baseline import is a permanent owner-only maintenance route, and LETTERBOXD_BASELINE_IMPORT is retired

**Status:** Proposed (owner decision `retire now` recorded; ADR acceptance pending; no production configuration authorization)  
**Original decision date:** 2026-10-30  
**Recorded at:** 2026-10-30  
**Approval source:** owner decision recorded on AIR-181 on 2026-10-30: retire only `LETTERBOXD_BASELINE_IMPORT` and keep the baseline import API as a permanent owner-only maintenance route, as for AIR-228; acceptance of this record is pending; separate approval is required to delete the production binding  
**Related work:** [AIR-181](https://trello.com/c/d6x0pvuc); prerequisites [AIR-171](https://trello.com/c/uvGt48sq) (importer) and [AIR-173](https://trello.com/c/w2bVRb72) (first production import); [AIR-285](https://trello.com/c/FFMUP4qm) (planned admin client); [ADR-0023](0023-letterboxd-user-facts.md) decision 6; [ADR 0048](0048-permanent-catalog-poster-maintenance-route.md) (the same pattern for poster hydration); [ADR-0039](0039-allowlisted-feature-flag-readout.md)  
**Supersedes:** None. ADR-0023 decides the import protocol (decision 6) but no switch for it; the switch was the rollout gate of the AIR-171 implementation, and this record retires that gate only. The `LETTERBOXD_FACTS` requirement and every part of the protocol stay  
**Superseded by:** None

## Context

ADR-0023 decision 6 made the baseline import a typed, bounded, idempotent, crash-recoverable operation: validate (no write), commit in bounded chunks with an intent before and a receipt after each, read back, and a rollback that restores a before-image only where the export's observation is still current. AIR-171 implemented it as `/api/letterboxd/baseline/validate`, `/commit` and `/rollback`, behind two switches: `LETTERBOXD_FACTS=on`, because without the facts writers the routine sync would clear imported ratings by absence, and a rollout gate of its own, `LETTERBOXD_BASELINE_IMPORT=on`. AIR-173 ran the first production import on 27 October 2026 with the gate on and set it back to off afterwards. The owner-only `feature_flags` read of 2026-10-30 10:21 UTC showed `LETTERBOXD_BASELINE_IMPORT` set to `off` and `LETTERBOXD_FACTS` set to `on`.

The owner wants the route kept for further archive imports and rollbacks; the planned admin page (AIR-285) will drive it. The second switch now only adds a settings change in front of every such run. Access is already owner-only: every `/api` route sits behind the Worker's Cloudflare Access application.

## Decision

1. **The route is permanent maintenance.** `/api/letterboxd/baseline/validate`, `/commit` and `/rollback` stay under their names and contract. No variable of its own gates them; the `409 import_disabled` answer no longer exists.
2. **`LETTERBOXD_BASELINE_IMPORT` is retired.** The Worker never reads it, and a binding of any value is inert. It stays in the `feature_flags` registry as retired, so the leftover binding is visible; no registered flag declares a requirement any more.
3. **The facts requirement stays.** The route answers `409 facts_disabled` unless `LETTERBOXD_FACTS=on`, as before.
4. **Access is unchanged.** The Worker's owner-only Cloudflare Access is the only access control. No separate permission check, token, role, middleware or switch is added. The CLI keeps sending the Cloudflare Access service-token headers only when they are set in its environment; the token used for the first import has been revoked, and issuing a credential for a remote step is a separate owner decision. The AIR-285 browser transport is designed separately and does not bypass Access.
5. **Data safeguards are unchanged.** Strict input and archive and plan identity, accepted identities only, bounded chunks, the freshness order of observations, create-only intents and receipts, idempotent replay and resume, compare-and-swap, partial-failure recovery and a rollback that keeps later observations all stay.
6. **Every production `validate`, `commit` and `rollback` stays a separate owner-approved operation.** Nothing runs on a schedule or after a dry run by itself; a deploy approves no call.
7. **The binding is removed as the last step of the retirement.** After the code is merged and deployed and the read-only checks pass, the owner removes the exact `LETTERBOXD_BASELINE_IMPORT` binding from Worker `iptv` under a separate, action-specific authorization, and its absence is read back (`feature_flags`: `state: absent`, `invalid: 0`). That removal and readback are the final acceptance of AIR-181: the card stays open until the binding is gone. `keep_vars: true` means no deployment removes it. `LETTERBOXD_FACTS` is not removed.

Not decided here: any change to the import protocol, the facts model or the CLI transport, and the admin page itself (AIR-285). Neither the acceptance of this record nor the approval of its PR authorizes a settings change, an Access change, an import call or an R2 write; the binding removal in decision 7 needs its own owner authorization.

## Alternatives considered

- **Delete the route with the switch.** Rejected by the owner: a later export or a rollback would then need new code.
- **Keep the switch as a permanent gate.** Rejected by the owner: it duplicates the owner-only Access boundary and the per-call approval, and the admin page would depend on a settings change before every run.
- **Add a separate token or permission check for the route.** Rejected: every `/api` route already sits behind the owner-only Access application.

## Consequences

- One gate fewer; the `import_disabled` branch, its tests and its documentation go away. `LETTERBOXD_FACTS` remains the route's only switch.
- An import call no longer needs a settings change first. The per-call owner approval, Access and the data safeguards are what bound it.
- Until the owner removes it as the last step of AIR-181, the leftover `LETTERBOXD_BASELINE_IMPORT` binding stays and changes nothing.

## Recovery and migration boundary

Reversible by a code revert. Before the binding is removed, the switch comes back with the leftover value `off`, which refuses import calls until the owner sets `on`. After the binding is removed, a revert to code that reads the switch also refuses them until `LETTERBOXD_BASELINE_IMPORT=on` is restored on Worker `iptv` (owner authorization). A revert undoes no imported fact or receipt; the `rollback` step does that while the receipts exist. This record authorizes no flag, binding, Access, R2 or D1 change.

## Evidence

- **Original decision:** owner decision recorded on AIR-181 on 2026-10-30.
- **Implementation:** `src/letterboxd-facts.js`, `src/feature-flags.js`, `tests/letterboxd-baseline-import.mjs`, `tests/letterboxd-baseline-chunks.mjs`, `tests/rating-history.mjs`, `tests/feature-flags.mjs`.
- **Dated verification:** AIR-173 production import (recorded on the card); `feature_flags` read 2026-10-30 10:21 UTC: `LETTERBOXD_BASELINE_IMPORT` `state: set`, `raw: off`, `valid: true`; `LETTERBOXD_FACTS` `on`. After deployment, a `feature_flags` read showing the switch as retired is the acceptance step; no import call, not even `validate`, is made in production for it without separate approval.
- **Uncertainty:** the route cannot be reached from a remote CLI until the owner decides on an Access credential; that is unchanged by this record.

## Follow-ups

None outside AIR-181: the binding removal and its readback (decision 7) close that card. AIR-285 builds the admin client on this contract.
