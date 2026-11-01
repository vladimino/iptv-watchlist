# ADR 0075: Diary page 1 is permanent on a migrated ratings run, and LETTERBOXD_DIARY_HISTORY is retired

**Status:** Accepted  
**Original decision date:** 2026-11-01  
**Recorded at:** 2026-11-01  
**Approval source:** The owner explicitly accepted ADR 0075 and separately visually approved the changed ratings `stateDiagram-v2` in `docs/architecture/scheduling-and-orchestration.md` on 2026-11-01 (Europe/Madrid), after [independent PASS review](https://github.com/vladimino/iptv-watchlist/pull/302#pullrequestreview-5727942206) of HEAD `dcd68abcc0ec685d3f7d32aa877229057ee27bc8` and successful PR CI. [Owner decision in PR #302](https://github.com/vladimino/iptv-watchlist/pull/302#issuecomment-6557730028). This acceptance does not authorize removing the Cloudflare `LETTERBOXD_DIARY_HISTORY` binding, modifying other flags or Scheduled Tasks, or performing manual Ratings/EPG/discovery, D1/R2 writes or migrations; the physical binding deletion remains a separate final owner gate after accepted deployment and safe read-only verification.  
**Related work:** [AIR-307](https://trello.com/c/5ZU2RsEt); prerequisite [AIR-295](https://trello.com/c/VtFZ6cci); [ADR 0049](0049-letterboxd-diary-viewing-history.md); [ADR 0067](0067-diary-recent-window.md); [ADR 0074](0074-retire-ratings-pipeline-switch.md)  
**Supersedes:** In part: [ADR 0049](0049-letterboxd-diary-viewing-history.md) where Diary is behind `LETTERBOXD_DIARY_HISTORY` and off by default; [ADR 0055](0055-retire-letterboxd-facts-switch.md) decision 5 where that binding stays a separate active switch; [ADR 0067](0067-diary-recent-window.md) only the clause that a diary gate that is off does not fetch; [ADR 0074](0074-retire-ratings-pipeline-switch.md) only the deferral of `LETTERBOXD_DIARY_HISTORY`. The page-1 budget, the history, the fail-closed migration and the permanent separate pipeline stay.  
**Superseded by:** None

## Context

ADR 0049 introduced the Diary reader behind `LETTERBOXD_DIARY_HISTORY`, off unless the binding is the exact string `on`. ADR 0067 kept that gate and limited the routine read to page 1. ADR 0074 moved that read onto the ratings run and left the gate in place: with it off, a migrated run started in the removal phase and finished `diary_off` without a Diary request.

Production, as recorded on the AIR-307 handoff of 2026-11-01, already runs with the binding `on`, migration complete, and the Ratings Task reading page 1. The last recorded ratings run finished `recent_window`. `wrangler.jsonc` uses `keep_vars: true`, so a deploy does not clear the binding. Deleting it before this code is deployed would make the old Worker skip Diary.

## Decision

1. **Diary page 1 is permanent on a migrated ratings run.** The Worker does not read `LETTERBOXD_DIARY_HISTORY`. When `migration` is `complete`, `ratings_sync_start` begins in phase `diary` and `ratings_sync_step` requests `https://letterboxd.com/<user>/diary/` once, for an absent, `on`, `off` or any other binding alike. A checkpoint with `diaryPagesRead >= 1` does not fetch again. Page 2 is not requested. `ratings_sync_status` field `diary.enabled` and `GET /api/letterboxd/diary` field `enabled` are that capability. They do not prove a fetch happened, and they do not prove the binding is absent.
2. **A failed Diary is not a skip.** A page that ends `blocked`, `rate_limited` or `failed` is recorded, including when no row was stored. The step still moves to the removal phase. The run ends `error` with that Diary cause once the removal phase stops. The run does not finish as a success with `cause: diary_off` because the binding is absent or off. Stored history and facts stay. The page-1 guards, the cursor join, the compare-and-swap lease and the removal queue are unchanged.
3. **An incomplete migration stays fail-closed.** When `migration` is `none`, `partial` or `regressed`, start and step answer `not_migrated` and write nothing. The EPG commit does not read Diary, does not look up films and does not call `ratings_storage_migrate`, as [ADR 0074](0074-retire-ratings-pipeline-switch.md) already decides. No value of this binding puts Diary back inside the commit.
4. **`LETTERBOXD_DIARY_HISTORY` is retired.** It stays in the `feature_flags` registry as retired: `effective` is null, a set binding has `issue: retired`, and the flag is valid only while absent. No source reads the binding. `effective: null` does not prove the binding is gone.
5. **Removing the production binding is a later step.** This record and its pull request do not delete, empty or rewrite the Worker `iptv` binding. `keep_vars: true` means a deploy leaves it. After this code is deployed and a read-only check accepts it, the owner deletes only that binding. Absence is then proved in Cloudflare settings and by `feature_flags` (`state: absent`, `retired: true`, `valid: true`), together with `ratings_sync_status` (`diary.enabled: true`, `migration: complete`). Setting the binding to `off` or to an empty string is not that deletion. `diary.enabled: true` alone does not prove the variable is gone and does not prove a Diary fetch. Only a later routine Ratings Task run, not a manual start, confirms page-1 processing after the binding is gone.
6. **A code revert after the binding is gone is not safe on its own.** Code that skips Diary when the binding is absent must not be deployed until `LETTERBOXD_DIARY_HISTORY=on` has been restored and read back. A revert does not restore R2 history, the Diary cursor, facts or the removal queue.

Not decided here: `REMOVAL_RATING_LOOKUP`, Scheduled Tasks, EPG, discovery, predictions, or D1 authority. Acceptance of this record does not authorize a binding deletion, a migration, or a ratings or EPG run.

## Alternatives considered

- **Keep the binding as a permanent gate.** Not chosen. Production already runs with it on, and the only remaining off path skips Diary.
- **Delete the binding in the same change as the code.** Not chosen. A deploy of the old code while the binding is already gone would skip Diary. The binding stays until the new code is what production runs.

## Consequences

- An absent, off or malformed binding no longer skips Diary on a migrated ratings run.
- `cause: diary_off` is no longer how an absent binding ends a run.
- `feature_flags` reports the leftover binding as retired. `diary.enabled: true` is not that report.
- The production binding remains until the separate owner step in decision 5.

## Recovery and migration boundary

Reversible by a code revert only while the binding is still `on`. After decision 5, restoring old code also requires `LETTERBOXD_DIARY_HISTORY=on` on Worker `iptv` before that deploy. Diary history, the cursor, facts and the removal queue stay in R2 either way. This record authorizes no flag change, binding deletion, Access change, R2 or D1 write, migration, or Scheduled Task edit.

## Evidence

- **Original decision:** owner handoff on AIR-307, 2026-11-01, recording the production binding `on` after the AIR-295 acceptance and the AIR-306 readback. This pull request adds no new production measurement.
- **Implementation:** `src/letterboxd-diary.js`, `src/letterboxd-ratings.js`, `src/feature-flags.js`, and the ratings tests named on the card.
- **Dated verification:** not recorded for a run after this code. The AIR-306 readback is the last documented production state of the binding, not a run of this retirement.

## Follow-ups

The binding deletion and its read-back (decision 5), then one later routine Ratings Task run, close AIR-307. They are not part of the code pull request.
