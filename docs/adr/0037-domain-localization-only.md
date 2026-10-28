# ADR 0037: The domain localization rule is the only localization of the programme and watchlist reads and of the EPG commit

**Status:** Proposed (owner decision required before merge)  
**Original decision date:** 2026-10-28  
**Recorded at:** 2026-10-28  
**Approval source:** [AIR-89](https://trello.com/c/vzR0uuZq) scope (domain as the only executed path for `programme`, `watchlist` and the EPG write localization; `metadata` stays default-off; rollback by redeploy of the previous verified commit) set by the owner on 2026-10-28 after the [AIR-42](https://trello.com/c/drLBuWjl) acceptance of the staged rollout; the explicit Accepted/Declined decision for this record is pending  
**Related work:** [AIR-42](https://trello.com/c/drLBuWjl), [AIR-89](https://trello.com/c/vzR0uuZq), [AIR-79](https://trello.com/c/485tlGLA); [ADR 0009](0009-canonical-film-person-identity.md), [ADR 0036](0036-scored-resolution-only.md); [lifecycle audit and rollout log](../evidence/film-person/lifecycle-audit-and-rollout.md)  
**Supersedes:** None. The per-path `off` / `shadow` / `on` rollout boundary that this record closes was recorded in the rollout log above, not in an ADR  
**Superseded by:** None

## Context

The AIR-42 lifecycle work introduced a second localization rule for titles and names, built on the pure domain module (`src/domain/film-person.js`): a cached automatic value is applied through a guarded transition that never downgrades a reviewed value, a reviewed dictionary value is applied only when the stored value's provenance allows it, and an owner-authored or unexplained reviewed value is kept with an explicit `titleConflicts` / `nameConflicts` entry instead of being overwritten. The earlier rule (the "legacy" one) copied the dictionary or the cache over the stored value unconditionally.

To roll the new rule out safely, `src/sources.js` and `src/worker.js` kept both rules behind the Worker variable `LIFECYCLE_LOCALIZATION`, independently for four call paths: the metadata sync (`metadata`), the EPG commit's write localization of the in-memory watchlist (`epg`), and the two reads `GET /api/programme` (`programme`) and `GET /api/watchlist` (`watchlist`). `off` ran the legacy rule, `shadow` ran both and reported comparison counts (an `X-Lifecycle-Localization` response header on the reads, `lifecycleLocalization` counters in the sync record), `on` ran the domain rule. The rollout log records the staged switch of 22–23 October 2026 and the final binding `on:programme,on:watchlist,on:epg`, with `metadata` left off; AIR-42 accepted the ordinary EPG write path on it.

Since then the legacy rule for the three accepted paths has been dead code that configuration could bring back: a missing or malformed binding, or a dropped token, selected the legacy rule for a path and silently overwrote owner-kept titles and names on the next read or commit, and `shadow` re-enabled a comparison against a rule that is no longer meant to run. The metadata path has not been through its own acceptance.

## Decision

The domain localization rule is the only localization of the programme and watchlist reads and of the EPG commit.

- `presentLocalized` (both reads) and `applyEpgLocalization` (the EPG commit) run the domain rule on every call and take no mode. `localizeFilmTitles` is called by the EPG commit with the domain rule. The legacy branches of these paths, the shadow comparison for them (`X-Lifecycle-Localization`, the `epg` entry of `lifecycleLocalization` in the sync record) and the per-path mode selection are removed.
- `LIFECYCLE_LOCALIZATION` is read once, by the metadata sync, through `metadataLocalizationMode`: `on:metadata` selects the domain rule, `shadow:metadata` the comparison, anything else the legacy rule (the metadata path's accepted default). The retired tokens `on:epg`, `on:programme`, `on:watchlist` and their `shadow:` forms are ignored; a binding that still carries them is inert for those paths. The absence of the variable does **not** enable the domain rule for metadata.
- Unchanged: the domain rule itself and its guards (reviewed values are never downgraded, owner authority wins and is recorded as a conflict, aliases accumulate), the reviewed dictionaries and the `REVIEWED_PEOPLE` override, the Letterboxd and TMDB identities, the response format of the reads apart from the removed diagnostic header, the published generation pin of the reads (they present the stored programme as published), and R2 as the production authority.

Not decided here: enabling the domain rule for the metadata sync (a separate acceptance), removing the stale path tokens from the Worker binding (a separate owner-approved settings change with a read-only check), and the D1 authority cutover.

## Alternatives considered

- **Keep the per-path flag with `on` as the default for the three paths.** Rejected: it keeps the legacy rule reachable from configuration for paths whose rollout is complete, which is the drift AIR-89 was opened to close, and an absent binding would then mean different things for different paths.
- **Retire the variable entirely and switch metadata to the domain rule as well.** Rejected: the metadata sync writes `titles.json`, `people.json` and `metadata.json`; its localization has not been accepted and the card explicitly keeps it default-off.
- **Keep `shadow` for the three paths as a diagnostic.** Rejected: the comparison measured the domain rule against the legacy one; without the legacy rule the counts have no meaning, and the shadow measurements of the rollout stay in the evidence log.

## Consequences

- One localization rule on the reads and the EPG commit; an owner-kept title or name can no longer be overwritten by a configuration change. The comparison header disappears from the reads and the `epg` counters from the sync record; the metadata counters stay while the metadata path is flag-gated.
- The flag register, the Film/Person reference and the lifecycle architecture page describe the variable as a metadata-only switch; the rollout log stays as history.
- Tests state the invariant: the reads return one and the same body, without the header, for the absent variable, every retired token, `off`, `shadow`, a bare `on`, garbage and the metadata tokens; the EPG write localization ignores a caller's mode word; the variable selects the metadata mode only, default off.

## Recovery and migration boundary

Rolling the reads or the EPG commit back to the legacy rule means redeploying the previous verified commit through the Worker rollback procedure, which does not revert R2: titles and names written by the EPG commit stay as written (this was already true under `on`). No flag, Scheduled Task, Access, R2 or D1 operation is authorized by this record; removing the stale tokens from the Worker binding needs its own owner approval.

## Evidence

- **Original decision:** [AIR-89](https://trello.com/c/vzR0uuZq); the staged rollout and its acceptance under [AIR-42](https://trello.com/c/drLBuWjl)
- **Implementation:** the AIR-89 pull request
- **Dated verification:** the shadow and cutover observations of 22–23 October 2026 in the [lifecycle audit and rollout log](../evidence/film-person/lifecycle-audit-and-rollout.md)
- **Uncertainty:** the current Worker binding was not read for this record; the metadata path's behaviour under `on:metadata` has not been measured in production

## Follow-ups

A separate acceptance for the metadata localization; removal of the stale path tokens from the binding under AIR-89 after separate owner approval; [AIR-79](https://trello.com/c/485tlGLA) retires legacy R2 operational persistence, which this record does not touch.
