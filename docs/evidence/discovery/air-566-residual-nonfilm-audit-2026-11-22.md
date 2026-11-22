# Residual non-film audit of unresolved Discovery candidates on `discover` channels

[AIR-566](https://trello.com/c/8RVlrvkk) · 22 November 2026, captured before 07:20 UTC · L0/L1 read-only. Aggregates and synthetic shapes only: no title, observation key or description of a real programme is in this report. The per-example classification stayed in a private local directory outside the repository.

**Verdict.** Of the **5,009** unresolved candidates that still have a showing on a `discover` channel, **820 (16.4%)** are proven series episodes by a structural form that no verified Film carries. A stateless title rule for four of those forms would reach **713** of them and could save up to **1,832** resolution attempts; the stored ledger would clean itself through the existing cheap pass, with no new writer. **No existing mechanism can exclude an unresolved candidate except that same title rule**, so the cleanup is a code decision for the owner, not an operation. The remaining rows are not proven non-films: in a 100-row manual sample of the 3,745 rows with no structural evidence about **82** were real films that TMDB did not identify. A `no_match` is not evidence of a non-film, and nothing here supports hiding them.

Nothing was applied: no screening rule, no policy change, no write to D1 or R2, no TMDB, model, EPG, Discovery or Task run.

## Pin

All numbers come from one capture. The schema version, the Discovery authority and transfer, and the Channel revision were read at the start and again after the last export, and were identical; the published EPG authority was read once, after the exports.

| Item | Value |
| --- | --- |
| Schema | `schema_contract.version` 33 |
| Discovery authority | `d1` / `open`, generation 291468, programme run `7bce173c-2cfe-420d-baaf-efebced1b410`; `discovery_transfer` `committed` (37,032 batches), published run equal to the authority run |
| Published EPG | `published_epg_authority` `d1` / `open`, generation 516, same run, finalized 2026-11-21T16:18:25Z (Madrid run key 2026-11-21) |
| Channel policy | `epg_channel_revision` revision 1, import revision 1, plan digest prefix `45adce23bdde`, 35 categories, 2,103 channels; revision written 2026-11-21T15:55:38Z |
| Ledger | `discovery_observation`: 21,516 `active`, 54,491 `archive` |
| Code | `main` at `3b025a7` |

The effective policy of a channel is derived as the repository derives it: `override_policy`, then the owner category policy, then the provider category policy, then `known_only`. A show on a channel the table does not hold is `known_only`. This audit did not read `stats.policyMode` of the published generation and does not claim that the pinned generation was scanned with the filter on; it classifies the stored shows by the current policy, which is what the card asks for.

## Cohorts and scope

The cohort is an `active` observation with no `verified` decision and no `confirmed_tmdb_id`, with at least one show whose channel is `discover`. Counts of every active row, by the policies of its shows:

| Active rows | Count | Handled by |
| --- | ---: | --- |
| `discover` only, unresolved, not confirmed | **4,934** | this audit |
| `discover` plus `deny_all` or `known_only` (mixed), unresolved, not confirmed | **75** | this audit (only the `discover` shows are evidence; no denied slot is used as proof) |
| `discover` only or mixed, `verified` | 9,117 and 117 | [AIR-567](https://trello.com/c/gDgSn2M7), not selected |
| `discover` only or mixed, not `verified` but a `confirmedTmdbId` is stored | 204 and 5 | identity evidence exists, not selected, noted as a boundary |
| `deny_all` only (any decision) | 6,470 | [AIR-565](https://trello.com/c/mSdBSd9j), not selected |
| `known_only` only, or `deny_all` plus `known_only` | 593 and 1 | [AIR-565](https://trello.com/c/mSdBSd9j), not selected |

4,934 + 75 + 9,117 + 117 + 204 + 5 + 6,470 + 593 + 1 = 21,516, the number of active rows: the sets are disjoint by their predicates and cover the ledger. The 20 November baseline (5,086 unnamed candidates on `discover`-only channels) was an orientation figure; the pinned figure is 4,934 on `discover`-only channels, 5,009 with the mixed rows.

Stored decisions of the cohort: `no_confident_match` 3,519 (586 `repeated_uncertain_match`), `ambiguous` 1,204, `duration_mismatch` 255, `needs_verification` 25, `excluded_nonfilm` 6. Every row has an XMLTV `categories` array of `[]` in the stored observation (the field is only written by a scan after the change), 1,246 rows have a year, and 1,201 rows have a description that is empty or equal to the title (a provider placeholder). Every row was seen in the latest snapshot. The current `nonFilmEPGReason()` screens **1** of the 5,009 titles.

By the channel categories of their `discover` shows: `Movies/Кино` carries 1,472 rows and 547 of the proven ones, `Cinemas/Кинозалы` 2,358 and 230, `Kids/Детские` 355 and 26, `UHD` 211 and 16, `Cinemas/Кинозалы TV Team` 269 and 1, `HDR` 98 and 0, and 246 rows sit on several of them. Episodes are therefore not confined to one category: the category policy alone cannot keep them out. By the shortest stored duration: 55-69 min 1,336 rows (669 proven), 70-99 min 2,142 (102), 100-139 min 1,230 (21), 140+ min 301 (28); the scan only admits 55-300 minutes.

## Groups

The classifier is [scripts/air-566-residual-nonfilm-audit.mjs](../../../scripts/air-566-residual-nonfilm-audit.mjs). The first matching group wins. A group is **proven** only when its form is structural (a film title does not carry it) and a check against a film-like reading passes. **Review** groups have the form but fail that check or rest on a brand. A `no_match` never decides a group.

| Group | Form (all synthetic) | Proof condition | Rows | Class |
| --- | --- | --- | ---: | --- |
| `ordinal_episode_proven` | `<Title>. 11-я серия`, `<Title> (31-я серия)`, `<Title>. 3-я - 4-я серии` | the stem reaches an ordinal of 7 or more anywhere in the ledger, the stem carries no year, and the stem is not the title of a verified Film | 559 | proven |
| `dash_season_episode_placeholder` | `<Title> 2-07`, `<Title> 1-3` | the description is empty or equal to the title, the duration is at most 80 min, and the stem repeats at least twice in the cohort | 196 | proven |
| `season_abbrev_episode` | `<Title>", 18 сезон, 10 с. "<Name>` | season marker plus the abbreviated episode marker, and the stem repeats | 24 | proven |
| `series_label_suffix` | `<Title> (2026) мини–сериал` | an explicit series label that is not leading (the current rule only reads a leading label) | 22 | proven |
| `pipe_season_episode` | `<Title> 2|5 <Name>`, `<Title> (2|1)` | a season-pipe-episode pair | 19 | proven |
| **Proven total** | | | **820** | |
| `ordinal_episode_review` | the ordinal form that fails the proof | stem below 7 ordinals, a year in the stem, or a verified Film with that stem | 212 | review |
| `numeric_suffix_block_review` | `<Title> 3-5` without the placeholder or repeat | a numeric suffix may be a film title | 22 | review |
| `season_marker_only` | `<Title> 2 сезон` | a season alone does not show an episode | 11 | review |
| `show_family` | ten or more rows share a `<Prefix>:` that no verified title uses | a brand, not a structure | 41 | review |
| `decorated_film_title` | `<Title> 2026 Драма` | a year and a genre appended to a title | 158 | likely film |
| `no_proof` | everything else | no structural evidence | 3,745 | no proof |

All 75 mixed candidates are `no_proof`. The discover-only and mixed split of every group is in the script output (`discoverOnly`, `mixed`).

### Exposure of the proven groups

A candidate is retried until `DISCOVERY_ATTEMPT_LIMIT` (5) attempts; a retry waits for `retry_at`, and the resolver selector skips a terminal row and a row whose `retry_at` is in the future. For the 820 proven rows, from the stored `attempts`, `terminal_reason` and `retry_at` at the time of the run (22 November 2026, before 07:20 UTC):

| Measure | Proven (820) | Four stateless forms (713) |
| --- | ---: | ---: |
| Resolution attempts that could still be spent (upper bound, sum of 5 minus attempts over non-terminal rows) | 2,090 | 1,832 |
| Already terminal (`repeated_uncertain_match`) | 39 | 31 |
| Selectable now (retry due) | 25 | 15 |
| In backoff until a later `retry_at` | 756 | 667 |

The latest `retry_at` among the 713 is 2026-11-29T04:47Z. An attempt is one resolution pass of a candidate, which can make several TMDB requests, so 1,832 is an upper bound of attempts, not of requests. The saving is one-off for the stock; the ongoing saving is the share of new episodes the rule keeps out, which this audit did not measure over time.

## False positives

1. **Verified controls.** 25,113 titles of observations with a `verified` decision, all residences. The structural predicates match **0** of them for the ordinal form, the pipe pair, the series label and a season marker, and **0** for the year-plus-genre decoration. The numeric dash predicate matches **1** (a real film whose title ends in a range). That film's description is a real plot of 69 minutes, not a placeholder, so the proof condition of `dash_season_episode_placeholder` rejects it. A second verified title with a range at its start, not at its end, is not matched by the suffix form at all. **Limit:** a verified title was found by an exact title search, so a title that carries a suffix such as `N-я серия` could never have been verified. This control shows that the form never appears on an identified Film; it does not prove that no unidentified film uses it.
2. **Film-like stems.** 58 rows of the cohort's ordinal-form titles, 18 stems, equal the title of a verified Film (multi-part and revived titles). They are all `ordinal_episode_review`, not proven, even where the ordinal is large: a stem collision with a Film is the multi-part-film risk that the current rule's documentation names, and the classifier does not guess which side it falls on. 18 of those rows have an ordinal of 7 or more and are series episodes that share a film's title; a stateless rule on the ordinal alone would screen them (see the recommendation).
3. **Manual review.** 50 proven rows drawn at random (seed 777: 30 ordinal, 14 dash, 6 abbreviated; the 19 pipe rows and 20 of the 22 label rows were also read): every one is an episode of a series, with an episode-level synopsis or a placeholder. Zero false positives in 50 bounds the rate below about 6% at 95% confidence for the sampled groups; the structural argument and the control above are the stronger evidence. The reviewer is the executor; the owner or an independent reviewer should repeat the draw.
4. **Negative controls.** A numbered Star Wars episode, a film title with the noun `Сезон` (`Сезон дождей`) and a cartoon feature whose title contains `Эпизод <Name>` fall outside every serial form and stay `no_proof`. The test fixtures pin these cases.

## False negatives and what the rest is

A seeded random sample of 100 `no_proof` rows (seed 20261122) was read by the executor:

| Reading | Sample of 100 | Estimate over 3,745 (95% interval is wide) |
| --- | ---: | --- |
| Real films that TMDB did not identify (known blockbusters, classics, local films; many with a year or a genre appended to the title, or the description reduced to the title) | about 82 | about 3,070 |
| Clear non-films that no stateless structural rule describes (talk-show episodes numbered with a hash, episodes named as `<Series> (<Title>)`, a topical programme, a kids' block, a season-episode code followed by a title) | 7 | about 260 |
| Ambiguous (documentary, cartoon compilation, event broadcast, a special) | 11 | about 410 |

So the audit leaves roughly **260** clear non-films unproven by structure. They are not a reason to widen a title rule: each shape is a different form, and the sampled films that look similar are real. **TMDB `no_match` is not evidence of a non-film**: the 82 films above carry that very status. A large share of the cohort is an identification failure, not a screening failure; that is outside this card.

## Existing cleanup mechanisms

| Mechanism | What it writes | Can it exclude these candidates? |
| --- | --- | --- |
| `nonFilmEPGReason()` in `scanEPG` and the cheap pass | `excluded_nonfilm` decision, or no candidate at scan | Yes, and it is the only one that writes this decision: every writer of `status:'excluded_nonfilm'` in `src` (`src/sources.js`, `src/discovery.js`) goes through `screenedNonfilmReason`. A stored decision is reversible when the rule no longer screens the title ([non-film screening](../../reference/domain/nonfilm-screening.md#reversibility)). |
| Owner policy-exclusion writer | retires a verified catalog Film by TMDB id on an exact owner-reviewed match | No. It operates on verified Films, not on an unresolved observation. |
| `reconsider`, `identity_assign`, `identity_reject`, `identity_revoke` intents | an owner decision about the TMDB identity of one observation | No. None writes `excluded_nonfilm`. |
| Channel policy `deny_all` / `known_only` | drops or restricts a programme by channel | No. The candidates are on `discover` channels. |

According to the code, a rule extension would reach the accumulated rows by itself: the paged resolver selects only actionable rows (`ACTIONABLE_FROM` in `src/discovery-authority.js`: not verified, no terminal reason, `retry_at` null or due), applies `screenedNonfilmReason` to each selected row before any TMDB call, and stores `excluded_nonfilm` when it matches (`src/discovery.js`, cheap pass). A row in backoff is therefore cleaned when its `retry_at` falls due, at no TMDB cost; a terminal row is never reselected and keeps its decision. This needs no writer, no hard delete and no backfill, and it keeps the decision history. That reading was not exercised against a rule change; the implementation card must prove it offline.

## Recommendation (for the owner; nothing here is applied)

1. **No cleanup operation.** There is no existing safe writer, and a hand-written set of decisions would be a new production writer. Do not hard-delete, purge or reclassify.
2. **Narrow follow-up code change, only on an owner decision.** Extend the title screen with four stateless forms, each with the guard that this audit measured:
   - an ordinal `N-я серия` (or a range or plural) with `N` or the upper bound **at least 7** (452 rows here, 18 of which share a stem with a verified Film and need an explicit decision on the stem guard; ordinals 1 to 6 stay candidates because of multi-part films, 127 proven rows);
   - `<Title> S-EE` with an empty or title-equal description and at most 80 minutes (196 rows; the description is on the scan XML and on the candidate);
   - the abbreviated season-and-episode marker (24 rows) and the non-leading series label (22 rows);
   - the season-pipe-episode pair (19 rows).

   Together they reach 713 of the 820 proven rows. The same function runs in `scanEPG`, so one change both stops new entries and, through the cheap pass, drains the stock. The change needs its own card, ADR check, offline replay on this cohort, fixtures from this report (positive controls, the verified-title collision, the Star Wars and `Сезон дождей` negatives) and a measured false-positive count on verified titles before deploy.
3. **Keep on review.** `ordinal_episode_review`, `numeric_suffix_block_review`, `season_marker_only` and `show_family` (286 rows) and the unproven rest. A brand rule for the 41 `show_family` rows is a product decision about shows and events, not a screening proof.
4. **Not a screening matter.** About four in five of the unproven rows look like real films with a title that did not match. An identification or title-normalization follow-up would deal with them; it does not belong in a screening rule. This is a sample estimate and needs a larger independent sample before a card is written.
5. **Do not open the conditional card 8** without the owner decision in point 2.

## Limits

- Read-only SQL over several minutes; the pin was identical at both ends, no snapshot transaction exists.
- The cohort is `active` rows only. 54,491 archived rows were not examined; the ordinal history for a stem uses every residence that carries a serial word.
- The labels of the two manual reviews are one reviewer's judgment, with no second reviewer and no ground truth.
- The proof thresholds (7 ordinals, 80 minutes, a repeat of 2, a family of 10) were chosen from this cohort, not from an independent set; the rule card must re-measure on a fresh generation.
- The cheap-pass cleanup path and the attempt economy were read in code and computed from stored fields; neither was run.
- The first filtered EPG sync and AIR-565 were not waited for; a later generation will change the counts.

## Reproduction

The classifier takes three JSON exports; stdout is aggregates, and titles go only to `--private-out`, which the script refuses inside the repository. Every query below is a `SELECT` against the production D1; the `ch` common table is the effective-policy derivation above.

```sql
-- cohort (one row per unresolved, unconfirmed active observation with a discover show)
WITH ch AS (
 SELECT c.channel_id, COALESCE(c.override_policy, oc.policy, pc.policy, 'known_only') pol
 FROM epg_channel c
 LEFT JOIN epg_channel_category oc ON oc.category_key = c.owner_category_key
 LEFT JOIN epg_channel_category pc ON pc.category_key = c.category_key),
agg AS (
 SELECT s.observation_key, sum(COALESCE(ch.pol,'known_only')='discover') d, sum(COALESCE(ch.pol,'known_only')='deny_all') x, sum(COALESCE(ch.pol,'known_only')='known_only') k
 FROM discovery_observation_show s
 JOIN discovery_observation o ON o.source_key = s.source_key AND o.observation_key = s.observation_key AND o.residence = 'active'
 LEFT JOIN ch ON ch.channel_id = s.channel_id GROUP BY s.observation_key)
SELECT o.observation_key ok, o.title t, o.year y, d.status st, d.terminal_reason tr, json_extract(d.payload_json,'$.attempts') att, d.retry_at ra,
 json_extract(o.payload_json,'$.durations') dur, substr(json_extract(o.payload_json,'$.description'),1,300) ds, a.d dsh, a.x xsh, a.k ksh
FROM discovery_observation o JOIN agg a ON a.observation_key = o.observation_key LEFT JOIN discovery_decision d ON d.observation_key = o.observation_key
WHERE o.residence = 'active' AND a.d > 0 AND o.confirmed_tmdb_id IS NULL AND COALESCE(d.status,'') <> 'verified';

-- history (serial words, every residence)
SELECT o.title t, o.residence rs FROM discovery_observation o
WHERE lower(o.title) LIKE '%серия%' OR lower(o.title) LIKE '%серии%' OR lower(o.title) LIKE '%серий%' OR lower(o.title) LIKE '%сезон%'
 OR lower(o.title) LIKE '%season%' OR lower(o.title) LIKE '%episode%' OR lower(o.title) LIKE '%эпизод%';

-- verified controls
SELECT o.title t FROM discovery_observation o JOIN discovery_decision d ON d.observation_key = o.observation_key WHERE d.status = 'verified';
```

```bash
node scripts/air-566-residual-nonfilm-audit.mjs --cohort cohort.json --history history.json --verified verified.json --private-out /private/outside/repo
node tests/air-566-residual-nonfilm-audit.mjs
```

The test fixtures are synthetic: one stem per group, the verified-title collision, the year-bearing stem, the numeric film title with a real plot, the public negative controls, the attempt arithmetic for terminal, due and backoff rows, and the refusal of a private directory inside the repository.
