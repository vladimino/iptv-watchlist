# ADR 0054: Letterboxd facts are the only model for watched, rating and watchlist, and LETTERBOXD_FACTS is retired

**Status:** Proposed (owner decision `retire now` recorded; ADR acceptance pending; no production configuration authorization)  
**Original decision date:** 2026-10-30  
**Recorded at:** 2026-10-30  
**Approval source:** owner decision recorded on AIR-182 on 2026-10-30: retire `LETTERBOXD_FACTS` and keep the behaviour of its production value `on` unconditionally; acceptance of this record is pending; separate approval is required to delete the production binding  
**Related work:** [AIR-182](https://trello.com/c/Kc2Uif73); prerequisites [AIR-170](https://trello.com/c/UaOFSsF9), [AIR-171](https://trello.com/c/uvGt48sq), [AIR-172](https://trello.com/c/FvqqJ8H0), [AIR-173](https://trello.com/c/w2bVRb72) and [AIR-181](https://trello.com/c/d6x0pvuc); [ADR-0023](0023-letterboxd-user-facts.md); [ADR-0024](0024-letterboxd-scan-summary.md); [ADR-0032](0032-owner-watched-mark-by-tmdb-identity.md); [ADR 0042](0042-retire-finds-watched-mark-switch.md); [ADR 0053](0053-permanent-letterboxd-baseline-import-route.md); [ADR-0039](0039-allowlisted-feature-flag-readout.md)  
**Supersedes:** in part, the `LETTERBOXD_FACTS` gate wherever an accepted record keeps it: [ADR-0032](0032-owner-watched-mark-by-tmdb-identity.md) decision 6 (the facts requirement and its `409 facts_disabled`), [ADR 0042](0042-retire-finds-watched-mark-switch.md) decisions 1, 3 and 4 (the mark follows the gate; stopping marks by switching it off) and [ADR 0053](0053-permanent-letterboxd-baseline-import-route.md) decision 3 (the baseline route's facts requirement). ADR-0023 and ADR-0024 decide the facts model, not a switch for it; the switch was the rollout gate of the AIR-171 implementation. Every other decision of those records stays  
**Superseded by:** None

## Context

ADR-0023 made watched, rating and watchlist separate Letterboxd facts with provenance, where only a greater observation replaces a value, and ADR-0024 stored a complete scan once as a summary observation, so absence from a list never clears a rating. AIR-171 implemented both behind `LETTERBOXD_FACTS`, enabled only by the exact string `on`, because turning it on changes what the routine EPG sync writes to R2. With the gate off, the films-list scan wrote `actualRating` straight into the view index and assigned `null` to watchlist films it did not see; the per-film lookup and the owner rating edit wrote the view index directly and appended to the legacy change log `enrichment/diagnostics/rating-observations.json`.

The owner set the gate on 27 October 2026 for the AIR-173 baseline import and kept it on. The owner's watched mark (ADR-0032, ADR 0042) and the baseline import route (ADR 0053) work only through the fact records, so both answered `409 facts_disabled` without it. The owner-only `feature_flags` read of 2026-10-30 12:51 UTC showed `LETTERBOXD_FACTS` set to `on`, valid and effective `on`.

Switching the gate off is not a safe rollback any more. The legacy scan would clear the ratings of every imported film that the public films list does not show, the watched mark would disappear from Finds and the baseline route would close.

## Decision

1. **Every Letterboxd writer records facts.** The EPG commit's films-list scan, the per-film lookup (and the removed-film, diary and baseline repairs that call it), the owner `PUT /api/enrichment/actual-ratings`, the owner watched mark and the completed watchlist sync always write fact records and scan summaries under `letterboxd/facts/` and project `actualRating`, `watched` and `watchlist` into the view index. This is the behaviour of the production value `on`. Absence from a list never clears a rating; a listed film without a rating becomes watched and not rated.
2. **The legacy writers are removed.** The direct view-index branches of the scan, the lookup and the owner edit and the writer of the legacy change log go away. The stored log stays readable history for the accuracy and film-history readers; nothing deletes it.
3. **`LETTERBOXD_FACTS` is retired.** The Worker never reads it, and a binding of any value (absent, `off`, a near miss, a non-string) is inert. It stays in the `feature_flags` registry as retired, so the leftover binding is visible.
4. **The routes that needed the gate need nothing else.** `POST /api/catalog/watched` and `/api/letterboxd/baseline/{validate,commit,rollback}` no longer answer `409 facts_disabled`; `watchedMarkEnabled` is always `true`. Every other guard is unchanged: the mark's method, origin, content type, body shape and catalog identity checks; the baseline route's strict input, archive and plan identity, accepted identities only, bounded chunks, create-only intents and receipts, idempotent replay and resume, compare-and-swap, partial-failure recovery and a rollback that keeps later observations. Access stays the Worker's owner-only Cloudflare Access plus the existing origin checks; no token, role or switch is added.
5. **Unchanged:** the fact model, the merge order, the link index, identity conflicts, the projection under every trusted alias, the ratings generation of the EPG commit, `REMOVAL_RATING_LOOKUP` and `LETTERBOXD_DIARY_HISTORY`, which stay separate active switches, and the readers of the view index.
6. **Returning to the legacy writers is a code revert, never a flag.**
7. **The binding is removed as the last step of the retirement.** After the code is merged and deployed and the read-only checks pass, the owner removes the exact `LETTERBOXD_FACTS` binding from Worker `iptv` under a separate, action-specific authorization, and its absence is read back (`feature_flags`: `state: absent`, `retired: true`, `invalid: 0`). That removal and readback are the final acceptance of AIR-182: the card stays open until the binding is gone. `keep_vars: true` means no deployment removes it.

Not decided here: any change to the fact model, the convergence migration, the import protocol, the Diary sources or the removal lookup. Neither the acceptance of this record nor the approval of its PR authorizes a settings change, an EPG run, a Letterboxd or TMDB request, an import call or an R2 or D1 write; the binding removal in decision 7 needs its own owner authorization.

## Alternatives considered

- **Retain as a permanent operational gate.** Not chosen by the owner. Its only use would be to switch back to the legacy writers, which clear imported ratings by absence and close the watched mark and the baseline route.
- **Retire after stabilization.** Not chosen. The fact writers have run in production since 27 October with the baseline import committed on top of them, and no further rollout step depends on the switch.

## Consequences

- One write path for every Letterboxd fact. The `off` branches, the `409 facts_disabled` answers, their tests and their documentation go away, and the legacy change log stops growing.
- The legacy writers cannot be brought back at runtime. A storage failure or an identity conflict stops a write exactly as before.
- A film that only the legacy writers ever touched keeps its stored view values until a source observes it; projections come only from records.
- Until the owner removes it as the last step of AIR-182, the leftover `LETTERBOXD_FACTS` binding stays and changes nothing.

## Recovery and migration boundary

Reversible by a code revert. Before the binding is removed, the switch comes back and the leftover binding `on` keeps today's behaviour. After the binding is removed, a revert to code that reads the switch also needs `LETTERBOXD_FACTS=on` restored on Worker `iptv` (owner authorization) before that code is deployed, or the next sync clears ratings by absence, the watched mark closes and the baseline route answers `409 facts_disabled`. Fact records, summaries, the link index and the legacy log stay in R2 in every case; the Worker never deletes them. This record authorizes no flag, binding, Access, R2 or D1 change.

## Evidence

- **Original decision:** owner decision recorded on AIR-182 on 2026-10-30.
- **Implementation:** `src/enrichment.js`, `src/worker.js`, `src/letterboxd-facts.js`, `src/feature-flags.js`; tests `tests/letterboxd-facts.mjs`, `tests/ratings.mjs`, `tests/removal-ratings.mjs`, `tests/finds-watched-mark.mjs`, `tests/letterboxd-baseline-import.mjs`, `tests/catalog-available-user-facts.mjs`, `tests/feature-flags.mjs` and the loaders that now include the facts module.
- **Dated verification:** AIR-173 production import (recorded on the card); `feature_flags` read 2026-10-30 12:51 UTC: `LETTERBOXD_FACTS` `state: set`, `raw: on`, `valid: true`, `effective: on`. After deployment, a `feature_flags` read showing the switch as retired is the acceptance step; no EPG run, lookup, mark or import call is made in production for it.
- **Uncertainty:** the read shows the binding, not when it was last changed.

## Follow-ups

None outside AIR-182: the binding removal and its readback (decision 7) close that card.
