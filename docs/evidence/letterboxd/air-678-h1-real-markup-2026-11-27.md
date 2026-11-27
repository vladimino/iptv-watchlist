# AIR-678: H1 real-markup verification (ADR 0217 delivery step 8)

**Verdict: H1 stays NO-GO.** No real Letterboxd film page with a positively absent TMDB relation was found, so neither the absence marker nor the eligible page types are established. `H1_RULES` stays empty and fail closed. This report authorizes no activation, flag, Task, migration or production write, and it is not a GO for AIR-679.

## Provenance and authority

- Owner decision of 27 Nov 2026 on [AIR-678](https://trello.com/c/4ohLLvnD): a small number of public GETs to `boxd.it` and `letterboxd.com`, outside the production Worker, no retry on challenge/403/429, no authentication, no transport change. A later owner instruction allowed the agent to find the candidate pages itself and chose one bounded read-only `SELECT` of the cohort described below.
- Captures: 27 Nov 2026 about 14:00-14:20 UTC from the agent container, 49 GETs in total (2 s apart, no retries, no challenge, no 403/429): 18 `boxd.it` redirects (1 control, 17 cohort lids) and 31 `letterboxd.com` film pages (3 controls, 1 availability probe whose body was not inspected, 12 probe slugs of which 3 answered `200` with a TMDB id and 9 were `404` or `301`, and the 17 cohort pages). The redirect of every cohort lid was `302` to a `/film/<slug>/` page.
- Cohort read: one `SELECT` on the production D1 `iptv` (`rows_written` 0, `rows_read` 4,888,386 because the anti-join was not index-driven; it was not repeated). It listed `ratings_view` aliases that are watched and rated, are not `tmdb`-format, have no `film_external_id` row for scheme `letterboxd`, and share their `fact_key` with no other alias. It returned 17 lids (the 20 facts of [AIR-627](https://trello.com/c/IOERZ9GI) are counted by a different predicate). The lids and slugs are the owner's private data and are **not** recorded here or in the fixtures.

## Result per H1 predicate (ADR 0217 decision 2)

| Check | Real evidence |
| --- | --- |
| 1 redirect | `boxd.it/<lid>` answers `302` to `https://letterboxd.com/film/<slug>/` for every page tried (1 control, 17 cohort lids). Confirmed. |
| 2 `200` and complete body | `200`, 160-390 KB, body ends with `</body>` `</html>`. Confirmed for every page. |
| 3 not a challenge | No challenge page was served. Confirmed. |
| 4 shortlink equals lid and canonical equals redirect target | **Not satisfiable by the current page parser.** A real page has no `<link rel="canonical">` and no `<link rel="shortlink">`. The lid is in `<input id="url-field-film-<n>" value="https://boxd.it/<lid>">` and the canonical path in `<meta property="og:url">`. `pageEvidence` returns `shortCode: null`, `shortlinkPresent: false`, `canonicalPath: null` for all three controls, so the dormant proof would refuse every real page with `shortlink_missing`. See "Findings". |
| 5 eligible page type | `og:type` was `video.movie` on the 3 controls (it was not extracted from the other pages), and the body tag carried `data-type="film"` on all 25 inspected film pages. No other type was seen, so the allowlist is **not** established beyond these two values. |
| 6 id block present and no TMDB | **Not established.** The block exists: `<p class="text-link text-footer"> ... More at <a ... data-track-action="IMDb"> <a ... data-track-action="TMDB">`. All 25 inspected pages carried the TMDB button and a TMDB link (a numeric body id on 23 of them, an empty one on the two TV controls). A page without that button, the positive absence, was **not observed**. |

## Controls (sanitized fixtures)

`tests/fixtures/air-678-letterboxd-real-markup/` holds excerpts of three public, non-private pages (head `og:*`, trimmed JSON-LD of name, year, duration and two actors, the real `<body>` tag, the shortlink input and the id footer; report ids replaced by `0`). Test: `tests/letterboxd-real-markup-h1.mjs`.

| Fixture | Body `data-tmdb-id` | Footer TMDB link | Meaning |
| --- | --- | --- | --- |
| `movie-with-tmdb-id` | `10750` | `/movie/10750/` | positive control: TMDB movie |
| `tv-zero-empty-body-id` | empty | `/tv/0/` | TMDB TV entity with id 0 |
| `tv-empty-body-id` | empty | `/tv/128876/` | TMDB TV entity |

The 17 cohort pages and the 3 further probe pages (`200`) matched the first row: numeric body id and a TMDB button. Their markup is not stored.

## Findings

1. **An empty `data-tmdb-id=""` is not an absence marker.** Both empty-id controls name a TMDB TV id in the footer. A parser that read the empty attribute as "no TMDB" would admit TV entities as lid-only films. The dormant proof refuses them today (any `themoviedb.org` reference is `tmdb_unreadable`), and the test pins that.
2. **Check 4 needs a parser change before H1 can ever pass.** The shared `pageEvidence` reads `link rel=shortlink/canonical` tags that real pages do not carry; the shortlink is `url-field` and the canonical is `og:url`. This change was **not** made here: `pageEvidence` also serves the live movie path (ADR 0090 tolerates a missing shortlink via the redirect hop), so changing it is not dormant. It needs its own card and review; the test pins the current behaviour so that the change is visible.
3. **The cohort of 17 does not show a no-TMDB page.** All 17 are TMDB-bearing pages that were not admitted for other reasons ([AIR-659](https://trello.com/c/GsNNdLck)). A page without TMDB may be rare or absent in this account's data. No H1 admission is supported by it.

## Limits

- Twenty-five pages are a small sample, not a census of Letterboxd. Absence of a no-TMDB example is not proof that none exists.
- The raw HTML captures were kept only in the session scratchpad; the fixtures are excerpts.
- The 4.9 M `rows_read` of the cohort query is recorded as a resource finding; it was one `SELECT`, not repeated.

## Next

Owner decision needed: keep H1 NO-GO until a real no-TMDB page is supplied (for example by the owner's own watch list or a Letterboxd user report), or change the decision (H2/H3 in ADR 0217 alternatives, a new decision). Separate card: shortlink and canonical extraction from `url-field` and `og:url` for the H1 proof.
