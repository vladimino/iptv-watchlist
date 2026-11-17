# AIR-503: root cause of the 33 same-title runtime conflicts

**Captured:** 17 November 2026 (UTC), read-only `SELECT` against production D1 `iptv`. `rows_written` was 0 on every query. No Worker GET, no TMDB call, no R2 read, no EPG, Discovery, prediction or ratings run, no flag change.
**Used by:** [AIR-503](https://trello.com/c/t9fZCHLQ). Follow-up to the Same-title runtime conflicts section of the [AIR-500 audit](air-500-false-film-identity-audit-2026-11-16.md). Related: [AIR-488](https://trello.com/c/p5PCEB0c) ([ADR 0151](../../adr/0151-epg-known-film-title-collision.md)), [AIR-498](https://trello.com/c/3dPOigK9).
**Code read:** `main` `69914093aa042cb61897aa8a6ff64361d7db9b81` (`src/sources.js` `scanEPG` and `knownSlotDecision`, `src/domain/scored-resolution.js` `runtimeEvidence`, `src/domain/slot-evidence.js`, `src/discovery.js` cheap pass and `touchCanonicalFilm`).
**Pinned state:** `published_epg_authority` `d1` / `open`, generation 511, published run `47663279-3e6b-423d-b696-b22edfcead91`.
**Verdict:** no confirmed wrong identity and no confirmed code defect in the 33. 32 of 33 keys are an artifact of the audit metric. Five keys are `insufficient evidence`, none is `confirmed wrong`. No production correction is proposed. The one residual question (a series-title alias on `tmdb_400160`) is a data and index-visibility limit that ADR 0151 already records, not a defect a guard can fix without a blanket runtime veto.

## What the AIR-500 metric measured

AIR-500 compared `abs(observation.duration − Film.runtime)` with `max(45, 40% × runtime)`. `observation.duration` is the length of the **first slot of the key in feed order** (`scanEPG` sets `duration: Math.round(duration)` on the first slot, and the duplicate-slot rebuild repeats that). The same observation stores every distinct slot length in `durations` (up to 12). The scorer does not use the single field: `observationDurations` takes the set, and `runtimeEvidence` takes the **minimum distance** over it. A first slot that is a 55 or 60 minute fragment, or a 240 minute marathon, is therefore not a scorer conflict when another slot of the key fits.

Recomputed with the scorer's own rule (minimum distance over `durations`, bands `near` max(8 min, 8%), `mid` max(25 min, 20%), `far` max(45 min, 40%)):

| Band of the best-fitting stored duration | Keys |
| --- | --- |
| `near` | 32 |
| `mid`, `far` | 0 |
| `conflict` | 1 (`проданный смех\|1981`, only stored duration 60 against 140) |

So the cohort of 33 is a property of the first-slot field, not 33 contradicted identities. Every other query in this record uses all stored durations.

## Why a fragment or a marathon does not become a show

A slot becomes a Film show only through a per-slot rule:

1. `scanEPG` attaches a slot to a watchlist Film, or confirms a catalog identity on that slot, only when `knownSlotDecision` leaves one identity. With a title year, a runtime beyond `max(45 min, 40%)` is `contradictory_runtime`. Without a year, a slot that is not within `max(8 min, 12%)` of the only indexed runtime is `insufficient_year_or_duration`. The slot stays a discovery observation. [ADR 0151](../../adr/0151-epg-known-film-title-collision.md).
2. A stored `verified` decision lends its Film to a slot only when the slot is confirmed on its own (`confirmedSlots`), or its own duration is inside the anchor tolerance (`slotEligibility`, [ADR 0142](../../adr/0142-epg-owned-generation-addressed-discovery-slots.md) decisions 5 and 6). A `known_epg_alias` decision has no anchor.

Result in production: for the 11 keys that have a current show, every current `published_epg_show` has a duration inside the band of its Film (table below). No 55, 60, 167, 240 or 270 minute slot is published as one of the 33 Films.

## Where the 11 `known_epg_alias` decisions came from

Eleven of the 33 keys carry `identitySource=known_epg_alias`. Their `discovery_decision_history` has one revision each: eight written by `import` on 2026-11-04T21:02:58Z and three by `resolver_chunk` on 2026-11-08 (19:18–19:58Z). All predate the 16 November acceptance of ADR 0151. ADR 0151 records that before it, one catalog-confirmed slot could verify the **whole observation** through the cheap pass; this record infers that route from the dates and the null ids and does not have the pre-0151 observations to prove it. ADR 0151 now sets the observation id only when every retained slot confirms the same id. The cheap pass creates a decision only when none exists (`discovery.js`, `!decision`), so a stored alias decision is never reopened; the current observation of all eleven has `confirmed_tmdb_id` null. That is consistent with the rule change and with no re-evaluation. It is a documented ADR 0151 consequence ("No stored showing is rewritten by this change"), not a new defect: the per-slot rule above still withholds every slot that is not confirmed or anchored.

## Named cases

- **`губка боб квадратные штаны|` (`tmdb_400160`, 95 min).** Stored durations `[87, 84, 240, 115, 60, 270]`. `tmdb_400160` has the series title (`Губка Боб квадратные штаны`, with dash variants) among its aliases, and the catalog holds three other SpongeBob films (`tmdb_228165` 93 min, `tmdb_281649` 94 min, `tmdb_991494` 96 min). One slot (channel `ch2341`, 2026-11-15 15:33:33Z, 87 minutes) was confirmed on this key and is the only current show. 87 against 95 is `near`. The 240 and 270 minute marathons and the 60 and 115 minute slots are not shows. Whether the 87 minute slot is `Губка Боб в бегах` or another programme under the series title cannot be decided from stored fields. This record does not read TMDB and does not name another film. Disposition `insufficient evidence`. The alias list does not show whether TMDB or an EPG title added the series title, so this record does not claim an alias feedback loop. `touchCanonicalFilm` does add raw titles of a touched observation to the Film aliases; that is documented and unchanged.
- **`солярис|` (`tmdb_2103`, Solaris 2002, 99 min).** Stored durations `[167, 95, 185]`. 167 and 185 minutes are consistent with a different adaptation. The catalog has no other Solaris, so there is nothing to attach them to, and no replacement id is proposed. The current Solaris shows are four 98 minute slots under `солярис|2002`. The yearless key has no current show. The rating evidence of AIR-500 for `tmdb_2103` is unchanged by this record and the admission must not be retired because of a slot. Disposition `insufficient evidence`.
- **`аватар|2009`, `август|2025`, `крид 3|2023`, `эра выживания|2022` and the other year keys with a leading 60 minute slot.** Each stores the full airing next to the fragment. Avatar publishes 178 minute airings against 162 (inside the scan's 12% band, 19 minutes). Explainable.
- **`а зори здесь тихие|`, `двенадцать месяцев|`.** Part-length slots (94, 63, 65, 76) next to full airings (180, 139). Parts are not attached; the full airing of `а зори здесь тихие|1972` is (187 minutes).
- **`прямой эфир|`, `основано на реальных событиях|`.** Generic titles. The stored durations scatter (a 180 minute live slot; 95 to 215 minutes). Fit to the admitted runtime does not identify the programme. `insufficient evidence`, no change.

## Per-observation classification (all 33)

Columns: the Film, the exact observation key, residence of its rows (`active`, `archive` or both), the first-slot `duration` that AIR-500 used, every stored `durations` value, the admitted runtime, the minimum distance and its band, the identity source of the stored decision, durations of the current `published_epg_show` rows whose `match_reason` equals the key, and the disposition. Four keys have no active observation (`зеленый фургон|`, `власть|2018`, `турецкий гамбит|`, `подлинная история банды келли|2020`); their durations are the archive row.

| film | observation key | residence | first slot | stored durations | runtime | min distance (band) | source | current show minutes | disposition |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `tmdb_400160` | `губка боб квадратные штаны\|` | active | 60 | [87, 84, 240, 115, 60, 270] | 95 | 8 (near) | known_epg_alias | 87 | insufficient evidence. Series title in the Film aliases; 240/270 are marathons, the one 87-minute show cannot be told from another SpongeBob film |
| `tmdb_53010` | `любовь с риском для жизни\|` | active | 200 | [207, 95, 200] | 87 | 8 (near) | tmdb_detail | none | explainable valid. A stored duration fits; the other slots are fragments, parts, marathons or cuts that no stored rule makes a show |
| `tmdb_14486` | `новые похождения кота в сапогах\|` | active | 95 | [86, 83, 85, 95, 190] | 83 | 0 (near) | known_epg_alias | 80 | explainable valid. A stored duration fits; the other slots are fragments, parts, marathons or cuts that no stored rule makes a show |
| `tmdb_1364113` | `счастливый билетик\|` | active+archive | 160 | [55, 145, 60, 160] | 53 | 2 (near) | tmdb_detail | none | explainable valid. A stored duration fits; the other slots are fragments, parts, marathons or cuts that no stored rule makes a show |
| `tmdb_808960` | `прямой эфир\|` | active | 180 | [76, 180] | 75 | 1 (near) | tmdb_detail | 70 | insufficient evidence. Generic title; the 180-minute slot is a live programme; the 70-minute show fits but has no year |
| `tmdb_19995` | `аватар\|2009` | active | 60 | [178, 177, 170, 172, 171, 162, 60] | 162 | 0 (near) | none | 178, 178, 178 | explainable valid. A stored duration fits; the other slots are fragments, parts, marathons or cuts that no stored rule makes a show |
| `tmdb_653851` | `двойная петля\|` | active | 230 | [139, 133, 230] | 138 | 1 (near) | tmdb_detail | none | explainable valid. A stored duration fits; the other slots are fragments, parts, marathons or cuts that no stored rule makes a show |
| `tmdb_59722` | `замерзший мир\|2011` | active | 180 | [180, 91] | 91 | 0 (near) | tmdb_detail | none | explainable valid. A stored duration fits; the other slots are fragments, parts, marathons or cuts that no stored rule makes a show |
| `tmdb_49106` | `а зори здесь тихие\|` | active | 94 | [110, 235, 215, 220, 179, 180, 115, 120, 94] | 180 | 0 (near) | tmdb_detail | none | explainable valid. A stored duration fits; the other slots are fragments, parts, marathons or cuts that no stored rule makes a show |
| `tmdb_2898` | `лучше не бывает\|` | active | 55 | [133, 135, 165, 139, 55] | 139 | 0 (near) | tmdb_detail | none | explainable valid. A stored duration fits; the other slots are fragments, parts, marathons or cuts that no stored rule makes a show |
| `tmdb_72201` | `двенадцать месяцев\|` | active | 55 | [139, 63, 76, 65, 60, 55] | 135 | 4 (near) | tmdb_detail | none | explainable valid. A stored duration fits; the other slots are fragments, parts, marathons or cuts that no stored rule makes a show |
| `tmdb_63532` | `проданный смех\|1981` | active | 60 | [60] | 140 | 80 (conflict) | known_epg_alias | none | insufficient evidence. The only stored duration is a 60-minute fragment; the key has no fitting slot; no current show |
| `tmdb_416051` | `основано на реальных событиях\|` | active+archive | 175 | [100, 215, 95, 195, 175] | 96 | 1 (near) | tmdb_detail | none | insufficient evidence. Generic title; four of five durations are far from 96; no current show |
| `tmdb_586387` | `август\|2025` | active | 60 | [138, 137, 60] | 138 | 0 (near) | none | 138, 138 | explainable valid. A stored duration fits; the other slots are fragments, parts, marathons or cuts that no stored rule makes a show |
| `tmdb_111` | `лицо со шрамом\|` | active | 89 | [89, 93, 170, 163] | 170 | 0 (near) | known_epg_alias | none | explainable valid. A stored duration fits; the other slots are fragments, parts, marathons or cuts that no stored rule makes a show |
| `tmdb_325821` | `зеленый фургон\|` | archive | 159 | [75, 125, 80, 159] | 88 | 8 (near) | tmdb_detail | none | explainable valid. A stored duration fits; the other slots are fragments, parts, marathons or cuts that no stored rule makes a show |
| `tmdb_429197` | `власть\|2018` | archive | 62 | [132, 126, 62] | 132 | 0 (near) | tmdb_detail | none | explainable valid. A stored duration fits; the other slots are fragments, parts, marathons or cuts that no stored rule makes a show |
| `tmdb_53129` | `турецкий гамбит\|` | archive | 200 | [124, 200] | 130 | 6 (near) | known_epg_alias | none | explainable valid. A stored duration fits; the other slots are fragments, parts, marathons or cuts that no stored rule makes a show |
| `tmdb_2103` | `солярис\|` | active | 167 | [167, 95, 185] | 99 | 4 (near) | known_epg_alias | none | insufficient evidence. 167/185 fit the 1972 adaptation (not in the catalog); 95 fits 2002; no current show under this key |
| `tmdb_206867` | `необыкновенные приключения карика и вали\|1987` | active | 63 | [126, 63] | 128 | 2 (near) | tmdb_detail | none | explainable valid. A stored duration fits; the other slots are fragments, parts, marathons or cuts that no stored rule makes a show |
| `tmdb_501395` | `подлинная история банды келли\|2020` | archive | 60 | [125, 60] | 124 | 1 (near) | none | none | explainable valid. A stored duration fits; the other slots are fragments, parts, marathons or cuts that no stored rule makes a show |
| `tmdb_21575` | `пророк\|` | active | 85 | [149, 90, 96, 95, 85] | 149 | 0 (near) | known_epg_alias | none | explainable valid. A stored duration fits; the other slots are fragments, parts, marathons or cuts that no stored rule makes a show |
| `tmdb_27939` | `дом который построил свифт\|` | active | 77 | [137, 136, 77] | 138 | 1 (near) | tmdb_detail | 136, 136 | explainable valid. A stored duration fits; the other slots are fragments, parts, marathons or cuts that no stored rule makes a show |
| `tmdb_257211` | `стажер\|2015` | active | 121 | [121, 122, 60] | 121 | 0 (near) | none | 121, 121, 121, 121, 121, 121, 121 | explainable valid. A stored duration fits; the other slots are fragments, parts, marathons or cuts that no stored rule makes a show |
| `tmdb_859` | `опасные связи\|` | active | 100 | [60, 119, 185, 115, 190, 90, 110, 180, 100] | 119 | 0 (near) | known_epg_alias | none | explainable valid. A stored duration fits; the other slots are fragments, parts, marathons or cuts that no stored rule makes a show |
| `tmdb_6950` | `эпидемия\|` | active | 99 | [69, 128, 123, 99] | 128 | 0 (near) | known_epg_alias | none | explainable valid. A stored duration fits; the other slots are fragments, parts, marathons or cuts that no stored rule makes a show |
| `tmdb_677179` | `крид 3\|2023` | active+archive | 60 | [116, 117, 118, 60] | 116 | 0 (near) | tmdb_detail | none | explainable valid. A stored duration fits; the other slots are fragments, parts, marathons or cuts that no stored rule makes a show |
| `tmdb_75656` | `иллюзия обмана\|2013` | active | 60 | [120, 115, 124, 60] | 115 | 0 (near) | tmdb_detail | 115, 124 | explainable valid. A stored duration fits; the other slots are fragments, parts, marathons or cuts that no stored rule makes a show |
| `tmdb_976720` | `эра выживания\|2022` | active | 60 | [114, 60] | 114 | 0 (near) | tmdb_detail | 114 | explainable valid. A stored duration fits; the other slots are fragments, parts, marathons or cuts that no stored rule makes a show |
| `tmdb_745` | `шестое чувство\|` | active | 55 | [105, 104, 107, 55] | 107 | 0 (near) | tmdb_detail | 107, 105 | explainable valid. A stored duration fits; the other slots are fragments, parts, marathons or cuts that no stored rule makes a show |
| `tmdb_11652` | `преодоление\|` | active | 55 | [100, 60, 55] | 105 | 5 (near) | known_epg_alias | none | explainable valid. A stored duration fits; the other slots are fragments, parts, marathons or cuts that no stored rule makes a show |
| `tmdb_512412` | `точка возврата\|` | active | 135 | [87, 92, 140, 135] | 87 | 0 (near) | known_epg_alias | none | explainable valid. A stored duration fits; the other slots are fragments, parts, marathons or cuts that no stored rule makes a show |
| `tmdb_556694` | `три тысячи лет желаний\|2022` | active | 60 | [101, 108, 60] | 108 | 0 (near) | tmdb_detail | 108, 108, 108, 108, 108, 108, 108 | explainable valid. A stored duration fits; the other slots are fragments, parts, marathons or cuts that no stored rule makes a show |

Totals: `confirmed wrong` 0, `explainable valid` 28, `insufficient evidence` 5. 11 keys have current shows; 22 have none (4 of them are archive only). Show minutes of the 11: 87 (`губка боб квадратные штаны|`), 80, 70, 178 ×3, 138 ×2, 136 ×2, 121 ×7, 115 and 124, 114, 107 and 105, 108 ×7. All fit their runtime within the scan's `max(8 min, 12%)` band. Two need a note: the 87 minute SpongeBob slot carries the series-title alias, and the 70 minute `прямой эфир|` slot matches a generic title. A fitting duration does not settle either identity.

`explainable valid` means the duration evidence does not contradict the stored identity. It does not re-prove the identity. The identity source is the stored decision (`tmdb_detail` or `known_epg_alias`); this record neither re-verifies nor changes it.

## User impact

- Current published shows: no show of the 33 Films has a duration outside its band. The two shows that deserve attention are one SpongeBob slot (87 minutes, 15 November) and one `прямой эфир|` slot (70 minutes, 15 November); neither is shown to be wrong.
- Finds and Last Chance read published shows and the admission, so they inherit the same result. Fragments, parts and marathons add no show.
- Predictions, ratings and watchlist are keyed by Film and are not changed by a slot. No Film is deleted, retired or rejected on this record.

## Regression coverage

[`tests/slot-duration-classes.mjs`](../../../tests/slot-duration-classes.mjs) (core suite) runs `scanEPG` on fixture XMLTV and asserts which slots become shows. It does not call production and does not need a new flag.

| Class (AIR-503 acceptance) | Assertion |
| --- | --- |
| Unequal durations of one key | Avatar 178, 170, 162 attach; the 60 minute slot stays an observation with reason `contradictory_runtime` |
| Short 55 and 60 minute slots | The Sixth Sense (yearless): 105 and 107 attach; 55 and 60 stay observations (`insufficient_year_or_duration`) |
| Long 167, 240, 270 minute slots | Solaris 2002: only 99 attaches; SpongeBob 240, 270, 60, 115 attach nothing; no replacement id is confirmed |
| Several adaptations, one title | With Solaris 1972 in the catalog, 167 minute slots are confirmed on that id per slot and never attach `tmdb_2103`; 99 minute slots attach `tmdb_2103` |
| Film split into parts | 94 and 86 minute parts of a 180 minute film attach nothing; the 187 minute airing attaches |
| Correct full airing | Стажер: every 121 minute airing attaches with basis `title_year`, no leftover observation |
| Audit metric | `scoreFilmResolution` with `[60, 178, 162]` is `accepted`, equal to `[162]`; `[60]` against 162 is `contradicted_runtime` |
| Stored decision | An alias decision without a confirmed slot owns no slot; a confirmed slot gets `scan_confirmed`; an anchored 162 minute slot gets `anchor`, 60 and 240 do not |

## Policy for provider durations

A slot that does not fit a known Film stays a discovery observation. The existing rules already give a predictable result: a short fragment, a part or a marathon is not a show; a stored decision does not own a slot it did not confirm or anchor; the Film, its admission, ratings and watchlist are never removed because of one slot. This record adds no veto, no new band and no new flag. A future audit of the same shape must read `durations`, not `duration`.

## Proposed disposition and follow-up

- Code: none. A guard for the series-title alias would need a rule that rejects a real alias, which ADR 0151 declined (Films absent from the index are not visible, and 87 against 95 is inside the accepted band). No ADR change.
- Data: none now. If the owner wants the 87 minute SpongeBob show or the `tmdb_400160` series-title alias removed, that is a separate, scoped correction with its own write set and readback, and needs an owner decision. It is not part of this record and does not republish the EPG.
- The 11 `known_epg_alias` decisions are historical. They stay until the next natural resolver chunk or an owner decision; nothing is rewritten here.

## Limits

- Per-slot history older than the stored `durations` (twelve distinct values per observation) and the `shows` of archived observations are not kept; the table cannot name the channel or start of a slot that is not in the current published generation. Only the 87 minute SpongeBob slot has a stored `confirmedSlots` entry that this record read.
- TMDB, XMLTV and R2 fingerprint bodies were not read. The identity of a slot is judged only from stored fields.
- The record is a point-in-time read of generation 511. A later EPG publication changes the show list.
