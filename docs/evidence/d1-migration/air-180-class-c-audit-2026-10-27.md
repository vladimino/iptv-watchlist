# Class C `film_unresolved` audit on the production snapshot

**Captured:** 2026-10-27, offline on the owner's machine, read-only  
**Input:** the [AIR-175 snapshot](air-175-r2-snapshot-identity-2026-10-26.md), re-verified first with `node scripts/r2-snapshot-export.mjs --verify` and no R2 credential in the environment: `consistent_fenced`, 7,994 objects, 581,345,885 bytes, aggregate `f71eee103b8e45a696def1805d050454bf3721e0cd688dc041c16bddcc0bdeb3`, fence ok. The class C list is the one of the [schema v3 offline import](air-177-candidate-show-identity-2026-10-27.md) (first of its three runs); no new import was run  
**Method:** each record's stored film id was looked up across every object of the snapshot (Film sources `watchlist.json`, `programme.json`, `epg/discovered-films.json`, `metadata.json`, the discovery decisions, the R2-only `started/` and `events/` user-state records, and the enrichment sidecars), and its `metadata.json` TMDB id was compared with the Film external ids the same import stored. No title or name matching was used  
**Scope:** private files only; no Cloudflare D1 (scratch or production), R2 request, Worker, Scheduled Task, flag or Access change. No acknowledged list was approved or used  
**Verdict:** **all 36 records have one cause**: films that left the Letterboxd watchlist after enrichment. None is a slug-only id, redirect gap, TMDB conflict or collision. Six records can be matched to an existing trusted Film by TMDB id; the other 30 have no Film to attach to. Three owner decisions are open (below)  
**Used by:** [AIR-180](https://trello.com/c/NrsSc6gk), [AIR-74](https://trello.com/c/5AdAmKPe), [ADR-0019](../../adr/0019-live-d1-backfill-boundaries.md) item 8

Aggregates only; titles, ids, source keys and checksums stay in the private owner packet.

## Cardinality

| Measure | Count |
| --- | --- |
| Class C records | 36: `fingerprint_payload` 14, `prediction_current` 14, `actual_rating` 7, `candidate_decision` 1 |
| Distinct stored film ids | 15, all Letterboxd short ids (no `tmdb_` id, no `film:` prefix) |
| Ids with fingerprint and prediction | 14 (the same 14 in both families) |
| Ids with an actual rating | 7: 6 of them also in the 14, 1 with the rating only |
| Ids with the discovery decision | 1, also in the 14 |
| Prediction bundles of these ids with a version object | 0 of 14 |

## Cause

| Check on the 15 ids | Result |
| --- | --- |
| In `watchlist.json` (397 films), `programme.json` or `epg/discovered-films.json` | 0 |
| In `metadata.json`, with a TMDB id | 15 |
| Last watchlist event for the id | 15 `removed` (2 were added again and removed again) |
| `started/` record present | 15 (14 with `started: true`, 1 older record with a start time only) |
| A Film redirect from the id | 0 |
| A Film holding the id as its Letterboxd id | 0 |
| A conflicting or multiply held TMDB id | 0 |
| The `metadata.json` TMDB id held by one trusted, non-conflicting Film | 3 ids (Films from EPG discovery) |

The Film lifecycle reader builds Films from the programme or watchlist list and from discovered films. A film that is enriched, started and then removed from the watchlist keeps its `metadata.json` entry and its enrichment objects in R2, but no longer has a Film. ADR-0019 item 8 forbids minting a Film id for such metadata-only records, so the importer leaves them as class C. The importer does what that decision says. What the owner has to decide is what should happen to these records.

## Groups and proposed dispositions

| Group | Records by family | Evidence | Proposed disposition (owner decides) |
| --- | --- | --- | --- |
| **G1** TMDB id held by an existing trusted Film that **has its own** fingerprint and prediction | 4: `fingerprint_payload` 2, `prediction_current` 2 (2 ids) | `metadata.json` TMDB id equals the trusted TMDB id of exactly one Film; that Film already carries fingerprint, prediction and mood-facet objects of its own | **Retire as superseded**: the existing Film's own payloads stay authoritative and these duplicates are not imported. They stay in R2 as acknowledged class C until AIR-77 removes or archives them |
| **G2** TMDB id held by an existing trusted Film, record is an owner rating | 2: `actual_rating` 2 (2 ids) | as G1; the existing Film has no actual rating, so attaching one does not collide | **Resolve by the existing trusted identity**: a strict rule (Letterboxd id → its `metadata.json` TMDB id → exactly one trusted, non-conflicting Film, otherwise unresolved). This is a new identity rule, so it needs an ADR and a code PR with tests before the records leave class C |
| **G3** no Film holds the TMDB id | 30: `fingerprint_payload` 12, `prediction_current` 12, `actual_rating` 5, `candidate_decision` 1 (12 ids) | no Film, redirect or external id points to these films; the one discovery decision is `verified` and names a Letterboxd id that is no longer a Film | **Keep in R2 as acknowledged class C** for AIR-74 (the ADR-0019 default; this records a known gap, not parity). The alternative needs its own decision: a new ADR for a "departed watchlist film" Film made from the `metadata.json` Letterboxd and TMDB ids. Retiring would drop 5 owner ratings, so it is not proposed |

Totals: 36 = G1 4 + G2 2 + G3 30. Proposed now as acknowledged class C: 34 (G1 and G3). G2 is proposed for resolution and would stay class C only if the owner declines the rule.

## Decisions needed from the owner

1. **G1:** retire the 4 duplicate fingerprint and prediction records in favour of the existing Film's own payloads, or keep them as class C.
2. **G2:** approve a strict TMDB link rule for the 2 ratings (ADR and code PR), or keep them as class C.
3. **G3:** acknowledge the 30 records as class C for AIR-74, and decide separately whether departed watchlist films should get Films before the read cutover ([AIR-77](https://trello.com/c/f3QzcNYf)).

After these answers, an acknowledged list can be built. A private draft for review sits next to the per-record packet. It is not approved, and the executor has not been run with it.

## Limits

- One snapshot, at its `finishedAt`. Live R2 has moved on since then: more films may have left the watchlist, and the class C list for the production run has to come from a fresh fenced snapshot.
- The TMDB link in G1 and G2 rests on the `metadata.json` TMDB id. That id is stored data, not re-checked against TMDB, because this audit made no network calls.
- The prediction bundles of these films have no version objects. That family is handled separately ([AIR-179](https://trello.com/c/vdLts7tJ)); this audit does not change it.
- No new import ran. The counts come from the existing schema v3 report plus read-only lookups.
