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

Every correctly identified credit of the verified source is kept, with no cap other than the chunk size. The enrichment path reads the Letterboxd credits through the shared page parser without its legacy ten-actor display cap. Completeness is explicit: both role sections must be present and every entry must be an object with a name; an omitted role, a malformed section or an entry that would be dropped is unreadable, never a complete set (a present, empty list is a complete empty role), and a parser that does not report completeness is read as incomplete. A person without a profile link stays a name-only gap. A Film has one credit namespace: the existing credits decide the source; both namespaces present means nothing is written and `credits_other_namespace` is listed; none means Letterboxd if anchored, otherwise TMDB. A Letterboxd credit without a real person slug is a gap (`name_only_credit`), never written. A part is complete only when every expected credit exists, judged by person identity. The whole expected set is published as durable chunk rows in one atomic batch before the first unit, together with the supersession of any old slot of another plan. A plan is **published** only when every slot `0..total-1` of one source holds the same expected-set digest and the same total; a prefix, a mixed set or an invalidated plan is never resumed (the source is fetched again and the plan republished), and a re-arm of the source, an anchor change or an owner retry clears the persisted plan. A Film interrupted anywhere resumes every chunk of a published plan from D1, and completing persisted units makes no upstream request. Persons are created first, one unit each, then the credits chunk; every unit asserts the anchor set, the Film plan epoch, the chunk row's own epoch, the lease and the control generation. A Film spans as many runs as it needs: before each group of units the drainer asks whether the remaining statement budget covers it plus the finalize-and-successor reserve, and the Workflow counts statements for the whole instance across its steps.

## Russian title

Each applicable source writes its own `film_localization_source` row. For TMDB the title is selected from the translations of the same response: exactly one distinct non-blank `ru` title is the value, several are decided by region `RU`, otherwise the selection is ambiguous (an owner decision) and a missing or malformed section is unreadable (a repairable failure). The Letterboxd film page exposes the film's own name and an untyped list of alternative titles, none carrying a language. A missing typed Russian title cannot be verified from it, so Letterboxd localization is **unsupported coverage**: its row is `not_applicable` (`no_typed_title_in_source`), neither a failure nor a verified absence, and nothing is inferred from Cyrillic text or an alias. Source precedence and the TMDB and Wikidata rows are unchanged.

## Failures

| Class | Examples | Treatment |
| --- | --- | --- |
| transport | 403, challenge, 429, 5xx, timeout, network, active cooldown | no failure consumed, `pending_since` set by the first one, backoff 15 minutes · 2^min(streak − 1, 5), at most 8 hours |
| repairable | unparsable response, missing or malformed section (translations, credits), a 404 of an anchored entity | bounded retries with backoff, then `deferred_repair`, rechecked after 1, 6 and then every 24 hours, never terminal. Success and failure are classified per part: a 200 whose translations or credits section is unreadable is not a recovery of that part, so repeated identical malformed responses reach quarantine. A new code version makes the deferred items of an older version runnable at once (the reconcile counts a pending version wake as runnable work, and an attempted repair records the running version); a valid section of a source wakes only the deferred items of that part and source in other Films, at most 20 per success and only items last attempted at least 15 minutes ago, so repeated unrelated successes cannot loop |
| owner required | a verified disagreement, an ambiguous translation | stays with the owner |

## Control, signals and the run

The control row has the states `inactive` (an absent row), `active` and `paused`. Activation is a separate owner operation and is not reachable from pause or resume. Every change of a control or scope row raises `generation`, which every batch asserts, so a stale plan cannot commit.

Known work is made pending by the change that causes it: triggers on `film_external_id`, `tmdb_retirement_decision`, `film_redirect` and `film_dimension`, and the rated admission, write one coalesced row per `(kind, subject, source, part)` in `enrichment_signal`. The producer consumes a signal in one batch whose every effect and acknowledgement carry the same guard (the signal pending at exactly the version read, the control active at the plan's generation, a live lease, an enabled scope). A guarded-out signal stays pending at its newest version. The producer's own writes emit no signal.

A run acquires the lease, consumes the runnable signals, picks due Films (live before background, the background share measured in committed units) and ends only for a reason: `idle`, `parked` (with the earliest due time), `handover` (the statement budget), `paused`, `generation_moved`, `lease_held`, `yield` or `error_backoff`. The budgets are safety budgets, not throughput quotas; the defaults are constants in `catalog-enrichment-drain.js` and each run's outbox entry reports them.

## Contention with EPG publication

The producer takes neither the Discovery lease nor the projector window and has no blanket dependency on EPG success. The existing EPG and Discovery gates are unchanged.

- **Narrow yield, proactive.** While an EPG publication or seal phase is active and progressing, the write units of a new step do not start. The evidence is that phase's own live lease: `discovery_lease` held by `holder_kind = 'epg'` with an expiry still ahead. A Discovery-held lease, no lease, an expired lease and an unreadable row are not a hold, so a failed or stalled EPG never holds enrichment and no timeout is invented. The inbox, signal consumption and anchor planning continue (they write only the producer's own state, never canonical Film or Person state).
- **No hot loop.** A yield ends the run with the stop reason `yield` and a wake time at the holder's lease expiry at the latest; the Workflow parks until then (a kick wakes it earlier), and the held work is not mistaken for runnable work.
- **Reactive deferral.** A storage or authority-fence failure on one Film defers that Film durably (the Film row and its due rows: a retry after 1, 5, 15 minutes, then hourly), sets no `pending_since`, consumes no failure and sets no cooldown, and the run continues with independent Films. Three failing Films in one run end it with `error_backoff`, and the Workflow parks by the same tiers before the next run. The deferred Film resumes by itself when its retry is due.

