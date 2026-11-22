# Residual non-film audit of unresolved Discovery candidates on `discover` channels

[AIR-566](https://trello.com/c/8RVlrvkk) · 22 November 2026, read between about 07:00 and 07:50 UTC · L0/L1 read-only. Aggregates and synthetic shapes only: no title, observation key or description of a real programme is in this report. The per-example classification stayed in a private local directory outside the repository.

**Verdict (provisional, pending independent review of the corrected evidence).** Of the **5,009** unresolved candidates that still have a showing on a `discover` channel, **819 (16.4%)** are series episodes proven by a structural form that no verified Film carries, with no trusted identity evidence on any slot. A proposed **stateless** title predicate, replayed offline over all 5,009 with only the inputs one programme has at scan time, fires on **721** rows (**703** with a known-title guard). Of those, 692 are in the proven set and 29 (11 with the guard) are not proven; it does not reach 127 proven rows. At the pinned moment **no row is selectable by the resolver**: every one of the 819 is in backoff, terminal or outside the show window. **No existing mechanism can exclude an unresolved candidate except the title screen**, so cleanup is a code decision for the owner, not an operation. The rest of the cohort is not proven non-film: in a 100-row manual sample of the unproven rest about **82** were real films that TMDB did not identify. A TMDB `no_match` is not evidence of a non-film.

Nothing was applied: no screening rule, no policy change, no write to D1 or R2, no TMDB, model, EPG, Discovery or Task run.

## Pin

| Item | Value |
| --- | --- |
| Schema | `schema_contract.version` 33 |
| Discovery authority | `d1` / `open`, generation 291468, programme run `7bce173c-2cfe-420d-baaf-efebced1b410`; `discovery_transfer` `committed`, published run equal to the authority run |
| Published EPG | `published_epg_authority` `d1` / `open`, generation 516, same run, finalized 2026-11-21T16:18:25Z (Madrid run key 2026-11-21) |
| Channel policy | `epg_channel_revision` revision 1, import revision 1, plan digest prefix `45adce23bdde`, 35 categories, 2,103 channels; revision written 2026-11-21T15:55:38Z |
| Ledger | `discovery_observation`: 21,516 `active`, 54,491 `archive` |
| Code | `main` at `3b025a7` |

The schema version, the Discovery authority and transfer, and the Channel revision were read at the start, in the middle and at the end of the work and were identical each time; the published EPG authority was read at the start of the corrections and at the end. No snapshot transaction exists across the separate reads.

The effective policy of a channel is derived as the repository derives it: `override_policy`, then the owner category policy, then the provider category policy, then `known_only`; a show on a channel the table does not hold is `known_only`. This audit did not read `stats.policyMode` of the published generation and does not claim the pinned generation was scanned with the filter on; it classifies the stored shows by the current policy.

## Cohorts and scope

The cohort is an `active` observation with no `verified` decision and no `confirmed_tmdb_id`, with at least one show whose channel is `discover`. Every active row, by the policies of its stored shows:

| Active rows | Count | Handled by |
| --- | ---: | --- |
| `discover` only, unresolved, no observation-level confirmed id | **4,934** | this audit |
| `discover` plus `deny_all` or `known_only` (mixed), unresolved, no observation-level confirmed id | **75** | this audit; none is proven (62 have no proof, 13 are on the trusted-identity review below) |
| `discover` only or mixed, `verified` | 9,117 and 117 | [AIR-567](https://trello.com/c/gDgSn2M7), not selected |
| `discover` only or mixed, not `verified` but an observation-level `confirmedTmdbId` is stored | 204 and 5 | identity evidence exists, not selected |
| `deny_all` only (any decision) | 6,470 | [AIR-565](https://trello.com/c/mSdBSd9j), not selected |
| `known_only` only, or `deny_all` plus `known_only` | 593 and 1 | [AIR-565](https://trello.com/c/mSdBSd9j), not selected |

4,934 + 75 + 9,117 + 117 + 204 + 5 + 6,470 + 593 + 1 = 21,516, the number of active rows: the sets are disjoint by their predicates and cover the ledger. The 20 November baseline (5,086 on `discover`-only channels) was an orientation figure; the pinned figure is 4,934 on `discover`-only channels, 5,009 with the mixed rows.

**Identity evidence below the observation level.** `confirmed_tmdb_id` is null for a partly confirmed observation: the observation carries an id only when every retained slot confirms the same one, and `confirmedSlots` keeps the per-slot ids (`applySlotConfirmation` in `src/sources.js`). The cohort therefore carries three more checks, and any row with one of them is placed on the **trusted-identity review** and in no proven group: a non-empty `confirmedSlots` (**55** rows), an `ownerIdentity` in the stored decision (**1**), a `discovery_intent` row for the observation key (**1**). **56** rows are affected (one has two); 13 of them are mixed. No `discovery_admission` row carries a non-null observation key, so no admission row names a cohort observation. Of the 56, 39 are terminal `ambiguous/repeated_uncertain_match`, 12 `ambiguous`, 5 `duration_mismatch`.

Stored decisions of the cohort: `no_confident_match` 3,519 (586 `repeated_uncertain_match`), `ambiguous` 1,204, `duration_mismatch` 255, `needs_verification` 25, `excluded_nonfilm` 6. Every row has an XMLTV `categories` array of `[]` in the stored observation, 1,246 have a year, 1,201 have a description that is empty or equal to the title (a provider placeholder), and every row was seen in the latest snapshot. The current `nonFilmEPGReason()` screens **1** of the 5,009 titles.

By the channel categories of the `discover` shows: `Movies/Кино` 1,472 rows, `Cinemas/Кинозалы` 2,358, `Kids/Детские` 355, `UHD` 211, `Cinemas/Кинозалы TV Team` 269, `HDR` 98, and 246 on several of them. Episodes are therefore not confined to one category: the category policy alone cannot keep them out. By shortest stored duration: 55-69 min 1,336 rows, 70-99 min 2,142, 100-139 min 1,230, 140+ min 301 (the scan admits 55-300 minutes).

## Evidence fields available per allowed slot

| Field | Scope | Consequence |
| --- | --- | --- |
| `discovery_observation_show`: channel id, channel name, start, end | one slot | the effective policy of every stored slot can be derived exactly |
| `confirmedSlots` in the observation payload | one slot | a per-slot confirmed id; used above to isolate trusted identity |
| description, durations, year, categories | merged over the observation | not per slot; a description or duration cannot be attributed to an allowed slot alone |

For every proven row and every row of the proposed predicate **all stored shows are on `discover` channels** (zero mixed rows in both), so no stored denied slot can have contributed to the merged description or durations. A slot that left the observation earlier may have contributed; that cannot be read back. The 75 mixed rows are in no proven group and no predicate hit, so no denied slot is used as proof anywhere in this report.

## Groups

The classifier is [scripts/air-566-residual-nonfilm-audit.mjs](../../../scripts/air-566-residual-nonfilm-audit.mjs). The first matching group wins. Evidence is counted per form and per **distinct observation**: a season number never counts as an episode ordinal, an abbreviated episode number is not an ordinal, and an observation that is in both the history and the cohort counts once. A group is **proven** only when its form is structural (a film title does not carry it) and the check against a film-like reading passes. The history, the verified controls and the identity fields are required inputs; a missing duration fails the dash guard. A TMDB `no_match` never decides a group.

| Group | Form (all synthetic) | Proof condition | Rows | Class |
| --- | --- | --- | ---: | --- |
| `ordinal_episode_proven` | `<Title>. 11-я серия`, `<Title> (31-я серия)`, `<Title>. 3-я - 4-я серии` | the stem reaches an ordinal of 7 or more in ordinal-form observations anywhere in the ledger, the stem carries no year, and it is not the title of a verified Film | 559 | proven |
| `dash_season_episode_placeholder` | `<Title> 2-07`, `<Title> 1-3` | description empty or equal to the title, a valid duration of at most 80 min, and the stem repeats in at least two distinct cohort observations | 196 | proven |
| `season_abbrev_episode` | `<Title>", 18 сезон, 10 с. "<Name>` | the abbreviated form, and the stem has at least two distinct abbreviated observations | 23 | proven |
| `series_label_suffix` | `<Title> (2026) мини–сериал` | an explicit series label that is not leading | 22 | proven |
| `pipe_season_episode` | `<Title> 2\|5 <Name>`, `<Title> (2\|1)` | a season-pipe-episode pair | 19 | proven |
| **Proven total** | | | **819** | |
| `trusted_identity_review` | any form | per-slot confirmed id, owner identity or owner intent | 56 | review |
| `ordinal_episode_review` | the ordinal or abbreviated form that fails the proof | stem below 7 ordinals, a year in the stem, a verified Film with that stem, or a singleton abbreviation | 213 | review |
| `numeric_suffix_block_review` | `<Title> 3-5` without the placeholder, valid duration or repeat | a numeric suffix may be a film title | 22 | review |
| `season_marker_only` | `<Title> 2 сезон` | a season alone does not show an episode | 11 | review |
| `show_family` | ten or more rows share a `<Prefix>:` that no verified title uses | a brand, not a structure | 41 | review |
| `decorated_film_title` | `<Title> 2026 Драма` | a year and a genre appended to a title | 158 | likely film |
| `no_proof` | everything else | no structural evidence | 3,689 | no proof |

819 + 343 review + 158 + 3,689 = 5,009. The discover-only and mixed split of every group is in the script output.

### Exposure of the proven groups

The resolver selects a row only when it is in the show window (a show start within 72 hours before to 24 hours after now), seen in the latest snapshot, and either not terminal and due, or its stored `evidence_key` differs from the observation's (`ACTIONABLE_FROM` in `src/discovery-authority.js`). Evaluated at 2026-11-22T07:20:00Z, **conditionally on unchanged evidence**:

| State | Proven (819) | Predicate hits, unguarded (721) | Predicate hits, with known-title guard (703) |
| --- | ---: | ---: | ---: |
| Selectable now | 0 | 0 | 0 |
| In backoff (`retry_at` in the future) | 661 | 588 | 571 |
| Terminal (`repeated_uncertain_match`) | 38 | 30 | 30 |
| Outside the show window (never selected while it stays out) | 120 | 103 | 102 |
| Attempts that could still be spent (upper bound: 5 minus stored attempts, in-window non-terminal rows only) | 1,795 | 1,607 | 1,558 |

The rows that are due by `retry_at` alone are exactly rows that left the window, so an earlier reading that counted them as selectable was wrong. The 69 rows with a changed `evidence_key` are all outside the window, so the bypass selects none now. An attempt is one resolution pass of a candidate, which can make several TMDB requests: these are upper bounds of attempts on unchanged evidence, not predictions of requests or of savings. The ongoing effect on new episodes was not measured.

## The proposed predicate, replayed offline

`proposedScreen()` in the script is an **offline-only** predicate that uses only what one programme has at scan time or in the cheap pass: its title, description and durations. It uses no ledger history, no repeat count and no verified-title list. It fires on: an ordinal `N-я серия` (or a range or plural) with `N` or the upper bound **at least 7**; the season-pipe-episode pair; a non-leading series label; the abbreviated season-and-episode marker; and `<Title> S-EE` with an empty or title-equal description and a **valid** duration of at most 80 minutes. A variant adds a guard against a known title (here the verified titles, as a stand-in).

| Reason | Hits, unguarded | Hits, with guard |
| --- | ---: | ---: |
| ordinal episode (N or upper bound ≥ 7) | 452 | 434 |
| `<Title> S-EE` with placeholder and valid duration | 204 | 204 |
| abbreviated season and episode | 24 | 24 |
| series label | 22 | 22 |
| season-pipe-episode | 19 | 19 |
| **Total** | **721** | **703** |

Intersection with the classifier over **all 5,009 rows**:

| Classifier group of a hit | Unguarded | With guard |
| --- | ---: | ---: |
| proven (`ordinal` 432, `dash` 196, `abbrev` 23, `label` 22, `pipe` 19) | 692 | 692 |
| `ordinal_episode_review` | 21 | 3 |
| `numeric_suffix_block_review` (placeholder `S-EE` singletons with no repeat evidence) | 8 | 8 |
| trusted identity, `no_proof`, any other group | 0 | 0 |
| **Outside the proven set** | **29** | **11** |

- The 721 − 692 = 29 additional hits are not proven by this audit. 18 of them are series episodes (ordinal 7 or more) that share a verified Film's title: the guard removes exactly those 18 (452 → 434), and they **stay on review unless a separate proof is made**. 3 more ordinal-review hits remain with the guard (a year in the stem or a singleton abbreviation). The 8 dash singletons have no repeat evidence because a stateless predicate cannot count one.
- **127 proven rows are not reached** (the 819 − 692): ordinals 1 to 6 and anything that needs the history.
- The ordinal arithmetic: the 559 proven ordinal rows are 432 with an ordinal of 7 or more and 127 below it. The 452 ordinal hits are those 432 plus 20 `ordinal_episode_review` rows with an ordinal of 7 or more (18 verified-title collisions and 2 with a year in the stem). The 21 review hits are those 20 plus 1 singleton abbreviation; the guard keeps 3 of them (2 + 1). An earlier statement that 713 of the 820 proven rows were reachable mixed overlapping sets and is withdrawn.
- **No hit is on the trusted-identity review**: the predicate itself ignores identity (the fixtures pin this), so a rule must keep the existing identity precedence of `screenedNonfilmReason`, which reads only the observation-level confirmed id; the 55 per-slot confirmations are not covered by it.
- **Verified controls.** On 25,113 titles of verified observations the predicate fires **0** times. The structural predicates on the title alone match 0 for the ordinal form, the pipe pair, the label, the abbreviated form, a season marker and the year-plus-genre decoration, and 1 for the numeric dash form: a real film whose title ends in a range, with a real plot and 69 minutes, which the description condition rejects. **Limit:** a verified title was found by an exact title search, so a title that carries a suffix such as `N-я серия` could never have been verified; this control shows the form never appears on an identified Film, not that no unidentified film uses it.

## False positives and false negatives

- **Film-like stems.** 58 rows of the cohort's ordinal-form titles, 18 stems, equal the title of a verified Film (multi-part and revived titles). All are `ordinal_episode_review`; 18 of the rows have an ordinal of 7 or more and are the collisions above.
- **Manual review of the proven groups.** 50 proven rows drawn at random from the first classifier version (seed 777: 30 ordinal, 14 dash, 6 abbreviated), plus the 19 pipe rows and 20 of the 22 label rows: every one is an episode of a series, with an episode-level synopsis or a placeholder. The corrected classifier has the same group sizes except one abbreviated row that moved to review, and the draw was not repeated. Zero false positives in 50 bounds the rate below about 6% at 95% confidence for the sampled groups; the structural argument and the control are the stronger evidence. The reviewer is the executor; an independent reviewer should repeat the draw.
- **Negative controls.** A numbered Star Wars episode, a film title with the noun `Сезон` (`Сезон дождей`) and a cartoon feature whose title contains `Эпизод <Name>` fall outside every serial form and stay `no_proof`. The fixtures pin these cases and the counterexamples of the review: a season number does not prove an ordinal, an abbreviated episode number does not prove an ordinal, one abbreviated observation seen in the history and the cohort is one observation, and a missing or malformed duration fails the dash guard.
- **False negatives.** A seeded random sample of 100 rows of the unproven rest (seed 20261122, drawn from the first classifier version before the trusted-identity rows were split off) was read by the executor:

| Reading | Sample of 100 | Estimate over the roughly 3.7 thousand unproven rows (interval is wide) |
| --- | ---: | --- |
| Real films that TMDB did not identify (known blockbusters, classics, local films; many with a year or genre appended to the title, or the description reduced to the title) | about 82 | about 3,000 |
| Clear non-films that no stateless structural rule describes (talk-show episodes numbered with a hash, episodes named `<Series> (<Title>)`, a topical programme, a kids' block, a season-episode code followed by a title) | 7 | about 260 |
| Ambiguous (documentary, cartoon compilation, event broadcast, a special) | 11 | about 410 |

So roughly 260 clear non-films stay unproven by structure. They are not a reason to widen a title rule: each shape is different, and the sampled films that look similar are real. **TMDB `no_match` is not evidence of a non-film**; the 82 films above carry that very status. A large share of the cohort is an identification failure, not a screening failure; that is outside this card.

## Existing cleanup mechanisms and what a rule would persist

| Mechanism | What it writes | Can it exclude these candidates? |
| --- | --- | --- |
| `nonFilmEPGReason()` in `scanEPG` and the cheap pass | no candidate at scan, or an `excluded_nonfilm` decision | Yes, and it is the only one that writes this decision: every writer of `status:'excluded_nonfilm'` in `src` (`src/sources.js`, `src/discovery.js`) goes through `screenedNonfilmReason`. A stored decision is reversible ([non-film screening](../../reference/domain/nonfilm-screening.md#reversibility)). |
| Owner policy-exclusion writer | retires a verified catalog Film by TMDB id on an exact owner-reviewed match | No. It operates on verified Films. |
| `reconsider`, `identity_assign`, `identity_reject`, `identity_revoke` intents | an owner decision about the TMDB identity of one observation | No. None writes `excluded_nonfilm`. |
| Channel policy `deny_all` / `known_only` | drops or restricts a programme by channel | No. The candidates are on `discover` channels. |

A title rule would act on the stock in **two different ways, and only one persists a decision**:

1. **Leaving the active ledger.** A rule in `scanEPG` keeps a matching programme out of the next generation's scan. At the next seal, an active observation that the new scan does not contain leaves the active ledger for the archive; a row that was seen in the previous scan is always archived by that commit, and the unseen backlog drains at the departure cap ([bounded ledger departure budget](../../reference/domain/candidate-discovery.md#bounded-ledger-departure-budget-adr-0112-accepted)). The stored decision stays exactly as it was, with no `excluded_nonfilm` written. This path can reach terminal and backoff rows alike.
2. **Persisting `excluded_nonfilm`.** The cheap pass writes it only for rows the resolver selects: in the window, seen in the latest snapshot, not terminal and due, or with a changed `evidence_key` (`src/discovery.js`, cheap pass). At the pin no row is selectable, 120 of the 819 proven rows are already outside the window and a terminal row is not reselected. **It is therefore not true that every historical decision would be rewritten when `retry_at` falls due**: a row that stops being seen leaves through path 1 and keeps its old decision.

Neither path needs a writer, a hard delete or a backfill, and neither was exercised against a rule change. The implementation card must prove, offline on this cohort, which rows leave through which path and what each leaves in the decision history.

## Recommendation (for the owner; nothing here is applied)

1. **No cleanup operation.** There is no existing safe writer, and a hand-written set of decisions would be a new production writer. Do not hard-delete, purge or reclassify.
2. **A narrow follow-up code change, only on an owner decision, and provisional on review of this evidence.** The replayed predicate is the candidate: 721 hits, of which 692 are proven and 29 are not (11 with a known-title guard). The implementation card has to decide, with this report's numbers: whether the known-title guard is available at scan time (it removes the 18 collisions, which stay on review unless proven separately); whether to drop the `S-EE` form or accept 8 placeholder singletons that have no repeat evidence; the identity precedence for per-slot confirmations (55 rows today, none hit); and that ordinals 1 to 6 stay unscreened (127 proven rows) because of multi-part films. It needs its own card, an ADR check, an offline replay on a fresh generation and a measured false-positive count on verified titles before any deploy.
3. **Keep on review.** The trusted-identity rows (56), `ordinal_episode_review`, `numeric_suffix_block_review`, `season_marker_only` and `show_family` (343 in all) and the unproven rest. A brand rule for the 41 `show_family` rows is a product decision about shows and events, not a screening proof.
4. **Not a screening matter.** About four in five of the unproven rows look like real films with a title that did not match. An identification or title-normalization follow-up would deal with them; it does not belong in a screening rule. This is a sample estimate and needs a larger independent sample before a card is written.
5. **Do not open the conditional card 8** without the owner decision in point 2.

## Limits

- Read-only SQL over about fifty minutes; the pin was identical at every check, no snapshot transaction exists.
- The cohort is `active` rows only. 54,491 archived rows were not examined; the ordinal history of a stem uses every residence that carries a serial word.
- The manual reviews are one reviewer's judgment with no second reviewer and no ground truth; both samples were drawn from the first classifier version.
- The proof thresholds (7 ordinals, 80 minutes, a repeat of 2, a family of 10) were chosen from this cohort, not from an independent set.
- The exposure model reads stored fields at one moment on unchanged evidence; the cheap-pass and archive paths were read in code and not run.
- The known-title guard uses verified titles as a stand-in; the catalog and watchlist indexes of a real scan were not replayed.
- The first filtered EPG sync and AIR-565 were not waited for; a later generation will change the counts.

## Reproduction

The classifier requires three JSON exports (cohort, history, verified controls). stdout is aggregates; titles go only to `--private-out`, which the script refuses inside the repository. Every query is a `SELECT` against the production D1; the cohort query is run in one piece, the intent and admission reads are separate small reads whose keys are merged into the cohort rows as `intent` before the run.

```sql
-- cohort (one row per unresolved, unconfirmed active observation with a discover show)
WITH ch AS (
 SELECT c.channel_id, COALESCE(c.override_policy, oc.policy, pc.policy, 'known_only') pol
 FROM epg_channel c
 LEFT JOIN epg_channel_category oc ON oc.category_key = c.owner_category_key
 LEFT JOIN epg_channel_category pc ON pc.category_key = c.category_key),
agg AS (
 SELECT s.observation_key, sum(COALESCE(ch.pol,'known_only')='discover') d, sum(COALESCE(ch.pol,'known_only')='deny_all') x, sum(COALESCE(ch.pol,'known_only')='known_only') k,
  sum(s.start_ms >= :window_start AND s.start_ms < :window_end) w   -- now minus 72 hours, now plus 24 hours, in milliseconds
 FROM discovery_observation_show s
 JOIN discovery_observation o ON o.source_key = s.source_key AND o.observation_key = s.observation_key AND o.residence = 'active'
 LEFT JOIN ch ON ch.channel_id = s.channel_id GROUP BY s.observation_key)
SELECT o.observation_key ok, o.title t, o.year y, d.status st, d.terminal_reason tr, json_extract(d.payload_json,'$.attempts') att, d.retry_at ra,
 json_extract(o.payload_json,'$.durations') dur, substr(json_extract(o.payload_json,'$.description'),1,300) ds, a.d dsh, a.x xsh, a.k ksh, a.w win,
 COALESCE(json_array_length(json_extract(o.payload_json,'$.confirmedSlots')),0) cs,
 (json_extract(d.payload_json,'$.ownerIdentity') IS NOT NULL) oid,
 (d.evidence_key IS NOT NULL AND d.evidence_key <> o.evidence_key) evmis, o.seen_in_latest sl
FROM discovery_observation o JOIN agg a ON a.observation_key = o.observation_key LEFT JOIN discovery_decision d ON d.observation_key = o.observation_key
WHERE o.residence = 'active' AND a.d > 0 AND o.confirmed_tmdb_id IS NULL AND COALESCE(d.status,'') <> 'verified';

-- owner intents and admissions that name an observation (small tables)
SELECT 'intent' k, observation_key ok FROM discovery_intent
UNION ALL SELECT 'adm', observation_key FROM discovery_admission WHERE observation_key IS NOT NULL;

-- history (serial words, every residence; ok is the observation key and is required to count distinct observations)
SELECT o.observation_key ok, o.title t, o.residence rs FROM discovery_observation o
WHERE lower(o.title) LIKE '%серия%' OR lower(o.title) LIKE '%серии%' OR lower(o.title) LIKE '%серий%' OR lower(o.title) LIKE '%сезон%'
 OR lower(o.title) LIKE '%season%' OR lower(o.title) LIKE '%episode%' OR lower(o.title) LIKE '%эпизод%';

-- verified controls (add ds and dur for the rows the title-only dash predicate matches)
SELECT o.title t, substr(json_extract(o.payload_json,'$.description'),1,300) ds, json_extract(o.payload_json,'$.durations') dur
FROM discovery_observation o JOIN discovery_decision d ON d.observation_key = o.observation_key WHERE d.status = 'verified';
```

```bash
node scripts/air-566-residual-nonfilm-audit.mjs --cohort cohort.json --history history.json --verified verified.json --now 2026-11-22T07:20:00Z --private-out /private/outside/repo
node tests/air-566-residual-nonfilm-audit.mjs
```

The test fixtures are synthetic: one stem per group, the verified-title collision, the year-bearing stem, the numeric film title with a real plot, the public negative controls, the review counterexamples (a season number, an abbreviated episode number, a doubly exported observation, a missing or malformed duration, trusted identity on a slot, an owner decision or an owner intent), the stateless predicate with and without the known-title guard, the exposure states, the refusal of a cohort row without the identity or window fields, and the refusal of a private directory inside the repository.
