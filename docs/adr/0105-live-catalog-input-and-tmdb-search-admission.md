# ADR 0105: A personal Letterboxd import matches against a live catalog read, finds missing films by a bounded TMDB search and admits them as inferred

**Status:** Accepted  
**Original decision date:** 2026-11-08 (owner GO for stage B2 on the AIR-388 card, Madrid)  
**Recorded at:** 2026-11-08  
**Approval source:** the owner's stage B2 GO comment on the [AIR-388 card](https://trello.com/c/fFvwYLjM#comment-6af09f1feb452738c7b5256d) (2026-11-08 16:11 UTC) after [PR #433](https://github.com/vladimino/iptv-watchlist/pull/433): one bounded read-only read of the live catalog and links, a bounded read-only TMDB search of at most 1,500 requests at no more than 4 per second, the implementation, and a recount. This is a decision about code and contracts. It is **not** authorization for a production validate, commit, Film admission, ratings write or mass import, nor for a Task, flag, migration, Access change or cutover. Each of those needs its own approved bounded plan.  
**Related work:** [AIR-388](https://trello.com/c/fFvwYLjM); [ADR 0104](0104-inferred-letterboxd-identity.md); [ADR 0087](0087-rated-archive-film-admission.md); [ADR 0099](0099-canonical-film-person-d1-authority.md); [ADR 0079](0079-d1-authoritative-published-epg.md)  
**Supersedes:** None. It extends ADR 0104 and changes no earlier Accepted record.  
**Superseded by:** None

## Context

ADR 0104 lets an export film match a stored TMDB movie by one unique original title and year. The first measurement used a legacy R2 snapshot of 1,947 films. The live catalog is not there: Film/Person sources are still R2-owned (`film_person_authority` `r2/open`), but since 2026-11-04 the Discovery catalog admission is D1-owned (`discovery_authority` `d1/open`). The R2 object `epg/discovered-films.json` stopped moving on 2026-11-04 (2,635 records), and the admitted catalog is the set of `current` movie rows of `discovery_admission` (5,971 on 2026-11-08). The trusted Letterboxd-to-TMDB links are a ratings-domain document that is D1-owned (`ratings_domain_authority` `d1/open`), so the R2 copy is behind. The baseline planner required a `consistent_fenced` R2 snapshot, which a 660 MB bucket with a continuous Discovery writer cannot give cheaply and which would not contain the D1-owned parts anyway.

Counted against the live catalog on 2026-11-08 (owner export of 13:55 UTC, counts only): 425 verified, 1,079 inferred into an existing Film, 93 review (56 alias only, 37 year drift), 24 provisional, 1 ambiguous and 842 unmatched.

## Decision

1. **A live catalog read is a valid identity input for matching.** `plan --catalog-dir <dir>` (exactly one of it and `--snapshot`) reads a directory made once, read-only, from the live authorities: `catalog.json` (the admitted Film records), `links.json` (the trusted link index), `provenance.json` (`source: live_catalog_read`, `readAt`, what was read), and optional `metadata.json`, `watchlist.json`, `programme.json`, `view-index.json`. It is for matching only. It is **not** a fenced snapshot and does not claim to be: a missing required file is an error, never a smaller catalog, and `origin.json` records the status `live_catalog_read` with the read time and the counts. The commit-time alias conflict and the admission conflict stay the authority against a link or code that changed after the read. The original snapshot input and its contract are unchanged.
2. **How the read was taken (2026-11-08).** Authority markers were read first. R2 objects were read with the read-only exporter client, which can build only `GET` and `HEAD` and never calls the Worker, so no repair, sync, reprojection or lease can run; each version was checked unchanged after the read. The catalog and the links were read by `SELECT` from D1. Nothing was written.
3. **Films the catalog does not know are found by a bounded TMDB search.** `scripts/letterboxd-tmdb-search.mjs` asks TMDB `search/movie` once per still-unmatched film (page 1, one attempt, no retry) and applies the ADR 0104 rule to the answer: exactly one movie whose normalized original title equals the normalized export name and whose release year equals the export year is `inferred_new`; a year one off, a name that matches only the localized title, several equal results, no result and a missing export year are review reasons and never admit a Film. Limits: at most 1,500 requests per run, at most 4 per second, no detail or enrichment request, the first 403 or 429 ends the run, three failures in a row end it, a decision is never asked again on resume. The credential is `TMDB_READ_TOKEN` from the environment only, sent as a bearer header, never printed or written; the tool creates no credential and without it only a dry run works. Output is a private file and counts only.
4. **The plan carries the search result, once.** `plan --include-inferred --tmdb-results <file>` turns an `inferred_new` decision into a plan item with `identity: "inferred"` only if no other export code and no accepted or inferred film holds the same movie. A movie that is already a catalog Film is linked as an existing Film (no `admit`); a missing one carries `admit: {title, year}`. The results file's SHA-256 is bound into `origin.json`, and the report counts decided, review (per reason), pending and error films and `filmsToCreate`.
5. **Admission uses the existing receipt, not a new writer.** When the commit route meets an item with `admit`, it first writes an entry to `letterboxd/admissions/verified-films.json` (the existing admissions receipt, `identity: "inferred"`, no `watchlist` field, `filmPath` null), then links and writes the facts, so the Film exists before its rating; the existing enrichment projector upserts the Film as it does for an AIR-340 admission. An entry that already holds the movie is kept unchanged, a source code already bound to another movie is a conflict that writes nothing, and a replay writes nothing. The receipt lists `admitted` per film. Rollback and the per-film unlink reverse the facts and the link as in ADR 0104 and leave an admitted Film in place: a Film is never deleted by an unlink.
6. **Not decided:** any production plan run, validate, commit or admission; the TMDB credential for a run (none exists in the agent session); retiring the snapshot input; the browser apply path (its index still does not read the catalog); AIR-321 Film authority; metadata or localization fetches for the new Films.

## Alternatives considered

- **Require the fenced snapshot:** rejected; it cannot be produced against a continuous writer at this size and does not hold the D1-owned catalog or links.
- **Read the catalog through a Worker route:** rejected for this stage; the Worker routes that read it can repair mirrors, and the owner's GO asked for a read that cannot.
- **Admit through a new admin identity step:** rejected; the baseline commit already has receipts, replay and rollback, and the admissions receipt plus the projector are the existing Film path.
- **Search with the year as a TMDB filter:** rejected; one unfiltered page lets the rule see a year drift and an alias-only hit instead of hiding them.

## Consequences

Most of the export reaches the catalog without a Letterboxd page lookup, and the remainder needs one search each within a hard budget. An inferred Film is marked in the receipt, so it is findable and correctable per film, but it sits in an object named `verified-films`; readers that need the distinction read `identity`. The catalog directory can be stale by the time of a commit, which the commit-time conflicts bound. A code revert does not remove an admission entry, a link or a fact already written.

## Recovery and migration boundary

Reversible: the code and the plan inputs. Not reverted by code rollback: admission entries, links, facts and receipts a commit wrote, and any Film the projector then created from an entry. A wrong film is corrected with the per-film unlink; removing an admitted Film is a separate, approved action. No migration, flag, Task, credential or production write is part of this change.

## Evidence

- **Live read (2026-11-08, read-only):** five R2 objects by `GET` with a `HEAD` after each (versions unchanged), the catalog and links by `SELECT`; the markers `film_person r2/open`, `ratings d1/open`, `published_epg d1/open`, `discovery d1/open`.
- **Counts:** as in Context; the search was **not run** (no TMDB credential in the agent session), so the 842 unmatched films are unresolved, not rejected.
- **Tests:** `tests/letterboxd-tmdb-search.mjs` (rule, limits, stop conditions, resume, no credential no request, private output, catalog directory checks) and `tests/letterboxd-inferred.mjs` (plan from a catalog directory and results, route admission, projector reading, replay, conflict, unlink keeps the Film).

## Follow-ups

A run of the search with an approved read-only TMDB token; a recount with its results; one approved bounded production plan (validate, then commit with receipts) and its freshness readback.
