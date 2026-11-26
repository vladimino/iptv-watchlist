# AIR-686: historical Film enrichment plan (HA)

Date: **26 November 2026** (revised the same day after the independent review of [PR #1029](https://github.com/vladimino/iptv-watchlist/pull/1029) at `2b5b12b`). Scope: **L0 planning, offline only** (repository code at `main` `aa17470`, [ADR 0219](../../adr/0219-discovery-film-enrichment-and-refresh.md), [ADR 0211](../../adr/0211-catalog-enrichment-producer.md) and the dated AIR-627 census comments linked in section 3). Card: [AIR-686](https://trello.com/c/ziqmHU3D), item "HA" of ADR 0219 decision 10. Parallel work: [AIR-605](https://trello.com/c/jnqrdG71). Parent: [AIR-655](https://trello.com/c/YIPK38Tg).

**Not done, by design:** no production read (no D1, R2 or Worker), no TMDB, Letterboxd or Wikidata request, no write, no migration, no flag, no Task, no activation, no new census. Every count below is a **dated AIR-627 aggregate** (24–25 Nov 2026, Film/Person g2, EPG P519), **not a live count and not a point-in-time snapshot**. The model of section 5 is an **estimate from code constants and stated assumptions**, not a measurement; the AIR-605 harness and the pilot of section 6 are the authority for real cost.

## 1. Verdict

1. **The historical cohort is bounded today but not fixed.** Two figures, with different meanings, must not be confused:
   - **12,255 Films** is an **identified planning scenario**: the sum of two identified subpopulations (2,525 minimal Discovery Films and 9,730 projector-era Discovery Films).
   - **12,642 admission rows** (12,476 current, 166 superseded) is the **dated row-count ceiling on the resolved Discovery population**, subject to the snapshot and identity caveats of section 3. They are **rows, not distinct Films**, and the **387-row difference to the scenario is not reconciled as a Film count** (166 superseded rows and 221 current rows that the two subpopulations do not explain; whether they overlap other cohorts or belong to H is unknown).
   - **Neither is a ceiling at activation**: Discovery admissions keep arriving (about 280 Films per day, a dated estimate). For scale only, 12,255 Films equal about 44 days of that arrival volume. This is an **arrival-volume equivalence, not a drain estimate**.
2. **Acquisition needs no new mechanism.** One TMDB response per Film carries its own parts (core fields, every supported credit, the translations). History is one more scope of the same drainer, queue and state owner (ADR 0219 decisions 1, 5, 10). **No legacy payload adoption.**
3. **The likely bottleneck is D1 statements for Person units, not upstream requests.** Person acquisition is one receipted unit per missing Person with no per-Film cap (ADR 0219 decision 8), so cost scales with cast size, which is **not measured** for this cohort.
4. **Structural consequence of accepted priority (R1, section 6):** a history Film that is currently available in the pinned EPG generation is *live*, not background, so part of the history cohort competes with new arrivals in the live tier. The share is **unmeasured**; the only evidence is that 1,213 of the 2,525 minimal Films were airing at P519.
5. **The bootstrap needs a correct invariant (section 2):** history is classified by **absence of stream evidence (an `admitted` signal row or a Discovery membership, in any state)**, not by absence of membership, because membership is asynchronous. Over-inclusion is harmless, omission is the failure.
6. **No new material owner choice is required.** AIR-686 itself requires the owner's acceptance of this plan; that disposition is **separate from HR authorization**, which still needs its own approved plan and gates (section 8).

## 2. Cohort definition and the bootstrap invariant

**Two different things, kept apart.**
- **H planning coverage** (this report): what is known about the historical population, with dated counts and stated uncertainty (section 3). It is not a classifier and authorizes nothing.
- **Safe activation eligibility** (HR, later): the live invariant below, evaluated by HR's own preflight at the moment of activation.

**H** = Films reachable from a `discovery_admission` row (current **or superseded**; membership is retained, P2 = B) that carry **no stream evidence**, resolved through the trusted `tmdb` claim (the admission's `film_id` is `tmdb_<n>`, not `film.id`). ADR 0219 adds no admission-time column, and none is invented here.

**Invariant for the historical bootstrap (the minimum HR must prove).**

1. **Stream evidence is synchronous; membership is not.** From the activation of the Discovery stream scope (C3c-A, the permanent `activated` flag), every authoritative new admission writes an `admitted` signal row **in the causal transaction**: `pending` on the steady path, `staged` inside a resolver transfer (ADR 0219 decisions 2 and 3). The signal row persists after consumption. A Discovery membership appears only later, when C1 consumes the signal and the Film resolves. A post-activation admission may therefore hold a pending, held, unresolved or staged signal and **no membership yet**. The classifier is **signal evidence or membership, in any state**, never membership alone.
2. **H candidates** are resolvable admission rows with **no stream evidence**. A non-authoritative import or restore leaves no signal (its staged signals are deleted), so its rows are history candidates, as ADR 0219 requires. A pre-activation row updated later has no update trigger and stays history.
3. **Unclassified candidates are accounted, not dropped.** A candidate whose signal is `staged` for an **unsettled transfer** is unclassified: it is not bootstrapped as history, and the bootstrap's own continuation re-evaluates it automatically until the transfer commits (the signal becomes `pending`, hence stream) or the staged signal is deleted (the row becomes a candidate). A candidate whose Film is not resolvable yet (an admission without a Film, or one of the 21 admission ids that are not the literal `film:tmdb:<n>`, all resolved through a trusted claim in the census) is **unresolved**: it resolves through the existing claim and `anchor_changed` path and is reported separately, never as complete and never as excluded.
4. **Over-inclusion is harmless; omission is not.** A Film has one state row per part and source and is planned once whatever its scopes (ADR 0219 decision 1); priority is the highest class its authoritative facts give. Adding a history membership to a Film that is also rated, Watchlist or stream duplicates no work and lowers no class. The bootstrap therefore **does not wait** for the rated or Watchlist memberships to be materialized and does not exclude a Film because a live scope has not created its membership yet. Only the **reporting denominators** subtract overlap, using the approved live-scope predicates (rated: `film_rated_admission.verified_at >= cutoff_at`; Watchlist: `watchlist_film`). The failure to prevent is a Film that reaches **no** scope.
5. **Merges and retirements are different.** A redirect or merge: membership and state **follow the survivor** and are counted once (deduplicated by survivor). A retirement or a verified identity conflict stays **owner-held**: listed, not counted as drained and not dropped (ADR 0219 decision 3).
6. **Minimal real dependency.** C3c-A must be **activated** first, so that every later admission leaves stream evidence; HR's bootstrap would otherwise miss a Film admitted between the bootstrap and C3c-A (neither signal nor membership). The existing **activation preflight** applies (no transfer in `loading`, no stale staged signal). There is **no dependency on draining the live queue**, no admission timestamp and no second producer. The bootstrap runs through the common mechanism, as the other scopes' bootstraps do: the gated trigger first, then a bounded, version-fenced, resumable paged pass under the scope revision with automatic continuation (ADR 0219 decision 3). HR specifies the implementation.

## 3. Measured cohort (dated, with exact sources and uncertainty)

Sources, all L0 SELECT/EXPLAIN with `rows_written=0`: **[A]** [census of 24 Nov 21:18 UTC](https://trello.com/c/IOERZ9GI#comment-6b05ff4285d1720e873e54fb); **[B]** [census of 25 Nov 05:33 UTC](https://trello.com/c/IOERZ9GI#comment-6b067313f616e5e51d1db9e1); **[C]** [continuation of 25 Nov 08:48 UTC](https://trello.com/c/IOERZ9GI#comment-6b06a0deb3fbeaeb5f93f8b2); **[D]** [disposition of 25 Nov 12:46 UTC](https://trello.com/c/IOERZ9GI#comment-6b06d8c178a1d27ed10c4e8f). "Derived" means arithmetic by this report on those comments. The comments are **live-database aggregates taken at different moments, not a coherent snapshot**.

| Quantity | Value | Source and caveat |
| --- | --- | --- |
| `film` rows | 13,393 | [B] |
| `discovery_admission` rows | **12,642** (current 12,476, superseded 166) | [B]; **rows, not distinct Films**; all resolve through a trusted `tmdb` claim, 21 not to the literal `film:tmdb:<n>` (not orphans) |
| Minimal Discovery Films (since 16 Nov; `film_mutation` only: Film, `tmdb` claim, title) | **2,525** | [B], [C]; no `film_metadata`, credits, aliases or dimensions; **0** overlap with rated, retention or Watchlist; 1,213 airing at P519 |
| Projector-era Discovery Films | **9,730** | [D], with ADR 0219's census paragraph; projector credits and aliases, mostly no `film_metadata` |
| "Enriched" Discovery Films | 9,951 | [C]: 12,476 current rows = 2,525 + **9,951** (**derived**). The gap to 9,730 is **221** current rows, **unexplained**: they may overlap rated, Watchlist or retention Films, or belong to H; this is a hypothesis, not a finding |
| Rows not covered by the two identified subpopulations | **387** = 166 superseded + 221 current | **derived**; **not reconciled as a Film count** |
| Rated Films | 714 (473 `metadata=missing`, no credits) | [A], [B]; cohort of [AIR-614](https://trello.com/c/wUHl13Yw) / [AIR-607](https://trello.com/c/Daq02gYy) |
| Watchlist `watchlist_film` | 391 (9 more hold `retention.watchlist=1` without membership, as ADR 0203 allows) | [B]; cohort of [AIR-615](https://trello.com/c/fCXSmk7K) |
| Unresolved identities | **0 observed** among admission rows | [B]; 4 corrected TV Films and 406 LID-owned Films are not Discovery admissions; 20 watched+rated facts without a Film are not cohort members |
| Future arrivals | about 2,525 in about 9 days, about **280 per day** | [B]; dated estimate, not a forecast |

**Sizing, stated honestly.** Planning scenario **12,255 Films**; dated row-count ceiling **12,642 rows** (not a Film count); the overlap with rated and Watchlist of the 9,730 and of the 387 other rows is **not measured** (zero for the 2,525). Do not add the rated or Watchlist counts to H. Neither figure bounds the cohort at activation.

## 4. Per-field gaps (explicit denominators; never summed)

Two denominators appear below and must not be mixed: **global** (all 13,393 Films) and **H** (the identified scenario of 12,255 Films, section 3).

| Field | Canonical state today | Gap | Evidence and uncertainty |
| --- | --- | --- | --- |
| Core (`film_metadata`: year, runtime, genres, poster, synopsis) | 414 physical rows **globally** (the retention/Watchlist cohort) | essentially **all of H** | `film_dimension.metadata=fresh` for 8,620 Films, of which 8,216 have no row: **status, not content** [A]. The Discovery payload holds values (for the minimal cohort: year, runtime, aliases 2,525 of 2,525; synopsis and genres 2,524; actors 2,523; directors 2,519; poster 2,517 [C]) but it is **Discovery's serving record, never a source** |
| Credits, **existing supported relationships** | 116,114 credits on 10,383 Films **globally** [A] (10,378 in [C]) | **global:** 3,010 Films without any credit (13,393 − 10,383), of which 2,525 minimal + 473 rated = 2,998, **12 unexplained**. **H:** the 2,525 minimal Films have none; the projector-era Films hold projector relationships | what is stored follows the ten-and-ten display heuristic, so "has credits" is **not** "complete". Average today 11.2 credits per Film over 53,777 Persons |
| Credits, **full source coverage** | not measured | unknown for every Film | needs the full verified TMDB set (ADR 0219 decision 8); a Film has full coverage only when every supported credit is present by person identity |
| Russian title (typed `ru` translation) | none for any Discovery Film; reviewed and provisional exist only for LID and Watchlist Films | **all of H** | arrives only through the historical scope (ADR 0219 decision 10) |
| Person display names | 111,619 of 116,114 credits have an alias but no localized name | **not an enrichment gap** | a reader gap, tracked by [AIR-656](https://trello.com/c/Gmp2zxKL); it affects what a user sees whatever HR writes |

## 5. Acquisition, cost and throughput

### 5.1 Options considered

| Option | Verdict | Reason |
| --- | --- | --- |
| **H-A** one TMDB response per Film (`movie/<id>?append_to_response=credits,translations`) through the common drainer, under the unchanged rules (anchors, agreement, precedence, provenance, receipts) | **Recommended; already decided in ADR 0219** | the response covers **its own parts** (core, credits, translations); no second producer or queue |
| H-B separate requests per part | rejected | about three times the TMDB requests for the same data |
| H-C adopt Discovery payload values | rejected by the owner (T1-a) | the payload mixes TMDB with EPG fallbacks and is not a source |
| H-D fill only the missing fields of projector-era Films | not a distinct option | core fields are missing for almost all of them, so the same request is needed; unchanged fields are no-ops (add-only, blank-never-overwrites) |

**What each source contributes (ADR 0211 decisions 2 and 3).**
- **TMDB:** core fields, the credits and the `ru` translation (its own `localization:tmdb` row). One response covers these parts.
- **Letterboxd:** applies only with a trusted lid claim (415 Films hold one). Its page is where **anchor agreement** is checked; it also writes its own localization row.
- **Wikidata:** needs only the TMDB anchor; it is a **Russian-title localization source** with its own state row, **not an identity agreement**. Precedence among automatic sources is `letterboxd`, `tmdb`, `wikidata`. Dropping Wikidata for history would remove a lower-precedence source row; it is a scope reduction relative to ADR 0211 and is **not assumed** by this plan.

**Request count, no hard bound claimed.** A `tmdb`-anchored Film typically needs TMDB (1) and Wikidata (at least 1); Letterboxd adds up to 2 requests when a trusted lid exists. ADR 0211 caps one acquisition at 4 requests per Film. Retries after transport failures, a redirect, an active shared cooldown and later refresh acquisitions add requests and are **not modeled**; the lower bound used below is about 2 requests per Film.

### 5.2 Model (estimate, not measurement)

Per-Film D1 statements `S = F + 13·p·c + Σ(n_chunk + 11)`, where `c` is supported credits, `p` the share needing a **new** Person unit, chunks hold at most 50 credits. Constants come from code: `MUTATION_STATEMENT_CAP = 60` and the Person unit batch (6 fixed statements, one per external id and alias, a 2-statement receipt tail: `src/canonical-person-mutation-producer.js`, `src/canonical-mutations.js`), plus ADR 0211's per-unit reconcile read, reservation and state settle. **Assumptions:** `F = 30` fixed statements for the core and localization units and the planning reads; a Person unit about 13 statements; chunk overhead 11. These are not measured. `N = 12,255` (the planning scenario, not a ceiling), usable budget 5,000 statements per instance (ADR 0219 decision 6: budget 6,000 minus a reserve of about 1,000).

| Credits `c` per Film | New-Person share `p` | Statements per Film | Films per instance | Instances | Total statements |
| --- | --- | --- | --- | --- | --- |
| 12 (today's average) | 0.3 | ~100 | ~50 | ~245 | ~1.2 M |
| 12 | 0.7 | ~162 | ~31 | ~398 | ~2.0 M |
| 30 | 0.3 / 0.7 | ~188 / ~344 | ~27 / ~15 | ~461 / ~844 | ~2.3 M / ~4.2 M |
| 60 | 0.3 / 0.7 | ~346 / ~658 | ~14 / ~8 | ~849 / ~1,613 | ~4.2 M / ~8.1 M |
| 120 | 0.3 / 0.7 | ~651 / ~1,275 | ~8 / ~4 | ~1,596 / ~3,126 | ~8.0 M / ~15.6 M |

Cast size and `p` are **the dominant unknowns**; the table brackets them, it does not predict. The existing Person table (53,777 Persons) lowers `p` for top-billed names, but whether those Persons share the TMDB namespace is not verified. Totals scale linearly with the cohort size actually found.

### 5.3 Bottlenecks and what they are not

- **Upstream TMDB:** about 12 k requests for the scenario. At Discovery's 200 ms spacing that is about **41 minutes** of spacing, about 3.4 hours at one request per second. TMDB's protective limit (about 40 requests per second) is quoted from the owner handoff in ADR 0219; the producer's one-request-per-scope rule and the shared cooldown with `Retry-After` keep it far below. Concrete provider behavior is assessed under G4.
- **D1 statements and Workflow instances:** the dominant cost (table above). The statement budget per instance, not wall time, bounds an instance; **no wall-clock figure is claimed**, because D1 latency under this write mix is unmeasured.
- **D1 `rows_written`:** an assumed 3 rows per credit and 8 per new Person gives roughly 1 M to 13 M rows across the bracket. Workers Paid includes **50 M rows written per month, then $1.00 per million** (Cloudflare D1 pricing, read 26 Nov 2026), so the bracket sits inside the allowance **by itself**; the account's current usage is **unknown**. Per `AGENTS.md` this is a measurement, not a gate.
- **Workflow steps** are billed beyond 500,000 per month once billing starts (Cloudflare Workers pricing, read 26 Nov 2026); step counts are unmeasured.
- **Wikidata** limits are not assessed (G4).
- **Steady state is cheap:** 280 arrivals per day at the same model is about 28 k to 357 k statements per day.

## 6. Priority, rollout and rollback

**R1 (structural, from the accepted ADR text).** ADR 0219 decision 5 precedence (1): a positive live fact (availability in the pinned EPG generation) makes a Film **live whatever its cohort**; the live tier is ordered oldest-`due_since` first. A history Film airing today is therefore live. History rows enter at the bootstrap and arrivals come later, so **new arrivals can sort behind airing history work** while it drains. How many history Films are airing is **not measured** (only 1,213 of the 2,525 minimal Films at P519), so no size is claimed. The one-in-eight background share protects history Films that are *not* airing and does not apply to these.

**Default, no new restriction:** the bootstrap runs in **bounded pages with automatic continuation** and the drainer stays **work-conserving**, using the resources available. This plan proposes **no quota, no manual wave gate and no artificial delay**. Actual mixed-workload latency and fairness (per-class latency, oldest due age) are evaluated by the AIR-605 harness and the pilot; only if they show a material effect on new arrivals does a trade-off go to the owner (section 9).

**Rollout (proposed for HR, each step under its own gate):**
1. Gates of section 8 satisfied and HR separately approved.
2. Add the history scope row, disabled; verify the dormant state.
3. **Pilot slice** (engineering validation, **not** an owner gate per page). Expected outcome: (a) measured statements and `rows_written` per Film for every shape (minimal, projector-era, large cast, airing and not airing) replace the assumptions of section 5; (b) classification is exhaustive: every candidate is exactly one of bootstrapped, stream, unclassified (staged), unresolved or owner-held, and the counts add up to the candidate count; (c) the completeness predicates of section 7 evaluate correctly, including a Film over 200 credits, protected values and an ambiguous translation; (d) provider behavior (a 429 with `Retry-After`, the shared cooldown) is observed and handled without consuming failure budget; (e) a rerun writes no duplicate receipts or values.
4. Run the bootstrap with automatic continuation, then drain under the common priority rules, reporting per-class latency, oldest due age and per-field coverage.
5. Natural acceptance by the coverage predicates of section 7.

**Rollback.** Disable the history scope (work stops, signals are held, the emitters keep recording) and, if needed, pause the control. **Written values stay**: they are corrected through the ADR 0214 owner and review routes or by a forward write. A code revert stops future runs and leaves the inbox harmless; it does not undo written data. Deleting what history wrote is a separate, explicitly approved, high-impact operation, not part of rollback.

## 7. Coverage definitions for HR acceptance

Each is a separate predicate with its own denominator (the candidate count at bootstrap, split by the classes of section 2), reported per field, never as one percentage. "Complete" is always **per applicable verified source and supported field**:

- **core:** every supported field present from the applicable verified source, with provenance written by the producer; a **protected** value (metadata lock, owner pin) is reported as protected, not as written and not as a gap;
- **credits:** every supported credit (actor, director) of the **verified** response present by person identity (ADR 0219 decision 8); "at least ten exist" is not complete, and an unreadable or incomplete response is never complete;
- **localization, per applicable source:** complete means a typed `ru` title was written **or** the source legitimately has no `ru` entry (`complete_with_gaps`). An **ambiguous translation is unresolved**, waiting for the owner, and is **never** counted as successful localization. Reviewed and owner values on top are reported as protected;
- **deferred repair:** items in `deferred_repair`, with class and age, are reported and never counted as complete;
- **not drained, with reason:** owner-held items (retirement, verified conflict, ambiguous translation), unresolved candidates and unclassified candidates are listed separately; **merged Films are counted once under their survivor**, so coverage is deduplicated and no work is dropped.

## 8. Gates and dependencies for HR (none is granted by this report)

| # | Gate | Why |
| --- | --- | --- |
| G1 | [AIR-605](https://trello.com/c/jnqrdG71) delivered with its harness acceptance | provides the drainer, inbox, priority, recovery and full credits; replaces section 5 estimates by measurements |
| G2 | the operation-key apply (AIR-603, M1) and the separate apply of C1's own schema ([AIR-606](https://trello.com/c/ubBrQe49)), with readback | ADR 0207 decision 7: the producer fails closed without them; AIR-606's existing AIR-275 dependency is **not** changed here |
| G3 | [AIR-607](https://trello.com/c/Daq02gYy) and [AIR-636](https://trello.com/c/0jJADYxg) natural acceptance | ADR 0219: mass enrichment waits for them |
| G4 | **assessment of concrete provider behavior and limits** (TMDB `429`/`Retry-After` through the shared cooldown, Wikidata endpoint behavior) in the harness and the pilot | an engineering assessment, not a separate blocking approval |
| G5 | the canonical credit reader prerequisite (bounded ordered reads, [AIR-656](https://trello.com/c/Gmp2zxKL) with AIR-647/649), proven end to end for more than 200 credits | a Film over 200 credits makes the whole canonical read refuse (`CREDIT_READ_CAP`); ADR 0219 decision 8 |
| G6 | C3c-A (Discovery stream activation) **activated**, with its activation preflight, and the classifier of section 2 (stream evidence, not membership alone) | the minimal real dependency; no queue-drain dependency |
| G7 | HR's own owner-approved plan, activation and L2/L3 gates | ADR 0219: HR is not planned or authorized now |

## 9. Owner choices

**None is required to accept this plan.** The material directions (one producer, no payload adoption, priority and fairness, full credits, history needing its own approval) are accepted in ADR 0219 and are cited, not asked again.

**Acceptance of this plan.** AIR-686 requires the owner's acceptance of this plan. That disposition is **separate from HR authorization**, which stays gated by section 8 and G7.

**Conditional trade-off, only if measured.** If the AIR-605 harness or the pilot shows a material effect on new-arrival latency under mixed load (R1), the owner would choose between (a) accepting a bounded delay of new arrivals while airing history drains, which favors history coverage speed, and (b) a cohort-aware rule that gives history Films a lower tier than stream arrivals, which needs an amendment to ADR 0219 decision 5. No measurement exists, so nothing is asked now.

## 10. Limits and unknowns

- All counts are dated 24–25 Nov 2026, taken at different moments, and move daily; the cohort grows with Discovery admissions until C3c-A and beyond.
- 12,255 is a planning scenario and 12,642 a row-count ceiling; the 387-row difference, the 221 unexplained current rows and the 12 Films without credits are **not reconciled**; the overlap of H with rated and Watchlist is unmeasured for everything except the 2,525.
- Section 5 is a model with stated assumptions; real statements per Film, latency, `rows_written`, request retries and the share of airing history Films are unmeasured. TMDB's rate limit is quoted from ADR 0219 (its documentation host was not reachable in this session); Wikidata's is unassessed.
- The live status of AIR-605, AIR-606, AIR-607, AIR-636 and AIR-656 was not read for this report.
- Resolving these unknowns needs measurement that this card does not request or authorize.
- No production fetch, write, migration, activation, flag or Scheduled Task occurred.
