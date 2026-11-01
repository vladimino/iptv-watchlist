# ADR 0074: The ratings pipeline is permanently separate, and RATINGS_PIPELINE is retired

**Status:** Accepted  
**Original decision date:** 2026-11-01  
**Recorded at:** 2026-11-01  
**Approval source:** The owner explicitly accepted ADR 0074 and visually approved both changed Mermaid diagrams (`docs/architecture/letterboxd-ingestion.md` and `docs/architecture/scheduling-and-orchestration.md`) separately on 2026-11-01 (Europe/Madrid), after the [positive independent review](https://github.com/vladimino/iptv-watchlist/pull/297#pullrequestreview-5727320441) of HEAD `ce411c27377ef8c47cfa2cada53cd94a0c572a08` and successful exact-HEAD PR CI. [Owner decision recorded in PR #297](https://github.com/vladimino/iptv-watchlist/pull/297#issuecomment-6556238389). Acceptance does not authorize a migration, any Scheduled Task edit, R2/D1 write, or other production changes; removing only the `RATINGS_PIPELINE` Cloudflare binding is conditionally authorized as the last production mutation after successful merge/deploy and safe production verification, followed by authoritative absence and MCP readbacks.  
**Related work:** [AIR-306](https://trello.com/c/PDn4ujI1); prerequisite [AIR-295](https://trello.com/c/VtFZ6cci); [ADR 0060](0060-independent-letterboxd-ratings-pipeline.md)  
**Supersedes:** In part: [ADR 0060](0060-independent-letterboxd-ratings-pipeline.md) where the Worker still chooses `inline` when `RATINGS_PIPELINE` is absent or is not the exact string `separate`, where `separate` before a complete migration behaves as `inline`, where status reports `pipeline: separate_pending_migration`, and where start and step answer `disabled`. The leased run, the Diary page budget, the queue, the migration witness and the legacy-link repair stay.  
**Superseded by:** [ADR 0075](0075-retire-letterboxd-diary-history-switch.md) (Proposed) in part: the deferral of `LETTERBOXD_DIARY_HISTORY`. The separate pipeline, the fail-closed migration and the `RATINGS_PIPELINE` retirement stay.

## Context

ADR 0060 moved Letterboxd ratings out of the EPG commit behind `RATINGS_PIPELINE`. The exact string `separate`, and only after `ratings_storage_migrate` reported `migration: complete`, made the commit enqueue removal references and left Diary and lookups to the ratings run. Every other value, including a missing binding, kept Diary and the member-page lookup inside the commit.

That default is no longer a safe rollback. Production, as recorded on closed AIR-295, runs with the binding set to `separate`, migration complete, and a nightly ratings run on the separate pipeline. `wrangler.jsonc` uses `keep_vars: true`, so a deploy does not clear the binding. Deleting the binding before this code is deployed would make the old Worker treat absence as `inline` and put Diary back inside the EPG commit.

## Decision

1. **Separate is permanent once storage is migrated.** The Worker does not read `RATINGS_PIPELINE`. When `migration` is `complete`, the EPG commit only enqueues the films its watchlist diff removed, as references to their removal event, and does not read Diary or request a member page. `ratings_sync_start` and `ratings_sync_step` run that work for an absent, `inline`, invalid or `separate` binding alike. `ratings_sync_status` reports `switch: separate`. That string is the permanent mode. It is not evidence that the binding is gone; `feature_flags` is.
2. **An incomplete migration fails closed.** When `migration` is `none`, `partial` or `regressed`, the EPG commit still publishes the programme and the watchlist event. It records that event's removed films as `removalRefs` on `sync.json` and does not enqueue them, read Diary, look up films, or call `ratings_storage_migrate`. A later blocked commit keeps every earlier reference and appends its own, so advancing the watchlist does not drop a removal event that was never queued. The sync run records `ratingsPipeline: blocked` and `ratingsMigration` (`none`, `partial` or `regressed`). Start and step answer `not_migrated` and write nothing. Status reports `pipeline: blocked`. Once migration is complete, the next sync start and the next step on the completed run enqueue every stored reference. `ratings_storage_migrate` copies those references into the queue when it runs and does not delete them from `sync.json`.
3. **`RATINGS_PIPELINE` is retired.** It stays in the `feature_flags` registry as retired: `effective` is null, a set binding has `issue: retired`, and the flag is valid only while absent. No source reads the binding.
4. **The inline commit path is removed.** The commit no longer has a Diary stage or a removal-lookup replay. Diary facts and member-page lookups remain on the ratings run. A completed sync that still carries an old `ratingPending` is closed by the existing stale-attempt rule and is not retried against Letterboxd.
5. **Removing the production binding is a later step.** This record and its pull request do not delete, empty or rewrite the Worker `iptv` binding. `keep_vars: true` means a deploy leaves it. After this code is deployed and a read-only check shows permanent separate behaviour, the owner deletes only that binding. Absence is then proved in Cloudflare settings and by `feature_flags` (`state: absent`, `retired: true`), together with `ratings_sync_status` (`switch: separate`, `migration: complete`). `effective` is null for a retired flag and does not by itself prove the binding is gone. Setting the binding to `off` or to an empty string is not that deletion.
6. **A code revert after the binding is gone is not safe on its own.** Code that treats a missing binding as `inline` must not be deployed until `RATINGS_PIPELINE=separate` has been restored and read back. A revert does not return the queue or the Diary cursor from schema version 2 to version 1.

Not decided here: changes to `LETTERBOXD_DIARY_HISTORY`, `REMOVAL_RATING_LOOKUP`, Scheduled Tasks, EPG, discovery, predictions, or D1 authority. Acceptance of this record does not authorize a binding deletion, a migration, or a ratings or EPG run.

## Alternatives considered

- **Keep the binding as a permanent gate.** Not chosen. The only remaining use of a non-`separate` value is the inline commit, which is the behaviour this retirement removes.
- **Delete the binding in the same change as the code.** Not chosen. A deploy of the old code while the binding is already gone would read Diary inside the EPG commit. The binding stays until the new code is what production runs.

## Consequences

- An absent or malformed binding no longer selects inline ratings. Unmigrated storage publishes EPG and skips ratings work instead of reading Diary.
- `pipeline: separate_pending_migration` and the start/step reason `disabled` are gone. Callers that treated `disabled` as "the switch is inline" now see `not_migrated` when storage is not migrated, and a normal run when it is.
- The integration footer uses the ratings run when migration is complete. Otherwise it reports `ratings_migration_blocked` and does not treat old `sync.json` rating fields as a current Diary result.
- The production binding remains until the separate owner step in decision 5.

## Recovery and migration boundary

Reversible by a code revert only while the binding is still `separate`. After decision 5, restoring old code also requires `RATINGS_PIPELINE=separate` on Worker `iptv` before that deploy. Queue schema version 2, the Diary cursor merge form and the migration witness stay in R2 either way. This record authorizes no flag change, binding deletion, Access change, R2 or D1 write, migration, or Scheduled Task edit.

## Evidence

- **Original decision:** owner handoff on AIR-306, 2026-11-01, recording the AIR-295 production acceptance (`RATINGS_PIPELINE=separate`, migration complete). This pull request adds no new production measurement.
- **Implementation:** `src/worker.js`, `src/letterboxd-ratings.js`, `src/enrichment.js`, `src/feature-flags.js`, `src/mcp.js`, and the ratings tests named on the card.

## Follow-ups

The binding deletion and its read-back (decision 5) close AIR-306. They are not part of the code pull request.