## Priority and fairness

Eligibility is retained; priority is derived at pick time from authoritative facts, and **unknown is not false**. A state row carries the cohort of its Film: `live` when any retained membership is in a live scope (rated, Watchlist, Discovery), `history` when only the historical widening holds it. A pick examines at most a window of rows per cohort at the head of the state index (ordered by `retry_at`, then `due_since`, so a backed-off item is not in the window), and classifies exactly those Films:

- `personal`: true for an authoritative Watchlist member or a verified rated admission; false only for a Film held solely by the Discovery scope that has neither; otherwise unknown. A missing Watchlist projection row is never read as a negative for a Film another scope holds.
- `available`: true for a member of the pinned published EPG generation, false when that generation is readable and the Film is not in it, unknown when no generation is readable.
- A positive fact makes the Film live whatever its cohort; a history-only Film without one is background; a Film of a live scope is live unless both facts are known false.

Live Films are served oldest first. Background work progresses under sustained live arrivals in about one committed unit in eight; the share is measured in committed units over the recent runs recorded in the outbox, so a handover does not reset it, and a start that fails consumes none of it. These are engineering defaults in one module, not an approved quota.

## The Workflow shell

An instance of the Cloudflare Workflow `CatalogEnrichmentWorkflow` (binding `CATALOG_ENRICHMENT_WORKFLOW`) runs `drain` in steps. A step is a bounded slice of the instance budget (`STEP_BUDGET`), not a whole drain: a step that ends at its slice continues in the next step of the same instance, and the instance hands over to a successor at its own budget or at its round cap. The instance's statement accounting includes its orchestration statements and charges a failed step attempt as a whole slice, after which the instance backs off. The **run record** is the `summary_json` of the `projection_run` row named `catalog_enrichment_run`: the live instance, its phase (`running`, `parked` or `retired`), its due time and the successor of a handover, moved by compare-and-swap. The drainer's own lease stays the authority for writing; the record only says whom to wake.

- **No lost wakeup.** Parking and retiring first make the intent durable on the record and only then re-check for runnable work (a runnable signal or a due Film); work found cancels the intent. `kick` runs after a causal change commits: the canonical commit point (`commit` in `src/canonical-mutations.js`, the one batch site of the identity, protection, redirect, retirement and rated-admission writers) calls it best effort, after the batch, only when the batch touched a trigger-bearing table and work is runnable; a rolled-back batch, an absent runner or a failing wake changes nothing, and the reconcile recovers a lost wake. A parked instance also wakes at the earliest retry time of a backed-off Film item or signal. A `parked` instance gets a `kick` event, a `running` instance with a live owner needs none, a `retired` record or a missing owner creates the next instance, and a send that throws is read as "no live owner". A `running` record is believed only while the drainer lease is live or the record moved within two minutes, so a crashed instance never strands the work.
- **Parked wait.** The instance waits for the `kick` event with the time to the earliest due retry as its timeout; a timeout throws, is caught and is the due-time wake.
- **Handover.** At the statement budget the instance records a strictly newer successor, creates it (idempotent by id) and stops; the successor writes only after it acquires its own lease.
- **Reconcile.** `reconcile` is the safety net for a lost kick, a path without the hook and a crash after a commit; it creates nothing when nothing is runnable. Its cron expression is not in `wrangler.jsonc`: the activation change delivers it. A deploy carries the binding and the dispatch, which do nothing while the control is not `active`.

## Observability

- **Run outbox and Events Log.** Each run writes one row of `catalog_enrichment_tick` (`started`, then `finished` or `stopped` with its counts and stop reason). A terminal row is delivered to the user Events Log as one event of type `catalog_enrichment`, create-only under a key that is a pure function of the run and its end time, so a retry never duplicates (an existing key is delivery). A failed put moves the row back one hour per failed attempt, the attempt counter is the compare-and-swap, a row that keeps failing cannot starve another, and nothing is deleted. The event carries counts only, with source-specific requests, transport outcomes, definite failures and cooldown skips for `letterboxd`, `tmdb` and `wikidata`, never a Film id or a payload. Delivery runs at the end of a run and in the reconcile, and never blocks a run.
- **Monitor stream.** `catalog_enrichment` is judged by the existing Monitor from bounded read-only D1 facts (`readMonitorFacts`); the Monitor keeps no enrichment clock or R2 record. A missing schema or control row and an `inactive` control are neutral, a pause is `delayed` and never alerts. It reports an abandoned run (a record or open run entry stale and no live drainer lease; a parked or handed-over run is healthy, and a stale record under a live lease is a long step), due work with no committed unit for the existing producer no-progress window, an upstream source with no successful answer for 24 hours while work is due (one issue per source), Films and parts that need the owner, and repairable work stuck at its recheck cap. Alerts use the standard confirmation, reminder and recovery planner. Undelivered run entries are shown, never judged.

## Not part of this contract yet

The `/admin/settings` page, the scope bootstraps and the Discovery and Watchlist emitters are separate deliveries.
