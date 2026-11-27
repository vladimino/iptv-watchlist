# Catalog Enrichment Producer: Discovery scope acceptance for AIR-684, 27 Nov 2026

**What this is.** A map from the Discovery-specific acceptance of [ADR 0219](../../adr/0219-discovery-film-enrichment-and-refresh.md) (decision 3 and the planned scenarios) to the executable test that covers it, and the numbers the offline harness printed for the Discovery path. It is **not** a production measurement: a scratch sqlite database built from the real migrations, a synthetic catalog, injected fetches, no Cloudflare, TMDB or production D1 call, and no pilot. The costs are reported, never used as a quota.

| Scenario (ADR 0219) | Covered by |
| --- | --- |
| Activation and publication race: an insert before the first activation is history, after it is stream; a row staged before the activation and published after it is stream; a row published before it is history | `migration-0050-discovery-enrichment` section 3a, 3c (schema); `catalog-enrichment-discovery` A1, A5 (the actual `replaceCatalog`) |
| No-op admission, a new admission of an existing Film, a delayed canonical admission | `catalog-enrichment-drain` Discovery section (existing Film 701, delayed anchor 702 resolved on the claim event, no spin while unresolved) |
| Competing identities, TV collisions | `catalog-enrichment-discovery` A1 (a TV row with a movie id is never staged or signalled); `migration-0050-discovery-enrichment` section 3a |
| Repeated, staged and aborted events; transfer recovery | `catalog-enrichment-discovery` A2, A6 (retry settles by identity, an interrupted transfer stays inert and not runnable); `migration-0050-discovery-enrichment` sections 3d to 3g |
| Old-version writers and import or restore | `migration-0050-discovery-enrichment` sections 3e to 3g (no origin, a stale origin, a later unrelated transfer never promotes); `catalog-enrichment-discovery` A4, B2 (before the apply the code is the former code) |
| Resolver publication versus import with the actual writers, drained by the producer | `catalog-enrichment-drain` Discovery section (transfer path 740 and 741) |
| Guarded effect and acknowledgement; no self-wake | `catalog-enrichment-drain` Discovery section (a moved control generation records no member and no acknowledgement; zero pending inbox rows after the producer's own write cycle) |
| Overlap with rated; one state set, one TMDB response | `catalog-enrichment-drain` Discovery section (Film 710) |
| Disabled and re-enabled scope: records while disabled, held, caught up on re-enable; superseded admission keeps its membership | `catalog-enrichment-drain` Discovery section (Films 720 and 701) |
| Source-change proof (verified per-part version, one pure projection shared with the producer) | `catalog-enrichment-plan` (versions); `catalog-enrichment-discovery` C (unit); `catalog-enrichment-producer` Discovery section against the producer's persisted `source_version` of every part: identical complete response (no signal, no wake, no epoch change, no refetch), changed credits, a changed runtime after completed enrichment, an equal version with an incomplete part, verified absence, missing or malformed sections (a malformed supported credit entry separately from a missing section), another request language, the English overview and genre ids, a superseded slot and the other credit source never resurrected |
| The real revalidation path: durable signal, wake from an idle producer, unchanged observation wakes nothing, a failed enqueue keeps the key retryable, a lost lease applies nothing | `discovery-revalidation` (the last section, on the real chain) |
| Russian-first shared acquisition, parser and digest (ADR 0224): one request shape, a typed observation with explicit coverage (an empty date, a null or zero runtime and an explicit null poster are verified absences; a missing key, a malformed translation entry or an overview that is not a string is unreadable, never an absence), an incomplete observation repairable and never settled or versioned (a fully populated and a partially blank Film, repeated repair to quarantine then recovery, mixed fetched and unfetched sources), the live request unchanged before the schema and for a Film no scope holds, Russian then English synopsis from tagged translations, poster tiers with the stable width then path rule, the genre id table checked against `GENRE_MAP`, an unmapped id as a gap with a version, assumed-English Letterboxd basis, a synopsis-only and a poster-only observation, the appearance of a Russian value, no false refresh from the top-level overview, genre names, votes or list order, a versioned mapping revision | `catalog-enrichment-sources` (the parser and the request shape), `catalog-enrichment-plan` (selectors, digest, table), `catalog-enrichment-producer` (persisted state parity and every observation above), `catalog-enrichment-discovery`, `discovery-revalidation` (the revalidation's request shape) |
| Payload of the appended images | `catalog-enrichment-sources`: synthetic (a detail without images 540 characters, a large synthetic images section 89,617, the cap 3,000,000; an oversized body is a repairable failure, never an absence); the RECORDED sizes are in the section below |
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

## Declaration path on a scratch combined tree (dated, not part of this change)

On 27 Nov 2026 this branch was merged in a temporary worktree with the AIR-631 branch (#1039, head `bf891d2`), my migration renumbered there to 0050, and the AIR-631 producer scenario run with its provenance control at `enforce` on a scratch database (synthetic films, nothing applied anywhere, the worktree discarded). The writer accepted `metadata.declared` as built here and persisted, for a Film with both complete observations and a confirmed agreement: `synopsis` and `poster` from `tmdb:603` with `language = ru`, `language_basis = explicit`; `year`, `runtime`, `url` and `genres` from `letterboxd:abc` with no language. With TMDB unavailable, the Letterboxd synopsis was persisted as `language = en`, `language_basis = assumed` and every other field without a language. At mode `off` no field row was written and the flat values were written as before. That scenario's own assertion (every field attributed to Letterboxd) holds only for the former provider order and changes with the language rule; the reconciliation of the two branches owns it. This is evidence of the path, not a replacement for the proof on the reconciled branches.

## Recorded TMDB responses (one-time capture, 27 Nov 2026)

**Authorization.** The product owner's one-time approval, relayed in [the PR thread](https://github.com/vladimino/iptv-watchlist/pull/1038#issuecomment-7223051965): three `ru-RU` detail responses (TMDB 603, 299536 and 593) and one comparative `en-US` response of 299536, at most four requests, outside the Worker, no retry. The four requests were made once each, all answered `200`. The session's existing proxy-injected read credential was used; no header or credential was sent or stored. No production data, Worker, sync, discovery run, migration or other upstream call was involved.

**Fixtures and tests.** `tests/fixtures/tmdb-recorded/` holds the sanitized responses (the `_capture` object of each file records the request, the raw size and what was kept or dropped) and `tests/catalog-enrichment-recorded-tmdb.mjs` plus a section of `tests/catalog-enrichment-producer.mjs` run the shared parser, the digest, the observer and the producer on them.

| Recorded response | Raw bytes | Raw characters | `credits` | `translations` | `images` (of which posters) |
| --- | --- | --- | --- | --- | --- |
| 603 `ru-RU` | 145,883 | 138,111 | 61,435 | 35,463 | 57,897 (31,059) |
| 299536 `ru-RU` | 326,740 | 314,968 | 236,201 | 41,153 | 72,603 (30,946) |
| 593 `ru-RU` | 68,410 | 59,384 | 16,667 | 29,430 | 24,282 (8,770) |
| 299536 `en-US` (credits only) | 218,147 | 218,133 | | | |

The appended `images` section is 24 to 73 KB on this sample (backdrops are about half of it); the largest response (299536, 326,740 bytes, the credits alone 236 KB) is about a ninth of the existing 3,000,000 body cap. This is a sample of three films, not a bound.

**What the sample demonstrates (recorded facts, each asserted in the tests).**
- `job` and `department` strings are **not localized** under `ru-RU` (the sets of `department|job` pairs of 299536 are equal in the `ru-RU` and `en-US` responses; names are translated). The recognized director string `Director` therefore works on this sample.
- Directors: 603 has two (9339, 9340), 299536 has two (19271, 19272, **equal to the independent `en-US` reference**), 593 has one (8452). The Directing department also holds assistant, second-unit and script jobs that are correctly not directors. The crew and cast ids of 299536 are the same in both languages.
- The genre ids of all three films (28, 878, 12, 18, 9648) are in the reviewed table, and the English names TMDB returns for 299536 under `en-US` are the table's English names. The Russian genre **names** under `ru-RU` are lowercase words (`боевик`) and differ from the existing vocabulary (`Боевик`): the id table is what is used.
- The translations section has all five keys in every entry (an empty overview would be an explicit empty string), and under `ru-RU` the top-level `overview` equals the Russian translation (it is still not used as proof of a language).
- `include_image_language=ru,en,null` returned exactly Russian, English and language-neutral posters, and each film has Russian posters (21, 5 and 21).
- The producer, run on the recorded 603 response, fills the blank fields (the tagged Russian synopsis, the genres in the existing vocabulary, the widest Russian poster, the whole cast and both directors), stores a core version equal to the observer's, and an identical observation afterwards is a no-op.
- **Selection note for the owner (P2-A).** TMDB's own top-level `poster_path` of a `ru-RU` request is, on all three films, a listed Russian poster, but the stable rule (width, then path) selects a **different** Russian poster for 603 and 593 (for 593 the top-level poster is 1000 wide and the selected one 2000 wide). That is the P2-A trade-off made visible: stable artwork selection over TMDB's own popularity choice.

**What the sample does NOT show (open gaps, not claimed).**
- A film with no Russian overview, one with no poster at all, one with only language-neutral posters, and a response that omits a section: none occurs among these three films, so those cases remain covered by synthetic fixtures only.
- A mixed response with a recognized and an unrecognized director string: no such response was recorded. Because the strings are not localized on this sample, the risk is lower, but it is not excluded for other films or languages.
- A verified OTHER-language tag of a poster (for example a French poster): the request filters to `ru,en,null`, so none is returned and none was recorded. The provenance writer of AIR-631 accepts only `ru`, `en` or no language, so a verified other tag cannot be persisted today; the observation records such a poster as language unknown, never as `ru` or `en`. Preserving an other-language tag would need additive schema support in AIR-631's tables before activation (coordination, not delivered here).
- The size of films with a much larger image gallery than these three.

## Limits


- Synthetic data and a local sqlite stand-in: the figures are not D1 latencies and say nothing about EPG contention or production volume.
- Per-scope latency and oldest-due age in production come from the existing Monitor facts after an owner activation; none is measured here.
- The apply (AIR-685) and the activation (C3c-A) are separate owner operations and are not exercised against any real database.
