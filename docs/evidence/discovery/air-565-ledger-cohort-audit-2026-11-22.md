# Discovery ledger cohort audit after the first filtered EPG

[AIR-565](https://trello.com/c/mSdBSd9j) · 22 November 2026, read between about 16:45 and 17:10 UTC · L0/L1 read-only. Aggregates only: no programme title, observation key or description is in this report. Nothing was applied: no D1 or R2 write, no cleanup writer, no EPG, Discovery, TMDB, Task or flag action.

**Verdict.** After the first accepted filtered EPG the **active** Discovery ledger holds **0 `deny_all` slots** and no deny-only or unknown-only observation; every observation that still has a `known_only` slot is Film-confirmed. The published generation holds 0 `deny_all` shows. The bounded lifecycle therefore already does what the card asks, and **no purge or cleanup writer is justified**. The one place where history from later-denied slots survives is the stored `durations` and `rawTitles` of 96 re-entering observations; for the 36 of them that are unresolved, an offline attribution (below) shows that **no current decision depends on that history and it cannot admit a Film**. The residual exposure for the 60 verified re-entries is not examined here and is handed to [AIR-567](https://trello.com/c/gDgSn2M7). The `EPG_CHANNEL_POLICY` binding is confirmed absent by a second, independent readback.

## Pin

| Item | Value |
| --- | --- |
| Schema | `schema_contract.version` 33 |
| Discovery authority | `d1` / `open`, `discovery_transfer` `committed`, programme run `bf89ba90-07eb-46ac-9723-15d309517830`; generation 295181 at the first read, 295201 at the cohort re-read |
| Published EPG | the same programme run `bf89ba90-…` (generation 517, accepted under [AIR-564](https://trello.com/c/omIQl2Lh)) |
| Channel policy | `epg_channel_revision` revision 2 (the EPG applied revision 1; revision 2 added 16 XMLTV-only channels as `known_only`, which classify like any channel the pinned map lacks), import revision 1, 35 categories, 2,119 channels |
| Code | `main` at `920ad8a` (the retirement of `EPG_CHANNEL_POLICY`, [#903](https://github.com/vladimino/iptv-watchlist/pull/903)) |

The Discovery generation advanced by 20 between the first read and the re-read: a natural workflow chunk of the same run. The cohort numbers below were re-read at generation 295201 and equal the first read, so nothing moved the cohorts in between. The effective policy of a channel is derived as the repository derives it: `override_policy`, then the owner category policy, then the provider category policy, then `known_only`; a show on a channel the table does not hold is `known_only`.

## (A) Published Film shows

| Measure | Value |
| --- | --- |
| Published shows of the pinned generation | 19,713 |
| On a `deny_all` channel | **0** |
| On a channel the table does not hold | 0 |
| On a `known_only` channel | 64, all on 2 channels registered in revision 2 (XMLTV origin) |

`published_epg_show` is **not frozen at publication**: after the scan writes its rows, Discovery inserts one guarded row per eligible slot of a verified observation into the same generation (`assignObservationSlots`, `src/discovery-authority.js`, [ADR 0142](../../adr/0142-epg-owned-generation-addressed-discovery-slots.md) decision 3), and a new generation replays the assigned rows (AIR-523). The row count of the pinned run therefore grows while Discovery runs: it read 19,713 at the start of this audit and 19,725 about 45 minutes later, with the run unchanged. Two earlier figures quoted on the card are consequently **not comparable** with these reads unless the read time and the counting grain are known: the 48 `known_only` shows of the handoff (this audit counts 64 rows, 42 films, 64 distinct channel and start pairs, all on 2 channels registered in revision 2) and a published-show total of 15,198 (this audit counts 19,713 and then 19,725 rows over 7,144 films and 560 channels; the previous run `7bce173c-…` holds 20,375 rows). **Neither earlier figure can be reconstructed from the repository or from D1**, so no explanation is offered; a recount that is to be compared must state the run, the read time and whether Discovery-assigned rows are included. None of this changes the verdict: there is no `deny_all` row in any of these reads.

## (B) Active Discovery, by cohort

Cohort of an observation = the effective policies of its current show slots. Candidates and show slots are counted separately.

| Cohort (active) | Observations | Show slots | `deny_all` slots | `known_only` slots | `discover` slots |
| --- | ---: | ---: | ---: | ---: | ---: |
| `discover` only | 13,770 | 26,799 | 0 | 0 | 26,799 |
| Mixed (`known_only` + `discover`) | 21 | 80 | 0 | 33 | 47 |
| `known_only` only | 14 | 20 | 0 | 20 | 0 |
| `deny_all` only | **0** | 0 | 0 | 0 | 0 |
| No shows | **0** | 0 | 0 | 0 | 0 |
| **Total active** | **13,805** | **26,899** | **0** | **53** | **26,846** |

The 35 observations with a `known_only` slot (21 mixed and 14 `known_only`-only): 34 have a `verified` movie decision and 1 has `duration_mismatch` with a confirmed slot; 34 carry a confirmed TMDB id on the observation and 1 verified one does not. None is an unconfirmed candidate, so nothing here would be sent to TMDB on policy grounds.

### Against the 20–21 November baseline

| Measure | 20–21 Nov pin (programme run `7bce173c-…`, generation 291468) | 22 Nov (run `bf89ba90-…`) |
| --- | ---: | ---: |
| `discovery_observation` `active` | 21,516 | 13,805 |
| `discovery_observation` `archive` | 54,491 | 64,148 |

Active fell by 7,711 and archive grew by 9,657. These are different snapshots of a ledger that also gains and loses observations through ordinary EPG turnover, so the two deltas are **not** a purge count and must not be reported as one; the card already warns that the scan figure (13,806 against 21,517) mixes several effects. The 20 November class sizes (6,308 deny-only, 564 deny/`known_only`-only, 181 mixed) were recalculated, not assumed: **0 of them remain active**, which is what the departures-to-archive lifecycle should produce.

### Archive keeps history

| Archived cohort | Observations | Show slots | `deny_all` slots |
| --- | ---: | ---: | ---: |
| `discover` only | 23,555 | 26,141 | 0 |
| No shows | 22,357 | 0 | 0 |
| `deny_all` only | 16,174 | 25,789 | 25,789 |
| `known_only` only | 1,989 | 2,005 | 0 |
| Mixed | 72 | 255 | 168 |
| `deny_all` + `known_only`, no `discover` | 1 | 3 | 2 |

Archived observations are not actionable and keep their slots as history; that is the intended ADR 0034 / 0156 behaviour, not residue to clean. `discovery_decision` holds 50,730 rows and `discovery_decision_history` 159,472. No earlier count of these two tables was taken before the filtered run, so **this report cannot show that no decision row was lost**; it shows only that the active cohorts are clean. The lifecycle code was not re-read line by line in this pass.

## Re-entry residue

96 active observations share their normalized title and year with an archived observation that has a `deny_all` slot (a title that aired on a denied channel before and now also airs on an allowed one, the case the card asks to leave to ordinary Discovery). None carries a current `deny_all` slot. How their *aggregate* fields compare with their current slots:

| Check on the 96 | Result |
| --- | --- |
| `firstAiring` equals the start of an archived denied slot | 7 |
| `lastAiring` equals the start of an archived denied slot | 0 |
| Stored `airings` exceeds the number of current slots | 82 |
| Some stored duration is absent from every current slot | 89 |
| Decisions | 60 `verified`, 23 `ambiguous`, 11 `no_confident_match`, 2 `duration_mismatch` |

Baseline: in a systematic 10% sample of all active observations (1,342), 625 (47%) also have a stored duration absent from the current slots, and 58% of the 13,709 active observations without an archived denied sibling have `airings` above the current slot count. Accumulation across a rolling slot window is normal; the elevated rate for the 96 (93% for durations) is a signal that needed the attribution below.

What the code does (`mergeDiscoveryCandidates`, `src/sources.js`): for a key in both the previous ledger and the latest scan, `firstAiring` is the minimum, `airings` the maximum, and `rawTitles` and `durations` the union of old and new, never recomputed from the current slots; the confirmed TMDB id and the confirmed slots come from the latest scan. `airings`, `firstAiring` and `description` are detail fields dropped from the streamed ledger. `durations` feed the scorer and the detail gate; `rawTitles` feed alias learning.

### Attribution of the 36 unresolved re-entries

Method: the 36 observations with a decision other than `verified` were read with their stored `durations` and decision (one bounded `SELECT`, 36 rows); for the same normalized titles the slot durations of the current observation and of the archived siblings were aggregated by effective channel policy (one bounded `SELECT`, grouped, about 120 result rows, 0.4 s); the attribution itself was done offline on those aggregates. A stored duration is **not** a current slot duration when no current slot of that observation has it ("extra"). An extra duration is classed *denied-only* when an archived `deny_all` slot of the same title has that duration and no archived permitted slot does, *permitted history* when an archived permitted slot has it, and *unattributed* when no remaining slot explains it. *Denied-only* is an upper bound: the same value may also have come from a permitted slot that left no archived row.

| Result over the 36 | Value |
| --- | ---: |
| Observations with no extra duration | 5 |
| Observations with at least one denied-only extra duration | 25 |
| Observations with extras, none denied-only | 6 |
| Extra durations in total: denied-only / permitted history / unattributed | 71: 26 / 7 / 38 |
| Decision reasons: `ambiguous_short_title_without_year` / `no_exact_title` / `ambiguous_collision` / `detail_runtime_mismatch` / `owner_policy_excluded` / ambiguous with no reason recorded | 18 / 10 / 4 / 2 / 1 / 1 |

Decision impact, read from `src/domain/scored-resolution.js` and `src/domain/resolution-acceptance.js`:

1. **The two ambiguity reasons and `no_exact_title` (32 of 36) are decided before any duration is looked at.** The scorer sets `no_exact_title` when no exact title exists and sets both ambiguity reasons from title quality, uniqueness and year relation, ahead of the score and the runtime. `owner_policy_excluded` (1) is a policy outcome. A different set of durations cannot change any of these 33.
2. **Durations can only widen acceptance.** The scorer's runtime evidence is the minimum distance over all stored durations, and the detail gate accepts when `durations.some(...)` is within tolerance. Removing a duration therefore cannot make a non-accepted observation accepted; at most it relabels an ambiguous one as `contradicted_runtime`, which admits nothing. All 36 are currently non-accepted with the full set, so **none would be accepted, rejected or newly verified by cleaning the denied-only durations**.
3. **The 2 `detail_runtime_mismatch` observations** (the only decisions whose reason is a duration test) were refused although the stored set includes a denied-only duration (one each); a refusal that survives the larger set also survives the smaller one, so the mismatch is not caused by stale history.
4. **`rawTitles` cannot reach the catalog for these 36.** They have no Film, and alias learning (`touchCanonicalFilm`, `src/discovery.js`, AIR-503) runs for a confirmed Film and adds a new normalized title only when the identity was confirmed independently (`tmdb_detail` or owner); otherwise only a cosmetic spelling of a key the Film already has is kept. Where `rawTitles` differ in these 36, the examined variants are decorations of the same title such as a `х/ф` prefix or trailing punctuation.
5. **Evidence key side effect of a fix.** `candidateEvidence` includes the stored durations, so changing them would change the `evidenceKey` of about 89 observations, reset their attempt counters and re-queue them for TMDB work, which is churn that a pure cleanup should not cause.

**Result.** For the 36 unresolved re-entries the answer is (a): the stale durations are **non-impacting for every current decision**, and the history cannot admit a Film. **Residual exposure, with a measurable bound:** the stale history is lenient, never strict, so a *future* retry could pass a runtime test thanks to a denied-only duration only if the decision first stops being title-driven. For 22 of the 25 observations with a denied-only extra (the ambiguity reasons and `no_exact_title`) that requires a new year, a unique title or a new exact title, none of which a duration supplies; the remaining 3 are the 2 refused ones above and the 1 with no recorded reason (not attributable). No code change is proposed, because no wrong decision is shown. If the owner prefers to remove the leniency anyway, the minimal fix is to rebuild `durations` and `rawTitles` from the current slots in the `replaceShows` branch of `mergeDiscoveryCandidates` with synthetic tests for: the same title on a denied and an allowed channel, re-entry from archive, per-slot confirmation, and an unchanged `evidenceKey` policy; it needs an explicit owner decision on the re-queue churn in item 5.

**Not examined, handed to AIR-567.** The 60 `verified` re-entries are settled identities, but whether any of them was accepted *because* a denied-only duration passed a runtime test is not shown here, because accepted candidates carry their TMDB runtime only in the TMDB detail, which this audit did not fetch. Likewise, the effect of `rawTitles` on the aliases of a verified Film is not examined. Both belong to the verified-Film audit.

## (C) Catalog identities (hand-over to AIR-567, read-only)

| Measure | Value |
| --- | --- |
| `discovery_decision` by status | `verified` 17,412; `no_confident_match` 24,591; `excluded_nonfilm` 4,887; `ambiguous` 3,031; `duration_mismatch` 652; `needs_verification` 156; no status 1 |
| `discovery_admission` | `current` 11,985 movies; `superseded` 166 movies; no `tv` rows |
| Owner intents (`discovery_intent`) | 1, state `receipt` |

This audit looked for wrong TMDB identities or unwanted types **only** through the active cohorts above and found none to hand over by name: the 35 `known_only`-slot observations are the only active ones whose channels are not in the discover set, and all are Film-confirmed. It did **not** audit the 17,412 verified decisions or the 11,985 current admissions against titles, types or TMDB data; that is [AIR-567](https://trello.com/c/gDgSn2M7). The absence of suspicious IDs here means "not examined", not "examined and clean". No correction or deletion of any Film, watchlist, rating or owner decision is requested.

## Protected data

No watchlist, ratings or owner-review table was read or compared before and after in this pass. The only owner action in Discovery, one intent, is in state `receipt` and untouched. Protection of verified identities rests on this read plus the absence of any writer in this audit; a before-and-after comparison would need a baseline taken before the filtered run, which does not exist.

## Reproducibility: query shapes and generation fence

All reads were `SELECT`s against production D1 `iptv` through the connector; no title or key is reproduced here. The shapes below are the ones used (identifiers as in `migrations/0011`, `0008`, `0032`).

- **Fence.** Read `discovery_authority` (`mode`, `cutover`, `programme_run_id`, `generation`), `discovery_transfer` (`committed`), `epg_channel_revision` (`revision`) and `schema_contract.version` before and after the cohort read. A cohort is accepted only if the run, the channel revision and the transfer state are the same on both sides. The Discovery `generation` is a counter that advances with every ledger chunk and is not part of the acceptance; it moved from 295181 to 295201 and the cohort read on the same run was repeated at 295201 with identical counts.
- **Effective policy of a channel.** `COALESCE(epg_channel.override_policy, policy of epg_channel_category WHERE category_key = owner_category_key, policy of epg_channel_category WHERE category_key = category_key, 'known_only')`; a show whose `channel_id` has no `epg_channel` row is `known_only` (left join, `COALESCE(p,'known_only')`).
- **Cohort of an observation.** Join `discovery_observation_show` to `discovery_observation` on `(source_key, observation_key)` for one `residence`, left-join the policy, aggregate per observation `d = SUM(p='deny_all')`, `k = SUM(p='known_only')`, `v = SUM(p='discover')`, `n = COUNT(*)`, then classify: `n` null is no shows; `d>0, k=0, v=0` deny-only; `k>0, d=0, v=0` known-only-only; `d+k>0, v>0` mixed; `d>0, k>0, v=0` deny and known-only without discover; otherwise discover-only. Observations are counted once; show slots are summed separately. No deduplication of shows beyond the primary key `(source_key, observation_key, ordinal)`.
- **Published shows.** `COUNT(*)` of `published_epg_show WHERE programme_run_id = <pinned run>`, with the same policy join on `channel_id`; the grains reported are rows, distinct `film_id`, distinct `channel_id || start_ms`, distinct `channel_id`.
- **Re-entry set.** Distinct `(normalized_title, year)` of archived observations having a `deny_all` slot, joined back to active observations on both columns with `COALESCE(year,0)`; this join was run once (17 s on a cold cache, 0.6 s warm). The unbounded variants (a second `NOT IN` or `EXISTS` over the same set) timed out at the connector's 60 s limit twice and one earlier join read about 176 million rows; none was repeated. The attribution above used only an `IN` list of the 36 normalized titles and an aggregate by `(residence, policy, duration)`.
- **Sample baseline.** Active observations with `rowid % 10 = 0` (1,342 rows) for the extra-duration measure.
- **Extra duration.** A stored value of `json_each(payload_json,'$.durations')` not among `ROUND((end_ms-start_ms)/60000.0)` of the observation's own `discovery_observation_show` rows.

## Binding removal readback (EPG_CHANNEL_POLICY)

The retiring change is [#903](https://github.com/vladimino/iptv-watchlist/pull/903), merged as `920ad8a`. The owner removed the Cloudflare binding afterwards. Read-only `feature_flags` readback by this session, 22 November 2026 17:12:51 UTC: `EPG_CHANNEL_POLICY` `state` `absent`, `raw` null, `effective` null, `valid` true, `retired` true, `redacted` false; the registry reports 25 flags, 2 set (`MONITOR`, `MONITOR_TRANSPORT`), 23 absent, 0 invalid; `storage` not accessed, `sideEffects` none. The independent reviewer's post-deploy readback reported the same values. This session removed nothing and holds no permission to.

## Method and limits

Every query was a `SELECT` through the Cloudflare D1 connector against production `iptv`. Heavy joins timed out or ran for many seconds (one read about 176 million rows); they were not repeated and the attribution was split into small bounded steps. A limit: slot-to-title attribution of `rawTitles` is impossible from `discovery_observation_show`, which stores the channel and times but not the programme title.

## Rollback

Nothing was changed, so there is nothing to roll back.
