# D1 projector: the three `identity_collision` Films (RCA, deterministic reproduction, L1 gate)

**Captured:** 2026-11-10 UTC, read-only: the code of `main` at `d73ac48`, the Worker log lines `event=d1_enrichment_projection` of four hourly runs (02:00 to 06:00 UTC), D1 `SELECT`s over `film`, `film_external_id`, `film_redirect`, `watchlist_film`, `projection_state`, `metadata_cache`, `film_generation`, `film_epg_last_airing`, `film_show`, `film_person_credit`, `film_alias` and `film_rated_admission` (the three source Films and their D1 counterparts only), and five read-only R2 `GET`s (the published pointer, the published programme, `watchlist.json`, `metadata.json`, the generation catalog key) through the bucket-scoped Object Read token. No manual projector, Discovery or EPG run, no flag, Task, cron, lease, window or budget change, no production write. Film ids are withheld below: the cases are called A, B and C.
**Scope:** [AIR-404](https://trello.com/c/rB2WlY9q). The three Films that [AIR-401](air-401-bulk-measurement-2026-11-10.md) reported with `identity_collision` in the one productive grouped run (03:00 Madrid, 02:00 UTC).
**Verdict:** **A DEFECT OF THE PROJECTOR'S PER-ENTITY FILM WRITE, REPRODUCED OFFLINE; NOT A DEFECT OF THE GROUPED WRITE PATH; PERSISTENT UNTIL FIXED; NOT A BLOCKER OF L1 FOR THE GROUPED PATH, BUT IT MAKES `errorCount` 0 UNUSABLE AS AN L1 ACCEPTANCE SIGNAL UNTIL A SEPARATE FIX.** In D1 each of the three Films' trusted TMDB id is already owned by the catalog Film of the same id (`film:tmdb:<id>`), which the projector wrote days earlier. The projector writes a Film with `projectFilm` and releases the Film it replaces with `projectLink` afterwards, in the same transaction; `projectFilm` checks the trusted external ids first, and the owner it is about to retire is not yet released, so the write is refused before the link is reached. The same refusal follows when the catalog Film is no longer in the view and no link exists. Which of the two holds for each of the three Films is not established (the D1 catalog was not read); both end the same way and have one fix plan.
**Used by:** [ADR 0106](../../adr/0106-bulk-projector-write-path.md) (L1 activation), [AIR-401](air-401-bulk-measurement-2026-11-10.md).

## What the production runs show

| Run (UTC) | Outcome | `errorCount` | Errors | Films written | `remaining` |
| --- | --- | --- | --- | --- | --- |
| 02:00 (03:00 Madrid) | `partial` | 3 | A, B, C: `identity_collision` | 348 | 18,955 |
| 03:00 | `budget` | 0 | none (the run did not reach them) | 0 | 19,695 |
| 04:00 | `budget` | 0 | none (did not reach them) | 0 | 20,576 |
| 05:00 | `partial` | 3 | A, B, C: `identity_collision` | 49 | 20,785 |
| 06:00 | `partial` | 1 | one of the three: `identity_collision` | 0 | 21,526 |

The same three Films are refused again whenever a run reaches them: it is not a one-off. The refused Film is not counted in `remaining`, so it does not hold the backlog; the run ends `partial` instead of `budget` or `complete`. `errors` holds `kind`, `id` and the error code only.

## The three cases (D1 and R2, read-only)

| | A | B | C |
| --- | --- | --- | --- |
| The Letterboxd Film in D1 (`film`, `film_external_id`, `film_redirect`, `watchlist_film`, `projection_state`) | absent | absent | absent |
| Trusted TMDB id in the source (`metadata_cache`) | present | present | present |
| D1 owner of that trusted TMDB id | `film:tmdb:<id>`, `trusted` 1, `conflicting` 0 | same | same |
| That owner: redirected, listed, rated admission, generations, EPG history, shows | no, no, no, 0, 0, 0 | same | same |
| That owner: credits, aliases, first projected (UTC) | 11, 1, 2 Nov | 11, 1, 1 Nov | 11, 1, 4 Nov |
| In the published programme and `watchlist.json` (R2) | yes, yes | yes, yes | no, no (only in `metadata.json`) |

The catalog of the published generation is not an R2 object under the D1 Discovery authority (the generation catalog key is absent in R2, as expected), so the catalog record of each TMDB id was not read; no D1 catalog read was made.

## Code path (`main` at `d73ac48`)

- `src/d1-enrichment.js`, per-entity Film write: inside one fenced transaction, `repository.projectFilm({film, watchlist, credits, metadata, preserveCanonical})`, then `repository.projectLink({survivor, redirect})` for each of the Film's redirects. A Film that carries redirects never joins a group.
- `src/canonical-repository.js` `planFilm`: for every trusted, non-conflicting external id of the Film it reads the current owner row and throws `identity_collision` if it is another Film, unless that Film is `input.releasing`. Only `planLink` sets `releasing` (from the redirect); the projector's `projectFilm` call does not. Reads inside the transaction see the state before it, so the retiring owner is still the owner when `projectFilm` plans.
- The offline importer and `applyLink` call the link first and so pass `releasing`; the projector's two-step order is the difference.

## Deterministic reproduction

`tests/d1-enrichment-identity-collision.mjs` (new, a characterization of today's behaviour on synthetic fixtures with the real projector, repository and migrations):

| Scenario | Result |
| --- | --- |
| S1: the catalog Film is projected first, then a Letterboxd Film with the same trusted TMDB id arrives with the catalog record still listed (the view links them) | `identity_collision` on every later run (three ticks tested), the Letterboxd Film never written, no redirect, the catalog Film stays the owner |
| S2 control: both arrive in the same first run | linked, the catalog id is a redirect, `errorCount` 0 |
| S3: the catalog Film is projected first, then the catalog no longer lists it | the same `identity_collision`; the stale owner row stays |
| S4 control: the Letterboxd Film is projected first, the catalog Film arrives later | linked, redirect written, `errorCount` 0 |

## Classification

| Case | Class | Reason | Severity |
| --- | --- | --- | --- |
| A | **Projector defect** (write order), and, if the view has no link, a stale duplicate in D1 | The Letterboxd Film cannot be projected while its TMDB twin owns the trusted id; reproduced as S1 or S3 | Medium |
| B | Same as A | Same | Medium |
| C | Same as A | Same; in addition the Film is in `metadata.json` only, not in the programme or the watchlist | Medium |

Severity is Medium because the three Films are 0.06 % of the 5,195 changed Films of that run, the refusal repeats every run that reaches them, nothing is lost in R2, and no duplicate row is written; the effect is that D1 does not hold the Letterboxd Film, its watchlist membership or the redirect, and keeps the TMDB twin as the Film.

## Does it block L1?

- **The grouped write path is not the cause.** The refusal happens in the per-entity path, with `fallbacks` 0 and `constraintFallbacks` 0 in the run; S1 and S3 refuse with the grouped path off. A Film with redirects never joins a group. Whether a Film without a link (S3) refused inside a group would count as a constraint fallback before the same per-entity refusal was not tested.
- **Verdict:** this does not block L1 activation of the grouped path. It does mean that `errorCount` 0 cannot be the acceptance signal of an L1 run while these Films are in the view: the acceptance has to name these three as known, or the fix below has to land first. The choice between the two is the owner's.

## Fix plan (not done here; a separate implement card, with owner GO for anything live)

1. In the projector's per-entity Film write, let `projectFilm` accept the Films the link retires (for example pass the redirects' `from` ids as releasing owners, or run the link plan first inside the same transaction). Tests: turn S1 around in this characterization (written, redirect present, `errorCount` 0), keep S2 and S4, add a case with two redirects.
2. S3 needs a decision, not code: a stale `film:tmdb:<id>` with no link in the view. Options for the owner: the view emits the link, a reviewed repair retires the stale Film, or the Letterboxd Film is refused on purpose and reported as a source identity issue. No data correction is made or proposed here.
3. To tell S1 from S3 per Film: read the D1 catalog record of each TMDB id through the Discovery authority's read route and check whether the view carries a redirect for it.

## Limitations

- The three cases are not split between S1 and S3; both are reproduced and both fail the same way.
- Run summaries were read from log lines; `projection_run` keeps one row, so the 02:00 UTC summary itself is no longer in D1.
- The grouped path with an unlinked refused Film was not run.
- Everything is one day and three Films.
