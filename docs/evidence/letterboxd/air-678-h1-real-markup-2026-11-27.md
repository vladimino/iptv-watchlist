# AIR-678: H1 real-markup verification (ADR 0217 delivery step 8)

**Verdict: H1 stays NO-GO.** No real Letterboxd film page with a positively absent TMDB relation was found, so neither the absence marker nor the eligible page types are established. `H1_RULES` stays empty and fail closed. This report authorizes no activation, flag, Task, migration or production write, and it is not a GO for AIR-679.

## Provenance and authority

- Owner decision of 27 Nov 2026 on [AIR-678](https://trello.com/c/4ohLLvnD): a small number of public GETs to `boxd.it` and `letterboxd.com`, outside the production Worker, no retry on challenge/403/429, no authentication, no transport change. The 13:31 UTC card decision **excluded production D1/R2 reads**. Later in the same session the owner told the agent in chat to find the pages itself and then chose, by replying `1`, the offered option of one bounded read-only `SELECT` of the cohort described below. That chat approval is **not recorded on the Trello card**; it needs the owner's confirmation or a card record, and this report does not claim a Trello reference for it.
- Captures: 27 Nov 2026 about 14:00-14:20 UTC from the agent container, 49 GETs that reached the upstream (no retries; no challenge, 403 or 429 from Letterboxd): 18 `boxd.it` redirects (1 control, 17 cohort lids) and 31 `letterboxd.com` film pages, counted without overlap: 3 controls, 1 availability probe whose body was not inspected, 10 further probe slugs (5 answered `200` with a TMDB id, 5 were `404` or `301`) and the 17 cohort pages. One earlier `boxd.it` attempt before the host was allowed was refused by the environment proxy (`CONNECT` 403) and never reached Letterboxd; it is not counted. Counts are from the session's own command log; no capture was refetched to reconcile them. The redirect of every one of the 18 `boxd.it` lids was `302` to a `/film/<slug>/` page.
- Cohort read: one `SELECT` on the production D1 `iptv` (`rows_written` 0, `rows_read` 4,888,386 because the anti-join was not index-driven; it was not repeated). It listed `ratings_view` aliases that are watched and rated, are not `tmdb`-format, have no `film_external_id` row for scheme `letterboxd`, and share their `fact_key` with no other alias. It returned 17 lids (the 20 facts of [AIR-627](https://trello.com/c/IOERZ9GI) are counted by a different predicate). The lids and slugs are the owner's private data and are **not** recorded here or in the fixtures.

## Result per H1 predicate (ADR 0217 decision 2)

| Check | Real evidence |
| --- | --- |
| 1 redirect | `boxd.it/<lid>` answers `302` to `https://letterboxd.com/film/<slug>/` for all 18 lids tried (1 control, 17 cohort). Confirmed. |
| 2 `200` and complete body | `200`, 160-390 KB, body ends with `</body>` `</html>`. Confirmed on every successful response that was inspected (25 pages: 3 controls, 5 probes, 17 cohort); the 404/301 probes are excluded. |
| 3 not a challenge | No challenge page was served on any request. Confirmed. |
| 4 shortlink equals lid and canonical equals redirect target | **Not satisfiable by the current page parser.** A real page has no `<link rel="canonical">` and no `<link rel="shortlink">`. The lid is in `<input id="url-field-film-<n>" value="https://boxd.it/<lid>">` and the canonical path in `<meta property="og:url">`. `pageEvidence` returns `shortCode: null`, `shortlinkPresent: false`, `canonicalPath: null` for all three controls, so the dormant proof would refuse every real page with `shortlink_missing`. See "Findings". |
| 5 eligible page type | `og:type` was `video.movie` on the 3 controls (it was not extracted from the other pages), and the body tag carried `data-type="film"` on all 25 inspected film pages. **Neither marker separates a feature film from a TV entity**: both TV controls carry `data-type="film"` and `og:type=video.movie`. No other type was seen, so the allowlist is **not** established and neither value establishes feature-film eligibility. |
| 6 id block present and no TMDB | **Not established.** The block exists: `<p class="text-link text-footer"> ... More at <a ... data-track-action="IMDb"> <a ... data-track-action="TMDB">`. All 25 inspected pages carried the TMDB button and a TMDB link: a numeric body id on 23 (1 control, 5 probes, 17 cohort) and an empty one on the two TV controls (23 + 2 = 25). A page without that button, the positive absence, was **not observed**. |

## Controls (sanitized fixtures)

`tests/fixtures/air-678-letterboxd-real-markup/` holds excerpts of three public, non-private pages (head `og:*`, trimmed JSON-LD of name, year, duration and two actors, the real `<body>` tag, the shortlink input and the id footer; report ids replaced by `0`). Test: `tests/letterboxd-real-markup-h1.mjs`.

| Fixture | Body `data-tmdb-id` | Footer TMDB link | Meaning |
| --- | --- | --- | --- |
| `movie-with-tmdb-id` | `10750` | `/movie/10750/` | positive control: TMDB movie |
| `tv-zero-empty-body-id` | empty | `/tv/0/` | TMDB TV entity with id 0 |
| `tv-empty-body-id` | empty | `/tv/128876/` | TMDB TV entity |

The 17 cohort pages and the 5 further probe pages (`200`) matched the first row: numeric body id and a TMDB button. Their markup is not stored.

## Findings

1. **An empty `data-tmdb-id=""` is not an absence marker.** Both empty-id controls name a TMDB TV id in the footer. A parser that read the empty attribute as "no TMDB" would admit TV entities as lid-only films. The dormant proof refuses them, but not at the TMDB guard: on real parser output both TV controls stop earlier at check 4 (`page_refused` / `shortlink_missing`), the movie control at `page_movie`. Only a **synthetic evidence adapter** (the url-field lid and the `og:url` path filled into the evidence, over the unmodified real HTML; labelled synthetic in the test, not a parser and not real evidence) reaches the TMDB relation guard, and there both TV controls are `tmdb_unreadable`. The raw guard also rejects any `data-tmdb-type` attribute, which every real page carries. None of this tells what a no-TMDB page looks like; that representation is **not inferred** from these controls.
2. **Check 4 cannot pass on real parser output.** The shared `pageEvidence` reads `link rel=shortlink/canonical` tags that real pages do not carry; the shortlink is in the `url-field` input and the canonical in `og:url`. Changing `pageEvidence` is not dormant (it also serves the live movie path, where ADR 0090 tolerates a missing shortlink via the redirect hop), so this PR does not change it and opens no card: that needs an owner disposition.
3. **The cohort of 17 does not show a no-TMDB page.** All 17 are TMDB-bearing pages that were not admitted for other reasons ([AIR-659](https://trello.com/c/GsNNdLck)). A page without TMDB may be rare or absent in this account's data. No H1 admission is supported by it.

## Limits

- Twenty-five pages are a small sample, not a census of Letterboxd. Absence of a no-TMDB example is not proof that none exists.
- The raw HTML captures were kept only in the session scratchpad; the fixtures are excerpts.
- The cohort `SELECT` read 4,888,386 rows and wrote 0. Shape: `ratings_view` filtered to watched and rated non-`tmdb` aliases, with a `NOT EXISTS` on `film_external_id` (`scheme = 'letterboxd'`, `value` = alias) and a correlated `NOT EXISTS` on `ratings_view` by `fact_key` (no index on `fact_key`). Lesson for later read-only cohorts: resolve the alias set and the `fact_key` groups in separate bounded statements and check `EXPLAIN` first. An expensive one-off read is not a new resource cap or an optimization task, and it was not repeated.
- The 17 candidates serve the identity recovery of [AIR-659](https://trello.com/c/GsNNdLck). They do not show that no no-TMDB page exists anywhere.

## Next

H1 stays NO-GO and AIR-678 stays open; AIR-679 stays blocked. H2 includes H1 and does not supply the missing positive-absence evidence; H3 would be a material policy change for the owner, not an engineering shortcut. No parser card is opened and neither H2 nor H3 is implemented without a disposition.
