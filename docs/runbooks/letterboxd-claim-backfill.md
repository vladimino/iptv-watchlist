# Letterboxd claim backfill: read-only preflight, L3 plan and readback (owner approval required)

Applies to the dormant module `src/canonical-letterboxd-claim.js` ([ADR 0184](../adr/0184-ratings-confirmed-letterboxd-claim-on-existing-film.md), Proposed). Nothing here authorizes a production write: the backfill is an L3 operation under [authorization and escalation](../process/authorization-and-escalation.md) and needs an owner-approved plan before it runs, even for a handful of rows.

## When this applies

A published programme lid has no trusted `letterboxd` claim in `film_external_id`, so `POST /api/started` answers `404 Unknown film`, while the Ratings projection ties that lid to one TMDB movie whose canonical Film exists. The cohort is whatever a fresh preflight finds; a number seen earlier is only a baseline.

## 1. Read-only preflight (no writes, owner-private output)

1. Read the Film/Person marker (`d1`/`open`, generation) and the ratings authority (`d1`/`open`, generation) and record both.
2. List the published programme lids that lack a trusted `letterboxd` claim, and for each the `ratings_view` row of the lid (`fact_key`) with the movie alias `tmdb_<n>`.
3. For each candidate run `planLetterboxdClaim` (or `applyLetterboxdClaims` with `dryRun: true`). The verdict is `pass`, `conflict` or `not_proved` with a typed reason:

| Reason | Verdict | Meaning |
| --- | --- | --- |
| `proved` / `already` | pass | write is allowed / the Film already holds the claim (no-op) |
| `ratings_alias_absent`, `ratings_movie_alias_absent`, `ratings_not_authoritative`, `film_absent`, `invalid_input` | not_proved | not enough provenance; stop this item |
| `ratings_alias_points_elsewhere`, `ratings_alias_ambiguous`, `tmdb_claim_not_unique_trusted`, `film_row_missing`, `film_redirected`, `tmdb_retired`, `lid_claimed_elsewhere`, `film_has_untrusted_claim`, `film_has_other_tmdb_claim`, `film_has_other_lid` | conflict | competing evidence; stop this item, never overwrite, route to owner review |

4. Keep the exact lid-to-movie mapping owner-private. Public records carry only aggregates (counts per verdict and reason).

## 2. L3 plan (owner approval, before any write)

The plan names: the frozen cohort (private list, count and a digest), the preflight timestamp and both authority generations, the writer identity (`applyLetterboxdClaims` through the existing fenced `film_external_ids` unit, origin `letterboxd_claim`, event = the plan's cohort id, at most 12 per call), the fences (marker generation, Film revision CAS, applied receipt), stop rules (any `conflict`, `not_proved`, `unknown` or `deferred` outcome stops the run for that item and is reported, a typed infrastructure failure stops the run), the expected row changes (per item: one `film_external_id` row, one Film revision increment, one applied receipt; nothing else), the event boundary (no Started mark, no Event, no rating or alias is written), and the rollback limits (below).

## 3. Execution and readback

Run only after the owner's exact GO. Re-run the preflight immediately before: a cohort that differs from the frozen one needs a new plan. Replaying the same event with the same cohort adds no rows, revisions or receipts. Read back: every `pass` item now has exactly one trusted, non-conflicting `letterboxd` claim with provenance `ratings_alias_bridge`; `catalogStartedFilm` answers `found`; unrelated Film and Person rows are unchanged. Record aggregates as dated evidence.

## Rollback and recovery

Code rollback does not remove written claims. A claim written by mistake is corrected through the owner-review and unlink routes; the receipt and the fixed provenance are the audit trail. Do not delete rows by hand.
