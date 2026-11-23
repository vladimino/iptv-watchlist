# ADR 0203: The Letterboxd Sync is the single writer of canonical Watchlist membership (`watchlist_film`), through a version-fenced `membership` effect

**Status:** Proposed (the architectural direction C was chosen by the Product Owner in [PR #934](https://github.com/vladimino/iptv-watchlist/pull/934#issuecomment-7102148394); the concrete version-aware protocol below has **no ADR-specific owner acceptance yet** and this record MUST NOT be merged while it is `Proposed`)  
**Original decision date:** 2026-11-23 (direction only)  
**Recorded at:** 2026-11-23  
**Approval source:** direction: [owner choice C on PR #934](https://github.com/vladimino/iptv-watchlist/pull/934#issuecomment-7102148394); protocol: **pending** (ADR-specific owner decision, to be linked here and in the registry)  
**Related work:** [AIR-582](https://trello.com/c/AdLQvzMe) (this implementation), [AIR-572](https://trello.com/c/ugyHjnc4) (Producer recovery and activation, owns the later hold lift), [AIR-571](https://trello.com/c/b6UrtwUG) (Watchlist authority), [ADR 0186](0186-letterboxd-sync-and-independent-watchlist-authority.md), [PR #934](https://github.com/vladimino/iptv-watchlist/pull/934)  
**Supersedes:** None. Amends [ADR 0186](0186-letterboxd-sync-and-independent-watchlist-authority.md) decision 1 only by adding an optional fourth causal effect.  
**Superseded by:** None

## Context

With the Watchlist authority at `d1` ([ADR 0186](0186-letterboxd-sync-and-independent-watchlist-authority.md)) the current ordered Watchlist is `watchlist_current` / `watchlist_snapshot`, published by the Letterboxd Sync up to four times a day. The canonical Film table `watchlist_film` (membership of a Film in the Watchlist) is read by `catalog-d1` (`inWatchlist`, the watchlist surface, person co-credits) and `canonical-read-model`. Read at 23 Nov 2026 on `main` (`6fab4bf`):

- The **only live writer** of `watchlist_film` is the EPG Producer (`writeFilmFacts`: `watchlist: true` for every listed Film of a sealed EPG copy, `release` with `watchlist: false` for the diff against the previous membership). The identity merge (`canonical-mutations`) moves membership together with a Film; `canonical-repository.js` has no Worker caller (offline scripts only). The Sync's effects `scan_facts`, `retention` and `removal_enqueue` never write membership.
- The Producer reads membership from the EPG generation pinned by `beginSync`, so it lags the Watchlist by up to a day and can roll a fresh Watchlist version back to an older copy. It is held (`PRODUCER_DELIVERY_HOLD = true`) and has no successful pass in production.
- `GET /api/watchlist` and `GET /api/programme` already compose membership and order from `watchlist_current` at read time; they are not part of this decision.
- Constraints found in the code: `letterboxd-sync-watchlist.js::run` requires a fully drained effect set before every new scan (so a stuck effect would block all following 4/day slots); `watchlist-d1.js::completeEffect` requires every lower version done; `0031` restricts `watchlist_effect.effect` by a CHECK to three values; a bare compare-and-swap on `watchlist_current.version = V` would block an effect V for ever once V+1 is current.

## Decision

**1. One writer, decided by one marker.** Migration `0037` adds `watchlist_membership_authority` (singleton): mode `producer` (today) or `sync`, a generation, and `baseline_version`. After the switch to `sync` **only** the Letterboxd Sync `membership` effect (and the one-time baseline operator, before the switch) writes `watchlist_film`. The EPG Producer keeps writing Film/Person facts, credits and identity; it plans **no** membership (no `watchlist` key, no release units, no read of `watchlist_film`), and the Film writer itself (`writeFilmFacts`) refuses any membership input in `sync` mode (`film_person_membership_owned`), so a stale plan, a receipt replay or a release cannot become a second writer. In `producer` mode the Producer write also asserts the marker inside its batch, so a switch landing mid-write aborts it. Identity merge still moves membership with the Film; it is a Film operation, not a membership decision.

**2. The effect set is decided by the marker at promotion time and re-asserted in the promotion batch.** In `producer` mode (and while the table is absent, schema below 37) every promotion has the three legacy effects exactly as today. In `sync` mode it has four: `scan_facts`, `retention`, `removal_enqueue`, then `membership`. The marker generation is asserted inside the promotion batch, so a promotion can never carry the old set after the switch nor the new one before it. No new cron, Task, Workflow or flag.

**3. What a committed snapshot means.** `committed` means the list is stored and its effects are owed; the projection catches up through the effect of that version, in the existing version order, never ahead of the drain.

**4. The `membership` effect.** It reads the durable `watchlist_change` rows of its version (added, removed), never a diff. Several Letterboxd ids may name one Film (`film_external_id` is keyed by film, scheme and value), so desired membership is decided per **Film** from the whole list: a removal clears a Film only when no lid of the version's list (for the reconcile: of the current snapshot) still resolves to it (one extra bounded identity read, only when a removal resolves to a Film). The identity resolver is capped at 1000 lids per call while a valid Watchlist may hold up to 5000 (`LIMITS.maxFilms`), so whole-list resolution, in the effect, the reconcile and the baseline, runs in chunks of at most 1000 with the per-id answers merged; a failing chunk fails the whole answer, never a partial result. Each Letterboxd id is resolved to a **trusted canonical Film** by the same resolver as the Producer (one trusted non-conflicting `letterboxd` claim, else an existing Film of that exact name, one redirect hop, ambiguity refused by name; no guessed id, no created Film, no title/year match) and written by `setFilmMembership` in one fenced batch with the resolver's proofs asserted inside it. Work is cut into 60 ids per call with a resume point on the pending row.

**5. Per-film version fence (why V cannot overwrite V+1).** `watchlist_film_fence(film_id, version, member)` records, per Film, the newest Watchlist version applied (a **tombstone** after a removal, because the membership row is deleted). `setFilmMembership` for version V is refused as `stale` when the stored version is greater, asserts "no newer version" inside the batch (a version applied between read and write rolls the batch back), and an equal version with the same state is an idempotent replay. Add → remove → add is therefore monotonic per Film regardless of the order effects run in; no global CAS on `watchlist_current.version` is used, so nothing can wedge an old effect.

**6. A bad id never holds a version; a system fault is bounded.**
- An id that is about *that id* (unresolved, ambiguous, redirect chain, proof changed) goes, if it was **added**, to the durable `watchlist_membership_handoff` ledger and the effect completes (a removed id with no Film has nothing to clear).
- A fault about the system (D1 unavailable, writer fence, revision conflict after one in-line retry) holds the effect for at most `MEMBERSHIP_EFFECT_MAX_ATTEMPTS = 6` calls (one per slot); after that **every** unprocessed id of the slice, removals included, is handed off and the effect completes. This also holds when the identity read fails as a whole; if the handoff cannot be recorded the effect stays held and never returns a receipt. A persistent fault can thus delay membership, never block the next Watchlist publication, and the handoff is written **before** the effect can complete.

**7. Late admission and reconcile.** After each scan the slot runs one bounded step (8 rows) over the due handoff rows. Each is reconciled against the **current** snapshot, never the version that first listed it: a current member is added, a departed one is not, applied at the current version (so a later effect of the same version is a no-op and an older one is stale). Unresolved ids back off (1 h, 3 h, 12 h) and become `terminal` after 12 attempts (every due attempt counts, a system fault included), waiting for the baseline operator or an owner decision; a new addition re-opens a `terminal` or `settled` row. The step is a no-op unless the marker is `sync`, and its failure never changes the slot outcome.

**8. One-time baseline reconciliation.** A pure planner and two calls (`dryRun`, read only; `apply`, at most 25 Film changes per call, idempotent) make `watchlist_film` equal to the resolved current snapshot: add missing, remove drift left by the Producer (membership only; no Film, claim, show or rating is touched), hand off unresolved ids. It refuses while effects of the current version are pending. Only when nothing remains does it record `baseline_version = current version`. It writes per-film fences at the current version.

**9. The switch.** `activateMembershipSync` is one guarded batch: marker `producer` at the expected generation, `baseline_version` equal to the current Watchlist version, and that version fully drained. A newer promotion invalidates the proof (the baseline is rerun). The switch is **roll-forward**; this change defines no switch back (a later ADR would, with its own fenced procedure).

**10. Rollout matrix (every row an owner-gated step; none is performed by merging or deploying this change).**

| Step | State after | Writers of `watchlist_film` |
| --- | --- | --- |
| 0. Merge and deploy this change (code only) | schema ≤ 36 or 37 with marker `producer`; the code behaves exactly as before (three effects, Producer owns membership); `PRODUCER_DELIVERY_HOLD` is `true` | Producer (held, so none) |
| 1. Migration `0036` then `0037` (separate GOs) | marker `producer`, generation 0 | unchanged |
| 2. Baseline `dryRun`, then `apply` until `baseline_version` equals the current version | table equals current Watchlist | baseline operator only (Producer held) |
| 3. Switch to `sync` (owner GO; Producer held and no non-terminal Producer chain) | promotions carry `membership`; the Film writer refuses Producer membership | **Sync only** |
| 4. Lift `PRODUCER_DELIVERY_HOLD` (a separate, narrow PR of AIR-572, own GO) | Producer writes Film/Person facts without membership | Sync only |

At no step do an old and a new writer both write: before step 3 the Producer is held by a static code constant, and from step 3 the Film writer refuses it. A deploy writes nothing automatically: until step 3 nothing in the Worker calls the new writers.

**Not decided here:** the production operator that wires `dryRun`/`apply`/switch to an owner-only route, the actual migration apply, the baseline apply, the switch, the hold lift, a switch back, and the wider Film unification (AIR-554/579).

## Alternatives considered

Only the options discussed on [AIR-572](https://trello.com/c/ugyHjnc4) are listed.

- **A: catch up on the next EPG pass.** Rejected by the owner (daily lag).
- **B: the Producer reads the current Watchlist snapshot.** Still tied to the daily `reopenChain`, gives no four-slot cadence and keeps two writers' interplay.
- **D: readers join `watchlist_current` directly and `watchlist_film` is retired.** Removes the writer entirely but needs a lid → Film join in the SQL of every consumer and is heavier for D1 (AIR-579). Kept as a possible later direction.
- **A global compare-and-swap on `watchlist_current.version = V`** (rejected inside option C): it would block effect V for ever once V+1 is current; the per-film fence replaces it.
- **Always insert the fourth effect, no marker:** rejected, because a deploy before the schema change would fail every promotion on the old CHECK constraint.

## Consequences

- Membership follows each published version within the drain of that slot, instead of the daily EPG pass; a Producer replay can no longer roll it back.
- New schema (three tables, a rebuilt `watchlist_effect`), one new module, one new Film writer, and a rollout with two owner-gated data steps. The rebuild of `watchlist_effect` runs inside the migration batch and keeps every row.
- D1 cost: one fenced batch per changed Film per version (about 6 statements), 60 Films per call; the baseline is bounded to 25 per call. A routine version changes few ids; the first baseline is the only large write and is operator-paced.
- Terminal handoff rows (an id with no trusted Film after 12 attempts) need the baseline operator or an owner decision; they are counted in the handoff ledger, and pending effects stay visible to the existing Letterboxd effect-drain monitor (all `watchlist_effect` rows are counted).
- The wider concerns (Film identity, retention, admission policy) stay outside membership.

## Recovery and migration boundary

Code rollback does not revert D1 rows, the marker or the fences. Before step 3 the change is fully reversible (marker `producer`; the baseline only aligned `watchlist_film` with the current Watchlist, which the Producer would have done). After step 3 the recovery is roll-forward: fix the writer, rerun the baseline (idempotent), the handoff ledger and fences are append-only facts. This ADR authorizes **no** migration, no baseline apply, no switch, no flag, no Task or cron change and no hold lift; each needs its own operation-specific owner GO.

## Evidence

- **Original decision:** direction C, [PR #934 comment](https://github.com/vladimino/iptv-watchlist/pull/934#issuecomment-7102148394); protocol acceptance: pending.
- **Implementation:** [AIR-582](https://trello.com/c/AdLQvzMe) pull request (link recorded on the card).
- **Dated verification:** offline only: `tests/watchlist-membership.mjs` on the sqlite D1 stand-in with the real migration chain (23 Nov 2026). No production observation.
- **Uncertainty:** the real-D1 cost of the first baseline; whether any production `watchlist_film` drift exists (read-only audit evidence is [PR #842](https://github.com/vladimino/iptv-watchlist/pull/842), historical).

## Follow-ups

- The owner-only production operator for `dryRun`/`apply`/switch (separate card, L2/L3 GO).
- The narrow hold-lift PR and natural-run acceptance in [AIR-572](https://trello.com/c/ugyHjnc4).
