# ADR 0201: Prediction recovery admits a stored Letterboxd id through the catalog film of the same trusted canonical Film

**Status:** Proposed (owner chose option C for the 11 `not_admitted` films and then the stored-id key approach on 2026-11-22 in the [AIR-478 thread](https://trello.com/c/IbsSCRce); this ADR awaits independent review and explicit owner acceptance)  
**Original decision date:** 2026-11-22  
**Recorded at:** 2026-11-22  
**Approval source:** [AIR-478 owner decision C](https://trello.com/c/IbsSCRce) (direction only; no production operation authorized)  
**Related work:** [AIR-478](https://trello.com/c/IbsSCRce)  
**Supersedes:** None  
**Amends:** [ADR 0165](0165-scoped-prediction-recovery-intent.md) decision 6 only for stored Letterboxd ids whose Film is already in the admitted catalog; the rest of decision 6 is unchanged  
**Superseded by:** None

## Context

A film the owner has watched leaves the watchlist. The admitted catalog (D1 `discovery_admission`, state `current`) then holds it under `tmdb_<n>`, while its prediction pointer, fingerprint and lineage stay under the stored Letterboxd id (for example `21XQ`). The recovery preview looked a stored id up by that exact key in the admitted set, so seven of eleven films were `blocked/not_admitted` although their Film is admitted. Read-only D1 checks on 2026-11-22 (`rows_written=0`) showed all 11 Films with trusted, non-conflicting identity and a current admission row. Under D1 authority the catalog is served from D1, not from an R2 mirror.

## Decision

1. **The stored id stays the key of prediction state.** No state, pointer, fingerprint or lineage is renamed or copied.
2. **One alias rule.** For a stored Letterboxd id the canonical Film bridge (`catalogFilmIdentityBridge`, trusted claims only, no title or year matching) must answer `ok` with `lid` equal to that id and a trusted TMDB id. The catalog id is then `tmdb_<tmdb>`. Absent, retired, conflicting or unreadable identity yields no alias and the film stays outside admission.
3. **Three consumers use the rule, and only for ids the caller names.** The recovery preview admits through the alias; the queue builder presents the catalog film under the stored id for each active recovery intent, so the index, the intent overlay and the manifest agree on one key; `readFilmsById` resolves a stored id that has no catalog entry of its own through the alias. No scan of the catalog or of lifetime Films is added.
4. **Not decided or changed.** Admission of films with no current catalog entry (retention-only) is not added. Nothing is added to the watchlist, no Discovery observation is created, the retry budget is never reset, and confirming an intent stays a separate owner action.

## Alternatives considered

- Migrating prediction state to the catalog key: rejected for AIR-478, an L3 data migration that rewrites immutable lineage.
- Fixing only the preview: rejected, the queue and manifest would still not find the film under the stored id.

## Consequences

The alias costs one bridge read per active intent per queue rebuild (bounded by the active-intent cap). A film whose identity cannot be read is simply not aliased.

## Recovery and migration boundary

Code only; no data written. Reverting the code restores the previous preview and queue. This ADR authorizes no flag, Task, production write or intent confirmation.

## Evidence

- **Original decision:** [AIR-478](https://trello.com/c/IbsSCRce)
- **Implementation:** the pull request that adds this ADR
- **Dated verification:** read-only D1 queries on 2026-11-22 (all 11 Films trusted, all with a current admission row)
- **Uncertainty:** why the preview of 2026-11-22 marked four `tmdb_*` ids `not_admitted` is not established; a repeated owner-only preview is needed.

## Follow-ups

Owner-gated: the exact confirmation of recovery intents for the allowlist after this code is deployed.
