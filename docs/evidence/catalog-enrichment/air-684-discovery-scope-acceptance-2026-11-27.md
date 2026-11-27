# Catalog Enrichment Producer: Discovery scope acceptance for AIR-684, 27 Nov 2026

**What this is.** A map from the Discovery-specific acceptance of [ADR 0219](../../adr/0219-discovery-film-enrichment-and-refresh.md) (decision 3 and the planned scenarios) to the executable test that covers it, and the numbers the offline harness printed for the Discovery path. It is **not** a production measurement: a scratch sqlite database built from the real migrations, a synthetic catalog, injected fetches, no Cloudflare, TMDB or production D1 call, and no pilot. The costs are reported, never used as a quota.

| Scenario (ADR 0219) | Covered by |
| --- | --- |
| Activation and publication race: an insert before the first activation is history, after it is stream; a row staged before the activation and published after it is stream; a row published before it is history | `migration-0049-discovery-enrichment` section 3a, 3c (schema); `catalog-enrichment-discovery` A1, A5 (the actual `replaceCatalog`) |
| No-op admission, a new admission of an existing Film, a delayed canonical admission | `catalog-enrichment-drain` Discovery section (existing Film 701, delayed anchor 702 resolved on the claim event, no spin while unresolved) |
| Competing identities, TV collisions | `catalog-enrichment-discovery` A1 (a TV row with a movie id is never staged or signalled); `migration-0049-discovery-enrichment` section 3a |
| Repeated, staged and aborted events; transfer recovery | `catalog-enrichment-discovery` A2, A6 (retry settles by identity, an interrupted transfer stays inert and not runnable); `migration-0049-discovery-enrichment` sections 3d to 3g |
| Old-version writers and import or restore | `migration-0049-discovery-enrichment` sections 3e to 3g (no origin, a stale origin, a later unrelated transfer never promotes); `catalog-enrichment-discovery` A4, B2 (before the apply the code is the former code) |
| Resolver publication versus import with the actual writers, drained by the producer | `catalog-enrichment-drain` Discovery section (transfer path 740 and 741) |
| Guarded effect and acknowledgement; no self-wake | `catalog-enrichment-drain` Discovery section (a moved control generation records no member and no acknowledgement; zero pending inbox rows after the producer's own write cycle) |
| Overlap with rated; one state set, one TMDB response | `catalog-enrichment-drain` Discovery section (Film 710) |
| Disabled and re-enabled scope: records while disabled, held, caught up on re-enable; superseded admission keeps its membership | `catalog-enrichment-drain` Discovery section (Films 720 and 701) |
| Source-change proof (verified per-part version, one pure projection shared with the producer) | `catalog-enrichment-plan` (versions); `catalog-enrichment-discovery` C (unit); `catalog-enrichment-producer` Discovery section against the producer's persisted `source_version` of every part: identical complete response (no signal, no wake, no epoch change, no refetch), changed credits, a changed runtime after completed enrichment, an equal version with an incomplete part, verified absence, missing or malformed sections (a malformed supported credit entry separately from a missing section), another request language, the English overview and genre ids, a superseded slot and the other credit source never resurrected |
| The real revalidation path: durable signal, wake from an idle producer, unchanged observation wakes nothing, a failed enqueue keeps the key retryable, a lost lease applies nothing | `discovery-revalidation` (the last section, on the real chain) |
| Russian-first shared acquisition, parser and digest (ADR 0224): one request shape, a typed observation with explicit coverage (an empty date, a null or zero runtime and an explicit null poster are verified absences; a missing key, a malformed translation entry or an overview that is not a string is unreadable, never an absence), an incomplete observation repairable and never settled or versioned (a fully populated and a partially blank Film, repeated repair to quarantine then recovery, mixed fetched and unfetched sources), the live request unchanged before the schema and for a Film no scope holds, Russian then English synopsis from tagged translations, poster tiers with the stable width then path rule, the genre id table checked against `GENRE_MAP`, an unmapped id as a gap with a version, assumed-English Letterboxd basis, a synopsis-only and a poster-only observation, the appearance of a Russian value, no false refresh from the top-level overview, genre names, votes or list order, a versioned mapping revision | `catalog-enrichment-sources` (the parser and the request shape), `catalog-enrichment-plan` (selectors, digest, table), `catalog-enrichment-producer` (persisted state parity and every observation above), `catalog-enrichment-discovery`, `discovery-revalidation` (the revalidation's request shape) |
| Payload of the appended images | `catalog-enrichment-sources`: synthetic, characters: a detail without images 540, a large realistic images section (300 backdrops, 60 logos, 215 posters) 89,617, the existing body cap 3,000,000; an oversized body is a repairable failure, never an absence. Not a measurement of real TMDB responses |
| Credits without a storage cap, typed Russian title | `catalog-enrichment-drain` Discovery section (75 actors and a director: 76 credits in two chunks, Russian title of the producer's own TMDB response) |
| Mixed live and background progress, bounded examined work, no artificial quota | `catalog-enrichment-drain` (priority end to end, with the discovery scope rows; unchanged by this change) |
| Dormancy | the migration creates no scope row; nothing is emitted before an owner activation; the code is the former code before the apply (`catalog-enrichment-discovery` B2) |

## Measured on the Discovery path (offline, synthetic, one run of the harness)

One existing Film with 75 actors and a director (two credit chunks), one unresolved admission in the same run:

| Measure | Value |
| --- | --- |
| Signals consumed in the first run | 2 (one resolved, one left pending: unresolved) |
| Films enriched in the first run | 1 |
| D1 statements in that run | 3134 (almost all the 75 Person units and the credit chunks) |
| Receipted units in that run | 80 |
| TMDB requests for the Film | 1 (core, credits and translations share one response) |
| Wall time of that run on the scratch database | about 0.7 s |
| Members after the whole scenario | `discovery` 6, `rated` 1 |
| TMDB requests for the Film that is also rated | 1 |
| Delayed anchor after the claim event | 1 request, resolved in the next run |

## Limits

- **Recorded `ru-RU` credits fixture: not delivered.** A recorded response needs a permitted capture and no production TMDB probe is authorized. The director detection uses an explicit, tested set of job strings and reports a crew list without a recognized director as the gap `directors_not_recognized`; whether TMDB localizes `job` under `language=ru-RU` is unproven and stays an open acceptance condition until a captured fixture exists.
- **What a permitted capture needs (not done).** One read-only `GET https://api.themoviedb.org/3/movie/<id>?language=ru-RU&append_to_response=credits,translations,images&include_image_language=ru,en,null` per film, with the TMDB read access token that the Worker already uses (`TMDB_API_READ_ACCESS_TOKEN`), for a small set of film ids chosen by the owner (for example a very popular film with a large images list, a film with several directors and mixed crew roles, a Russian-origin film, a film with no Russian overview and one with no poster), run once outside the Worker and saved as JSON fixtures with the ids. No per-film extra query, no change to the Worker, no production data touched. The same capture settles three open points: which `job` strings arrive under `ru-RU`, the genre id table, and the real response size. It stays owner-gated.
- **Genre table.** The id table is the documented TMDB list mapped to the existing words; it has not been verified against a recorded provider response.

- Synthetic data and a local sqlite stand-in: the figures are not D1 latencies and say nothing about EPG contention or production volume.
- Per-scope latency and oldest-due age in production come from the existing Monitor facts after an owner activation; none is measured here.
- The apply (AIR-685) and the activation (C3c-A) are separate owner operations and are not exercised against any real database.
