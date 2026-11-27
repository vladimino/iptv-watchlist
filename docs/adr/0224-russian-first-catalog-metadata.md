# ADR 0224: Russian-first catalog metadata with verified language precedence

**Status:** Proposed

**Recorded:** 2026-11-27.

**Owner direction:** [2026-11-27, Russian-first plan approved](https://github.com/vladimino/iptv-watchlist/pull/1038#issuecomment-7218845453). The owner explicitly approved the direction, including English fallback, language-aware provenance, shared acquisition and safe historical refresh. Final ADR disposition remains pending independent technical review.

**Amends on acceptance:** [ADR 0211](0211-catalog-enrichment-producer.md) decision 2 (only field precedence and acquisition for synopsis/poster/genres); [ADR 0214](0214-film-metadata-per-field-provenance.md) decisions 2–5, 7–9 and 11 (language in value-bound provenance, comparator, history/merge/revert and dormant compatibility); [ADR 0219](0219-discovery-film-enrichment-and-refresh.md) decisions 2, 9–11 (shared verified projection and language-quality coverage for admitted cohorts). All other decisions remain binding.

**Delivery:** [AIR-684](https://trello.com/c/G8hayTH6), [AIR-631](https://trello.com/c/i8td3wu0), [AIR-633](https://trello.com/c/z6MFlDvW). Existing historical plan [AIR-686](https://trello.com/c/ziqmHU3D), future separately authorized HR. No new producer, no activation or production authorization.

## Context

The catalog language is Russian. English Letterboxd descriptions were a temporary consequence of the available film page, not a desired catalog language. AIR-684's original fix compared English overviews and omitted the poster from the TMDB core digest because its Discovery and producer requests used different languages. That would preserve a source limitation as product policy. The accepted source precedence also puts Letterboxd first for all six core fields, which can prevent a confirmed Russian TMDB value replacing an English Letterboxd value even after provenance is enabled.

## Selected direction: Russian first, English fallback

- Synopsis: a verified nonblank Russian TMDB translation; otherwise English from TMDB or Letterboxd under the existing source precedence among equal-language, equal-confidence observations. Distinguish verified absence from unreadable or ambiguous coverage. A blank never clears a stored value. Do not infer language from script or from a provider name alone.
- Poster: select a verified Russian-language poster when present, otherwise English. If neither is available, retain an existing usable poster rather than erase it. Do not guess the language of an unlabelled image. Confirm the exact coverage and deterministic selection in the shared parser; no changes to owner-selected images.
- Genres: reuse the existing Russian vocabulary/mapping for the respective provider. TMDB genre IDs identify the categories, not localized strings. Do not invent a new taxonomy or change the existing decision not to compare unlike provider vocabularies. Verify coverage, distinguish an empty list from missing/invalid data.
- Year, runtime, URL, title localization, credits, anchors and agreement are unchanged.

## One acquisition and one projection

Discovery verified revalidation and Catalog Enrichment use the same Russian-first normalized TMDB projection and field selection. Explicitly request `language=ru-RU`, `append_to_response=credits,translations,images`, `include_image_language=ru,en` in the existing detail call; preserve Discovery's existing `alternative_titles`. See [TMDB image languages](https://developer.themoviedb.org/docs/image-languages) and [append to response](https://developer.themoviedb.org/docs/append-to-response). Confirm the real response coverage, selection parity and payload-size effect using offline fixtures; do not claim the top-level localized poster is necessarily the English fallback. Do not add a separate fetch or an observation transport.

The shared core source version covers all six selected fields, source identity and verified language where applicable, not timestamps or the entire image list. The projection used to compare is the projection used to write. No source_changed for unverified coverage; a verified identical complete version writes nothing, wakes nothing and changes no epoch. An incomplete part stays due; changed selected Russian translation or poster (including the appearance of a previously absent Russian value) reopens the relevant work. No self-wake. Keep the existing producer's own fetch and causal inbox/ack fences. If source format prevents the selected policy, return evidence before making a material compromise.

## Precedence, language provenance and safe refresh

Keep the existing confidence/identity/owner protection rules. For synopsis and poster only, compare verified language quality before provider preference at equal confirmed confidence: Russian outranks English. Within equal language quality the existing source precedence, freshness and deterministic tie-break apply. No automatic replacement of a protected field, no confidence degradation, no known-disagreement write, no unconfirmed replacement of a nonblank value. A confirmed Russian value cannot be replaced by an English fallback. Unknown language stays unknown, never fabricated; handle legacy unattributed values under the existing safe adoption/replacement rules without silently degrading Russian values. Any materially unresolved legacy-language trade-off must be raised, not hidden in a default.

Persist the selected value's verified language in the same typed per-field provenance binding, including history, merge, owner/release/revert and readback where applicable. Keep atomic value/lineage binding, control/anchor/revision/lease fences, the transport-only 72 h blank-only exception and existing off/hold behavior. In enforce, the common planner must actually consider confirmed Russian upgrades to nonblank English fields and request the eligible sources, not merely change a comparator unreachable behind a blank guard. The single canonical writer decides replacement. No new source authority and no change to credit provider precedence. All production gates remain independent.

## Delivery and acceptance

- AIR-684: shared Russian-first TMDB acquisition/parser, existing genre mapping, full digest, real observer/producer parity and missing/malformed/empty section fixtures. Include changed synopsis-only and poster-only observations, English fallback, Russian appearance, no false refresh, same-call acquisition and actual payload measurement. Dormant scope and admission gates unchanged.
- AIR-631: typed language provenance and single comparator; history/merge/revert, bound-language and off/hold/enforce fixtures, locked/unknown/confirmed values, no English downgrade. Coordinate one shared parser/contract with AIR-684; do not duplicate implementation.
- AIR-633: enforce-mode planner and actual writer path for language upgrade (including a Letterboxd-anchored Film with verified TMDB agreement), retain independent settled parts, existing guards and metrics. Test Russian replaces English, fills blank, fallback remains usable, no regression of owner pins or confidence. AIR-634 owner readback follows the same field contract.
- Historical delivery: reuse existing rated, Watchlist and Discovery/history cohorts and common durable drainer. Include eligible existing English or missing metadata, not just new admissions; distinguish language coverage from nonblank coverage and unknown language, account for overlapping cohorts and previously completed core versions. Plan a bounded automatically continuing re-arm through existing mechanisms for eligible older policy results if needed; no periodic sweep, no implicit scope widening or blanket reset. The approved historical evidence remains a dated planning snapshot; HR execution and activation require their own gates.
- No extra permanent throughput restriction, no new scheduler/storage authority, no change to production controls or eligibility cutoff. Keep the existing migration/activation sequence and verify natural acceptance using the existing cards.

## Alternatives not selected

1. English projection solely for digest parity, with TMDB poster omitted: preserves the wrong product language and misses genuine changes.
2. Compare language-dependent raw responses: causes false refreshes and can continually re-arm work.
3. A second enrichment or translation pipeline: duplicates responsibility and bypasses the existing provenance contract.

## Consequences

The extra images data increases the existing HTTP response size, not the number of round trips. Measure that cost rather than invent a quota. The existing schema change is still dormant, allowing language to be represented before activation. After enforce, quality upgrades are ordinary guarded writes with history; rollback remains hold and explicit correction under ADR 0214, not a bulk data reversal. A code deploy grants no production operation.
