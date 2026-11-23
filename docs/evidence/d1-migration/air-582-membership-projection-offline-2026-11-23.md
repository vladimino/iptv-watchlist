# AIR-582: canonical Watchlist membership projection, offline evidence (23 Nov 2026)

**Scope:** offline development of [ADR 0203](../../adr/0203-watchlist-membership-letterboxd-single-writer-projection.md) (Proposed). Measured on the sqlite D1 stand-in with the real migration chain `0001` to `0037`. **No production database, bucket, Letterboxd or Cloudflare resource was read or written**, no migration, baseline, switch, flag, Task or cron was applied, and `PRODUCER_DELIVERY_HOLD` is `true` and unchanged. This is not production verification.

**Source state:** `main` at `6fab4bf` (PR #934 merged); migration `0036` is the last file on `main`, so the new file is `0037`.

## What `tests/watchlist-membership.mjs` proves

| Claim | Result |
| --- | --- |
| Migration `0037` refuses anything but a complete 36, is additive, starts the marker as `producer` generation 0, copies and switches nothing, keeps every `watchlist_effect` row through the rebuild and keeps the immutability trigger | pass |
| Legacy compatibility: schema 36 and marker `producer` both publish exactly three effects; the new code writes nothing until the marker is `sync` | pass |
| The marker decides the effect set at promotion time; a switch landing between the read and the promotion batch aborts that batch whole (`conflict`, no snapshot) | pass |
| The switch is refused without a baseline proof of the exact, fully drained current version; a newer promotion invalidates the proof; a wrong generation and a second switch are refused | pass |
| Version fence: V1 cannot land over V2, add -> remove -> add keeps the V3 add against a late V2 remove, a version applied between read and batch rolls the batch back, the removal leaves a tombstone | pass |
| Zero shadow Film: an unknown id never creates a Film; a redirected Film, a missing Film and a failed identity proof are refused; an ambiguous claim is never guessed | pass |
| Single writer in `sync` mode: `writeFilmFacts` refuses a membership input (set, clear, release) while other facts still write; in `producer` mode the Producer write asserts the marker in its batch and a mid-write switch aborts it | pass |
| Effect: trusted lid-owned and TMDB-owned Films alike; an unresolved id gets a durable handoff and does not hold the version; removal clears membership only (Film, claim kept) | pass |
| Late effects applied out of order (V3, V2, V1) end at the V3 state | pass |
| A failing effect holds for at most 6 calls, then hands off every not-yet-applied id and completes; the next publication is not blocked; the handoff is reconciled against the current snapshot once healthy | pass |
| Late admission: backoff, application at the CURRENT version, a departed id is not added from its first-seen version, terminal after 12 attempts, a new addition re-opens it, the step is a no-op until the switch | pass |
| Baseline: the dry run opens no batch and changes nothing; apply is bounded (1 Film per call in the test), idempotent, removes drift and adds missing ids without touching a Film, hands off unresolved ids, records the proof and unlocks the switch; it refuses while effects are pending | pass |
| Review regressions (PR #946): two lids naming one Film (a removal of one never clears it, effect and reconcile, re-add restores it); a whole-batch identity failure for 6+ attempts loses no id (added or removed) and an unrecordable handoff holds the effect; every due reconcile attempt, transient or whole-step failures included, uses the 12-attempt budget | pass |
| Source audit: the only `src` files that write `watchlist_film` are the Film writer, the identity merge and the legacy repository (no Worker caller); the Film writer has exactly two insert and two delete sites | pass |

Existing suites updated only for the new newest schema number (36 to 37) and the migration chain list: `canonical-producer-chain`, `canonical-rated-admission-bundle`, `canonical-rated-admission-producer`, `watchlist-root-fence`, `migration-pattern-limit`.

## Not established

The cost of the first baseline on the real D1 (bounded to 25 Film changes per call, about six statements each), whether production `watchlist_film` has drift, and any natural-run behaviour. Those need the separate owner GOs listed in the ADR rollout matrix.
