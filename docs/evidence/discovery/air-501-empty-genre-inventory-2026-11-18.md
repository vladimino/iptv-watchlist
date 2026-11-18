# AIR-501: inventory of current admissions that ADR 0150 / ADR 0168 would withhold, and proposed write set

**Captured:** 2026-11-18 10:30–10:44 UTC (11:30–11:44 Europe/Madrid). Point-in-time production D1 `SELECT` through the Cloudflare D1 query API, database `iptv` (`3fba0e0a-44e9-4a3a-a7ba-edaee6bcafcb`). No Worker GET, no Access preview, no POST, no TMDB call, no R2 read, no EPG/Discovery/prediction run, no flag, Task or migration. `rows_written=0` on every statement.
**Used by:** [AIR-501](https://trello.com/c/ShipZn0N) follow-up after [ADR 0168](../../adr/0168-empty-genre-card-is-unclassified.md). **This is a proposed write set. It is not a GO and does not execute `catalog_policy_exclude@1`.**
**Method:** every current movie admission whose stored genres are empty or contain Music (267 of 10 368), classified offline with the `main` `admissionPolicy` / `filmAdmissionInput` (the same function `catalog_policy_exclude@1` uses), then read by hand against the stored title and synopsis. Stored Documentary genre: **0** current admissions (AIR-504 removed the proven ones). This is a shortlist from catalog metadata, **not** a certified population audit: a fiction film is never listed on one word, and a card whose stored synopsis is empty cannot be judged from D1.

## Classifier result on the 267

| `admissionPolicy` | Count | Meaning for `catalog_policy_exclude@1` |
| --- | --- | --- |
| `concert` | 1 | eligible |
| `ambiguous` | 3 | eligible (Music-only bare token) |
| `unclassified` (empty genres, ADR 0168) | 16 | **not eligible**: the writer acts only on `documentary`, `concert`, `ambiguous` |
| `null` (Music-only or Music+feature, no phrase) | 247 | not eligible |

Of the 16 empty-genre cards, **12 are ordinary Soviet/Russian feature films** (for example `Формула радуги`, `Ищите маму`, `Весенний призыв`, `Подвиг Одессы`, `К тёще на блины`) and must stay. Of the 247, fiction with a Music genre (for example `Bohemian Rhapsody`-type biographies, `Judy`, `Inside Llewyn Davis`, musical comedies) must stay.

## Authority at capture

Markers read in this 18 November session (the AIR-504 GO-1 capture is the separate 16 November record): Discovery `d1` / `open`, published EPG `d1` / `open`, programme run `ae4c4209-3894-41aa-8798-bb82a2d11a2b` at the 18 November previews. Each execute re-reads the live admission and fences on the current generation; nothing here replaces that.

## Proposed write set

Every film below has one current admission, **one** `verified` decision (under the 12-observation cap), no `watchlist_film` row and no `film_rated_admission` row. Counts are `basis='discovery'` shows in the published programme run; sealed (non-discovery) shows: 0 for all.

### Tier A: eligible for `catalog_policy_exclude@1` as it is on `main`

| film_id | Title (stored) | Class | Discovery shows | Why |
| --- | --- | --- | --- | --- |
| `tmdb_110445` | Пикник: 30 Световых лет (2012, Music, 139 min) | `ambiguous` | 1 | Band concert; synopsis names a grand concert |
| `tmdb_192657` | Whitesnake: Made in Japan (2013, Music, 73 min) | `ambiguous` | 2 | Synopsis: concert recorded at a festival in Saitama |
| `tmdb_23710` | Shakira: Oral Fixation Tour (2006, Music, 93 min) | `ambiguous` | 1 | Synopsis: concert tour |
| `tmdb_24970` | Pink Floyd: Pulse (1995, Music, 142 min) | `concert` | 1 | Synopsis: filmed on the Division Bell tour at Earl's Court |

### Tier B: proven policy violations by stored metadata, **not** eligible for the current writer

The classifier returns `unclassified` or `null` for these, so a preview would answer `not_policy_excluded` and nothing would be written.

| film_id | Title (stored) | Stored class | Discovery shows | Evidence in the stored card |
| --- | --- | --- | --- | --- |
| `tmdb_761960` | Пикник: Традиционный весенний концерт (2014, no genre, 108 min) | `unclassified` | 1 | Synopsis: the concert of 7 March 2014 at the Lensoviet hall |
| `tmdb_1063549` | Gaga Chromatica Ball (2024, Music, 117 min) | `null` | 1 | Synopsis: the performance before 52 000 people |
| `tmdb_785554` | BLACKPINK: The Show (2021, Music, 87 min) | `null` | 0 | Synopsis: `The Show opened with. 2020. koncert` |
| `tmdb_801575` | Кино в Севкабеле (2021, Music, 70 min) | `null` | 0 | Synopsis: the band performed at the Sevkabel port and recorded a film |
| `tmdb_534012` | Paul Rodgers - Free Spirit (2018, Music, 80 min) | `null` | 3 | Synopsis: 16-song collection filmed in London |
| `tmdb_988831` | Neil Young: Three More Decades (2021, Music, 79 min) | `null` | 2 | Synopsis: a DVD documentary on the artist |
| `tmdb_1623086` | Арктика. Очищение (2020, no genre, 55 min) | `unclassified` | 0 | Synopsis: an expedition of 18 men; non-fiction |
| `tmdb_569928` | Большой белый танец (no year, no genre, 68 min) | `unclassified` | 0 | Synopsis: a film about the great white shark; nature documentary |
| `tmdb_1603299` | Северный морской путь, или Русская дорога в океане (no year, no genre, 64 min) | `unclassified` | 0 | Synopsis: how the national transport artery is built; non-fiction |

### Tier C: needs external verification before any write

| film_id | Title (stored) | Discovery shows | Why it is held |
| --- | --- | --- | --- |
| `tmdb_450202` | Britney Spears: Apple Music Festival (2016, Music, 88 min) | 1 | Stored synopsis is empty; the title is a festival set |
| `tmdb_1126350` | DJ BoBo - EVOLUT30N (2023, Music, 134 min) | 1 | Stored synopsis is empty |
| `tmdb_1603159` | TesseracT: RADAR (2025, Music, 90 min) | 4 | Synopsis is the title only |

Total proposed: 4 (A) + 9 (B) + 3 (C) = **16** current admissions; 10 of them were in the pending queue on the 18 November read, per the RCA on the card. Not re-read here: current queue membership (D1 `prediction_queue` chunks) and prediction pointers, which each execute reconciles.

## What can and cannot run

- **Tier A** can go through `catalog_policy_exclude@1` after an owner `GO` and an Access session, one film per request, exactly as in the [AIR-504 GO-1 contract](air-504-write-set-2026-11-16.md): preview (GET) must answer `available`, policy `concert` or `ambiguous`; then one POST per film with a fresh `idempotencyKey`. Stop that id on `not_eligible`, `budget_exceeded`, `linked_admission`, `unknown_authority` or `queue_unreconciled`.
- **Tier B** has no existing mechanism. Needs an owner decision: (a) extend `admissionPolicy` for the writer only (a code PR and an ADR, because the same function feeds the detail gate and `GET /api/programme`), or (b) a bounded owner-approved id list on the writer. A manual D1 `UPDATE` is not an option.
- **Tier C** needs a source outside D1 (the TMDB page or the owner's judgement) before it enters either path.

No ratings, fingerprints, immutable predictions or Film/Person R2 objects are deleted by any of this (ADR 0153).

## Not proven

- That the 247 Music-only and 16 empty-genre cards are the whole population: Documentary-by-title cards with a feature genre or another type of card are outside this query.
- Preview eligibility for Tier A (no Access GET was made).
- Queue membership and fingerprints at capture time for the 16 ids.
