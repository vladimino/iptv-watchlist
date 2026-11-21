# AIR-549 / AIR-497: canonical Film and published Watchlist identity, metadata and Producer Workflow audit

**Captured:** 21 November 2026, approximately 09:39-10:00 Europe/Madrid. **Code:** `main` at `14d8ae8e3288b37e3ae07dc43e61379870c78624`; before this documentation commit, the next `main` commit `dc03b1e0` touched only EPG checkpoint scripts, tests and a runbook, not the source files listed below. **Runtime:** production Cloudflare D1 `iptv`, current published EPG generation 515, schema version 29, Film/Person `d1/open` generation 2, metadata cache `d1` generation 45. **Methods:** read-only `SELECT` / `PRAGMA` queries with `changed_db:false`; Cloudflare `GET` for Workflow instance list and three individual histories; GitHub source and Accepted ADR inspection. No Worker POST, app GET with hidden side effects, D1/R2 mutation, retry, Task/cron/flag/Access change, production Workflow create or repair.

**Verdict: identity links for current published Watchlist 395/395, but nine Film entities have missing canonical presentation and membership facts. There are two independent P1 blockers on the canonical Producer path. A runtime-only fix is unsafe.**

Related cards: [AIR-549](https://trello.com/c/BgwRv3uw), [AIR-559](https://trello.com/c/733sRAxu), historical [AIR-497](https://trello.com/c/xNqCjZgu) and [AIR-499](https://trello.com/c/8ifHCioP). The historical cards are Done for their accepted scope; this audit does not silently reopen or repudiate those owner decisions.

## Identity and domain model

[ADR 0009](../../adr/0009-canonical-film-person-identity.md) defines one trusted Film identity, with external ids and provenance. [ADR 0079](../../adr/0079-d1-authoritative-published-epg.md), decision 1, **deliberately** makes `published_epg_member.film_id` the published document's source identifier without an FK to `film`; EPG publication must not mint canonical Film rows or depend on verified identity. A `published_epg_document` JSON chunk stores the full published Film fields. [ADR 0099](../../adr/0099-canonical-film-person-d1-authority.md) independently makes Film/Person authoritative in D1 and changes its producer and reader boundary. The accepted but **unimplemented** [ADR 0186](../../adr/0186-letterboxd-sync-and-independent-watchlist-authority.md) proposes another independent D1 Watchlist membership/version owner, not an automatic canonical Film metadata join.

This is **one D1 database with separate authoritative domains**, not one physical Film record reused by all routes. The published snapshot is a legitimate publication/observation artifact; its repeated metadata becomes a bug when it is treated as a rival source of **current** Film title, year or canonical membership. Unknown EPG observations still require their own keys and cannot acquire Film identity by title/year.

For the user-reported film, production has one existing canonical Film, with a single trusted Letterboxd claim and one trusted TMDB claim. No second canonical Film row or conflicting trusted claimant was found. The published Watchlist snapshot and `metadata_cache` hold its localized title and year; `film_dimension.localization` has no effective reviewed/provisional title, `film_metadata.year` is null, and `watchlist_film` has no membership row. Its Started payload uses the canonical reader's fallback to `film.original_title`. The private pair of actual ids is intentionally not repeated in this published report.

## Live current-publication parity

A single pinned generation was used across the following bounded read-only aggregate queries. The current programme and Watchlist each have 395 published member rows (395 distinct ids); all 395 Watchlist ids resolve via one trusted `letterboxd` claim to a stored canonical Film after the [AIR-559 one-off claim backfill](https://trello.com/c/733sRAxu).

| Check | Source-id canonical `film:<lid>` | Existing canonical `film:tmdb:<n>` | Total |
| --- | ---: | ---: | ---: |
| Published Watchlist members | 386 | 9 | 395 |
| Trusted canonical identity found | 386 | 9 | 395 |
| Corresponding `watchlist_film` membership | 386 | **0** | **386** |
| `film_metadata` row exists | 386 | **3** | 389 |
| Effective canonical localization exists | 386 | **0** | 386 |
| Canonical year exists | 386 | **3** | 389 |
| Any canonical credits exist | 386 | 9 | 395 |
| `film_sync_state` exists | 386 | 3 | 389 |

All 395 have `metadata_cache` rows, title and year, and the current published snapshot has an authoritative 395-member listing. The 386 effective canonical localized titles equal those cached for the same lids, and all **non-null** canonical years agree with the cache. **Nine title gaps and six year gaps**, no contradictory non-null years and no separate native-lid canonical row for an item whose trusted owner is a different TMDB Film. The full canonical `watchlist_film` table contains 392 rows, of which 386 are current Watchlist members. The other six rows were not classified here; they can reflect independent retained or lagging membership and must not be deleted or inferred to be stale.

There are 12,586 Film rows in the database, but this audit **does not** claim an exhaustive entity-deduplication study across every Discovery admission. Its complete, source-pinned census is the current 395-member Watchlist and its canonical links.

The user-reported film's `metadata_cache` timestamp is 2 November, `peopleVersion=1`, `peopleNamesVersion=2`, with synopsis present; the 30-day `metadataPending()` policy (`src/metadata-cache.js:19-21`) does not request a refresh merely because a later trusted claim was written. The backfill contract ([ADR 0184](../../adr/0184-ratings-confirmed-letterboxd-claim-on-existing-film.md)) deliberately writes only the trusted claim and receipt, not the Film's title/year/membership. Hence the data can stay split without any new ingest event.

## P1-A: Producer Workflow has never completed a single production step

Full read-only Cloudflare instance-list pagination of `iptv-producer`: **113 total instances, 113 `errored`, 0 successful**, from 16 November 2026 15:01 UTC through 21 November 2026 08:00 UTC. Three individually inspected instances, including the earliest, an intermediate and the latest, all report:

```text
TypeError: The RPC receiver does not implement the method "bind".
step_count: 0
```

Production D1 has **zero** `canonical_producer_run` rows and **zero** `canonical_write_receipt` rows with `origin='epg'`. The latest `canonical_producer_chain` is `owner_state='pending'`, `takeover_count=15`, lease expired 21 November 2026 08:05 UTC, and its `run_key` is null. Repeated hourly recovery requests create and lose new instances rather than commit producer progress.

**High-confidence code cause, without a symbolic production stack trace:** `src/canonical-producer-workflow.js:237` does `step.do.bind(step)` *before* the first nonce step is scheduled. Cloudflare's Workflow RPC method does not implement the ordinary JS `.bind` invoked here. This exact error and zero executed steps match the source location and timing. `tests/canonical-producer-chain.mjs` uses ordinary JavaScript `{do:(name,fn)=>...}` objects at its integration calls; those stubs allow `.bind` and do not represent the deployed RPC method. The test coverage gap explains why offline successful cases and CI missed this deployment failure. This is not proof that every downstream unit would succeed once this initial fault is fixed.

**Do not apply a one-line `.bind` repair and automatically restart the Workflow**: P1-B below exposes an identity duplication risk on the first previously blocked real pass.

## P1-B: The sealed producer plan does not resolve published lids to their trusted canonical Film

In `src/canonical-producer-workflow.js:38-45`, `canonicalFilmId(raw)` syntactically turns an input lid `L1` into `film:L1`; `planFromSealed():93-123` uses that spelling for every observed unit and its credits. No `film_external_id` trusted-claim lookup occurs in this mapping. The nine TMDB-owned published items therefore target synthetic `film:<lid>` ids even though their trusted owner is already `film:tmdb:<n>`.

`src/canonical-epg-producer.js:32-46` faithfully passes these targets into `film_facts`. `src/canonical-producer-adapters.js:145-160` calls `prePlanFilmFacts`. The writer's `requireExisting` is **opt-in** (`src/canonical-film-writers.js:136-137`); the EPG source facts from `filmFactsOf` do not set it. `planFilmFacts` emits `INSERT INTO film ... ON CONFLICT(id) DO UPDATE` for its supplied target (`src/canonical-film-writers.js:165-166`) even if that local Film id is missing. It can therefore create a second Film entity with cached/published metadata instead of augmenting the already trusted TMDB owner. The existing Film's `tmdb` claim is not copied into the new row, so trusted-claim uniqueness alone does not prevent this **shadow Film**. Any precise existing-ID match is required before allowing the writer to create or update.

This is a **static potential future write path**, not an observed duplicate in production. There is no current `film:<lid>` twin for the nine. Identity conflict and migration protections need an explicit synthetic regression test of an existing TMDB Film and a newly linked lid before enabling a repaired producer. Test zero new Film rows, zero wrong memberships or credits, and an unchanged owner identity.

There is a second, related source/target mismatch: `src/canonical-catalog-reader.js:211-239` (`catalogTitlesFromD1`) chooses `film:<id>` for a published lid, not the trusted claim owner. By contrast `catalogMetadataFromD1():305-392` *does* query the typed `film_external_id` rows and can find the TMDB-owned Film. This means two canonical readers can resolve the same published lid differently. `catalogStartedFilm():159-189` correctly uses `catalogFilmIdentityBridge` but exposes the real TMDB Film's missing year and localization.

An existing safe resolver pattern is `resolveExistingFilmId` in `src/canonical-metadata-sync-producer.js:54-76`. It checks typed TMDB and Letterboxd claims, refuses conflicting owners and returns the actual Film id. However the `applyMetadataSync` call is in `src/worker.js:1168-1193`, conditioned on selected metadata-sync batch ids; it is **not** a general reconciliation of all published members on claim changes or every EPG commit. It is not an adequate standalone liveness guarantee for these nine.

## Consumer/ownership inventory

| Consumer | Actual current-state input/identity decision | Consequence |
| --- | --- | --- |
| `GET /api/watchlist` | Pinned `published_epg_document('watchlist')`, then `catalogTitlesFromD1` and owner-reviewed overlay (`worker.js:2559-2572`; `sources.js:518`) | The snapshot's localized fields display correctly even when the linked canonical Film has no effective localization; the dictionary lookup for a TMDB-owned lid misses its Film |
| `GET /api/programme` | Pinned published programme and Watchlist documents, dictionary and owner overlays (`worker.js:2535-2557`) | Same split between presented source metadata and canonical Film, masked by embedded snapshot values |
| `POST /api/started` | Exact trusted canonical bridge, then `film_dimension.localization` and `film_metadata.year` (`worker.js:1057-1079`; `canonical-catalog-reader.js:159-189`) | For the user-reported Film, a correct Started identity creates an English title and null year; the old R2 mirror is intentionally not used |
| `GET /api/events` | Event JSON journal in R2, `eventFilm` normalization; presentation enrichment only for `ratings` (`worker.js:999-1021`) | Correct canonical metadata written later will **not** relabel the already persisted Started event without a read-side projection or owner-approved journal repair |
| `GET /api/catalog/film/<tmdb>` and `/api/catalog/available` | Discovery catalog/admission for primary Film body and independent canonical fallback/metadata bridge and published shows (`worker.js:641-736,809-833`) | Still compose fields from distinct domains; not yet one shared canonical Film presentation model |
| `GET /api/d1/films/<id>` and person filmography | D1 canonical `film`, `film_metadata`, `film_dimension` and `watchlist_film` (`catalog-d1.js:237-267`) | A caller using published lid will not find a separately named TMDB owner by its lid spelling; canonical membership is false for the nine |
| Admin snapshot/dictionaries | Pinned published document plus bounded `catalogTitlesFromD1` / `catalogPeopleFromD1` (`src/admin/read.js`) | Localized titles for a TMDB-owned published lid may come from the snapshot rather than an authoritative canonical dimension |
| Canonical bulk read model | `src/canonical-read-model.js`, redirects and owner/dictionary/automatic precedence | **Inactive and not bundled**, so cannot be credited as the current shared API reader |
| Predictions/ratings | Independent D1 fact/projection domains and current programme/catalog inputs | Their separate data authority does not imply canonical presentation parity; this audit did not claim a full prediction/ratings parity census |

## Design decision required before implementation

Maintain the accepted distinction between **publication/observation ownership** and **canonical Film identity/metadata ownership**. A published generation may keep an immutable snapshot of what was observed for replay, audit and atomic availability reads, but it should not become a competing current Film metadata authority once a trusted identity exists.

Proposed invariants for owner discussion, **not yet an accepted ADR**:

1. For each source `lid`, exactly one trusted canonical `film.id` may own its current confirmed Film identity. Every producer and current Film reader uses one typed bridge to that id, preferably a batched lookup with completeness and conflict checks. A source key alone can never mint another canonical Film if a trusted owner exists.
2. `film` / `film_dimension` / `film_metadata` own durable current title, year, localization, credits and Film metadata under the existing source precedence and revision/receipt rules. `metadata_cache` remains input evidence, not a second public authority. Published snapshots can retain their historical `observedTitle`, `observedYear` and original ids, but the current Film view is resolved canonically.
3. The Watchlist owner (today published EPG, proposed independent Watchlist in ADR 0186) owns **membership and order**. `watchlist_film` must be explicitly classified as a derived canonical projection or retired as an independent consumer source, with a verifiable synchronization/freshness rule. Removing a Watchlist member does not delete the canonical Film or its historical shows, per ADR 0186.
4. Unknown/unverified EPG observations and current show slots remain separate from Film until identity proof. Neither title/year/slug similarity nor an EPG membership row is an identity claim. Trusted claims/owner-reviewed identity still govern merges and missing/conflicting lids.
5. Expose a source-aware, generation-fenced read model with a stable `canonicalFilmId` and a consistent title/year precedence to Programme, Watchlist, Started, Events, Film page, D1 catalog and Admin. Specify explicitly which historical Event fields are immutable and what can be decorated at read time.
6. A claim creation or new Watchlist admission must have a bounded, receipted metadata/membership hydration or a durable outstanding intent. A fresh `metadata_cache` entry cannot suppress needed hydration. Every reader should be able to distinguish `complete`, `lagging` and `unknown`, not silently mask lag with a source JSON copy.
7. Run consistency checks across the published cohort and bounded corrective operations. Any production backfill, Workflow restart/retry, flag/Task modification, D1 schema or write needs its **own explicit owner GO**.

## Safe follow-up order (recommendation only)

1. **Prevent unsafe reactivation.** Do not manually retry, reset leases or deploy a runtime-only `step.do.bind` fix. First specify a fail-closed producer identity gate and a synthetic mixed `film:<lid>` / `film:tmdb:<n>` test that refuses Film duplication. Test that an RPC-shaped `step.do` does not support ordinary `.bind`, plus a runtime-compatible contract test.
2. **Design the shared identity/metadata contract**, explicitly reconciling ADR 0009, 0079, 0099, 0120, 0141, 0184 and the accepted future ADR 0186. Require a separate ADR and maintain the architecture diagram at the project owner-visual gate.
3. **Implement and independently review** safe producer ID resolution and write targeting, then Workflow RPC compatibility, plus observable freshness/health and no-silent-restart-on-repeated-errors tests. Only reviewed, deployed, safe code may proceed to controlled production verification, with a separately approved GO for operations that write.
4. **Bounded 9-Film data repair plan**, read-only discovery first with exact claim ownership, expected canonical missing fields and provenance. Only after owner GO write through the existing canonical CAS/receipt units. No raw SQL copy, no title/year identity matching, no duplicate creation, and no unrequested user Started marks/Events changes.
5. **Consumer convergence and acceptance:** one shared metadata read model for verified Films with explicit published-history semantics, prove all 395 current Watchlist Film identities resolve to the same owner and canonical title/year/membership where applicable; verify the user-reported Started/Events presentation without mutating event history. Separately verify Discovery/catalog and retained Films, since the 395-member census is not sufficient for the whole catalog.

**Safety note:** a successful PR CI or code deployment does not prove canonical producer execution; all 113 production Workflow instances in the observed history failed. Conversely, the single-run AIR-559 claim backfill had genuine independent `apply`/readback success. These are different writers and evidence types.

This report is **read-only research**, not permission to repair the producer, change the authoritative schema, activate the future claim producer or run production work.
