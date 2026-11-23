# Verified Film identity audit after the Channel blacklist

[AIR-567](https://trello.com/c/gDgSn2M7) · 22 November 2026, read on the afternoon of that day (UTC; the prediction queue snapshot used below is 17:30:20Z) · L0/L1 read-only. Aggregates only: no programme title, observation key, TMDB title or description is in this report. Nothing was applied: no D1 or R2 write, no `catalog_policy_exclude`, no identity correction, no TMDB, EPG, Discovery, Task or flag action. The owner-review list is private and is not in this repository.

**Verdict.** The verified Film catalog is **not damaged by the Channel blacklist** and the audit found **no evidenced wrong TMDB identity and no evidenced unwanted type among the current admissions**. All 12,035 distinct verified TMDB ids still have a trusted canonical Film; the Channel policy removed *shows*, not identities. A deny-only history exists for 418 Films, and for every one of them the Film link, the current admission and (where present) the rating and watchlist facts are present today (historical parity was not compared and is UNKNOWN). Across all 17,46x verified decisions the independent tests (year, runtime, alias collision, genre/type) leave **one uncertain identity** and **four informational duration outliers**; none is caused by a `deny_all` channel. No corrective operation is proposed as a batch. What the stored data **cannot** show (adult content, sports recordings, a feature-genre concert) is listed as UNKNOWN below.

## Pin

| Item | Value |
| --- | --- |
| Schema | `schema_contract.version` 33 |
| Discovery authority | `d1` / `open`, programme run `bf89ba90-07eb-46ac-9723-15d309517830`, generation 296460 at the first read (a natural chunk counter that kept advancing) |
| Channel policy | `epg_channel_revision` 2; effective policy derived as in [AIR-565](air-565-ledger-cohort-audit-2026-11-22.md) |
| Queue | `prediction_queue_overview`: run `bf89ba90-…`, profile version 2, `consistent` true, 12,404 Films, 7,051 pending (3,654 hot, 3,397 cold) |
| Code | `main` at `e8a12bc` |

The ledger moves while Discovery runs: verified decisions read 17,462 and later 17,463, current admissions 12,016, 12,017 and 12,021 in different reads. Each table below states the read it comes from; cohorts were compared only within one query. A comparison against a number from another read is not exact.

## 1. Verified decisions against admissions and Films

| Measure | Value |
| --- | --- |
| `discovery_decision` `verified` | 17,462 (all `movie`, all with `film_id` and `tmdb_id`) |
| Distinct verified TMDB ids | 12,035: 12,017 with a `current` admission, 18 with none |
| `discovery_admission` | `current` 12,017, `superseded` 166 (all `tmdb_<id>` canonical ids) |
| Verified TMDB ids with a trusted, non-conflicting canonical Film (`film_external_id`) | **12,035 of 12,035** |
| Of them: on the watchlist / rated admission / watchlist retention | 25 / 328 / 46 |

Explainable exceptions, 19 decisions: 18 verified TMDB ids have **no admission row at all** (not superseded, no row), and one decision carries a legacy short `film_id` while the admission of the same TMDB id uses `tmdb_<id>`. Ten of the 19 are generation-1 imported decisions (`known_alias_year_runtime`; nine of the ten have no observation row left) and nine are `tmdb_detail` decisions. **All 18 without an admission are canonical Films on the watchlist and carry a watchlist retention row**, so none is catalog-only. The audit did not read the code path that decides when a watchlist Film needs no admission, so the cause is not stated; the observation is that none of the 19 is an unprotected orphan.

### Census reconciliation (one bounded `COUNT`, read 22 November 2026 17:52:14Z, Discovery generation 297536)

The year and runtime tests in section 3 ran on **earlier reads** and cover only decisions that have an admission; the ledger had grown by the time of this count, so the totals differ across reads. At this one read, every verified decision falls in exactly one row:

| Group (one read) | Decisions |
| --- | ---: |
| `verified` total | 17,526 |
| With an admission (all `current`; 0 `superseded`) | 17,507 |
| of which with an observation row (the runtime denominator) | 17,394 |
| of which with no observation row (the year test's "no observation row" bucket) | 113 |
| With no admission | 19 |
| of which with an observation row | 10 |

How the earlier census reconciles: the year test inner-joined decisions to admissions, so it excludes the no-admission decisions and its `unknown` bucket (one side of the year missing) contains **none** of them. Its 17,451 decisions equal the runtime test's 17,338 (decisions with an admission **and** an observation row, so a duration exists) plus the 113 with an admission and no observation row. The runtime test skips those 113 because they have no stored duration to test; they appear only in the year table's own bucket. The 19 no-admission decisions are in **neither** test. The 17,451 and 17,338 were read earlier than this count: the ledger gained verified decisions in between (17,462 to 17,526), and no-admission decisions read 18 (plus the one legacy `film_id` case) earlier and 19 here, so the counts of different reads are not additive.

## 2. The 20 November "178 verified deny-only" baseline

The figure was recalculated, not assumed. Over every residence, `verified` observation rows by cohort of their current slots:

| Residence | Cohort | Observation rows | Slots |
| --- | --- | ---: | ---: |
| active | `discover` only | 9,035 | 18,810 |
| active | mixed `known_only` + `discover` | 20 | 78 |
| active | `known_only` only | 14 | 20 |
| archive | `discover` only | 12,552 | 13,832 |
| archive | no shows | 4,025 | 0 |
| archive | **`deny_all` only** | **558** | 845 |
| archive | mixed with a `deny_all` slot | 32 | 143 |
| archive | `known_only` only / mixed `known_only` + `discover` | 43 / 3 | 44 / 6 |

There is **no active verified observation with a `deny_all` slot**. The 558 deny-only rows are all archived history. They are **not comparable** with 178: the 20 November figure counted a different pin and grain (active observations on a previous run), and neither can be reconstructed from the repository or D1. The 558 rows belong to **418 distinct Films**:

| Films with deny-only observations | Count |
| --- | ---: |
| Total, every one with a `current` admission and a trusted canonical Film | 418 |
| No other (permitted) observation, no show in the published generation | 192 |
| Another permitted observation exists, not published now | 118 |
| Published in the current generation through permitted slots | 108 |
| On the watchlist | 0 |
| Rated admission | 6 |

**The disappearance of a `deny_all` show is not the deletion of a Film identity or of a user fact.** For these 418 Films the admission, the canonical Film link and the 6 rated admissions are all present today; the Channel policy only decides which slots Discovery and the scan take. The 192 Films with no other evidence are catalog-only: they keep their identity and have no current show. Whether the 192 sit in the prediction queue was **not** read per Film (one sample query timed out and was not repeated); the queue as a whole covers the catalog (12,404 Films), so they are expected in the cold lane, but this is UNKNOWN for them.

## 3. (b) Wrong TMDB identity: independent tests

None of the tests uses the channel category.

| Test (over verified decisions with a current admission) | Result |
| --- | --- |
| Year, observation against admission, both known | equal 7,445; **off by 1 year 635; off by 2 or more: 0**; one side unknown 9,258; no observation row 113 |
| Runtime, same tolerance as `src/domain/resolution-acceptance.js` (`max(25, 0.2·runtime)` with a year, `max(10, 0.12·runtime)` without), any stored duration | 17,333 within tolerance, **5 outside**, 0 with no duration, 0 with no TMDB runtime |
| Learned aliases (`film_alias`, source `epg` 240, `programme` 76, `owner` 3) colliding with a title alias of a **different** Film | **0** |

A title-containment screen against the admission's own alias list was run and **discarded**: learned aliases live in `film_alias`, not in the admission payload, so the test produced a meaningless mismatch rate and no conclusion is drawn from it. Alias *correctness* beyond the collision test (an alias attached to a Film that does not match its title) is not shown.

### The 5 runtime outliers

All five are real, well-known Films (checked privately by title). Four are explained by an airing slot that is much shorter or longer than the TMDB runtime (a partial airing or a slot with breaks), with the year equal or off by one: **valid, informational**. One has a runtime gap of about 50 minutes and a year offset of one: **uncertain (d)**. It is in the hot prediction lane and eligible now (`prediction_film_diagnostics`), so a wrong identity would consume a prediction. It is a feature drama, so `catalog_policy_exclude@1` is not applicable; the applicable correction path would be `discovery_identity_correct`. Details are in the private owner list.

### The 60 verified re-entries handed over from AIR-565

The AIR-565 re-entry set was reproduced (60 active `verified` observations that share their key with an archived observation with a `deny_all` slot). The question was whether a denied-only stored duration could have helped a verified acceptance.

| Result over the 60 | Count |
| --- | ---: |
| TMDB runtime within tolerance of a **current** slot (acceptance independent of history) | 56 (22 `known_epg_alias`, 34 `tmdb_detail`) |
| Passes **only** on the stored duration history | 4 (`tmdb_detail`) |

In the 4, the year is unknown (tolerance about 11 to 12 minutes). Each stored history contains passing values, but only one value per Film matches an archived `deny_all` slot; the others (for example 85, 100, 105 minutes) match no archived slot, so they are not attributable to a denied channel. Titles are unique, uncommon Russian titles and the identities are plausible. Result: **no evidence that a denied-only duration changed a verified decision**; the four are valid with the residual noted. `rawTitles` reaching aliases: 316 learned aliases exist, none collides with another Film; the 76 `programme` aliases sit on 2 Films and are listed privately for owner review as a curiosity, not as an error.

## 4. (c) Valid TMDB movie, unwanted type

The classifier of [ADR 0150](../../adr/0150-documentary-and-concert-film-exclusion.md) (`admissionPolicy`) was applied to the genre facts of the admissions in SQL (genre names as `genreFacts` treats them).

| Admissions at that read | Count |
| --- | ---: |
| `current` with a feature genre | 12,007 |
| `current` with no genre | 12 |
| `current` with only Music | 2 |
| `current` with a Documentary genre | **0** |
| `superseded`: Documentary 124, Music-only 37, no genre 5 | 166 |

The 14 `current` cards without a feature genre were read privately: all 14 are narrative Films with a plot synopsis, none a documentary or concert. A title/synopsis keyword screen over all current admissions for concert and sports terms returned 7 hits, all feature films (false positives). Result: **no current admission is evidenced as a Documentary or concert recording**, so the existing owner writer `catalog_policy_exclude@1` ([ADR 0153](../../adr/0153-catalog-policy-exclusion.md)) has **no new eligible Film** from this audit, and it was not widened.

## 5. Consequences by surface

| Surface | Effect of a `deny_all` show disappearing |
| --- | --- |
| Finds (published generation) | The Film loses that slot only; 0 `deny_all` rows are published (AIR-565); 108 of the 418 Films still publish through permitted slots |
| Permanent Film pages and Film/Person facts | **Currently linked:** every one of the 12,035 verified ids has a trusted canonical Film link today. `film_person`/Person rows and Film metadata were **not** audited and no before-the-blacklist snapshot exists, so historical parity is UNKNOWN |
| User facts | **Currently present:** 328 rated admissions, 25 watchlist Films and 46 retention rows among verified ids; none of the 25 watchlist Films has a deny-only history. No pre-filter baseline was read, so before/after parity is UNKNOWN; `ratings_document` was not read |
| Prediction queue | Catalog-wide (12,404 Films); a Film with a current admission stays queued whether or not it has a show; per-Film lane for the 192 not read |

## 6. UNKNOWN and limits

- **Adult content and sports recordings.** The admission payload stores no adult flag and no category; ADR 0150 does not classify them. A narrow keyword screen found nothing, but "not detected" is not "examined and clean".
- **A feature-genre concert or documentary** is classified `null` by design (`featureGenre`), so it is outside the classifier and outside the screen.
- **Wrong TMDB identity with a plausible year and runtime** cannot be found without TMDB; no TMDB call was made.
- **The 113 verified decisions with no observation row** (legacy imports) cannot be tested for year or runtime.
- **Ratings documents** (`ratings_document`) and R2 immutable sources were not read; user facts are evidenced through `film_rated_admission`, `watchlist_film` and `film_retention` only. No before-and-after comparison of protected tables exists (no pre-filter baseline), so protection rests on this read and on the absence of any writer here.
- **Per-Film queue lane** was read for two Films only.
- Counters moved between reads (see Pin); every table is internally consistent but tables are not summed across reads.

## Reproducibility: query shapes

All reads were `SELECT`s against production D1 `iptv` through the connector, plus read-only `prediction_queue_overview` and `prediction_film_diagnostics`. Heavy joins timed out twice at the 60 s limit (read only, not repeated); the shapes below are the ones that completed.

- **Fence.** `schema_contract.version`, `discovery_authority`, `epg_channel_revision` read first; the programme run and the Channel revision were unchanged between reads.
- **Effective policy of a channel.** As in AIR-565: `override_policy`, then the owner category policy, then the provider category policy, then `known_only`.
- **Verified against admission.** `discovery_decision` (`status='verified'`) left-joined to `discovery_admission` on `media_kind='movie'` and `tmdb_id`; Film link through `film_external_id` (`scheme='tmdb'`, `trusted=1`, `conflicting=0`).
- **Cohorts.** `discovery_observation` joined to verified decisions by `observation_key`, left-joined to `discovery_observation_show` and the policy, grouped per `(source_key, observation_key)`.
- **Year and runtime.** Observation `year` against admission `$.year`; `json_each` of observation `$.durations` against admission `$.runtime` with the tolerance above; current-slot duration is `ROUND((end_ms-start_ms)/60000.0)`.
- **Published and queue identifiers differ by surface.** `published_epg_show.film_id` is `tmdb_<id>` for Discovery rows and the bare short id for sealed rows; prediction tables use the short canonical id without the `film:` prefix. A first presence check that compared a canonical `film:` id with `published_epg_show` returned 0 by mistake and was redone with the correct keys.
- **Type.** Admission `$.genres` names against the `genreFacts` sets (`documentary`, `music`, `tv movie` families); keyword `LIKE` screen over `$.title`, `$.original`, `$.synopsis`.
