# EPG non-film screening

EPG discovery drops obvious series episodes and TV shows before any TMDB Movies request. The screen is a title rule in `nonFilmEPGReason()` ([source](../../../src/sources.js)). It is deliberately narrow: a missed episode costs at most a few bounded TMDB lookups, while a wrongly screened feature film is never looked up at all. A title that is not clearly serialized stays a discovery candidate.

## Where the screen runs

| Step | Input | Effect |
| --- | --- | --- |
| EPG scan (`scanEPG`) | Raw programme `<title>` and the programme XML | A programme with one reliable watchlist/catalog match is never screened. Otherwise a screened programme is counted in `filteredNonMovies` and does not enter the discovery ledger. |
| Discovery cheap pass (`resolveDiscoveryChunk`) | Ledger candidate title | Stores `{status:'excluded_nonfilm', reason}` for a screened candidate. A `verified` decision or a candidate with `confirmedTmdbId` is never screened. |
| Actionability (`resolutionActionability`) and counts (`discoveryCounts`) | Candidate and stored decision | A candidate the current rule screens is not actionable and counts as `rejectedNonfilm`. |
| Ledger canonicalization | Merged candidate | A verified decision is carried over first; otherwise the current rule decides. |

`screenedNonfilmReason(candidate, decision)` applies the identity precedence: it returns `null` for a verified decision or a confirmed TMDB identity, and the title rule's reason otherwise.

## Reason codes

| Code | Screened forms | Not screened on its own |
| --- | --- | --- |
| `show_label` | Leading `TV series`, `TV show`, `Телешоу`, `Телепередача`, `Передача`, `Телепрограма`, `Серіал`; a bare `Series:`/`Show:` only with a colon | `Show Boat`, `Series 7: The Contenders` |
| `series_label` | Leading `т/с`, `м/с`, `телесериал`, `мультсериал`, `сериал` | — |
| `episode_label` | Episode codes `S01E01`, `S1E1`, `S01 E01`, `S1.E1`, `S1,Ep1`, `s01ep04`; any season marker together with any episode marker (`Season 1. Ep. 7`, `сезон 2, серия 10`, `Сезон 4-й 17-я серия`, `(Series 13) … (Episode 6)`); `серия N` / `N серия`; ordinal seasons `Сезон 4-й` / `4-й сезон`; `Episode` with a number of 100 or more; a trailing `. Ep N` | `Episode 3`, `Эпизод 3`, `Season 2`, `Сезон охоты 2`, `N-я серия` / `N-серия` without a season (multi-part films aired in parts), `Ep 12` inside a title |
| `season_episode_suffix` | A lettered title followed by `-S-E`, such as `Пример-1-5` | A date-like title with no letters, such as `12-05-08`; `Title 3-3` without a dash before the numbers |
| `broadcast_episode` | `Выпуск N`, `Выпуск №N`, `Спецвыпуск N`; `N-M серии` | — |
| `xmltv_episode_num` | Programme XML with `<episode-num system="xmltv_ns">` whose episode part has a number, or `system="onscreen"` with an episode code or season and episode | An `episode-num` without an episode number |

Words such as `Live`, `концерт`, `документальный`, `интервью` and `шоу` never screen a title: concert and documentary films are films. The screen never queries TMDB TV.

## Reversibility

A stored `excluded_nonfilm` decision is not permanent. When the current rule no longer screens the candidate's title, `resolutionActionability` treats the candidate as actionable again, and the next normal discovery chunk resolves it like any other current observation; a confirmed `confirmedTmdbId` is promoted to `verified` in the cheap pass without TMDB. Until that happens the stored decision stays as it is: there is no backfill, no R2 cleanup and no rewrite of historical or expired candidates. A candidate that is not current is not re-checked. A rule that still screens the title keeps the stored decision unchanged, including its original reason code. Film/Person readers continue to treat a stored `excluded_nonfilm` decision as "no Film" until the resolver replaces it.

## Measurement

`filteredNonMovies` in `epg/discovery-latest.json` and `rejectedNonfilm` in the discovery status are totals over all reason codes. Under the proposed [ADR 0034](../../adr/0034-bounded-discovery-ledger.md) bounded ledger, `rejectedNonfilm` would count active rows only, and archived rows would be screened again when they re-enter. They are not the frequency of any single form and are not evidence of screening quality. [The screening audit script](../../../scripts/air-94-screening-audit.mjs) compares the rule with a frozen copy of the earlier rule on a local snapshot and prints aggregates only; title lists go to an explicit private directory outside the repository.
