# Serial-episode screen: offline replay of the production predicate

[AIR-566](https://trello.com/c/8RVlrvkk) · 22 November 2026 · second delivery of the card, after the [residual audit](air-566-residual-nonfilm-audit-2026-11-22.md). L0/L1 read-only: the replay reads local exports of production `SELECT`s and the repository code; it writes nothing and calls no service. Aggregates and synthetic shapes only; no title, observation key or description of a real programme is in this report.

**Verdict.** The production predicate (`serialEpisodeReason()` and `serialDashEpisodes()` in `src/sources.js`, scan only) was replayed over the 5,009 audit candidates with the **real catalog index**: **666 hits, all 666 inside the audit's proven set, 0 outside it, 0 on a trusted-identity row, 0 on a mixed row, 0 on the 25,113 verified-title controls.** It deliberately reaches fewer rows than the audit's stateless predicate (721 hits) because every form that carried an unproven hit is either guarded or left out. This report proves the predicate against the pinned ledger; it does not prove behaviour on a new scan. That needs the natural EPG run after deploy.

## What was implemented (scope)

A scan-only screen with four forms, the reliable-match precedence unchanged, and no change to the discovery cheap pass, to stored decisions, to the Channel policy or to the verified-Film paths. The maintained description is in [non-film screening](../../reference/domain/nonfilm-screening.md#serial-episode-screen-scan-only). In short:

| Form | Guard |
| --- | --- |
| `<Title> 2\|5 <Name>` season-pipe-episode pair | none beyond the form and two letters of title |
| trailing `мини-сериал` label (after a closing parenthesis, a colon or a dash, ending the title) | the bare word, an inflected form and a title that merely contains it are titles |
| ordinal `N-я серия` with `N` (or a range's upper bound) at least 7 | stem without a year, stem not a known Film title, catalog present in the scan input |
| `<Title> S-EE` | placeholder description, valid duration of at most 80 minutes, a whole title that is not a known Film title, same stem in at least two distinct programmes **of the same scan** |

Left out on purpose, with the numbers the audit measured: ordinals 1 to 6 (127 proven rows), the abbreviated `<Title>", N сезон, K с.` form (23 proven rows, one singleton), `<Title> 2 сезон`, series labels other than `мини-сериал`, and every `S-EE` singleton of a scan (the 8 unproven singletons of the audit).

## Corrections after the first independent review

Two false-positive paths were found at the first head and closed; the replay was repeated and its numbers did not change.

- **Deferred `S-EE` pass and a known whole title.** The immediate screen exempted a programme whose whole title is a known Film title; the same-scan pass did not, so a catalog Film titled like one member of a placeholder pair, refused only by its runtime, could have been dropped together with its sibling. The pass now never collects such a programme. An end-to-end `scanEPG` fixture with a catalog Film refused by runtime pins it, and a replay case does the same.
- **Overbroad label.** The label pattern matched inside inflected words (`минисериалов`, `мини-сериале`). It is now a trailing descriptor only. Negative titles are pinned in the pure rule and in the scan fixture.
- The earlier replay exempted a known whole title for every form, which production did only for the immediate screen; production now matches it for every form, so the replay and the scan agree. On the pinned ledger neither path was exercised: 472 of the 5,009 candidates have a whole title that is a known catalog title and none of them has a serial form, and the 20 label rows all end in the label.

## Replay method

- Inputs: the pinned cohort of the audit (Discovery generation 291468, Channel revision 1, 5,009 unresolved candidates with a `discover` show), the history and verified exports of the audit, and a catalog export: the 11,876 `current` rows of `discovery_admission` with title, original, aliases and movie titles.
- The known-title index is built the way `scanEPG` builds it for a catalog-only Film (title, original, aliases, movie titles, each normalized): 56,599 keys. The Letterboxd watchlist titles are not in the replay; the scan input also holds them, so they can only add protection.
- The production functions of `src/sources.js` are loaded and called, not copied. The same-scan repeat pass uses the cohort observations as the stand-in for one scan's discovery map. A programme whose whole title is a key of the index is exempt, as in the scan.
- The audit classifier supplies the group of every hit; the exposure model of the audit supplies the resolver state of every hit at 2026-11-22T07:20:00Z (conditional on unchanged evidence).

## Result

| Measure | With the catalog guard (production) | With no known titles |
| --- | ---: | ---: |
| Hits over the 5,009 candidates | **666** | 685 |
| of them in the audit's proven set | **666** | 667 |
| of them outside the proven set | **0** | 18 |
| on a trusted-identity row (per-slot confirmation, owner identity, owner intent) | 0 | 0 |
| on a mixed row (a stored show on a non-`discover` channel) | 0 | 0 |

| Reason | Hits (production) |
| --- | ---: |
| `ordinal_episode` | 431 |
| `dash_season_episode` | 196 |
| `mini_series_label` | 20 |
| `season_pipe_episode` | 19 |

- The catalog guard keeps **19** rows that the unguarded predicate would screen: the 18 series episodes that share a verified Film's title and one proven ordinal row whose stem is also a catalog title. They stay candidates; nothing is claimed about them.
- **153 proven rows are not reached**: 127 ordinals below 7, 23 abbreviated, 2 series labels other than `мини-сериал`, and the 1 guarded ordinal.
- The 8 `S-EE` singletons that the audit left unproven are **not** hit: the repeat is required within the scan, and a singleton stem is kept. The 56 trusted-identity rows are not hit.
- **Verified controls.** On the 25,113 titles of verified observations the production predicate fires **0** times for the ordinal, pipe and label forms. One verified title has the `S-EE` shape (a real film whose title ends in a range); its description is a real plot, so it is not a placeholder and the form does not fire. A scan fixture pins that case.
- **Manual false-positive review.** 40 hits drawn at random from the production hit set (seed 20261123: 15 ordinal, 10 `S-EE`, 8 label, 7 pipe), read by the executor: all 40 are episodes of a series. The earlier review of 50 proven rows and of the pipe and label rows agrees. Zero in 40 bounds the rate below about 8% at 95% confidence for this draw; the structural argument and the verified controls are the stronger evidence. A second reviewer should repeat the draw.
- **Resolver state of the hits** at the pin: none is selectable now; 538 are in backoff, 30 are terminal and 98 are outside the show window; the attempts that could still be spent are at most **1,481** on unchanged evidence. This is an upper bound, not a saving.

## Fail-safe checks by level

| Level | Check | Where |
| --- | --- | --- |
| `scanEPG` precedence | one reliable watchlist or catalog match, and a whole title that is a known Film title refused only by year or duration, are not screened | `tests/serial-episode-screening.mjs` |
| `scanEPG` guards | stem known, year in the stem, ordinal below 7, catalog absent, singleton `S-EE`, real description, long duration, confirmed candidate | the same test, each guard mutation-checked |
| `known_only` channels | a screened programme does not claim its slot; a known Film on the same channel and start is kept; no duplicate-slot conflict | the same test |
| Cross-channel and same title | the same screened title on a `discover` channel is screened; a known stem on another channel is kept | the same test |
| Discovery cheap pass | `nonFilmEPGReason` and `screenedNonfilmReason` do not screen the new forms; no stored decision depends on them | the same test, and `tests/nonfilm-screening.mjs` unchanged |
| Deny and known-only policy, verified Films | no code change; a `deny_all` programme is dropped before this screen and a verified or confirmed Film is a reliable match | existing tests, full suite |
| Replay | the exact predicate over the audit cohort, controls and the real catalog | `tests/air-566-serial-rule-replay.mjs` on synthetic data |

## Limits

- The replay proves the predicate against the pinned ledger, not a fresh scan. The same-scan repeat is approximated by the ledger's active observations; the natural EPG run after the deploy is the real check (`stats.serialFiltered` of the new generation, a stable candidate count and the filtered-title counts).
- The Letterboxd watchlist titles are not in the known-title index of the replay.
- The history export of the audit used a `LIKE` on lower-case Cyrillic (SQLite folds only ASCII), so an upper-case serial word in a title is missing from it; that affects the audit's ordinal evidence, not this predicate, which needs no history.
- The manual reviews are one reviewer's judgment with no second reviewer.
- The stock of already stored observations leaves the active ledger by the ordinary seal and archive when the next scan omits it; the replay does not model the seal, and no decision is rewritten.
- The thresholds (7 ordinals, 80 minutes, a repeat of 2) came from the audit cohort; a fresh generation should be measured before they are changed.

## Reproduction

```bash
node scripts/air-566-serial-rule-replay.mjs --cohort cohort.json --history history.json --verified verified.json --catalog catalog.json --now 2026-11-22T07:20:00Z --private-out /private/outside/repo
node tests/air-566-serial-rule-replay.mjs
node tests/serial-episode-screening.mjs
```

The cohort, history and verified exports are the queries of the [residual audit](air-566-residual-nonfilm-audit-2026-11-22.md#reproduction). The catalog export is one read-only query:

```sql
SELECT film_id f, json_extract(payload_json,'$.title') t, json_extract(payload_json,'$.original') o,
 json_extract(payload_json,'$.aliases') al, json_extract(payload_json,'$.movieTitles') mt
FROM discovery_admission WHERE state = 'current';
```
