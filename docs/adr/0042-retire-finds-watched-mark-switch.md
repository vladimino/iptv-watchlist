# ADR 0042: The owner's «Смотрел» mark has no switch of its own, and FINDS_WATCHED_MARK is retired

**Status:** Accepted 2026-10-29 (explicit owner approval; no production configuration authorization)  
**Original decision date:** 2026-10-29  
**Recorded at:** 2026-10-29  
**Approval source:** owner flag disposition `retire now`, keeping the behaviour of the current value, given in the AIR-230 session on 2026-10-29; owner explicitly accepted ADR-0042 in the AIR-230 PR #220 conversation on 2026-10-29; separate approval is required to delete the production binding  
**Related work:** [AIR-230](https://trello.com/c/AW2GqqQL); prerequisites [AIR-214](https://trello.com/c/dX5YZlFY) (implementation) and [AIR-215](https://trello.com/c/MC9Ku87Z) (rollout); [ADR-0032](0032-owner-watched-mark-by-tmdb-identity.md); [ADR-0023](0023-letterboxd-user-facts.md); [ADR-0039](0039-allowlisted-feature-flag-readout.md)  
**Supersedes:** [ADR-0032](0032-owner-watched-mark-by-tmdb-identity.md) in part: the mark's own switch in decision 6 and the switch-based disable; the `LETTERBOXD_FACTS` gate of decision 6 and every other guard stay  
**Superseded by:** None

## Context

ADR-0032 gave the owner's «Смотрел» mark two gates: `LETTERBOXD_FACTS=on`, because the mark writes only through the fact records, and a switch of its own, `FINDS_WATCHED_MARK`, enabled only by the exact string `on`. The own switch was a rollout gate. AIR-215 set it on 27 October 2026 after the owner had read `LETTERBOXD_FACTS: on`, and the owner has marked films from Finds since. The owner-only `feature_flags` read of 2026-10-29 06:26 UTC showed `FINDS_WATCHED_MARK` set to `on` and valid, with its `LETTERBOXD_FACTS` requirement met.

The route is not a sensitive one-off write. It writes one owner `watched` fact for one verified catalog film, and the owner can revoke the mark at once. It stays behind the owner-only Access application, a strict same-origin check, a 512-character JSON body with exactly `tmdbId` and `watched`, and the published-catalog TMDB identity check. The switch only duplicates a decision the owner has already taken.

## Decision

1. `POST /api/catalog/watched` and the «Смотрел» button no longer read a switch of their own. They are available exactly while `LETTERBOXD_FACTS` is `on`, which is the behaviour of the production value `FINDS_WATCHED_MARK=on`. `GET /api/catalog/available` reports `watchedMarkEnabled: true` exactly then.
2. `FINDS_WATCHED_MARK` is retired. The Worker never reads it, and a binding of any value is inert. It stays in the `feature_flags` registry as retired, so the leftover binding is visible.
3. Unchanged: the `LETTERBOXD_FACTS` gate (`409 facts_disabled`), method, origin, content type, body shape and catalog identity guards, the fact record and projection, revocation, and the client behaviour. The refusal `409 mark_disabled` no longer exists.
4. Stopping new marks is done by switching `LETTERBOXD_FACTS` off, which also stops every other fact writer, or by a code revert.

5. **The binding is removed as the last step of the retirement.** After the code is merged and deployed and the read-only checks pass, the owner removes the exact `FINDS_WATCHED_MARK` binding from Worker `iptv` under a separate, action-specific authorization, and its absence is read back (`feature_flags`: `state: absent`). That removal and readback are the final acceptance of AIR-230: the card stays open until the binding is gone. `keep_vars: true` means no deployment removes it.

Not decided here: any change to the facts gate, the guards or the fact model. Neither the acceptance of this record nor the approval of its PR authorizes a settings change; the binding removal in decision 5 needs its own owner authorization.

## Alternatives considered

- **Retain as a permanent operational gate.** Considered and not chosen by the owner. It would keep a second switch on a reversible, owner-only, single-fact write that already sits behind Access, origin and identity guards and the facts gate.
- **Retire after stabilization.** Not chosen. The mark has run in production since 27 October with owner use, and no further rollout step depends on the switch.

## Consequences

- One code path for the route and the button. The `mark_disabled` branch, its tests and its documentation go away.
- New marks can no longer be stopped while the other fact writers keep running; stopping them means switching the facts gate off or reverting the code.
- Until the owner removes it as the last step of AIR-230, the leftover `FINDS_WATCHED_MARK` binding stays and changes nothing.

## Recovery and migration boundary

Reversible by a code revert. Before the binding is removed, the switch comes back and the leftover binding `on` keeps the mark available. After the binding is removed, a revert to code that reads the switch also needs the original `FINDS_WATCHED_MARK=on` restored on Worker `iptv` (owner authorization), or the mark answers `409 mark_disabled`. Marks already written stay valid owner facts in every case. This record authorizes no flag, binding, R2 or D1 change.

## Evidence

- **Original decision:** owner disposition in the AIR-230 session on 2026-10-29.
- **Implementation:** `src/worker.js`, `src/feature-flags.js`, `tests/finds-watched-mark.mjs`, `tests/feature-flags.mjs`.
- **Dated verification:** `feature_flags` read 2026-10-29 06:26 UTC: `FINDS_WATCHED_MARK` `state: set`, `raw: on`, `valid: true`, `effective: on`, `unmetRequirements: []`. A read-only `GET /api/catalog/available` after deployment (`watchedMarkEnabled: true`) is the acceptance step; no production mark is written for it.
- **Uncertainty:** none on behaviour. The read shows the binding, not when it was last changed.

## Follow-ups

None outside AIR-230: the binding removal and its readback (decision 5) close that card.
