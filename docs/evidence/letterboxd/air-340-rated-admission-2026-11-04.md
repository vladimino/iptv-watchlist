# Rated archive admission: synthetic contract

**Captured:** 2026-11-04, local `node tests/letterboxd-rated-admission.mjs`, `node tests/letterboxd-rated-candidates.mjs`, `node tests/film-retention.mjs`, `node tests/admin-letterboxd-apply.mjs`, `node tests/admin-letterboxd-page.mjs` and the rated-archive section of `node tests/d1-enrichment.mjs`. No production R2, D1, Worker, Letterboxd page, TMDB call, flag or Scheduled Task
**Input:** invented ZIP rows, an in-memory bucket, and a fresh local SQLite database through the ratings migrations. One programme film, one R2 fact and one D1 fact are labeled fixtures. No private export, rating or snapshot id is copied
**Method:** the pure classifier; the preview and apply routes with a fetch counter; one identity step against a stub page and a stub movie document; the lifecycle reader; one projector pass with the admissions object missing, present and invalid
**Scope:** contract test only. Not a live inventory and not a count of production Films
**Verdict:** **SYNTHETIC CONTRACT HOLDS.** An open ratings marker compares the D1 fact and does not read the R2 fact. A held marker still reads R2. A broken marker is `ratings_domain_unavailable` and writes nothing. A rated row the matcher does not accept is stored by archive SHA-256 and short code after an explicit commit, survives an interrupted receipt, and is not duplicated by a replay. A watched row with no rating is excluded. HTTP 403 stops the identity step and is not retried until resume. A missing TMDB token does not verify the film. A verified movie is `tmdb_<n>` with no watchlist field and no Letterboxd link. A TV page and a conflicting historical TMDB id stay needs-review and write no Film. A missing admissions object admits nobody. A present object inserts that one Film with no watchlist membership. The same movie already on a programme film stays one Film. The October 2026 count of 2,040 is ignored
**Used by:** [AIR-340](https://trello.com/c/zWxj3laC), [ADR 0087](../../adr/0087-rated-archive-film-admission.md) (Proposed)

## What the fixtures show

| Case | Result |
| --- | --- |
| Open ratings marker, D1 rating newer than the archive, older R2 rating present | Outcome `older`. The film record and the link index are absent from the R2 reads |
| Marker `d1` with cutover `held` | The R2 fact is read and can replace |
| `ratings_view` dropped while the marker is open | Status 200, `ratings_domain_unavailable`, writes false |
| Programme generation changes during the read | `ratings_domain_generation` drift |
| Rated unmatched row, watched-only row, ambiguous remake | Pending, excluded, needs-review. Preview performs no fetch and no put |
| Confirm and commit of the candidate chunk, then a failed receipt put and a retry | One registration. The retry does not add the code again |
| Same archive committed again, and the published EPG pointer changed | The SHA-keyed candidate document stays. A newer stored observation is not rewritten |
| Identity step, HTTP 403, then the same call without `resume` | No second fetch. The candidate stays pending |
| Resume with no TMDB token | `tmdb_unavailable`. No admissions object |
| Resume with a movie document that agrees | Admission `tmdb_900001`, rating written, `links.letterboxd` null, no `watchlist` on the fact, the admission or the view index |
| Rollback after that verification | The verified code stays. The needs-review code is removed |
| TV page, and a stored historical TMDB id that disagrees | Needs-review. No Film |
| Remembered counts 561, 1 and 1,478 | Returned as ignored. They are not the chunk |
| Lifecycle: admissions map present for `tmdb_77` | One Film, membership false, shadow parity holds |
| Same movie already on a programme film | One Film |
| Admission item carrying `watchlist: false`, or no admissions object | Nobody admitted from this path |
| Projector: object missing | `film:tmdb:77` count 0 |
| Projector: object present | One Film inserted, `watchlist_film` count 0 |
| Projector: `films` is an array | Outcome `failed`, reason `input_invalid`, no Film written |

## Limits

- No production object was listed or read. The number of rated rows in a future owner ZIP is unknown.
- The identity step was exercised with stub responses. It does not measure Letterboxd or TMDB behaviour.
- Deploying the reader does not write. A later production identity step that writes the admissions object would let the existing enrichment cron upsert that Film. This run does not do that, and it does not authorize it.
