# EPG non-film screening

EPG discovery drops obvious series episodes and TV shows before any TMDB Movies request. The screen is a title rule in `nonFilmEPGReason()` ([source](../../../src/sources.js)). It is deliberately narrow: a missed episode costs at most a few bounded TMDB lookups, while a wrongly screened feature film is never looked up at all. A title that is not clearly serialized stays a discovery candidate. A second, scan-only screen ([serial-episode forms](#serial-episode-screen-scan-only)) removes four structural forms that carry more evidence than a title word; it never runs in the discovery cheap pass.

## Where the screen runs

| Step | Input | Effect |
| --- | --- | --- |
| EPG scan (`scanEPG`) | Raw programme `<title>` and the programme XML | A programme with one reliable watchlist/catalog match is never screened. Otherwise a screened programme is counted in `filteredNonMovies` and does not enter the discovery ledger. |
| Serial-episode screen (`scanEPG` only) | Programme title, description and duration, plus the known-title index of the scan | A programme with no reliable Film match and no known whole-title match whose title has one of the [serial-episode forms](#serial-episode-screen-scan-only) is counted in `filteredNonMovies` and in `serialFiltered` and does not enter the discovery ledger. The cheap pass, the actionability check and the status counts do not apply these forms, so no stored decision depends on them. |
| Channel policy (`scanEPG`, before the title is read) | `epg_channel_policy` map, when `EPG_CHANNEL_POLICY` is `on` | A programme on a `deny_all` channel is dropped before Film matching, so neither a Film show nor a screening count nor a candidate exists for it. On `known_only` only a reliably identified Film is kept; every other programme is skipped, so the title rule never sees it. See [Channel policy](candidate-discovery.md#channel-policy-in-the-epg-scan). |
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

Words such as `Live`, `концерт`, `документальный`, `интервью` and `шоу` never screen a title: concert and documentary films stay candidates. The scored identity gate refuses them later. Any TMDB Documentary is `documentary_excluded`. A recording of a real concert is `concert_recording` when a Music card with no feature genre agrees with a concert/music category or with an explicit performance phrase in the title, or with such a phrase other than `live in` in the overview. A TV Movie card with no Music is `concert_recording` when that category and a performance phrase agree, or when the title and overview independently each contain such a phrase. A card with no Music, TV Movie, Documentary or feature genre uses the same independent title-and-overview test. A bare Live/Concert word is not that phrase, and neither is `live in` or a bare `live` in an overview. Two holds keep their own durable reason and verify nothing until the observation is owner-confirmed ([ADR 0168](../../adr/0168-empty-genre-card-is-unclassified.md)): a card with no genre at all that no phrase rule excludes is `needs_verification` / `genre_evidence_missing`, and a Music card with no feature genre whose overview contains `concert` or a word starting `концерт` is `needs_verification` / `concert_recording_ambiguous`. The owner policy-exclusion writer additionally reads performance and documentary words in the stored synopsis of a card with no feature genre (a title word alone does not count) ([ADR 0169](../../adr/0169-writer-only-catalog-cleanup-classification.md)); that classifier never runs in the gate. Six owner-reviewed ids are eligible for the writer on an exact title, year and runtime match ([ADR 0171](../../adr/0171-owner-reviewed-policy-exclusion-list.md)); the gate never reads that list. A TMDB id the owner retired with the writer is not admitted again by a new observation key: [ADR 0172](../../adr/0172-owner-policy-exclusion-blocks-reentry.md) adds `owner_policy_excluded`. The screen never queries TMDB TV.

XMLTV `<category>` is copied onto the discovery candidate (`categories`, at most eight distinct non-empty values). An empty or absent tag becomes `[]`. It does not screen at scan: a `Концерт` category does not drop the title. The identity gate reads a non-empty array as one concert signal beside TMDB Music, and, on a TV Movie card, beside an explicit performance phrase. A stored observation that omits `categories` is treated as `[]` until the next EPG scan writes the field. A film category, or a missing category, does not by itself save a Documentary or a concert recording that the detail card already shows.

## Serial-episode screen (scan only)

`serialEpisodeReason()` and the same-scan pass `serialDashEpisodes()` in [source](../../../src/sources.js) add four forms. They run only in `scanEPG`, after the reliable-match precedence, and only for a programme whose whole normalized title matches **no** Film in the scan's known-title index (watchlist and catalog titles, originals, aliases and movie titles). The discovery cheap pass, `resolutionActionability` and the status counts do not evaluate them, so a stored `excluded_nonfilm` decision is never written, or re-opened, because of one of these forms.

| Form | Rule | Reason in `serialFiltered` |
| --- | --- | --- |
| Season-pipe-episode pair | `<Title> 2|5 <Name>`, `<Title> (2|1)`: two digit groups around a vertical bar after at least two letters | `season_pipe_episode` |
| Mini-series label | the label `мини-сериал` (any dash) after at least one letter of a title; the bare word is a title | `mini_series_label` |
| Ordinal episode | `N-я серия`, `N-я - M-я серии`: `N`, or the upper bound of a range, of **7 or more**; a stem (the title before the marker) with at least one letter, **no year** in it, and **not a known Film title** in the index | `ordinal_episode` |
| `<Title> S-EE` | `<Title> 2-07`: a placeholder description (empty or equal to the title), a valid duration of at most 80 minutes in every airing, no catalog or per-slot confirmation, and the same stem in **at least two distinct programmes of the same scan** | `dash_season_episode` |

Fail-safe rules that keep a film out of the screen:

- Ordinals 1 to 6 stay candidates: a multi-part film is aired in parts.
- The ordinal form runs only when the scan input holds at least one catalog Film. An empty or unavailable catalog would make every stem look unknown and never permits a screen.
- A programme with one reliable watchlist or catalog match is never screened, and neither is one whose whole title is a known Film title that only the year or the duration refused.
- A missing description, duration or identity is never a reason to screen: the `S-EE` form needs a valid duration and a repeat, and a singleton stem in a scan is kept.
- On a `known_only` channel a programme that one of these forms would screen does not claim its slot, like any other screened non-film, so a competing known Film on the same channel and start is kept.

The screen does not read a stored decision. An observation that is already in the ledger leaves the active ledger by the ordinary seal and archive when the next scan no longer contains it; no decision is rewritten and nothing is deleted. Forms that are deliberately **not** screened: an abbreviated `<Title>", N сезон, K с.` marker, a season alone (`<Title> 2 сезон`), `Эпизод N` and `Season N`, a series label that is not `мини-сериал`, a numeric suffix without the placeholder and the repeat, and every ordinal below 7.

## Reversibility

A stored `excluded_nonfilm` decision is not permanent. When the current rule no longer screens the candidate's title, `resolutionActionability` treats the candidate as actionable again, and the next normal discovery chunk resolves it like any other current observation; a confirmed `confirmedTmdbId` is promoted to `verified` in the cheap pass without TMDB. Until that happens the stored decision stays as it is: there is no backfill, no R2 cleanup and no rewrite of historical or expired candidates. A candidate that is not current is not re-checked. A rule that still screens the title keeps the stored decision unchanged, including its original reason code. Film/Person readers continue to treat a stored `excluded_nonfilm` decision as "no Film" until the resolver replaces it.

## Measurement

`filteredNonMovies` in `epg/discovery-latest.json` and `rejectedNonfilm` in the discovery status are totals over all reason codes. Under the proposed [ADR 0034](../../adr/0034-bounded-discovery-ledger.md) bounded ledger, `rejectedNonfilm` would count active rows only, and archived rows would be screened again when they re-enter. They are not the frequency of any single form and are not evidence of screening quality. [The screening audit script](../../../scripts/air-94-screening-audit.mjs) compares the rule with a frozen copy of the earlier rule on a local snapshot and prints aggregates only; title lists go to an explicit private directory outside the repository.

[The residual audit](../../../scripts/air-566-residual-nonfilm-audit.mjs) classifies the unresolved candidates that still have showings on `discover` channels into proven series-episode forms, review groups and rows with no structural evidence, and checks each form against the titles of verified Films ([report](../../evidence/discovery/air-566-residual-nonfilm-audit-2026-11-22.md)). It does not change the rule: the forms listed above as not screened stay unscreened.

[The serial-rule replay](../../../scripts/air-566-serial-rule-replay.mjs) runs the production functions of the serial-episode screen over a local export of the ledger, the verified titles and the catalog, and prints aggregates only ([report](../../evidence/discovery/air-566-serial-rule-replay-2026-11-22.md)). `stats.serialFiltered` of a scan counts the observations each form removed; it is part of `filteredNonMovies`, not an addition to it.
