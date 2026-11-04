# Rated archive admission: synthetic contract

**Captured:** 2026-11-04, local `node tests/letterboxd-rated-admission.mjs`, `node tests/letterboxd-rated-candidates.mjs`, `node tests/film-retention.mjs`, `node tests/admin-letterboxd-apply.mjs`, `node tests/admin-letterboxd-page.mjs` and the rated-archive section of `node tests/d1-enrichment.mjs`. No production R2, D1, Worker, Letterboxd page, TMDB call, flag or Scheduled Task
**Input:** invented ZIP rows, an in-memory bucket, and a fresh local SQLite database through the ratings migrations. One programme film, one R2 fact and one D1 fact are labeled fixtures. No private export, rating or snapshot id is copied
**Method:** the pure classifier; the preview and apply routes with a fetch counter; identity steps against stub pages and stub movie documents, including a failed put, a second short code, a cursor, a delayed body and an oversized body; one metadata continuation and one localization continuation; the lifecycle reader with a richer discovered film; one projector pass with the admissions object missing, present and invalid
**Scope:** contract test only. Not a live inventory and not a count of production Films
**Verdict:** **SYNTHETIC CONTRACT HOLDS.** An open ratings marker compares the D1 fact and does not read the R2 fact. A held marker still reads R2. A broken marker is `ratings_domain_unavailable` and writes nothing. A rated row the matcher does not accept is stored by archive SHA-256 and short code after an explicit commit, survives an interrupted receipt, and is not duplicated by a replay. The candidate receipt is `fact: candidate`, not a rating write. A watched row with no rating is excluded. HTTP 403, a timeout and an oversized body stop the identity step and leave the code pending. A missing TMDB token does not verify the film. The admission is written before the rating. A failed rating write resumes without a second fetch and without a second rating. A second short code for the same movie is needs-review and does not replace the first source code. A pending code that sorts before the cursor is still selected. A verified movie is `tmdb_<n>` with no watchlist field and no Letterboxd link. A TV page and a conflicting historical TMDB id stay needs-review and write no Film. A missing admissions object admits nobody. A present object inserts that one Film with no watchlist membership. A richer discovered film replaces a thin archive stub. A candidate removed during the fetch is not admitted. A second claim for a different movie id does not replace the first. An enrichment page that is a different movie, a TV page, or a drifted shortlink or canonical path writes no metadata. The October 2026 count of 2,040 is ignored
**Used by:** [AIR-340](https://trello.com/c/zWxj3laC), [ADR 0087](../../adr/0087-rated-archive-film-admission.md) (Accepted)

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
| Candidate receipt | `fact` is `candidate`. First commit is `registered`; an unchanged replay is `kept` |
| Two short codes, one movie | The admission put precedes the rating put. The second code is `needs_review` `tmdb_already_imported` and the first `sourceCode` stays |
| Pending code that sorts before the cursor | That code is the next identity step |
| Same title and year, neither fetched | `same_title_year`. No fetch |
| Timeout, a body over 3,000,000 bytes, HTTP 429, a challenge | The code stays pending. No admission |
| Admission put fails, then resume | No second page fetch. The fence completes |
| Film-record put fails after the admission, then resume | The rating is written. No new fetch |
| Verified-mark put fails after the rating exists, then resume | The code becomes `verified`. The rating stays one value |
| Verify, then two enrichment continuations | Verification does not set `metadataAt`. The next step stores the synopsis. The step after that stores one Russian title and marks enrichment `done` |
| Discovered film richer than the thin `tmdb_77` stub | One Film, the discovered credits kept |
| Archive-only admission that already has a synopsis and a director | The lifecycle reader sees that film. Parity holds |
| Identity status | Reads the stored queue. `writes` is false. No fetch |
| Rollback while the page fetch is in flight | The candidate stays `removed`. No admission and no rating |
| Two identity steps claim different movie ids for one code | One claim wins. The other is `intent_conflict` and writes neither a Film nor a rating |
| Short code already bound to another movie id | `historical_alias_conflict`. The earlier binding stays. No second Film |
| Enrichment page with another TMDB id, a TV type, a different shortlink, or a different canonical path | The stop names that mismatch. The admission gains no synopsis |

## Limits

- No production object was listed or read. The number of rated rows in a future owner ZIP is unknown.
- The identity step was exercised with stub responses. It does not measure Letterboxd or TMDB behaviour. The page and movie caps were exercised by a delayed and an oversized stub, not by a live host.
- Deploying the reader does not write. A later production identity step that writes the admissions object would let the existing enrichment cron upsert that Film. A later explicit step on the same route would fetch one film page and one localization lookup. This run does not do either, and it does not authorize them.
