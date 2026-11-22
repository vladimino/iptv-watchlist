# Discovery ledger cohort audit after the first filtered EPG

[AIR-565](https://trello.com/c/mSdBSd9j) · 22 November 2026, read between about 16:45 and 17:10 UTC · L0/L1 read-only. Aggregates only: no programme title, observation key or description is in this report. Nothing was applied: no D1 or R2 write, no cleanup writer, no EPG, Discovery, TMDB, Task or flag action.

**Verdict.** After the first accepted filtered EPG the **active** Discovery ledger holds **0 `deny_all` slots** and no deny-only or unknown-only observation; every observation that still has a `known_only` slot is Film-confirmed. The published generation holds 0 `deny_all` shows. The bounded lifecycle therefore already does what the card asks, and **no purge or cleanup writer is justified**. One residual is **not proven either way** and is recorded as an open question, not as a defect: aggregate evidence fields of 96 re-entering observations may still carry history from slots that were later denied (see [Re-entry residue](#re-entry-residue)).

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

The [AIR-565 handoff](https://trello.com/c/mSdBSd9j) quoted 48 `known_only` slots at the first read; this read counts 64 shows. The difference was **not reconciled**: the handoff may have counted distinct confirmed slots rather than shows, or counted before a later publish step. It does not affect the verdict (no `deny_all` show), and the card should not treat 48 or 64 as authoritative without a fenced recount.

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

96 active observations share their normalized title and year with an archived observation that has a `deny_all` slot (a title that aired on a denied channel before and now also airs on an allowed one, the case the card asks to leave to ordinary Discovery). All 96 have only current slots on allowed or `known_only` channels, and **none carries a current `deny_all` slot**. How their *aggregate* fields compare with their current slots:

| Check on the 96 | Result |
| --- | --- |
| `firstAiring` equals the start of an archived denied slot | **7** |
| `lastAiring` equals the start of an archived denied slot | 0 |
| Stored `airings` exceeds the number of current slots | 82 |
| Some stored duration is absent from every current slot | 89 |
| Decisions | 60 `verified`, 23 `ambiguous`, 11 `no_confident_match`, 2 `duration_mismatch` |

Baseline for the same measures: in a systematic 10% sample of all active observations (1,342), **625 (47%)** also have a stored duration absent from the current slots, and across the 13,709 active observations without an archived denied sibling 58% have `airings` above the current slot count. Accumulation across a rolling slot window is therefore normal, and the elevated rate for the 96 (93% for durations) is a signal, not proof.

What the code does (`mergeDiscoveryCandidates`, `src/sources.js`): when a key exists in both the previous ledger and the latest scan, `firstAiring` is the minimum, `airings` the maximum, and `rawTitles` and `durations` the union of old and new, never recomputed from the current slots; the confirmed TMDB id and the confirmed slots come from the latest scan. `airings`, `firstAiring` and `description` are detail fields and are dropped from the streamed ledger; `durations` feed the duration guard and `rawTitles` feed alias learning (`src/discovery.js`). So the 7 `firstAiring` matches are display-only. The two fields that can affect a decision are `durations` and `rawTitles`.

**Not proven.** A direct attribution of the extra durations of the 36 unresolved observations (23 `ambiguous`, 11 `no_confident_match`, 2 `duration_mismatch`) to denied slots only was attempted and its query exceeded the 60 second limit of the connector twice; it was not repeated, because a heavy scan on the production D1 adds load for a question that an offline join answers better. The 60 verified observations are settled identities and are not affected. For the 36 unresolved ones the realistic effect of stale durations is a blocked or ambiguous decision, not a wrong authorization, because the confirmation fields come from the latest scan. No merge, re-entry or seal bug is **proven**, so no code change is proposed in this card.

Proposed follow-up (needs the owner's decision, not part of this evidence): an offline attribution on exported cohort files in the style of [AIR-566](air-566-residual-nonfilm-audit-2026-11-22.md), and, only if it shows denied-slot durations changing a decision, a slot-attributed recomputation of `durations` and `rawTitles` inside the merge with synthetic tests (same title on two channels, re-entry from archive, confirmed per slot).

## (C) Catalog identities (hand-over to AIR-567, read-only)

| Measure | Value |
| --- | --- |
| `discovery_decision` by status | `verified` 17,412; `no_confident_match` 24,591; `excluded_nonfilm` 4,887; `ambiguous` 3,031; `duration_mismatch` 652; `needs_verification` 156; no status 1 |
| `discovery_admission` | `current` 11,985 movies; `superseded` 166 movies; no `tv` rows |
| Owner intents (`discovery_intent`) | 1, state `receipt` |

This audit looked for wrong TMDB identities or unwanted types **only** through the active cohorts above and found none to hand over by name: the 35 `known_only`-slot observations are the only active ones whose channels are not in the discover set, and all are Film-confirmed. It did **not** audit the 17,412 verified decisions or the 11,985 current admissions against titles, types or TMDB data; that is [AIR-567](https://trello.com/c/gDgSn2M7). The absence of suspicious IDs here means "not examined", not "examined and clean". No correction or deletion of any Film, watchlist, rating or owner decision is requested.

## Protected data

No watchlist, ratings or owner-review table was read or compared before and after in this pass. The only owner action in Discovery, one intent, is in state `receipt` and untouched. Protection of verified identities rests on this read plus the absence of any writer in this audit; a before-and-after comparison would need a baseline taken before the filtered run, which does not exist.

## Method and limits

Every query was a `SELECT` through the Cloudflare D1 connector against production `iptv`. Three heavy joins timed out or ran for many seconds (one read about 176 million rows); they were not repeated, and the later attribution was split into smaller steps. A document-level limit: slot-to-title attribution of `rawTitles` is impossible from `discovery_observation_show`, which stores the channel and times but not the programme title.

## Rollback

Nothing was changed, so there is nothing to roll back.
