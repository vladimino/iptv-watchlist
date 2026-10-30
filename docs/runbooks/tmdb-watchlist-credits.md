# TMDB credits for watchlist Films in D1 (owner approval required)

`scripts/tmdb-watchlist-credits.mjs` ([AIR-286](https://trello.com/c/EswNQuv8)) adds TMDB directors and actors to the watchlist Films in the D1 database `iptv`, next to their Letterboxd credits. Watchlist Films otherwise carry only Letterboxd credits and catalog Films only TMDB credits, so no Film carries both and the `coCredit` queue of [`/api/d1/persons/review`](../reference/api/d1-catalog.md) stays empty. One Film with both is the cross-source evidence of [ADR-0009](../adr/0009-canonical-film-person-identity.md) and [AIR-201](https://trello.com/c/1uvzKiGg): the same Film, the same role, the same name.

The script only adds rows. It merges, links or renames no person, matches nothing by name, and never changes Film identity, ratings, predictions, R2, a Worker binding or the deploy configuration. R2 stays authoritative for every existing page until a later phase of [ADR-0051](../adr/0051-d1-domain-r2-blobs.md) moves it.

## What it writes

- Films: every Film with a `letterboxd` external id and exactly one trusted, non-conflicting `tmdb` external id, read from D1.
- Request: `GET https://api.themoviedb.org/3/movie/<tmdbId>?language=ru-RU&append_to_response=credits`, the request and language discovery uses.
- Persons: discovery's format. Directors are the crew with `job` `Director`, actors the cast, the first ten of each in TMDB order, one credit per person and role. A missing person gets `person` (`person:tmdb_director/<id>` or `person:tmdb_actor/<id>`, `role_id` without the prefix, contract version 1) and one `person_alias` of kind `name` with the TMDB credit name and provenance `{"source":"tmdb","task":"AIR-286"}`. An existing person is reused unchanged.
- Credits: `film_person_credit` rows numbered after the Film's existing credits of the same role, in TMDB order.

## Steps

All modes take `--dir` (an absolute private directory outside the repository) and `--database-id` (the target uuid; the database name must be `iptv`). Credentials come from the environment only, as in the [credentials skill](../../.claude/skills/iptv-credentials/SKILL.md): `D1_BACKFILL_ACCOUNT_ID`, `D1_BACKFILL_API_TOKEN`, and for `--fetch` `TMDB_API_READ_ACCESS_TOKEN`. Behind an HTTPS proxy add `NODE_USE_ENV_PROXY=1`.

1. `--fetch` reads the Film list from D1 and asks TMDB once per Film, waiting `TMDB_REQUEST_INTERVAL_MS` (default 200 ms, discovery's pace) before each request. A network or `5xx` failure is retried at most twice; `429`, a refused token or any other status stops the run. Each answer, a `404` included, is saved under `<dir>/tmdb/<tmdbId>.json` (mode 600) and never requested again, so a stopped run resumes and a later D1 reload can repeat the write without the network. Network access to TMDB needs owner approval.
2. `--plan` diffs the saved answers against D1 and writes nothing but `<dir>/plan-<time>.json`: new persons, reused persons, new credits, Films without a saved answer, TMDB `404`s, the expected `coCredit` pairs and the current `coCredit` totals.
3. `--bookmark` prints the D1 Time Travel bookmark of the database now.
4. `--apply` refuses while any Film has no saved answer, records a Time Travel bookmark in `<dir>/apply-<time>.json`, writes one request per Film, then plans again and reports the remaining credits (0 on success) and `coCredit` totals before and after, computed with the Worker's own query. Writing to production D1 needs a separate owner approval.

Every statement is a no-op when its row exists and they run in dependency order (person, name, credit), so a run that stops halfway is completed by the next one and a repeated `--apply` changes nothing. A write is never retried: an uncertain answer stops the run as `d1 write_uncertain`, and the next run reads back and continues.

## Ordering and rollback

- A full D1 reload from R2 replaces these rows, because R2 holds no TMDB credits for watchlist Films. Run `--apply` after a reload, from the saved answers, without asking TMDB again.
- Rollback is a D1 Time Travel restore to the bookmark recorded by `--apply`. It also discards any other D1 write made after that moment.
