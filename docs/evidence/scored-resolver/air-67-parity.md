# AIR-67 shadow parity

> Historical sample. See [evidence registry](../README.md) for context and later decisions. This text is not a current operational authorization.

**NO-GO.** Do not set `SCORED_RESOLUTION=on`. Do not start [AIR-68](https://trello.com/c/qbLDc6Ql).

This is the first parity decision on the baseline collected by [AIR-66](https://trello.com/c/z5Ndcll9). It is not a new sample, not a scorer change, and not the later re-measure. Candidate discovery stays in [AIR-80](https://trello.com/c/hQPjVTXv). A second production comparison, after that code exists, is [AIR-81](https://trello.com/c/ywuOtfo0). Legacy remains the writer. R2 remains the store.

Checked 2026-10-23 06:16 UTC, read only. The live binding is still the text `shadow`. Worker cron is empty. The published pointer is still generation `2e63530d-27f6-43cc-85dd-f5a2c9c97e16`, phase `published`. The latest Worker deploy is `4fdf26cf-e21e-4bcd-9c4c-72a4ddbd5571` at 2026-10-23 01:35 UTC, source `wrangler`, message `docs: record AIR-66 production shadow and read-only backtest (#49)`. That deploy does not change `scoreFilmResolution` or the acceptance gate. Those files are the same from `203727b` through `e7e9d11`. `LIFECYCLE_LOCALIZATION` was read and not changed. No resolver chunk, EPG sync, TMDB call, or prediction was started for this decision.

## 1. What was compared

Two evidence sets. They are not added together.

Production shadow, 2026-10-22 23:44:20 UTC through 23:57:10 UTC, twelve calls to the existing resolve route, one chunk each. Code `203727b`. Generation `2e63530d-27f6-43cc-85dd-f5a2c9c97e16`. Each preview was copied before the next chunk replaced `epg/discovery-score-preview.json`. No observation key repeated. The detail and the per-chunk table are in [the AIR-66 record](air-43-shadow-rollout.md).

| Comparison | Rows | Share of 79 |
| --- | ---: | ---: |
| `agree_verified` | 50 | 63% |
| `agree_unresolved` | 29 | 37% |
| `legacy_only` | 0 | 0 |
| `scored_only` | 0 | 0 |
| `different_id` | 0 | 0 |
| `detail_not_compared` | 0 | 0 |

Chunk errors: none. Chunk `retryAt`: none. Legacy TMDB counter: 156 calls, 12 or 14 per chunk. No 429 in a chunk response. Legacy inserted 50 catalog films. Decision rows `verified` rose by 125, which is those 50 plus 75 cheap-pass alias rows in chunk 1. `no_confident_match` rose by 19 against 27 preview writes that ended in that status. The pre-run resolution object was not kept, so those eight rows are either rewrites of an existing `no_confident_match` or older rows that became `verified` inside the 50. Same-evidence retries are ruled out (`attempts` is 1 on all 29 shared refusals). `ambiguous` and `duration_mismatch` did not change. Terminal no-match stayed 0.

Offline scorer diagnostic, same generation, `now` fixed at 2026-10-23 01:04:00 UTC. `scoreFilmResolution` only. No movie-detail payload, so nothing here is `detail_verified`. An `accepted` score is not a verified decision.

| Metric | Known aliases | Yearless | Collisions |
| --- | ---: | ---: | ---: |
| Selected | 100 | 40 | 30 |
| Scoreable | 100 | 26 | 30 |
| Accepted | 76 | 6 | 17 |
| Ambiguous | 22 | 20 | 12 |
| Contradicted | 2 | 0 | 1 |
| Missing local evidence | 0 | 14 | 0 |
| Disagreement with a stored id | 21 of 96 | 13 of 19 | 7 of 24 |

The 75 known-alias keys are the chunk-1 cheap pass: `identitySource` `known_epg_alias` and `checkedAt` `2026-10-22T23:44:20.389Z`. The other 25 are a key-sorted fill of current observations. The catalog already contains the 50 films inserted during the twelve chunks. It is not a pre-run index.

## 2. Sampling

The production slice is hot and dated, every preview row has a year, and every `knownBefore` is false. Chunk 1 reused 75 known aliases before scoring, and those rows never entered the preview. The offline pass is the measurement of that bypass. It is not a second production shadow run.

Not present in the production comparison: a yearless title, a known alias inside the preview, a contradictory runtime, a remake the two resolvers split, a shadow-only detail fetch, `legacy_only`, `scored_only`, and `different_id`. A quiet hot slice does not clear those classes.

`scored_only` would be a possible false film, not an improvement. None occurred, so the false-match rate is unmeasured, not shown to be zero on a representative set. `legacy_only` would be a recognition loss of the scorer against legacy. None occurred on the hot slice. The shared refusals below are losses of both.

## 3. Where the baseline fails cutover

### Shared recognition loss

These production rows are `agree_unresolved`. Both resolvers refused. The offline index agrees, except where a different local film is the exact title. No new TMDB search was made for this decision.

| Observation | Loss |
| --- | --- |
| `блейд 1\|1998` | Title preparation. Catalog TMDB 36647 is `Блэйд` (1998). The observation key is `блейд 1`. The extra token blocks the alias. `э` does not fold into `е`. |
| `11 друзей оушена\|2001` | TMDB 161 is not in this catalog. The public title spells the number. The observation uses `11`. Production search found no exact title. |
| `ирония судьбы или с легким паром\|1975` | Search is sent with `year=1975`. TMDB 43430 is dated 1 January 1976. Acceptance allows one year. The search parameter does not. |
| `мортал комбат\|1995` | TMDB 9312 is not in this catalog. Production search found no exact title. |
| `чудо женщина\|2020` | The observation dropped `1984`. The only local exact title is TMDB 297762, Wonder Woman (2017). The scorer returns `contradicted_year` at 0.65. TMDB 464052 is not in this catalog. |
| `гол 2\|2008`, `чужой против хищника 1\|2004` | Same sequel suffix as Blade. Production search found no exact title. |

Turning `on` uses the same search year and the same exact-title rule. It would not recover these films. That work is [AIR-80](https://trello.com/c/hQPjVTXv). It must not be folded into this decision.

### Cheap pass and the scorer

The cheap pass runs before the mode branch. `confirmedTmdbId` with no decision becomes `verified` and `known_epg_alias` under `off`, `shadow`, and `on`. Those rows never reach the scorer.

On the recovered 75, a short yearless title with one local film scores about 0.83 and stops at `ambiguous_short_title_without_year` (`year_required`). Examples: `72 часа|` stored 949838, `вечные|` stored 524434, `7500|` stored 82657. The stored id is the cheap-pass id. The scorer does not accept it. Because the cheap pass still runs under `on`, this is not evidence that cutover would un-verify those rows. It is evidence that the production preview never compared them, and that a future path which scores them instead of the cheap pass would refuse titles legacy currently verifies.

A long unique yearless title can be accepted. `007 координаты скайфолл|` accepts 37724 with a near runtime. `double trouble|` is also long and unique, then `contradicted_runtime` (143 against 90). Missing year is not itself acceptance.

### Remakes

With a year, the scorer separates editions and matches the stored id. `бегущий человек|1987` accepts 865. `бегущий человек|2025` accepts 798645. Without a year, the same title ties at 0.755 and stays `ambiguous_collision`, while the cheap pass had stored 798645. `the island|` likewise refuses to choose between 3764 (1960) and 1635 (2005). `война|1994` contradicts both local years and accepts neither.

That is the gate behaving as specified. It is also a class the twelve chunks did not contain. `on` would replace the legacy alias shortcut with this scorer. The shortcut was not in the production preview, so that replacement is not measured on live search evidence.

### Detail verification

Every production `agree_verified` row was `detail_verified` on the card legacy had already fetched. Shadow did not have to fetch a second card. `detail_not_compared` is 0. The offline pass had no movie-detail payload, so its accepted scores stay short of `detail_verified`. One offline accepted row was still actionable; the gate stops at `needs_verification`. The other accepted rows were already `verified`, so the gate refuses them as not actionable. A score was not treated as verification.

### Identity, retries, quota, provenance

Reviewed titles were not rewritten by the shadow comparison. The 50 new catalog films are legacy inserts. Identity trust for those 50 is agreement on the legacy card, not a separate review of all 50. The spot check in the AIR-66 record matches the obvious titles it opened, including `Казнь` 650030 as the 2021/2022 film. It does not clear the unmeasured `scored_only` class.

AIR-48 retry and terminal behavior held on this run: uncertain rows got `attempts` 1 and a retry, no chunk error incremented attempts, terminal no-match stayed 0. The generation pointer did not move. Latency was about 30 seconds per chunk. The legacy TMDB counter stayed inside the 16-call cap. That is a smoke budget, not a quota proof for `on` across the remaining current queue (ready now was still about 15940 after the twelve chunks).

The prediction run `47b4efd1-53b5-4875-964e-0c517bcfa809` is not part of this parity. Its `parse_error` rows do not enter the go/no-go.

## 4. Decision

**NO-GO for cutover.**

The hot slice did not disagree, and the detail gate held on the cards legacy fetched. That is enough to keep `shadow` and not enough to make the scorer the writer. The sample misses the paths where the two resolvers can split. The paths that were measured offline show short yearless titles and yearless collisions where the scorer refuses a stored id. The shared title and year misses are real, and `on` would keep them. False-match risk was not observed because `scored_only` and `different_id` were absent, not because a representative set cleared them.

[AIR-68](https://trello.com/c/qbLDc6Ql) stays blocked. [AIR-80](https://trello.com/c/hQPjVTXv) is the one code change for title and year variants. [AIR-81](https://trello.com/c/ywuOtfo0) is the next shadow comparison and the next go/no-go. This card does not implement either. A NO-GO here does not need another fixing card beyond those two: the discovery gaps named above are already their scope, and the cheap-pass difference is a measurement AIR-81 has to include, not a silent change to acceptance thresholds. The later result is NO-GO in `docs/air-81-parity.md`.

`shadow` stays. Rollback is unchanged: delete `SCORED_RESOLUTION` or set it to anything other than `shadow` or `on`. Both are `off`. No code revert is required.
