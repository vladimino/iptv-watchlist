# AIR-374 inventory of the readers of canonical Film/Person data and of `canonicalFreshness` (14 Nov 2026)

**Captured:** 2026-11-14 (UTC), repository at `origin/main` `f314b33`. **Method:** static code reading and `grep` only. No production read, no D1, R2 or connector access, no code change. **Scope:** the "limited inventory" of the owner decision of 14 Nov 2026 on [AIR-374](https://trello.com/c/ha7ais3w) (S-C): the readers of `canonicalFreshness`, and the dependency of Film membership and `film_credits` on Person identities. It does not decide S-C, does not split the pass and changes no reader.

## Verdict in five lines

1. **Nobody in the Worker calls `canonicalFreshness`.** Its only users are the S4-4 driver (`readCanonicalFreshness`, `readerDecision`), the run module, tests and documentation. [ADR 0128](../../adr/0128-epg-canonical-producer-durable-execution.md) decision 11 already says no reader consumes canonical EPG membership while the layer is dormant, and that the wiring PR enumerates the readers and assigns each a mode. The audit test it promises for a direct read of canonical membership does not exist yet.
2. **Two live Worker readers are marker-gated, not freshness-gated.** `GET /api/programme` and `GET /api/watchlist` read their titles through `catalogTitlesFromD1` at marker `open`, and the `/api/d1/*` views read Film and Person rows. Both check only the marker state and generation, never whether the producer pass is complete.
3. **The title readers depend on `film_facts` units alone.** The effective localization row is materialised in the same batch as the Film facts (`src/canonical-film-writers.js`), and `catalogTitlesFromD1` reads exactly those rows for the Film ids of the published documents.
4. **Today `current` waits for the whole plan.** `canonicalFreshness` looks at the live `film_facts` results only, but `current` also requires `pass_state='passed'`, which is the cursor passing the last unit of the plan, Person and credit units included.
5. **`film_credits` units depend on Person identities, and they are last in the plan.** The plan order is `film_facts`, `person_mutation`, `person_state`, `film_credits` (`KIND_RANK`), and a credit whose Person is absent is a recoverable `film_person_reference` refusal.

## `canonicalFreshness` and its consumers

| Consumer | Kind | Note |
| --- | --- | --- |
| `readCanonicalFreshness`, `readerDecision` in `src/canonical-producer-driver.js` | The S4-4 consumer boundary | Unbundled and dormant; `readerDecision` takes a mode (`membership` or `display`) |
| `canonicalFreshness` in `src/canonical-producer-run.js` | The pure function | Inputs: the published generation, the run row of that generation, the live `film_facts` results |
| Tests and references | `tests/canonical-producer-driver.mjs`, `tests/canonical-producer-run.mjs`, `tests/canonical-producer-schema.mjs`, the producer references | No Worker or route consumer |

## Readers of canonical Film/Person rows

The marker-gated reader module the Worker bundles is `src/canonical-catalog-reader.js`. The remaining-readers registry in the same file (`CANONICAL_READER_REGISTRY`, 20 entries) lists the readers and writers of the former R2 mirrors.

### A. In the Worker today, gated by the marker only

| Reader | What it reads at `open` | Depends on |
| --- | --- | --- |
| `GET /api/programme` and `GET /api/watchlist` titles (`catalogTitlesFromD1` through `src/worker.js`) | `film_dimension` rows with `dimension='localization'`, `status='provisional'`, for the Film ids of the published documents; a Film with no row is simply absent from the answer | `film_facts` units only. No state or generation appears in the response |
| `/api/d1/*` views (`src/catalog-d1.js`: `status`, `persons`, `persons/review`, `persons/{role}/{key}`, `.../identity`, `films/{id}`) | Film and Person rows read directly; owner-facing | Person units for people, Film units for Films |
| Rated-archive fallback of the film route (`catalogAdmittedFilmFromD1`) | `film_rated_admission`, identity claims, redirects, the retirement ledger | Not the EPG pass: rated admission writes these rows |

All three re-read the marker after their reads and refuse on a move (`film_person_generation_moved`); none reads the producer run.

### B. In the repository, not wired

`src/canonical-read-model.js` (`readFilms`, `readPersons`) is the bulk read model for the future UI, API, Admin, Finds, film page and person filmography. Nothing in the Worker imports it. A person filmography needs the Person and credit units to be complete; a film page needs the Film facts.

### C. Readers of the R2 mirrors that are not yet moved

The registry marks eleven `freeze` entries `moved:false` (the optional metadata of the film route, the available route, the ratings film labels, the writers `metadataSync` and `epgSync`, the Admin `read`, `limbo`, `health` and Letterboxd archive readers, the footer and the migration export). The mirrors freeze at `open`, so moving them is open cutover-readiness work, not a freshness question; each will need a mode when it moves. The five `exception` entries stay as they are by owner decision.

### Not classified

`src/prediction-d1.js`, `src/owner-review-d1.js` and `src/offline-importer.js` appear in the file list that reads canonical tables; they were not read for this page and are not claimed to be freshness readers. The R2-mirror readers of section C were not read one by one.

## The dependency of membership and credits on Persons

| Fact | Evidence in the code |
| --- | --- |
| The plan order is Film facts, then Person mutations, then Person states, then credits | `KIND_RANK` in `src/canonical-producer-run.js`: `film_facts` 1, `person_mutation` 2, `person_state` 3, `film_credits` 4; the cursor key is (kind rank, id) |
| A credit refers to Persons that must exist | `film_credits` adds credits to ONE Film (`src/canonical-person-adapters.js`); `film_person_reference` (a credit's Person or a referenced Film is absent) is classed RECOVERABLE (`src/canonical-producer-run.js`) |
| Membership is the Film-facts unit | `watchlist_film` is written by `writeFilmFacts` (`src/canonical-film-writers.js`); no reader route reads `watchlist_film` today |
| `canonicalFreshness` counts live `film_facts` results only | `readCanonicalFreshness` passes `liveFilmFactsResults`; ADR 0128 decision 11 calls these the membership-affecting results |

With the modelled generation of the [synthetic measurement](air-465-m2b-synthetic-scale-2026-11-14.md) (397 `film_facts`, 6,452 `person_mutation`, 391 `film_credits`), the first 397 units of the plan are the Film facts and the credits are the last 391. A claim that covers the credits therefore covers essentially the whole plan; a claim that covers only the Film facts is the first 397 units.

## What this implies, and what it does not decide

- The only live reader that needs a freshness-like guarantee today (the programme and watchlist titles) depends on the first 397 units, while `current` waits for all 7,240. Whether to add a narrower claim, split the pass or keep one claim is the S-C question. **The owner has not approved a split**, and this page does not choose.
- After the mirrors freeze at `open`, the titles of a Film that is new to a generation reach the title readers when its `film_facts` unit has been applied, not at publication. With the current reader a Film with no row is silently missing and the response carries no state. Assigning the title readers a mode (fail closed, or display-only with the state and generations visible, as decision 11 allows) belongs to the wiring PR, not to this page.
- The `/api/d1/*` views and the future filmography depend on Person and credit completeness, which is a property of the whole plan.

## Not verified here

- Production behaviour of any route, the live marker, and the live EPG and producer state.
- Whether `film_facts` units alone fill every title the readers expect (for example titles written by the dictionary pass rather than the Film facts): the localization row of the Film facts writer was read, the dictionary producer was not traced.
- The unclassified modules and the R2-mirror readers listed above.

Related: [ADR 0128](../../adr/0128-epg-canonical-producer-durable-execution.md), [producer driver reference](../../reference/data/producer-driver.md), [D-C decision pack](../../runbooks/film-person-d-c-decision-pack.md), [Back to the D1 migration evidence index](README.md).
