# AIR-502: XMLTV categories missing on D1 observations

**Captured:** 2026-11-16, 00:17–00:40 UTC (01:17–01:40 Europe/Madrid). Code of `main` `53f6ad7d` plus this delivery. Read-only R2 GET/HEAD and offline tests. No EPG, Discovery, TMDB, D1 write, flag or Task.
**Used by:** [AIR-502](https://trello.com/c/CBurd3gC). Related to [AIR-500](https://trello.com/c/dD3BRQ2H) / [AIR-496](https://trello.com/c/4NxERbZW) / [ADR 0149](../../adr/0149-concert-recording-identity-gate.md). Not a blocker for [AIR-501](https://trello.com/c/ShipZn0N).
**Verdict:** the 0/27 593 `payload_json.categories` count is an **absent scan field on the last published generation**, not a D1 strip and not proof that the XMLTV provider omits `<category>`.

## Method

- Code path: `xmltvCategories` / `scanEPG` (`src/sources.js`), `mergeDiscoveryCandidates`, D1 `itemStatements` / `observationUpsert` (`payload={...item}` minus `shows`), `observationFromRow`, detail gate `observation.categories` (`src/discovery.js`, `src/domain/resolution-acceptance.js`).
- Read-only R2 (Object Read `R2_SNAPSHOT_*`, GET/HEAD only): `epg/published-generation.json`; immutable `epg/generations/3b7c7152-eb54-45f7-8985-92c377b57181/discovery-latest.json` streamed in full; HEAD of `epg/raw/guide.xml` and similar keys; listing pages for xml/guide/raw names.
- D1 SELECT was not repeated in this session (`D1_BACKFILL_API_TOKEN` refused). The AIR-500 counts remain the production D1 observation.
- Live `EPG_XML_URL` was not present. No raw XMLTV object exists in the production bucket.

## Pinned production objects

| Object | Result |
| --- | --- |
| Published pointer | `programmeRunId` `3b7c7152-eb54-45f7-8985-92c377b57181`, `phase` `published`, last-modified 2026-11-15 16:05:02 UTC (17:05 Europe/Madrid) |
| Generation ledger | 35 169 466 bytes, last-modified 2026-11-15 16:04:01 UTC |
| `"categories"` substring in that ledger | **0** |
| First item keys | `airings`, `confirmedTmdbId`, `description`, `duration`, `durations`, `firstAiring`, `key`, `lastAiring`, `lastSeenAt`, `lastSeenProgrammeRunId`, `normalizedTitle`, `rawTitles`, `seenInLatestSnapshot`, `shows`, `title`, `year` |
| Raw XMLTV keys (`epg/raw/guide.xml`, `epg/guide.xml`, `epg/guide.xml.gz`) | **absent** |
| AIR-496 on `main` | `654d0cb7` 2026-11-15 23:02:22 UTC (16 Nov 00:02 Europe/Madrid), **after** this scan |

AIR-500 (2026-11-16 00:32–00:44 Europe/Madrid) counted 0 of 27 593 active observations with a non-null `$.categories` array. That matches a generation sealed before `scanEPG` wrote the field.

## Code path (current main)

1. `scanEPG` reads `<category>` from each discovery programme (`xmltvCategories`, at most eight distinct non-empty strings) and sets `candidate.categories` (including `[]`).
2. `mergeDiscoveryCandidates` spreads the latest scan item, so a new generation overwrites the previous payload's categories.
3. D1 ingest stringifies the item without `shows`. Categories stay in `payload_json` when the scan put them there.
4. The detail gate uses `candidate.categories \|\| []`. A missing field and `[]` are the same missing-state. `concert_recording` needs a concert/music category and TMDB Music without Documentary or another feature genre.

`observationJson` in `src/epg-repository.js` still omits categories. That table is the staged EPG candidate store, not `discovery_observation`. The identity gate does not read it.

## Diagnosis

| Hypothesis | Result |
| --- | --- |
| D1 `json_extract` missed another key | Rejected for this generation: the R2 ledger has no `categories` key at all |
| Persistence strips the array after scan | Not on current main: ingest keeps the scan field; offline ingest of a concert programme stores `["Концерт"]` |
| Categories are ephemeral-only | They are required on the persisted observation for ADR 0149. Current code persists them; the live ledger predates that code |
| Provider never sends `<category>` | **Unproven.** No stored raw XMLTV. The 0/27 593 count cannot distinguish empty source from unstored field |
| AIR-496/AIR-501 policy | Unchanged. Empty/absent categories still verify a Music-only TMDB card |

Supplied / persisted / available-to-gate for generation `3b7c7152…`: supplied **unknown**, persisted **0** (field absent), available-to-gate **0**. After the next natural EPG scan on this code: persisted arrays (possibly empty) become the diagnostic missing-state; a non-empty concert/music category becomes available to the gate for **new** unverified observations. Already verified Music-only admissions stay verified until a separate identity correction.

## Limits

No live XMLTV sample. D1 not re-queried. No production writer. Natural EPG after deploy is the check that `categories` appears on new active observations.

## Offline tests

`tests/xmltv-categories-observation.mjs`: parser (including `lang`), scan of Концерт / Фильм / missing / empty, merge onto a previous item without the field, D1 payload round-trip, gate `concert_recording` vs missing/empty vs `Фильм`.
