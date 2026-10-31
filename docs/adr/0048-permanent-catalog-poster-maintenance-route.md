# ADR 0048: Catalog poster hydration is a permanent owner-only maintenance route, and CATALOG_POSTER_HYDRATION is retired

**Status:** Accepted 2026-10-29 (architecture only; no production configuration authorization)  
**Original decision date:** 2026-10-29  
**Recorded at:** 2026-10-29  
**Approval source:** explicit owner acceptance of ADR-0048 and visual approval of the rendered Mermaid diagram in the AIR-228 PR #238 conversation on 2026-10-29; separate approval is required to remove the production binding  
**Related work:** [AIR-228](https://trello.com/c/jhRjobcA); [AIR-15](https://trello.com/c/Yz6SGd3R) (route and one-time run); [AIR-283](https://trello.com/c/s35GwqRz) (planned admin client); [ADR-0020](0020-owner-triggered-catalog-poster-hydration.md); [ADR-0039](0039-allowlisted-feature-flag-readout.md)  
**Supersedes:** [ADR-0020](0020-owner-triggered-catalog-poster-hydration.md) in part: the `CATALOG_POSTER_HYDRATION` gate and the one-time framing of the operation. The route, the read-only dry run, the verified-identity rule, the resolver lease, the generation and compare-and-swap checks, the batch limit, the outcomes and receipts, and the owner approval of every production execution call stay  
**Superseded by:** [ADR 0062](0062-catalog-poster-negative-index.md) (Proposed) in part: terminal `no_poster_on_tmdb` and `tmdb_id_mismatch` answers are retained, and the ordinary queue no longer revisits them. The route, the dry run, the identity rule, the lease, generation and compare-and-swap checks, the batch limit and the per-call owner approval stay

## Context

ADR-0020 added `POST /api/enrichment/catalog/posters` to fill the `poster` field of verified catalog records from TMDB movie detail, behind the off-by-default switch `CATALOG_POSTER_HYDRATION` (exact string `on`), as a one-time bounded operation. AIR-15 ran it on 26 October 2026: a pilot of 10, then 1,679 posters in 84 batches; the read-only check afterwards left one verified record without an image (`tmdb_895123`), and the visual smoke of five cards passed. The owner-only `feature_flags` read of 2026-10-29 18:03 UTC showed the switch set to `off`.

The owner wants the route kept to restore posters after a mass TMDB discovery failure, and the planned data health admin page (AIR-283) will drive it with a preview, a confirmation and progress. The switch now only adds a settings change in front of every such run. Access is already owner-only: every `/api` route sits behind the Worker's Cloudflare Access application.

## Decision

1. **The route is permanent maintenance.** `POST /api/enrichment/catalog/posters` stays under its name and contract. Execution (`dryRun: false`) is no longer gated by a variable; the `409 Catalog poster hydration is off` answer no longer exists. `enabled` stays in the answers and is always `true`.
2. **`CATALOG_POSTER_HYDRATION` is retired.** The Worker never reads it, and a binding of any value is inert. It stays in the `feature_flags` registry as retired, so the leftover binding is visible.
3. **Access is unchanged.** The Worker's owner-only Cloudflare Access and the same-origin check of the sibling POST routes are the only access control. No separate permission check, token, role or switch is added. The AIR-283 confirmation guards against an accidental start; it is not an authorization.
4. **Data safeguards are unchanged.** The read-only dry run (no TMDB request, no write), `limit` 1–20, the cursor, `done` and `retryable`, the verified-identity rule, TMDB pacing and the `429`/`retryAt` stop, the resolver lease and its `409`, the published-generation check, the compare-and-swap on each catalog copy, the poster-only write and the partial-write reports all stay. They protect the data, not access.
5. **Every production execution call stays a separate owner-approved operation.** Nothing runs on a schedule; a deploy approves no call.
6. **The binding is removed as the last step of the retirement.** After the code is merged and deployed and the read-only checks pass, the owner removes the exact `CATALOG_POSTER_HYDRATION` binding from Worker `iptv` under a separate, action-specific authorization, and its absence is read back (`feature_flags`: `state: absent`). That removal and readback are the final acceptance of AIR-228: the card stays open until the binding is gone. `keep_vars: true` means no deployment removes it.

Not decided here: any change to the write rules, a scheduled or automatic hydration, or the admin page itself (AIR-283). Neither the acceptance of this record nor the approval of its PR authorizes a settings change, an execution call or an R2 write; the binding removal in decision 6 needs its own owner authorization.

## Alternatives considered

- **Delete the route with the switch.** Rejected by the owner: a mass TMDB discovery failure would then need new code before posters could be restored.
- **Keep the switch as a permanent gate.** Rejected by the owner: it duplicates the owner-only Access boundary and the per-call approval, and it would make the admin page depend on a settings change before every run.
- **Add a separate owner permission check, token or role for the route.** Rejected: every `/api` route already sits behind the owner-only Access application; a second mechanism would diverge from the sibling write routes.

## Consequences

- One execution path; the switch check, its `409` and its tests and documentation go away. The dry run is unchanged.
- An execution call no longer needs a settings change first. The per-call owner approval and the data safeguards are what bound it.
- The architecture diagram's owner node no longer names the switch.
- Until the owner removes it as the last step of AIR-228, the leftover `CATALOG_POSTER_HYDRATION` binding stays and changes nothing.

## Recovery and migration boundary

Reversible by a code revert. Before the binding is removed, the switch comes back with the leftover value `off`, which refuses execution calls until the owner sets `on`. After the binding is removed, a revert to code that reads the switch also refuses execution until `CATALOG_POSTER_HYDRATION=on` is restored on Worker `iptv` (owner authorization). Posters already written stay in every case; they are TMDB assets of the verified ids. This record authorizes no flag, binding, execution, R2 or D1 change.

## Evidence

- **Original decision:** owner decision recorded on AIR-228 on 2026-10-29.
- **Implementation:** `src/discovery.js`, `src/feature-flags.js`, `tests/catalog-posters.mjs`, `tests/feature-flags.mjs`.
- **Dated verification:** AIR-15 one-time run of 26 October 2026 (recorded on the card); `feature_flags` read 2026-10-29 18:03 UTC: `CATALOG_POSTER_HYDRATION` `state: set`, `raw: off`, `valid: true`. After deployment, a `feature_flags` read showing the switch as retired is the acceptance step; no route call, not even a dry run, is made in production for it without separate approval.
- **Uncertainty:** none on behaviour. The read shows the binding, not when it was last changed.

## Follow-ups

None outside AIR-228: the binding removal and its readback (decision 6) close that card. AIR-283 builds the admin client on this contract.
