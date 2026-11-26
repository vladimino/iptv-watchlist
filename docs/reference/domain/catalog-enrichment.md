# Catalog Enrichment Producer

The producer that fills the canonical metadata, credits and Russian titles of admitted Films from Letterboxd, TMDB and Wikidata. It is **dormant**: without a control row in `active` it reads "not active" and writes nothing. Decisions live in [ADR 0211](../../adr/0211-catalog-enrichment-producer.md) as amended by [ADR 0219](../../adr/0219-discovery-film-enrichment-and-refresh.md); this page is the maintained contract of the code in `src/catalog-enrichment-*.js` and `src/admin/settings.js`. Schema: [D1 schema](../data/d1-schema.md#catalog-enrichment-producer-schema-v47-dormant). Operations: [runbook](../../runbooks/catalog-enrichment-producer.md).

## What it never does

It never creates, merges or redirects a Film. It never writes or changes a claim, an alias or `canonical_identity`. It never reads the identity evidence ledger to decide anything. A 404 is availability, never a retirement. Every canonical write goes through an existing fenced writer (`writeFilmFacts`, the `film_credits` unit, `mutatePerson`) with a receipt.

## Modules

| Module | Role |
| --- | --- |
| `catalog-enrichment-plan.js` | Pure planner: anchors and their digest, the commit guards, precedence and the 72-hour fallback, retry and failure classes, credits namespace and chunks, the Russian title selection, priority |
| `catalog-enrichment-store.js` | Storage: the control row and its operations, the `projection_run` lease, the inbox emitter, the runnable-signal read and the guarded consumption of one signal |
| `catalog-enrichment-units.js` | Receipted units under the keys of the table below, the reconcile-then-reserve protocol, the durable unit generation |
| `catalog-enrichment-sources.js` | One request round per applicable source behind the shared upstream cooldown, and the Letterboxd page agreement |
| `catalog-enrichment-producer.js` | The step for one Film: anchor check, fetch, decision, units, state rows |
| `catalog-enrichment-drain.js` | The resource-bounded queue drainer: one call is one run |
| `catalog-enrichment-workflow.js` | The Workflow shell: the instance body, the run record, the kick, the parked wait and the reconcile |
| `admin/settings.js` | The authenticated control and readback routes ([admin API](../api/admin.md#catalog-enrichment-control-apiadminsettings)) |

## Anchors and sources

A source writes a Film only through its own identity anchor on that Film.

- `tmdb`: exactly one trusted, non-conflicting `tmdb` claim, held by no other Film as a trusted claim, and not retired.
- `letterboxd`: exactly one trusted, non-conflicting `letterboxd` claim (the `boxd.it` code) held by no other Film. The admission alias, a slug row and an inferred pair are not anchors. A fetched page only confirms an anchor and never creates one.
- `wikidata`: rides on the `tmdb` anchor and is keyed by that id (P4947).

A source without an anchor is `not_applicable` and is never fetched. A Letterboxd-only Film is enriched from Letterboxd alone; a TMDB id on its page is an identity hint, never a claim.

**Page agreement** (Letterboxd): `boxd.it/<lid>` with at most one redirect to a film page; the shortlink code equals the anchor (or, without a shortlink, the redirect is the link); the canonical path equals the landing path; with a TMDB anchor, exactly one `data-tmdb-id`, of type `movie`, equal to the anchor. A rule failing on a 200 page is a verified disagreement: the Film becomes `identity_disagreement`, no source writes it, and only an anchor change or an owner retry reopens it.

## Fill-only precedence

A blank core field (year, runtime, synopsis, poster, url, genres) is written from the first source in the order `letterboxd`, `tmdb` whose answer has a value, once every earlier source is `absent` or `not_applicable`. An earlier source that is `pending` makes the field wait; one that `failed` keeps it waiting for the owner. A stored value is never overwritten and a different answer is only listed (`stored_differs`, `value_conflict`).

With a Letterboxd anchor, core and credits writes need a recorded agreement for the Film's current anchors. The only exception is the transport-only fallback: a source unavailable through upstream transport (a 403, a challenge, a 429, a 5xx, a timeout, a network error or an active cooldown) for 72 hours continuously counts as unavailable, the next source fills through its own anchor, and each field is listed (`fallbackFill`, and `unconfirmedAgreement` without a recorded agreement). A handover, a yield, a pause, a lost lease or a resource stop never counts toward the 72 hours and never sets a cooldown.

## Units and keys

| Part | Unit | Key |
| --- | --- | --- |
| core | one `film_facts` write | `enrich:<film>:core` |
| localization | one source row per source | `enrich:<film>:localization:<source>` |
| credits | one `film_credits` chunk of at most 50 | `enrich:<film>:credits:<source>:<slot>` |
| Person | one `person_mutation` per missing Person | `enrich:person:<person id>` |

A replan keeps the key and changes the digest, so the protocol abandons an unresolved receipt of the old plan before it reserves a new one. A key that reaches the receipt history cap advances the durable generation of its logical unit and continues under `<key>:g<k+1>`; the old receipts are kept.

Every unit asserts, inside its own batch, the lease, the control generation and its guards. The core batch carries one blank guard per written field, the anchor-set guard, the epoch guard and the metadata lock guard. A guarded-out unit is a stale plan: the Film is replanned and nothing is written.

## Credits

Every correctly identified credit of the verified source is kept, with no cap other than the chunk size. A Film has one credit namespace: the existing credits decide the source; both namespaces present means nothing is written and `credits_other_namespace` is listed; none means Letterboxd if anchored, otherwise TMDB. A Letterboxd credit without a real person slug is a gap (`name_only_credit`), never written. A part is complete only when every expected credit exists, judged by person identity. Persons are created first, one unit each, then the credits chunk; a Film spans as many runs as it needs.

## Russian title

Each applicable source writes its own `film_localization_source` row. For TMDB the title is selected from the translations of the same response: exactly one distinct non-blank `ru` title is the value, several are decided by region `RU`, otherwise the selection is ambiguous (an owner decision) and a missing or malformed section is unreadable (a repairable failure). The Letterboxd page carries no Russian title, so its row is a complete absence.

## Failures

| Class | Examples | Treatment |
| --- | --- | --- |
| transport | 403, challenge, 429, 5xx, timeout, network, active cooldown | no failure consumed, `pending_since` set by the first one, backoff 15 minutes · 2^min(streak − 1, 5), at most 8 hours |
| repairable | unparsable response, missing section, a 404 of an anchored entity | bounded retries, then `deferred_repair`, rechecked after 1, 6 and then every 24 hours, never terminal |
| owner required | a verified disagreement, an ambiguous translation | stays with the owner |

## Control, signals and the run

The control row has the states `inactive` (an absent row), `active` and `paused`. Activation is a separate owner operation and is not reachable from pause or resume. Every change of a control or scope row raises `generation`, which every batch asserts, so a stale plan cannot commit.

Known work is made pending by the change that causes it: triggers on `film_external_id`, `tmdb_retirement_decision`, `film_redirect` and `film_dimension`, and the rated admission, write one coalesced row per `(kind, subject, source, part)` in `enrichment_signal`. The producer consumes a signal in one batch whose every effect and acknowledgement carry the same guard (the signal pending at exactly the version read, the control active at the plan's generation, a live lease, an enabled scope). A guarded-out signal stays pending at its newest version. The producer's own writes emit no signal.

A run acquires the lease, consumes the runnable signals, picks due Films (live before background, the background share measured in committed units) and ends only for a reason: `idle`, `parked` (with the earliest due time), `handover` (the statement budget), `paused`, `generation_moved`, `lease_held`, `yield` or `error_backoff`. The budgets are safety budgets, not throughput quotas; the defaults are constants in `catalog-enrichment-drain.js` and each run's outbox entry reports them.

## The Workflow shell

An instance of the Cloudflare Workflow `CatalogEnrichmentWorkflow` (binding `CATALOG_ENRICHMENT_WORKFLOW`) runs `drain` in steps. The **run record** is the `summary_json` of the `projection_run` row named `catalog_enrichment_run`: the live instance, its phase (`running`, `parked` or `retired`), its due time and the successor of a handover, moved by compare-and-swap. The drainer's own lease stays the authority for writing; the record only says whom to wake.

- **No lost wakeup.** Parking and retiring first make the intent durable on the record and only then re-check for runnable work (a runnable signal or a due Film); work found cancels the intent. `kick` runs after a causal change commits: a `parked` instance gets a `kick` event, a `running` instance with a live owner needs none, a `retired` record or a missing owner creates the next instance, and a send that throws is read as "no live owner". A `running` record is believed only while the drainer lease is live or the record moved within two minutes, so a crashed instance never strands the work.
- **Parked wait.** The instance waits for the `kick` event with the time to the earliest due retry as its timeout; a timeout throws, is caught and is the due-time wake.
- **Handover.** At the statement budget the instance records a strictly newer successor, creates it (idempotent by id) and stops; the successor writes only after it acquires its own lease.
- **Reconcile.** `reconcile` is the safety net for a lost kick, a path without the hook and a crash after a commit; it creates nothing when nothing is runnable. Its cron expression is not in `wrangler.jsonc`: the activation change delivers it. A deploy carries the binding and the dispatch, which do nothing while the control is not `active`.

## Not part of this contract yet

The Monitor fact reader, the `/admin/settings` page, the scope bootstraps, the Discovery and Watchlist emitters and a yield read from the real EPG publication phase (the drainer accepts an injected predicate) are separate deliveries.
