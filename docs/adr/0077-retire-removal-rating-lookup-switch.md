# ADR 0077: The per-film removal lookup is permanent, and REMOVAL_RATING_LOOKUP is retired

**Status:** Proposed
**Original decision date:** 2026-11-01
**Recorded at:** 2026-11-01
**Approval source:** Not documented. The owner approved the functional scope on [AIR-272](https://trello.com/c/Oezn5dLP) (`retire now`, keep the bounded fallback). That approval is not acceptance of this record.
**Related work:** [AIR-272](https://trello.com/c/Oezn5dLP); prerequisites [AIR-271](https://trello.com/c/k7kDc6Lf), [AIR-273](https://trello.com/c/TVB01Xm0), [AIR-51](https://trello.com/c/33d4hKJ3), [AIR-295](https://trello.com/c/VtFZ6cci); [ADR 0043](0043-removal-rating-lookup-queue.md); [ADR 0060](0060-independent-letterboxd-ratings-pipeline.md); [ADR 0074](0074-retire-ratings-pipeline-switch.md); [ADR 0075](0075-retire-letterboxd-diary-history-switch.md)
**Supersedes:** In part: [ADR 0043](0043-removal-rating-lookup-queue.md) decision 6 (the off-by-default gate); [ADR 0060](0060-independent-letterboxd-ratings-pipeline.md) where `REMOVAL_RATING_LOOKUP` still selects the member-page lookup; [ADR 0055](0055-retire-letterboxd-facts-switch.md) decision 5 only where this binding stays an active switch; [ADR 0074](0074-retire-ratings-pipeline-switch.md) and [ADR 0075](0075-retire-letterboxd-diary-history-switch.md) only the deferral of `REMOVAL_RATING_LOOKUP`. The queue, the five-per-step and three-attempt budgets, the 403/429 pause, the event references, the Diary page-1 budget and the fail-closed migration stay.
**Superseded by:** None

## Context

ADR 0043 put the per-film member-page lookup behind `REMOVAL_RATING_LOOKUP`, off unless the binding is the exact string `on`. ADR 0060 moved the lookup onto the ratings run and kept the gate: with it off, the removal phase settled references and stopped with `lookup_off` without a member-page request. ADR 0074 and ADR 0075 retired the other ratings switches and left this one in place.

Production, as recorded on the AIR-272 preflight of 2026-11-01, already runs with the binding `on`, migration complete, and the Ratings Task idle. The last recorded ratings run finished `recent_window` with `lookup.checked` 0, because no removed film was due. That is an on-mode baseline. It is not a run after this flag is removed, and `checked: 0` is not proof that a member page was fetched. `wrangler.jsonc` uses `keep_vars: true`, so a deploy does not clear the binding. Deleting it before this code is deployed would make the old Worker skip the lookup.

Diary page 1 does not cover the whole history. A film the Diary did not rate can still need the member page. AIR-273 recorded a rating-only film whose page answered 404, so this fallback is not a promise that every removed film receives a rating.

## Decision

1. **The bounded per-film lookup is permanent on a migrated ratings run.** The Worker does not read `REMOVAL_RATING_LOOKUP`. After Diary page 1, the removal phase still links legacy references and writes ratings already known onto each removal event. A removed film with no proved rating stays eligible for one member-page GET, for an absent, `on`, `off`, empty or any other binding alike. `ratings_sync_status` field `removal.lookupEnabled` is that capability. It does not prove a fetch happened, and it does not prove the binding is absent.
2. **Always available is not an extra request.** A film the Diary or a stored fact already rated is not requested again. A film absent from the current Diary page keeps a confirmed stored rating and is not requested, including when a new reference reopens its entry. The rating written to that event is the fact-precedence winner: the greater of the stored rating observation and the films-list floor, not a stale rating left on the queue entry. A film the current page lists without a rating is still looked up: that page is not proof, and the stored rating does not stand in for it. A null or absent rating is not watched and does not resolve the entry. The limits stay: at most five member-page GETs per step, at most three attempts per film, claim before the request, compare-and-swap, a six-hour pause of the whole queue after 403 or 429, `not_found` after 404, `not_rated` that does not mean watched, pending expiry and pruning, event references, and a refused late outcome. A missing or invalid URL is not requested. A paused queue is not requested.
3. **A failed Diary is not a successful finish.** A Diary page that ends `blocked`, `rate_limited` or `failed` still moves the step to the removal phase, and that phase may still run the bounded lookup. The run ends `error` with the Diary cause once removal stops. It does not finish as a success because the lookup ran.
4. **The EPG commit still does not look films up.** It does not read Diary, does not make a member-page GET and does not write ratings. When migration is complete it enqueues removal-event references only. That enqueue does not read this binding.
5. **An incomplete migration stays fail-closed.** When `migration` is `none`, `partial` or `regressed`, start and step answer `not_migrated` and write nothing. The EPG commit does not look films up and does not return to an inline ratings path, as [ADR 0074](0074-retire-ratings-pipeline-switch.md) already decides.
6. **`REMOVAL_RATING_LOOKUP` is retired.** It stays in the `feature_flags` registry in its current slot. `effective` is null. A set binding has `issue: retired` and `valid: false`. The flag is valid only while absent. No source reads the binding to turn the lookup on or off. `effective: null` does not prove the binding is gone.
7. **Removing the production binding is a later step.** This record and its pull request do not delete, empty or rewrite the Worker `iptv` binding. `keep_vars: true` means a deploy leaves it. After this code is deployed, both post-merge jobs succeed, and a read-only check accepts it, the owner may delete only that binding. Until then it stays `on`. Setting it to `off` or to an empty string is not that deletion. Absence is then proved in Cloudflare settings and by `feature_flags` (`state: absent`, `retired: true`, `valid: true`), together with `ratings_sync_status` (`removal.lookupEnabled: true`, `migration: complete`). `lookupEnabled: true` alone does not prove the variable is gone and does not prove a member-page GET. A later routine Ratings Task run is the observation. If no film is eligible, `lookup.checked: 0` does not prove a GET, and this record does not authorize creating a removal in order to force one.
8. **A code revert after the binding is gone is not safe on its own.** Code that skips the lookup when the binding is absent must not be deployed until `REMOVAL_RATING_LOOKUP=on` has been restored and read back. A revert does not restore R2 rating facts, the queue or removal events. After the binding is deleted, the lookup cannot be turned off by a flag. An emergency stop is a separately approved code revert or Task action. The 403/429 pause and the request budgets stay.

Not decided here: Scheduled Tasks, EPG, discovery, predictions, or D1 authority. Acceptance of this record does not authorize a binding deletion, a migration, or a ratings or EPG run.

## Alternatives considered

- **Remove the per-film lookup.** Not chosen. The owner kept it as the fallback for a removed film the Diary did not rate. Page 1 is not the whole history.
- **Keep a permanent operational gate.** Not chosen. Production already runs with the binding `on`, and the only remaining off path skips the lookup.
- **Delete the binding in the same change as the code.** Not chosen. A deploy of the old code while the binding is already gone would skip the lookup. The binding stays until the new code is what production runs.

## Consequences

- An absent, off or malformed binding no longer skips the member-page lookup on a migrated ratings run.
- `stoppedBy: lookup_off` is no longer how an absent binding ends the lookups.
- A film already rated from Diary, or absent from the current Diary page with a confirmed stored fact, is not requested. That includes an entry a new removal reference reopened. A film the current page lists without a rating is still looked up. A null or absent rating stays eligible for the lookup. A 403 or 429 still pauses the queue.
- `feature_flags` reports the leftover binding as retired. `removal.lookupEnabled: true` is not that report.
- The production binding remains until the separate owner step in decision 7.

## Recovery and migration boundary

No new migration. `ratings_storage_migrate` is unchanged and is not run by this record. The queue version, the event references and the Diary cursor stay. A code revert does not roll those objects back.

## Research evidence

No new measurement. The production binding, the idle migrated pipeline and the last run's `lookup.checked: 0` are the AIR-272 preflight of 2026-11-01, recorded on that card. This pull request adds no evidence file.

## Follow-up

Deleting the Cloudflare binding, and one later routine Ratings Task run, close the card. They are not this pull request.
