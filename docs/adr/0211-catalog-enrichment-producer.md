# ADR 0211: Admitted Films are enriched by a canonical catalog-enrichment producer from Letterboxd, TMDB and Wikidata, independent of EPG airing

**Status:** Accepted  
**Original decision date:** 2026-11-24 ([consolidated owner choices](https://github.com/vladimino/iptv-watchlist/pull/975#issuecomment-7140090124), [0211-7 = B](https://github.com/vladimino/iptv-watchlist/pull/975#issuecomment-7141202861), then the [final disposition](https://github.com/vladimino/iptv-watchlist/pull/975#issuecomment-7141800326))  
**Recorded at:** 2026-11-24. Revised the same day after the [design review of the package](https://github.com/vladimino/iptv-watchlist/pull/975#pullrequestreview-6039232220), its [re-review](https://github.com/vladimino/iptv-watchlist/pull/975#pullrequestreview-6040005516), the [second re-review](https://github.com/vladimino/iptv-watchlist/pull/975#pullrequestreview-6040703398) and the [consolidated owner choices](https://github.com/vladimino/iptv-watchlist/pull/975#issuecomment-7140090124).  
**Approval source:** [Product Owner final disposition of 24 Nov 2026](https://github.com/vladimino/iptv-watchlist/pull/975#issuecomment-7141800326). The owner wrote «принимаю!», accepting this record as reviewed at `d1a5c2bf` in the [final technical review](https://github.com/vladimino/iptv-watchlist/pull/975#pullrequestreview-6045607308). The selections are 1 = A (PF planned), 2 = extended B, 3 = A, 4 = A, 5 = C, 6 = extended A and 7 = B (transport-only fallback). Requested originally by disposition 6C on [PR #975](https://github.com/vladimino/iptv-watchlist/pull/975#issuecomment-7131137347). This is an architecture acceptance only. It grants no implementation, migration, activation, mode change or production GO.  
**Related work:**
- [AIR-555](https://trello.com/c/JPgjoBzK), under [AIR-275](https://trello.com/c/4x7hH0gI).
- [ADR 0207](0207-letterboxd-admissions-coordinated-in-d1-only.md) retires the R2 rated enrichment and holds the delivery graph (decision 7).
- [ADR 0213](0213-film-identity-evidence-ledger.md), a sibling record.

**Supersedes:** In part [ADR 0087](0087-rated-archive-film-admission.md) decision 4: metadata written onto the R2 admission entry.  
**Superseded by:** In part by [ADR 0214](0214-film-metadata-per-field-provenance.md) (Accepted 2026-11-25), only while its provenance mode is `enforce`: decision 1 (fill-only), the decision 2 rule that a later answer of an earlier source never overwrites, and the decision 3b rule that values under a superseded anchor are never overwritten.

**Amended by ADR 0224:** Amended in part by [ADR 0224](0224-russian-first-catalog-metadata.md) (Accepted 2026-11-27, decision 2 only: language-aware field precedence and acquisition for synopsis, poster and genres; [owner disposition](https://github.com/vladimino/iptv-watchlist/pull/1045#issuecomment-7221071584)); original status and approval retained. All other clauses remain binding.

## Context

### What exists (main `c5ecc1bd`, 24 Nov 2026)

**`writeFilmFacts` (`src/canonical-film-writers.js`)** is the only writer of `film_metadata`. That table has the columns `year`, `runtime`, `synopsis`, `poster`, `url`, `genres_json`, `people_version`, `payload_json`, `r2_key`, `content_sha256` and `updated_at` (`migrations/0001`). The original title lives on `film`, and localization lives in `film_dimension` and the `*_localization_source` tables.
- Every input section except the `film` row is optional. A metadata-only caller (`metadata_sync`) passes `requireExisting: true`, the stored `contractVersion` and `metadata`.
- **`film_metadata` has no per-field source and no owner or reviewed guard.** A non-blank incoming value overwrites the stored one, whatever wrote it. Only blank-never-overwrites protects it.
- At commit time it asserts the marker generation, the Film revision, no redirect, existence (with `requireExisting`), up to 12 caller guards, and the producer fence when one is bound.

**Identity claims.**
- `film_external_id(film_id, scheme, value, trusted, conflicting, provenance_json)` holds the claims. A unique index allows one trusted owner per `(scheme, value)`.
- The schemes include `tmdb`, `tmdb_tv`, `letterboxd` (the lid) and `letterboxd_slug`. A `letterboxd_slug` row is always untrusted.
- The verified short code of an admission is the alias `film_alias kind='letterboxd_short_code'` (`film-admission.js:103`).
- **A canonical Film can hold a trusted Letterboxd claim and no TMDB claim.** The legacy Watchlist Films `film:<lid>` do, and their identity stays `unresolved` (`domain/film-person.js:89,132`).
- **Every writer that creates a Film today needs a TMDB id:**
  - Discovery admission refuses without one (`canonical-discovery-admission-producer.js:25-29`);
  - `admitRatedFilm` keys on it, and `film_rated_admission.tmdb` is `NOT NULL` (migration 0021).

  New admissions therefore always carry a TMDB claim.
- A retired movie id stays as an untrusted `tmdb` row, decided in the owner ledger `tmdb_retirement_decision`.

**Persons** are identified per role and per source:
- TMDB: `tmdb_actor/<id>` and `tmdb_director/<id>`, which are stable.
- Letterboxd: `actor/<slug>` and `director/<slug>`. The slug comes from the ld+json `sameAs`/`url`, and falls back to the display name when the link is missing (`sources.js:344`), which makes a name-only id.
- People are never merged by name alone. `name_only` and `same_name` are review candidates only (`domain/canonical-person.js:1-13`).
- Credits are add-only (`film_credits`), at most 50 per unit. Nothing is removed or reordered.

**What each source can supply.**

| Source | What it supplies | Code | Keyed by |
| --- | --- | --- | --- |
| Letterboxd film page (`parseFilm`, `sources.js:340-348`; `pageEvidence`, `letterboxd-identity.js:89-107`) | name and original name, year, runtime, genres (mapped to Russian), poster, synopsis, all directors, up to 10 actors with person slugs, alternative titles, the short code, the canonical path and every `data-tmdb-id` | — | the page itself |
| TMDB `movie/<id>` | year, runtime, genres, poster, overview, credits with stable person ids, translations | — | the TMDB id |
| Wikidata SPARQL | Russian film titles | `sources.js:614-620` | P4947, the TMDB id |
| Wikidata SPARQL | person names | — | Letterboxd person slugs (P6119/P12383) |

**Localization.** The target language is Russian.
- Precedence is owner, then the reviewed dictionary, then automatic sources in the order `letterboxd`, `tmdb`, `wikidata`, `epg`, `discovery` (`localization-sources.js:1-16`).
- An absent value has **no source row**, because `value` is `NOT NULL` (migration 0014). The dimension status says `missing`.

**Metadata coverage.**
- The two receipted metadata producers see only EPG-listed Watchlist Films: `metadata_sync`, in the EPG metadata stage, and the `epg` `film_facts` units.
- With the Watchlist marker at `d1`, a pinned EPG run fetches no metadata (`src/worker.js:1315`).
- **714 of 714 admitted Films have no `film_metadata` row** (L0 read, 24 Nov 2026 12:21 UTC).

**Upstream callers.** They share credentials and rate-limit scopes but no coordination.

| Upstream | Shared scope | Callers today | Rate-limit handling today |
| --- | --- | --- | --- |
| TMDB | one bearer, `TMDB_API_READ_ACCESS_TOKEN` | Discovery Workflow chunks; the catalog poster route and its weekly cron; `movieDetail` in the Diary check, the Watchlist admission and the archive identity step; the status probe route | Discovery spaces requests 200 ms apart and stores a Retry-After `retryAt` (clamped to 30-3,600 s) that only Discovery reads. The poster path stops its batch on a 429 and does not read Discovery's `retryAt`. `movieDetail` ignores Retry-After. |
| Letterboxd | Worker egress, no credential | the Watchlist scan; the Diary page; `boxd.it` and film-page checks (Diary, Watchlist admission, archive step); the removal-phase rating refresh; metadata-sync film pages | The Diary, Watchlist and removal paths each keep their own state: per-id `nextAttemptAt`, the ledger's `next_retry_at`, and a 6 h `pausedUntil` for removals. The slot `cooldown_until` is set only on a Workflow failure. Metadata sync keeps fetching after a 429. A Diary 429 does not stop the Watchlist scan in the same slot, by design (`letterboxd-sync.js:664-667`). |
| Wikidata | no credential | metadata sync; EPG localization; the archive enrich step | No backoff anywhere. EPG localization continues to the next batch after a 429. |

Two other upstreams each have a single caller and their own durable pause:
- the EPG XMLTV source: the EPG Workflow and an owner route, with a fixed 6 h pause on 429;
- Telegram and the webhooks of the Monitor, with `holdUntil` from `retry_after`.

**Transport failures consume finite budgets in several places:**
- Diary identity attempts;
- the removal queue's three attempts;
- the poster cron's `retryAttempts`;
- the orchestration quarantine caps.

**Admin surface.**
- The admin pages are static assets served for GET and HEAD. There is **no `/admin/settings`** page.
- The admin write routes check:
  - that the `Cf-Access-Jwt-Assertion` header is present;
  - that the `Origin` is the Worker's own;
  - an action header and a JSON content type.

  They do **not** verify the JWT signature or the owner identity in the Worker; Access at the edge is the authentication.
- Only `/mcp` verifies the JWT in the Worker (`mcp.js:97-121`).
- The closest existing toggle pattern is the channel policy import: revisioned, with an explicit readback, answering 503 `readback_failed` with `outcome: unknown` (`admin/channels.js:120-178`).

**Scheduling.**
- The hourly cron runs `reconcileDiscoveryWorkflow`, then `Promise.allSettled` over the EPG ensure, Monitor and prediction ordering. It has no per-step deadline, and the Worker CPU limit is 120,000 ms.
- `projection_run` is a per-name lease store.
- Producer outcomes are drained to the Events Log.

## Decision

### 1. A metadata-only writer contract, fill-only (0211-1 = A)

The producer calls `writeFilmFacts` with **only** `metadata`, `sync` and `localization.sources`, plus the add-only person and credit units of decision 3. It does **not** pass `dimensions.metadata`, whose `provenance_json` other metadata writers replace (`canonical-film-writers.js:175-177`). It always passes:
- `requireExisting: true`;
- the stored `contractVersion`;
- the `expectedRevision` of its own snapshot, so a stale plan fails on the revision and is replanned, never forced.

**It never creates, merges or redirects a Film, and never writes or changes a claim, an alias or `canonical_identity`.** If no canonical Film exists, an observation stays in its own domain (the Watchlist snapshot and ledger, the Ratings records, the archive documents, Discovery).

**Fill-only.** A field is written only when its stored value is blank. That is re-asserted in the batch with one guard per written field. It never overwrites a value that an EPG producer, an owner edit or an earlier run wrote.

**Per-field provenance is planned, not deferred indefinitely.** Card PF (ADR 0207 decision 7) plans owner choice 1 = B as its own follow-up record. It would add per-field source and observed time, an owner lock per field, and a safe refresh and overwrite rule, so that a newer automatic value may replace an older automatic one and never an owner value. Until PF is decided and delivered, this producer stays fill-only.

### 2. Sources, identity anchors and precedence (0211-2 = extended B)

**Each source may write a Film only through its own identity anchor** on that Film. There is no global TMDB guard.

| Source | Anchor (each asserted in the write batch, by its exact value) | Not an anchor |
| --- | --- | --- |
| `letterboxd` | **Reliable ownership of a Letterboxd entity by this Film:** a trusted, non-conflicting `film_external_id(scheme='letterboxd', value=<lid>)` row, with no other owner of that lid. In this code base the lid **is** the `boxd.it` short code: the Diary check requires `shortCode === lid` (`letterboxd-diary-identity.js:30`). | the same code held only as the admission alias `film_alias kind='letterboxd_short_code'` (written for inferred admissions too); a `letterboxd_slug` row; a known URL alone; an inferred pair (`restricts`, method `title_year_search`) |
| `tmdb` | a trusted, non-conflicting `film_external_id(scheme='tmdb')` row, no other trusted owner of that id, and the id not retired | an untrusted or conflicting row; a retired id |
| `wikidata` | the `tmdb` anchor; the Wikidata item must name exactly that TMDB id (P4947) | anything without a TMDB anchor in this record. A lookup by Letterboxd film id is a possible later extension, not designed here |

**Letterboxd needs no TMDB claim.** A Film with a reliable Letterboxd anchor is eligible for Letterboxd metadata whether or not it holds a TMDB claim. The producer neither requires nor manufactures a TMDB match.

**Reliable ownership is distinct from an inferred cross-provider relation.**
- The Letterboxd anchor says that this Film owns this Letterboxd entity. It exists before the fetch, as a trusted lid claim. Such claims come from:
  - the ADR 0184 claim unit (`canonical-letterboxd-claim.js`), which writes one only from a current, unambiguous Ratings link that is **not** an inferred title-and-year link. The Diary and Watchlist checks request that claim after a verified page check (`ensureLetterboxdClaims`);
  - the own lid of a legacy Watchlist Film `film:<lid>`.
- An **inferred** `same_work` never creates an anchor. Nor does the admission alias, because the inferred import writes it too.
- A page fetched by the producer can only **confirm** an existing anchor. It never creates one.
- **The anchor is a canonical claim, not an evidence row.** This producer never reads the ADR 0213 ledger to decide anything, consistent with that record's choice 5.

**The page agreement contract.** The rules are those of the Diary check (`verifyPage`), applied to the anchor:
1. Request `boxd.it/<lid>`, and follow at most one redirect to a `letterboxd.com/film/<slug>/` page.
2. If the page has a shortlink, its code equals the anchor lid. Otherwise the redirect from `boxd.it/<lid>` is the link.
3. The canonical path equals the landing path, and the page parses as a film.
4. **Only when the Film holds a TMDB anchor:** the page has exactly one `data-tmdb-id`, of type `movie`, and it equals that anchor.

For a Letterboxd-only Film, a TMDB id on the page is recorded as an identity hint, never as a claim.

**Intentional limitations of the contract:**
- The slug comes from the landing page and is not checked against a trusted slug; no trusted slug scheme exists.
- The title and year are not identity tests here. They are metadata, compared only as conflicts and hints.

**Outcomes of the contract:**
- **Agreement** is recorded on the Film's state as `agreed_anchor_digest`, the digest of the exact anchors it confirmed.
- **Disagreement** is any rule failing on a 200 page. The producer records `identity_disagreement` visibly and writes nothing more from **any** source for that Film, until an anchor changes or the owner retries (decision 3b).
- The producer never resolves identity, and never applies metadata across an unverified or contradicted mapping.

**Which checks finish before which writes.**
- `core` and `credits` writes from any source need a recorded agreement for the Film's **current** anchors whenever the Film holds a Letterboxd anchor. A **known disagreement always blocks**.
- **Unresolved agreement work stays open, whatever the fields.** While the Film holds a Letterboxd anchor and no agreement is recorded for its current anchors, the Letterboxd agreement check stays due. That holds even when every field is already filled, and even after a fallback filled the last blank field, until the agreement is confirmed, a disagreement is found, or the owner resolves it.
- **The only exception is the transport-only fallback below (owner choice [0211-7 = B](https://github.com/vladimino/iptv-watchlist/pull/975#issuecomment-7141202861), 2026-11-24).** Without a confirmed agreement, a field may be filled only by that fallback, and it is then listed as `unconfirmed_agreement`.
  - A Letterboxd source that is `failed` (`needs_attention`) grants **no** exception. Neither does a 404 or an invalid or non-film page. `core` and `credits` then wait, visibly, until the owner resolves the Film (retry or an identity correction).
- A source's own localization row needs only that source's anchor, because one source's row never replaces another's.
- Wikidata needs only the TMDB anchor.

**Applicable sources.** For each Film the producer derives the set of sources whose anchors hold. A source without an anchor is `not_applicable`. That is not a failure, and nothing is fetched from it.

**Precedence for a blank field.** The order is fixed:

| Field | Order | Note |
| --- | --- | --- |
| year, runtime, synopsis, poster, url, genres | `letterboxd`, `tmdb` | url: the canonical page of the winning source. Genres are not compared across sources, because the vocabularies differ |
| Russian title (localization source rows) | each applicable source writes **its own** `film_localization_source` row (`letterboxd`, `tmdb`, `wikidata`) | the existing resolver order (`letterboxd`, `tmdb`, `wikidata`) chooses, with owner and reviewed values on top; no waiting |
| credits | the credit source of the credits rule below | — |

**Per field, each applicable source is in one of five states:**
- `value`: it answered with a value;
- `absent`: it answered completely without one;
- `pending`: due, upstream transport, cooldown, or stopped by this tick's own deadline;
- `failed`: definite failures, up to `needs_attention`;
- `not_applicable`.

**The rule.** A blank field is written from source S only if S has `value` and every source before S in the order is `absent` or `not_applicable`.
- `absent` means a confirmed absence in a successful, valid response, so the normal precedence applies at once.
- A `failed` earlier source makes the field wait for the owner.
- If an earlier source is `pending`, the field **waits**, and S's state stays `due` with reason `waiting_for_precedence` and the earlier source's `retry_at`.
- Nothing is stored as a candidate. When the field becomes decidable, S is fetched again. There are no proof snapshots, and fill-only is unchanged.
- **Both completion orders give the same writes.** Letterboxd first: Letterboxd fills. TMDB first: TMDB waits, Letterboxd later fills, and TMDB is refetched only for the fields Letterboxd lacked.

**Transport-only fallback (owner choice [0211-7 = B](https://github.com/vladimino/iptv-watchlist/pull/975#issuecomment-7141202861)).** If the earlier source has been **unavailable through upstream transport for 72 h continuously** for that Film, it counts as unavailable for the waiting fields. The next source then fills them, but only through its own reliable anchor.
- **What counts toward the 72 h.** Only upstream transport outcomes count: a 403, a challenge, a 429, a 5xx, a timeout of a request that was sent, a network error, or an active shared cooldown.
  - `pending_since` is set by the first such outcome and cleared by any successful, valid response from that source for the Film.
  - **This tick's own deadline or unit budget never counts.** A source stopped or never reached because of scheduling leaves `pending_since` unchanged, so a scheduling shortage cannot masquerade as 72 h of upstream unavailability.
  - A definite failure (a 404, an invalid or non-film page, a parse failure) clears `pending_since` and never leads to the fallback.
- **A known identity disagreement always blocks**, before or after the 72 h.
- Each such field is listed as `fallback_fill`, with the source that filled it and the source that was waited for. If the Film's agreement was not yet confirmed, the field is also listed as `unconfirmed_agreement`.
- A later answer from the earlier source never overwrites it, because the producer is fill-only. A different value is recorded as `stored_differs`. If a later disagreement is found, every `unconfirmed_agreement` field is listed for owner review.
- Card PF decides any later replacement.

**Deadline between sources.** A Film's writes start only after every applicable source of its due parts has answered or stopped in this tick. A source stopped by the deadline is `pending` (transport class, no failure), so the tick writes only the fields that are already decidable.

**Source set versus anchor value.**
- A **source-set change** means a source becomes applicable or stops being applicable, because an anchor appears or disappears.
  - When the set grows, the new source's gaps reopen: unfilled `core` fields and its own localization row.
  - When it shrinks, that source stops at once, because its anchor guard fails at commit. Its earlier writes remain.
- An **anchor value change** means the same source keeps an anchor but with another value: TMDB A → B, or lid L → L′. That is an identity correction, handled by decision 3b.

**Conflicts are visible, not silently resolved.** For each field the producer compares the values of the sources that answered, and the stored value, with a fixed equality rule:
- year: exact;
- runtime: within 5 minutes;
- poster, url and genres: not compared.

It then records:
- `value_conflict` (field, values per source) when two sources disagree. Precedence still decides, but the conflict stays listed;
- `stored_differs` when a source disagrees with a non-blank stored value. Fill-only never overwrites it.

Both are listed in the state and reported (decision 5). Neither ever changes a claim.

**Metadata informs identity work but never proves it.** A year conflict, a page naming another TMDB id, or a runtime far apart is recorded as an **identity hint** on the Film's state. A later identity reader (ADR 0213 decision 8) may read hints. A hint is never proof, never evidence of `same_work`, and never modifies a claim.

**The credits rule: one namespace per Film, including what other producers wrote.** People are identified per source (`actor/<slug>` or `tmdb_actor/<id>`), so the producer must not add a second namespace to a Film.
- **The Film already has credits in one namespace** (for example, Letterboxd credits from the EPG chain). The credit source is that namespace's source, if it is applicable, and only missing credits are added. If that source is not applicable, no credits are written.
- **The Film has credits in both namespaces.** No credits are written, and the part records `credits_other_namespace` (`complete_with_gaps`) for owner review.
- **The Film has no credits.** The source is `letterboxd` if anchored, otherwise `tmdb`.
- The credit source is fixed when `credits` is first planned and is never reopened for another source. The one exception is an identity correction (decision 3b), which holds `credits` for the owner.
- No person is merged on name, and no credit is deleted.

**Persons.**
- **Letterboxd credits** are written only for credits with a real person slug, as `actor/<slug>` and `director/<slug>`. A credit whose id would fall back to the display name is **not written**; it is a gap (`name_only_credit`).
- **TMDB credits** use TMDB person ids.
- The producer never merges a Letterboxd person with a TMDB person, or with any person on name alone. Grouping stays with the existing non-destructive person rules.
- Person-name localization is not part of this record.

### 3. Parts, per-source state, partial success and receipts (0211-3 = A)

Enrichment has three independent **parts**:
- `core`: year, runtime, synopsis, poster, url and genres;
- `credits`;
- `localization`.

**State lives in its own minimal store**, an additive table `catalog_enrichment_state`, with primary key `(film_id, part, source)`. No other writer touches it. It has these columns:
- `film_id`, `part`, `source`;
- `status`: `due`, `complete`, `complete_with_gaps`, `not_applicable`, `needs_attention` or `identity_disagreement`;
- `reason`;
- `anchor`: the exact scheme and value it was planned with;
- `source_version`, `refresh_epoch`;
- `failures`, `transport_streak`, `pending_since`, `retry_at`, `due_since`;
- `expected_json`, `gaps_json`, `conflicts_json`, `hints_json`;
- `updated_at`.

**The Film row.** A row with `part = 'film'` and `source = '*'` holds the Film-level state.
- Its `status` is `active` or `identity_disagreement`, and it has its own `plan_epoch`, raised by every anchor change, retry and resume.
- One more column, `film_json`, holds:
  - the applicable source set;
  - `anchor_digest`, `agreed_anchor_digest` and `anchor_checked_at`;
  - the disagreement;
  - the lists `fallback_fill`, `unconfirmed_agreement` and `written_under_superseded_anchor`.
- No guard reads `film_json`. Commit guards check the exact anchors in canonical tables.

**Completion comes from canonical state plus the state rows.**
- **`core` is complete** when every field is non-blank, or when every applicable source is settled (`absent` or `not_applicable` for the missing fields): `complete_with_gaps` lists the fields that no applicable source had. A `failed` source leaves `core` waiting, visibly, for the owner.
- **`credits` is complete** when every credit of the **expected set** exists. The expected set comes from the credit source's complete response:
  - at most **10 actors** and at most **20 directors**, in source order;
  - so at most 30 credits, within the unit cap of 50.

  It is stored in `expected_json` when the part is planned. A Film with more than 20 directors records the gap `directors_truncated`. One bound applies everywhere in this record.
- **`localization` is complete per applicable source.** Each applicable source (`letterboxd`, `tmdb`, `wikidata`) has its own state row:
  - `complete`: its `film_localization_source` row exists;
  - `complete_with_gaps`: the source answered completely and has no Russian title. This is a legitimate absence, and it is recorded here because a source row cannot hold an empty value;
  - `not_applicable`: no anchor.

  A source that becomes applicable later is due for its own row only.
- **A lost state update** causes at most one redundant fetch, never a wrong write.

**Fill-only and freshness.** A part that is `complete` or `complete_with_gaps` is **not** fetched again on a schedule.
- `film_sync_state.metadata_at` is set only when, after the write, every `core` field that some applicable source can supply is non-blank.
- A legitimate refresh is an explicit, separately decided action. It raises the part's `refresh_epoch`, and the epoch is part of the request identity.

**Retry semantics, consistent with ADR 0207 decision 4b:**
- **Transport.** A 403, a Cloudflare challenge, a 429, a timeout, a network error, a 5xx, an active shared cooldown (decision 5) or the tick deadline **does not consume a failure**.
  - The state row keeps its `due_since`, so the Film keeps its place in the queue.
  - `transport_streak` grows. `pending_since` is set only by an upstream transport outcome, never by this tick's deadline or budget.
  - `retry_at` is the later of the transport backoff and the shared cooldown. The backoff is the same as in ADR 0207 decision 4b: 15 min · 2^min(streak − 1, 5), so at most 8 h.
  - There is no cap on transport retries. A long streak is visible (decision 5), and after 72 h of upstream transport the transport-only fallback applies (decision 2).
- **Definite.** A 404 of the anchored entity, a 200 that does not parse, a missing required section of a complete response, or a check that throws **consumes one failure**. After **6** failures the row is `needs_attention`, visible, and no longer retried automatically. A 404 of a trusted TMDB id is reported as an identity hint, never as a retirement.
- **Identity disagreement** stops the Film (decision 2) without consuming failures.
- A part or source that succeeded is never retried because another one failed. The only exception is a field waiting for precedence, which is refetched when it becomes decidable.

**Unit identities.** Every canonical write is one receipted unit with a deterministic identity.
- The `operation_key` names the unit, not the plan. The event carries the part's `refresh_epoch` and the `anchor_digest`.
- The digest carries the `sourceVersion`: SHA-256 of the canonical JSON of the source fields used, with no clocks.
- **A replan therefore keeps the key and changes the digest**, so the reconcile protocol abandons any unresolved receipt of the old plan before reserving a new one.

| Part | Unit | Target | `operation_key` | Bound |
| --- | --- | --- | --- | --- |
| core | one `film_metadata`/`film_sync_state` write | the Film | `enrich:<film>:core` | one batch, ≤ 12 guards |
| localization | one `localization_source` write per source | the Film | `enrich:<film>:localization:<source>` | ≤ 3 sources (existing cap 10) |
| credits | one `person_mutation` unit **per missing Person**, as accepted in ADR 0130 | that Person | `enrich:person:<person id>` | one Person per unit (ADR 0130's bound of 40 is external ids plus aliases of one Person); at most 30 missing Persons per Film, written over as many ticks as the budget allows |
| credits | one add-only `film_credits` unit | the Film | `enrich:<film>:credits:<source>` | ≤ 30 credits (existing cap 50) |

**Commit guards: the exact anchor set and the plan epoch.** Every unit asserts these in its own fenced batch:
- **the anchor set.** One compound guard checks the plan's anchors as a set:
  - every anchor its plan used or checked (its own source's, and for agreement the other one) still holds by its exact `(scheme, value)`: trusted, non-conflicting, singly owned, and for TMDB not retired;
  - **no other** trusted `letterboxd` or `tmdb` anchor of the Film exists beyond the planned ones.

  So an anchor added while an old plan runs fails that plan too;
- **the plan epoch.** The `refresh_epoch` of the unit's state row, and the Film row's `plan_epoch`, still equal the values the plan read. An owner `retry`, an anchor check or a resume that raises either epoch therefore makes every batch of an older plan fail, even with unchanged anchors, and the tick replans;
- the `metadata` dimension's owner and reviewed locks (Film units);
- the lease;
- the control generation (decision 6).

**State writes are fenced the same way.** Every write of a state row asserts the lease and the row's epoch, so a stale tick can neither commit canonical data nor overwrite the state of a newer plan.

**The `core` batch** is **one** `writeFilmFacts` batch. Its guards stay within the cap of 12:
- at most 6 per-field blank guards;
- 1 anchor-set guard;
- 1 epoch guard;
- 1 lock guard;
- the lease;
- the control generation.

That makes 11 in all.

**Person units** are the existing per-Person `person_mutation` units: one target Person, one revision and one receipt tail (`mutatePerson`, `canonical-mutations.js:148-175`).
- C1 adds an optional, validated `guards` input to `mutatePerson` and to its producer adapter, like the caller guards of `writeFilmFacts`. It is bounded, and it is counted inside the writer's 60-statement cap.
- No multi-target mutation contract is introduced.
- Each Person unit carries the plan's anchor-set guard, the epoch guard, the lease and the control generation, so no Person is written for an invalidated or stale Film plan.
- Its key `enrich:person:<person id>` is per Person. When two Films' plans need the same new Person, the partial unique index lets one reservation through. The other is `in_flight`, then finds the Person present: a no-op, with no receipt.

**Attribution survives partial success, without a provenance model.** Before each unit, the producer records a small **write intent** on its state row (in `film_json` for the Film row): the fields or credits the unit will add, the anchor digest, the epoch and the unit's `operation_key`.
- After the unit, it settles the intent from the receipt (`applied`, or nothing written).
- After a crash, the reconcile protocol finds the unit's receipt by key, and the intent says what it wrote and under which anchor.
- That is the only attribution kept, and it is enough for `written_under_superseded_anchor`. It is not card PF's per-field provenance on `film_metadata`.

- **Cross-origin correlation.** A Person or credit may already exist from another origin, such as the EPG chain. The person unit inserts only absent Persons, and the credits unit adds only what is missing. With the credits rule of decision 2, this never adds a second namespace.
- **Sequencing and partial recovery.** `credits` runs its Person units first, then its credits unit. A credit whose Person is missing is refused (`film_person_reference`), so the database enforces the order. If the deadline falls after some Persons, the next tick recomputes the missing Persons and credits from canonical state against the stored expected set. A Film need not finish in one tick.
- **Receipts per unit** follow the **reconcile-then-reserve** protocol of ADR 0207 decision 3: the history fingerprint, settling unresolved receipts, an atomic reservation, and a loser that replans. This record therefore depends on card R1 (the receipt `operation_key`).

### 3b. Identity changes and recovery

**Anchor check before filtering due work.** Before it selects due work, each tick recomputes the anchor digest for every Film it is about to plan. It also does so for up to **20** further in-scope Films with the oldest `anchor_checked_at`, whatever their status, including `complete`, `needs_attention` and `identity_disagreement`. The digest is SHA-256 of the sorted anchors `(scheme, value, trusted, conflicting, retired, holds)`, where `holds` says whether the anchor still satisfies its whole rule, including **no other owner** of that value. So a change on another Film that takes or releases the same value is detected too. Computing it is a bounded read of `film_external_id` and `tmdb_retirement_decision`.

**On a change:**
- **The source set grew:** the new source's gaps reopen (decision 2).
- **The source set shrank:** that source's rows become `not_applicable`, and its earlier writes remain.
- **An anchor value changed (an identity correction):**
  - Every state row of the Film is invalidated. Its status becomes `due`, with failures and streak at 0 and `expected_json` cleared. `refresh_epoch` rises by 1, `agreed_anchor_digest` is cleared, and `identity_disagreement` is lifted.
  - Unresolved receipts of the old plan are abandoned by the reconcile protocol (same key, different digest) before any new reservation, so no stale unit lands.
  - **Values written under the old anchor are neither overwritten nor deleted**, because the producer is fill-only and credits are add-only. They are listed as `written_under_superseded_anchor`, each field or credit with its old anchor. They are visible in `/admin/settings` and to the Monitor, for correction through the existing owner routes or card PF.
  - **`credits` is held** with `needs_attention` and the reason `superseded_credits` whenever this producer added credits under the old anchor. That stops the new identity's cast from being mixed into the old one in the same namespace. The owner releases it with `retry`, after correcting or accepting the listed credits.

**Unchanged anchors: an explicit owner retry.** A Film blocked by `identity_disagreement`, or a part in `needs_attention`, whose anchors did not change, is retried only by an owner action. The request is `POST /api/admin/settings/catalog-enrichment` with `{action: 'retry', filmId, part?, source?, expectedRows, requestId}`, and it has the same authentication and readback as decision 6. `expectedRows` gives, for each selected state row, the `status` and `updated_at` that the owner saw. That is the retry's own compare-and-swap. A retry never changes the control row's revision, so it does not race with pause or resume.
- It resets the selected rows to `due`, clears failures and the disagreement, and raises `refresh_epoch` and the Film's `plan_epoch`, so every batch of an older plan fails (decision 3).
- It keeps `due_since`.
- It writes no metadata itself.

### 4. Eligibility, scope and fairness (0211-4 = A)

**A Film is due for a part and source when all of these hold, after the anchor check of decision 3b:**
- it is in the activated **scope**: initially, Films whose `film_rated_admission.verified_at` is at or after the control's `cutoff_at`;
- it exists and is not redirected;
- the source is applicable (its anchor holds), and the Film is not in `identity_disagreement`;
- that part and source are not `complete`, `complete_with_gaps` or `needs_attention`, and their `retry_at` has passed;
- its `metadata` dimension is not owner- or reviewed-locked.

**Fairness.** Due work is taken **oldest first by `due_since`**: the admission time, or the time a new source became applicable.
- A transport retry keeps its `due_since`, so it keeps its place.
- A stream of new admissions cannot starve older ones.

**The initial scope is honest about what it reaches.**
- Every new admission carries a trusted TMDB claim, because admission requires a TMDB id (Context). So the initial scope always has the `tmdb` and `wikidata` anchors.
- It has the `letterboxd` anchor once a trusted lid claim exists. That is normally the case after a Diary or Watchlist check, which requests the claim.
- A rated-archive admission whose code is held only as the admission alias, and an inferred import admission, have no Letterboxd anchor. Letterboxd becomes applicable for them only when a trusted lid claim appears later, and then reopens only their gaps.
- **Letterboxd-only Films** (a trusted lid, no TMDB claim, such as the legacy `film:<lid>` Watchlist Films) are **designed and tested** in this record. They are **not in the initial production scope**: they enter only through scope C3b (Watchlist members) or a future Letterboxd-only admission path.
- **Scope widening is a separate decision each:**
  - C3a: the 714 existing admitted Films;
  - C3b: Watchlist members, which closes the pinned-run gap of the Context and changes the Watchlist metadata path.

  Neither is included silently.

**Tests (C1 acceptance).**
- **Units:**
  - a lost response of each unit kind;
  - a partially applied `core` or `credits` part (persons applied, credits not);
  - a changed source with an unresolved receipt of the same unit;
  - a cross-origin no-op (Persons and credits already written by the EPG chain);
  - a stale lease writing nothing;
  - complete-but-empty answers for each part and source.
- **Sources and precedence:**
  - both completion orders of Letterboxd and TMDB give the same writes;
  - a Letterboxd transport failure makes TMDB fields wait, then fill when Letterboxd answers;
  - **the transport-only fallback (0211-7 = B):**
    - after 72 h of upstream transport, TMDB fills the waiting fields, listed as `fallback_fill` and, without agreement, as `unconfirmed_agreement`;
    - 72 h made only of this tick's deadline or budget shortages grants no fallback;
  - a definite-error cap (`needs_attention`), a 404 or a non-film page of Letterboxd grants **no** fallback: `core` and `credits` wait for the owner;
  - a successful response missing a field (`absent`) lets the next source fill it at once;
  - a source that recovers before 72 h fills first. A source that recovers after a fallback overwrites nothing, records `stored_differs` and confirms or refutes the agreement;
  - a known disagreement blocks every automatic write, before and after 72 h;
  - the deadline falling between two sources;
  - a value conflict and a stored difference, both listed;
  - a page disagreement stops every source;
  - a Letterboxd-only Film (no TMDB claim) enriched from Letterboxd alone;
  - an inferred admission and an alias-only admission get no Letterboxd fetch;
  - name-only credits are not written;
  - Person units: the deadline after some Persons, resumed next tick; two Films creating the same Person concurrently (one reservation, the other a no-op); a stale Film plan refused at the Person unit;
  - Films with existing credits in one namespace, and in both namespaces.
- **Identity changes:**
  - a TMDB correction A → B on a completed Film;
  - a retirement;
  - a lid replacement L → L′;
  - a correction while a part is mid-recovery;
  - an anchor added while an old plan runs: the old plan's batches fail;
  - a source-set shrink or growth that resolves a previously blocked Film;
  - an owner retry racing a live tick: the tick's later batches fail on the epoch, and no state of the newer plan is overwritten;
  - agreement work kept open after every field is filled;
  - `credits` held as `superseded_credits` after a correction, then released by an owner retry;
  - another Film taking or releasing the same anchor value, detected by the `holds` bit;
  - a retry with stale `expectedRows`;
  - a correction during a pause;
  - a blocked Film recovering after its claim fix;
  - an owner retry with unchanged anchors;
  - a Person unit refused for an invalidated plan.
- **Control and pause:**
  - a pause between the check and the request (a residual request, no write);
  - resume keeping the cutoff, scope and pending work;
  - activation not reachable from the checkbox;
  - the applied, rejected and uncertain readbacks;
  - a stale `expectedRevision`.

### 5. Operational contract and shared upstream coordination (0211-5 = C)

**Lease.** One `projection_run` row (`projection = 'catalog_enrichment'`) with a fresh random `lease_id` per acquisition. Every write batch asserts that its own `lease_id` is current and that `lease_until` is still ahead (one guard). Overlapping ticks are impossible, and a stale tick cannot write.

**Deadline.** Each tick has an absolute deadline of **25 s** from its start, with a 5 s write reserve. Every fetch timeout is `min(source timeout, deadline − reserve − now)`. The source timeouts are 12 s for TMDB, 15 s for Letterboxd and 15 s for Wikidata. No write starts without the reserve.

**Per-tick bounds and fit to the deadline.** At most **2 Films**, one after the other.
- **Requests per Film.** At most one request per applicable source:
  - Letterboxd: `boxd.it/<lid>` with at most one redirect to the film page, so at most 2 requests;
  - TMDB: `movie/<id>?append_to_response=credits,translations`;
  - Wikidata: one SPARQL query.

  So a Film makes at most 4 upstream requests, and a tick at most **8**.
- **Sources in parallel, never two requests to one scope at once.** The sources of one Film are different upstream scopes, so they are fetched in parallel. Each fetch has the timeout `min(source timeout, deadline − reserve − now)`. A source cut by that timeout is `pending` (transport, no failure).
- **Writes after the fetches, bounded by a measured unit budget.** A Film's writes start after all its fetches have ended, and only inside the reserve.
  - Each receipted unit costs a reconcile read, a reservation, its fenced batch and a state settle, so a few D1 round trips.
  - Each tick has a **unit budget**, initially 12 units, and stops writing when the budget or the reserve is spent. The units are:
    - core: 1;
    - localization: up to 3;
    - Persons: one per missing Person, up to 30;
    - credits: 1.
  - The rest of a Film continues at the next tick from canonical state, so **a Film need not finish in one tick**.
  - The budget is raised only from measured tick costs, like the Film bound.
- **A second Film starts only with time left.** It starts only if at least 10 s remain before the reserve.
- **Measurement before raising the bound.** The bound of 2 Films is a starting value. It is raised only by an owner decision after measurement: each tick records its wall time, its fetch times per source and its D1 statements. At 2 per hour, the 714 legacy Films (if C3a is chosen) would take at least 15 days. That is a minimum, not an ETA.

**Shared upstream coordination.** One durable cooldown per upstream scope, adopted by **all** relevant producers **in the same delivery scope** (cards UC1-UC3 of ADR 0207 decision 7), not by this producer alone.

- **Scopes.** A scope is a credential or rate-limit domain, never a producer:
  - `tmdb`, the one bearer;
  - `letterboxd`, Worker egress to `letterboxd.com` and `boxd.it`;
  - `wikidata`, `query.wikidata.org`.

  The EPG XMLTV source and the Monitor's Telegram and webhooks each have a single caller and their own durable pause, so they are out of scope. The Cloudflare Access certificate fetch is infrastructure, also out of scope. A cooldown of one scope never blocks another scope, so there is no false cross-source blocking.
- **The callers of the inventory (the Context), by kind:**

  | Scope | Writer paths: they read the cooldown, skip, and write it on a signal | Read-only paths: they read the cooldown and never write it |
  | --- | --- | --- |
  | TMDB | Discovery Workflow chunks; the owner poster route `POST /api/enrichment/catalog/posters` and the poster weekly cron; `movieDetail` in the Diary check, the Watchlist admission and the owner archive step; this producer | `GET /api/integrations/tmdb/status`, the one registered outbound read of the read-side-effect baseline (`tmdb-status-probe`). If the cooldown is active it answers from the cooldown without a request; otherwise it requests as today, and on a 429 it reports the status without writing the cooldown |
  | Letterboxd | the Letterboxd Sync Watchlist scan and Diary page; the identity checks (Diary, Watchlist admission, archive step); the removal-phase rating refresh; metadata-sync film pages; this producer | none |
  | Wikidata | metadata sync; EPG localization; the archive enrich step; this producer | none |

  Every MCP read tool and every other GET makes no request to these scopes today, and stays that way. The read-side-effect baseline (ADR 0107) is therefore unchanged: the probe stays a registered outbound read with no storage write.
- **Table.** An additive single table `upstream_cooldown(scope PRIMARY KEY, until_at, reason, retry_after_s, set_by, updated_at)`.
- **Which signals set a cooldown:**
  - a **429** from that scope;
  - a **Cloudflare challenge**, as detected by the existing `isChallenge`;
  - a **403** from that scope.

  These are rate-limit and blocking signals that concern every caller of the scope.
- **Which signals do not:**
  - a **404** is about one entity;
  - a **5xx**, a timeout or a network error stays a local retry for its caller, because one failing entity must not block the scope.
- **Duration.**
  - With `Retry-After` (seconds, or an HTTP date): that value, clamped to 30-3,600 s.
  - Without it: 300 s for a 429, and 900 s for a challenge or a 403.
- **Monotonic extension and concurrency.** The write is `INSERT … ON CONFLICT(scope) DO UPDATE SET until_at = MAX(until_at, excluded.until_at), …`. It is commutative, so concurrent writers never shorten a cooldown, and the last reason wins only together with the latest `until_at`.
- **Expiry.** A cooldown whose `until_at` has passed is inert. Rows are overwritten, never deleted.
- **Reading.** Before each request to a scope, an adopting caller reads that scope's row. If the cooldown is active, the caller does not send the request, and maps the skip to its **existing not-now path, without consuming any attempt, failure or quarantine budget**:
  - Discovery: its `retryAt` becomes `max(retryAt, until_at)`;
  - the Letterboxd Sync phases: deferred, and not counted as a transient failure toward the quarantine caps;
  - the Diary and Watchlist identity checks: `upstream_cooldown`, which costs no attempt (ADR 0207 decision 4b);
  - the removal queue: `pausedUntil` becomes `max(pausedUntil, until_at)`, and the claim does not count;
  - metadata sync and EPG localization: they skip the remaining requests of that scope in the step and record the skip;
  - the poster cron: no `retryAttempts` increment;
  - this producer: transport (decision 3).
- **What it is not.** A shared cooldown is **not a global request-rate limiter**. No token bucket or shared request spacing is designed here. Each caller keeps its own spacing (for example, Discovery's 200 ms).
- **Other producers' own failure budgets are out of scope.** Some existing budgets are consumed by a transport failure that a caller actually receives:
  - the removal queue's three attempts;
  - the poster cron's `retryAttempts`;
  - the orchestration quarantine caps.

  They are other producers' policies, not part of this producer or of the owner's selections. This record changes them only in one way: a **cooldown skip** never counts against them. Changing their own transport rules is a separate decision, listed as a candidate follow-up.
- **Fail-safe.** If the table or the mode row (below) is absent or unreadable, the caller behaves exactly as today with its local policy. A coordination failure never blocks production work and never makes a caller more aggressive than today. A failed cooldown write is logged, and the caller's local backoff still applies.
- **Rollout and rollback.** One durable mode row `upstream_coordination(mode, revision, updated_at)`, with three modes:
  - `off`: today's behaviour, and the delivered default;
  - `observe`: callers write cooldowns and record each "would have skipped" decision, but skip nothing;
  - `enforce`: callers skip.

  Each mode change is an owner production operation. Rollback is `off`, which needs no code revert. The adoption ships in **one** card (UC1) for all callers, dormant at `off`.
- **Tests (UC1 acceptance):**
  - per caller: a 429 with and without `Retry-After`, a challenge, a 403, a 404 (no cooldown) and a 5xx (no cooldown);
  - two concurrent writers (the longer cooldown wins);
  - expiry;
  - a TMDB cooldown never blocking Letterboxd;
  - an absent table and an unreadable mode (today's behaviour);
  - `observe` skipping nothing;
  - a cooldown skip consuming no attempt, failure or quarantine budget;
  - GET and MCP reads writing nothing, with the GET write audit passing.

**Scheduling.** The step joins the hourly cron's `Promise.allSettled` as its own entry, and its errors are recorded, not swallowed.

**Outcome outbox and visibility.** The existing `canonical_producer_outcome` (migration 0038) is specific to the EPG Producer chain. The producer therefore uses a small dedicated outbox, `catalog_enrichment_tick(tick_id PRIMARY KEY, started_at, finished_at, state, counts_json, delivered_at, delivery_attempts)`.
- `tick_id` is stable for the tick: the lease id plus the hour. Delivery to the Events Log deduplicates by it.
- A tick writes `started` before its first request, and `finished` or `stopped` (with the reason, for example `paused` or `deadline`) at the end.
- `counts_json` carries, per source:
  - requests, transport skips, cooldown skips and definite failures;
  - written fields;
  - new conflicts, disagreements and hints.
- **A Monitor fact reader** (code in `monitor.js` and `MonitorPolicy`) reports:
  - a tick still `started` past its deadline plus a margin, which is an interrupted tick;
  - a transport streak of a scope with no successful request for 24 h while work is due;
  - due Films not progressing;
  - new `needs_attention` and `identity_disagreement` rows.
- **The `/admin/settings` page (decision 6)** shows the same counts read-only, with the active cooldowns.

### 6. Activation, control, pause and the `/admin/settings` checkbox (0211-6 = extended A)

**Dormant delivery.** The implementation is delivered dormant. Without a control row, every tick reads "not active" and writes nothing.

**Durable control.** The single source of truth is one small additive table, `catalog_enrichment_control`:
- `id = 1`;
- `state`: `inactive`, `active` or `paused`;
- `cutoff_at`, `scope`;
- `generation`, `revision`;
- `updated_at`, `updated_by`.

Every write batch of the producer asserts `state = 'active'` and its generation (one guard), together with the lease.

**Operations on the control.** They are one function with compare-and-swap on `revision`, so a stale request changes nothing and says so.
- **Activate** (`inactive → active`) sets `cutoff_at` and `scope`. It is an owner production operation (card C2). It is **not** reachable from the checkbox.
- **Pause** (`active → paused`) raises `generation`.
- **Resume** (`paused → active`) raises `generation` and **keeps `cutoff_at`, `scope` and all pending work** (state rows, `due_since`). Resume never widens the scope and never activates from `inactive`.
- Scope widening (C3a, C3b) is a separate owner operation with its own decision.

**Pause and drain.**
- **No new request after a pause.** The tick re-reads the control fresh before every upstream request and before every write.
- **Residual.** A request already authorized by the last successful check (read, then request) may still be sent, and requests already in flight complete. That is at most one request per source, and the drain is at most the longest fetch timeout (15 s).
- **Every durable effect is fenced.** Every write asserts the generation and the lease: Film units, Person units, state rows and the outbox. After a pause, nothing a residual request returns is written.
- **The terminal report.** The only write permitted after a pause is the tick's terminal outbox entry (`stopped`, reason `paused`). It asserts the lease, not the control.
- **A code revert** stops future ticks but does not cancel a running one. The pause is the stop control.

**The `/admin/settings` checkbox.** A new admin page, `/admin/settings`, with a section "Каталог: обогащение".
- **The checkbox** "Обогащение включено" invokes the **same** control function (pause or resume). There is no second flag.
- **It is disabled** while the state is `inactive`, with the text that activation is a separate operation.
- **Read route.** `GET /api/admin/settings` returns the **effective** state:
  - the stored `state`, `generation`, `revision`, `cutoff_at` and `scope`;
  - the last tick's outbox state;
  - whether a tick is still draining after a pause (`stopped` not yet written), with its deadline;
  - the counts of decision 5 and the active upstream cooldowns;
  - the Films in `identity_disagreement` or `needs_attention`, with their lists `fallback_fill`, `unconfirmed_agreement` and `written_under_superseded_anchor`, each with a retry action.

  It is a pure read and registered in the GET write baseline.
- **Write route.** `POST /api/admin/settings/catalog-enrichment` with `{action: 'pause'|'resume', expectedRevision, requestId}`, where `expectedRevision` is the control row's. The same route takes `{action: 'retry', filmId, part?, source?, expectedRows, requestId}`, which uses the state rows' own compare-and-swap (decision 3b). It is registered as POST-only in the read-side-effect audit. It requires:
  - an Access JWT **verified in the Worker**: signature against the team JWKS, issuer, audience and expiry, through the verifier that `/mcp` already uses (`mcpVerifyAccess`);
  - an owner identity check against a configured owner subject;
  - the existing admin conditions: the Worker's own `Origin`, the action header `X-IPTV-Admin-Action` and a JSON content type.

  Today's other admin routes check only that the header is present. Hardening them is **not** part of this record.
- **Readback.** After the write, the route reads the row back and answers:
  - `applied`, with the new effective state;
  - `rejected`, with the current state (a stale revision);
  - `uncertain`, when the readback failed: 503 with `outcome: unknown`, as in the channel policy pattern.
- **The page** shows the read-back state. On failure it shows the error explicitly and leaves the checkbox at the last read-back value, never at the clicked one.
- **UI acceptance is independent** (card CU):
  - visual QA at desktop and mobile widths, with no screenshots committed;
  - the applied, rejected and uncertain paths;
  - a disabled checkbox while `inactive`;
  - the drain display after a pause.

  CU depends on the control contract delivered in C1. This record authorizes no production setting change.

**Rollback of data.** None. Metadata already written is valid canonical data under fill-only and precedence. A wrong value is corrected by the owner and review routes.

## Alternatives considered

- **Reuse `metadata_sync` with a second eligibility source.**
  - Against: it is bound to the EPG run document, keyed by lid through `metadata_cache`, and stops when the Watchlist is pinned.
- **Overwrite merge, as the EPG producers do.**
  - Against: without per-field provenance it would replace owner-edited or newer values. Fill-only now; per-field provenance is card PF.
- **TMDB only, with a global trusted-TMDB eligibility guard** (the previous revision).
  - Against: it made Letterboxd metadata depend on a TMDB claim, which the owner rejected (0211-2).
- **A Letterboxd page as an anchor through `data-tmdb-id` alone.**
  - Against: that would let the producer's own fetch create the ownership it is supposed to check. Ownership must exist beforehand, as a trusted lid claim.
- **Credits from every applicable source.**
  - Against: the same people would be written twice under two source-specific ids, with no safe merge. One credit source per Film by precedence instead.
- **A cooldown table used only by this producer, with adoption by the other producers as later cards** (the previous option 5a/5b).
  - Against: the owner rejected postponed adoption (0211-5 = C).
- **A global request-rate limiter.**
  - Not designed. A shared cooldown answers rate-limit and blocking signals, and spacing stays per caller.
- **A code constant, or a second flag for the UI, as the activation.**
  - Against: no durable cutoff, and two sources of truth. One durable control row instead.

## Consequences

- **Admitted Films get canonical metadata** without EPG airing, from Letterboxd, TMDB and Wikidata, through the existing writers. There is no new metadata authority and no identity effect.
- **Letterboxd is a first-class source**, keyed by reliable Letterboxd ownership, and the Letterboxd-only path is designed and tested before it is in scope.
- **New durable contracts:**
  - fill-only metadata with per-source anchor guards;
  - a per-source state table with visible conflicts, disagreements and hints;
  - a `projection_run` lease;
  - a durable control row with an authenticated `/admin/settings` control;
  - a dedicated tick outbox;
  - one shared upstream cooldown per scope, adopted by every relevant producer behind one mode row.
- **Behaviour changes for other producers** happen only when the upstream mode leaves `off`. In `enforce`, a 429, challenge or 403 in one caller pauses every caller of that scope until the cooldown ends. One example: the Watchlist scan no longer runs into a Letterboxd rate limit that the Diary phase just hit, which replaces the per-slot independence of `letterboxd-sync.js:664-667` for those signals only.
- **Metadata can stay partial** under fill-only until card PF is decided.

## Recovery and migration boundary

- Additive tables, applied by card CM, or earlier by M1 when they are lower-numbered (ADR 0207 decision 7, migration apply order):
  - `catalog_enrichment_state`;
  - `catalog_enrichment_tick`;
  - `catalog_enrichment_control`;
  - `upstream_cooldown`;
  - `upstream_coordination`.

  No existing table changes.
- Activation, pause, resume, scope and the upstream mode are durable owner operations. Data written is kept.
- The upstream mode rolls back to `off` without a code revert. The producer stops through the pause.
- This ADR, even when Accepted, authorizes no migration apply, activation, mode change, fetch or write.

## Evidence

- Code surveys made for this record on `main` `c5ecc1bd` (24 Nov 2026), summarized in the Context: the upstream caller inventory, the admin authentication, the identity claims and the source parsers.
- Production L0 read, 24 Nov 2026 12:21 UTC: Watchlist marker `d1` generation 3; 714 of 714 admitted Films without `film_metadata`.

## Owner choices in this record

The owner selected these on 2026-11-24 ([consolidated owner choices](https://github.com/vladimino/iptv-watchlist/pull/975#issuecomment-7140090124), and [0211-7 = B](https://github.com/vladimino/iptv-watchlist/pull/975#issuecomment-7141202861)) and accepted the record the same day ([final disposition](https://github.com/vladimino/iptv-watchlist/pull/975#issuecomment-7141800326)).

| # | Choice | Owner selection | In this revision |
| --- | --- | --- | --- |
| 0211-1 | Fill-only or per-field provenance | **A**, fill-only; B planned explicitly as card PF | decision 1 |
| 0211-2 | Sources | **extended B**: Letterboxd first-class, independent of a TMDB claim; TMDB and Wikidata kept | decision 2 |
| 0211-3 | Independent parts, state and receipted units | **A**; consistent transport retry semantics | decision 3 |
| 0211-4 | Scope | **A**: new admissions after the cutoff only; C3a and C3b separate | decision 4 |
| 0211-5 | Cross-producer upstream coordination | **C**: shared, adopted by all relevant producers in one delivery scope | decision 5, cards UC1-UC3 |
| 0211-6 | Activation and control | **extended A**: the durable control plus an `/admin/settings` checkbox using the same control | decision 6, card CU |
| 0211-7 | Fallback when a higher-priority source is unavailable (raised by the [targeted re-review](https://github.com/vladimino/iptv-watchlist/pull/975#pullrequestreview-6045305740)) | **[B](https://github.com/vladimino/iptv-watchlist/pull/975#issuecomment-7141202861)**: transport-only fallback after 72 h of continuous upstream unavailability, with `fallback_fill` and `unconfirmed_agreement`. No fallback for a definite-error cap, a 404 or an invalid page. A known disagreement always blocks | decision 2 |
