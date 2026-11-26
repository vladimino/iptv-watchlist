# AIR-686: historical Film enrichment plan (HA)

Date: **26 November 2026**. Scope: **L0 planning, offline only** (repository code at `main` `aa17470`, [ADR 0219](../../adr/0219-discovery-film-enrichment-and-refresh.md), [ADR 0211](../../adr/0211-catalog-enrichment-producer.md) and the dated [AIR-627](https://trello.com/c/IOERZ9GI) census comments). Card: [AIR-686](https://trello.com/c/ziqmHU3D), item "HA" of ADR 0219 decision 10. Parallel work: [AIR-605](https://trello.com/c/jnqrdG71). Parent: [AIR-655](https://trello.com/c/YIPK38Tg).

**Not done, by design:** no production read (no D1, R2 or Worker), no TMDB, Letterboxd or Wikidata request, no write, no migration, no flag, no Task, no activation. The card allows a read-only census only when separately authorized; none was. Every count below is a **dated AIR-627 aggregate** (25 Nov 2026, Film/Person g2, EPG P519), **not a live count and not a point-in-time snapshot**. The model of section 5 is an **estimate from code constants and stated assumptions**, not a measurement; the AIR-605 harness is the authority for real cost.

## 1. Verdict

1. **The historical cohort is bounded and small relative to the producer's design workload.** The dated upper bound is **12,255 Films** (2,525 minimal Discovery Films plus 9,730 projector-era Discovery Films), about **44 days of the current Discovery arrival rate** (about 280 Films per day). It is a one-off backlog, not a new steady-state load.
2. **Acquisition needs no new mechanism.** One TMDB response per Film carries core fields, every credit and the translations, exactly as the common producer fetches it. The history cohort is one more scope of the same drainer, queue and state owner (ADR 0219 decisions 1, 5, 10). **No legacy payload adoption.**
3. **The likely bottleneck is D1 statements for Person units, not upstream requests.** Upstream is about 12 k TMDB requests (plus Wikidata, section 5). Person acquisition is one receipted unit per missing Person with no per-Film cap (ADR 0219 decision 8), so cost scales with the cast size, which is **not measured** for this cohort.
4. **One structural finding the plan must handle (section 6, R1):** under ADR 0219 decision 5 a history Film that is **currently airing** is *live*, not background. Roughly half of the minimal cohort is airing (1,213 of 2,525 at P519), so a large part of the history cohort enters the *live* tier at activation and competes with new arrivals there, in age order.
5. **No new material owner choice is required to plan HR.** The material directions are already accepted in ADR 0219. HR itself still needs its own owner approval, after the gates of section 8. Section 9 lists the one conditional trade-off.

## 2. Cohort definition

**H (historical cohort)** = Films reachable from a `discovery_admission` row (current or superseded; membership is retained, P2 = B) that existed **before the Discovery stream scope is activated**, and that hold **no membership in any live scope** (rated, Watchlist, Discovery stream). Everything admitted after activation is stream (ADR 0219 decision 3, P1 = B). Identity is the trusted `tmdb` claim (the admission's `film_id` is `tmdb_<n>`, not `film.id`).

**Boundary risk found.** ADR 0219 deliberately adds no admission-time column. H is therefore defined by **absence of membership at the moment HR runs its bootstrap**. That is exact **only if the Discovery stream scope (C3c-A) is already activated**, because from then on every new admission carries a signal and a membership. If HR bootstrapped before C3c-A, a Film admitted between the bootstrap and C3c-A would belong to neither cohort. HR must therefore run its bootstrap after C3c-A, or HR's plan must define an explicit fence. This is an engineering ordering constraint, recorded as gate G6.

## 3. Measured cohort (dated, with sources and uncertainty)

All rows: [AIR-627 comments](https://trello.com/c/IOERZ9GI) of 24–25 Nov 2026 (Film/Person g2; EPG P519 for airing), L0 SELECT/EXPLAIN, `rows_written=0`. "Derived" means arithmetic by this report on two comments.

| Quantity | Value | Source and caveat |
| --- | --- | --- |
| `film` rows | 13,393 | census comment of 25 Nov 05:33 Madrid |
| `discovery_admission` rows | 12,642 (current 12,476, superseded 166) | same; **all** resolve through a trusted `tmdb` claim, 21 not to the literal `film:tmdb:<n>` (not orphans) |
| Minimal Discovery Films (since 16 Nov; `film_mutation` only: Film, `tmdb` claim, title) | **2,525** | no `film_metadata`, credits, aliases, dimensions; **0** overlap with rated, retention or Watchlist; 1,213 airing at P519 |
| Projector-era Discovery Films | **9,730** (audit comment of 25 Nov 12:00) | projector credits and aliases, mostly no `film_metadata` |
| Current admissions identity | 12,476 = 2,525 + **9,951** | **derived**: the 9,951 "enriched" figure of the continuation comment. The 9,730 vs 9,951 gap (**221**) is **not reconciled**; plausible cause is overlap with rated, Watchlist or retention Films, which is a hypothesis only |
| Rated Films | 714 (473 `metadata=missing`, no credits) | cohort of AIR-614 / AIR-607, **excluded** from H |
| Watchlist `watchlist_film` | 391 (9 more hold `retention.watchlist=1` without membership; ADR 0203 allows it) | cohort of AIR-615, **excluded** from H |
| Unresolved identities in the Discovery population | **0 observed** | 4 corrected TV Films and 406 LID-owned Films are not Discovery admissions; 20 watched+rated facts have no Film and are not cohort members |
| Future arrivals | about 2,525 in about 9 days, about **280 per day** | dated estimate, not a forecast |

**Cohort size.** Upper bound for H is **12,255** (2,525 + 9,730). The lower bound after removing overlaps with the live scopes is **not known**: the overlap of the 9,730 with rated and Watchlist was not measured (zero for the 2,525). Do not add the rated or Watchlist counts to H.

## 4. Per-field gaps (separate denominators; never summed)

| Field | Canonical state today | Gap for H | Evidence and uncertainty |
| --- | --- | --- | --- |
| Core (`film_metadata`: year, runtime, genres, poster, synopsis) | 414 physical rows in total (the retention/Watchlist cohort) | essentially **all** of H | `film_dimension.metadata=fresh` for 8,620 Films, of which 8,216 have no row: **status, not content**. The Discovery payload holds values (year, runtime, aliases 2,525 of 2,525; synopsis and genres 2,524; actors 2,523; directors 2,519; poster 2,517 of the minimal cohort) but it is **Discovery's serving record, never a source** |
| Credits | 116,114 credits on 10,383 Films (10,378 in the later comment) | **no credits:** 3,010 Films (13,393 − 10,383), of which 2,525 minimal + 473 rated = 2,998, **12 unexplained**. **Incomplete credits:** unknown for the projector-era Films | projector credits follow the ten-and-ten display heuristic, so "has credits" is **not** "complete". Completeness needs the full TMDB set (ADR 0219 decision 8). Average today is 11.2 credits per Film over 53,777 Persons |
| Russian title (typed `ru` translation) | none for any Discovery Film (reviewed or provisional exist only for LID and Watchlist Films) | **all** of H | arrives only through the historical scope (ADR 0219 decision 10) |
| Person display names | 111,619 of 116,114 credits have an alias but no localized name | **not an enrichment gap** | a reader gap, tracked by [AIR-656](https://trello.com/c/Gmp2zxKL); it affects what a user sees whatever HR writes |

## 5. Acquisition, cost and throughput

### 5.1 Options considered

| Option | Verdict | Reason |
| --- | --- | --- |
| **H-A** one TMDB response per Film (`movie/<id>?append_to_response=credits,translations`) through the common drainer, under the unchanged rules (anchors, agreement, precedence, provenance, receipts) | **Recommended; already decided in ADR 0219** | core, credits and translations share one request; no second producer or queue |
| H-B separate requests per part | rejected | about three times the TMDB requests for the same data, no benefit |
| H-C adopt Discovery payload values | rejected by the owner (T1-a) | the payload mixes TMDB with EPG fallbacks and is not a source |
| H-D fill only the missing fields of projector-era Films | not a distinct option | core fields are missing for almost all of them, so the same request is needed; unchanged-field writes are no-ops by the add-only and blank-never-overwrites rules |

**Applicable sources.** For a `tmdb`-anchored Film ADR 0211 decision 2 makes `tmdb` and `wikidata` applicable. `letterboxd` applies only with a trusted lid claim (415 Films hold one), so history makes about **2 requests per Film** (TMDB 1, Wikidata 1), not 4. Whether the history scope should skip Wikidata is **not** assumed: it would weaken the agreement check, so it is not an engineering default. Wikidata's limits are **not assessed** (gate G4).

### 5.2 Model (estimate, not measurement)

Per-Film D1 statements `S = F + 13·p·c + Σ(n_chunk + 11)`, where `c` is supported credits, `p` the share needing a **new** Person unit, chunks hold at most 50 credits. Constants come from code: `MUTATION_STATEMENT_CAP = 60` and the Person unit batch (6 fixed statements, one per external id and alias, a 2-statement receipt tail: `src/canonical-person-mutation-producer.js`, `src/canonical-mutations.js`), plus ADR 0211's per-unit reconcile read, reservation and state settle. **Assumptions:** `F = 30` fixed statements for the core and localization units and the planning reads; a Person unit about 13 statements; chunk overhead 11. These are not measured. `N = 12,255`, usable budget 5,000 statements per instance (ADR 0219 decision 6: budget 6,000 minus a reserve of about 1,000).

| Credits `c` per Film | New-Person share `p` | Statements per Film | Films per instance | Instances | Total statements |
| --- | --- | --- | --- | --- | --- |
| 12 (today's average) | 0.3 | ~100 | ~50 | ~245 | ~1.2 M |
| 12 | 0.7 | ~162 | ~31 | ~398 | ~2.0 M |
| 30 | 0.3 / 0.7 | ~188 / ~344 | ~27 / ~15 | ~461 / ~844 | ~2.3 M / ~4.2 M |
| 60 | 0.3 / 0.7 | ~346 / ~658 | ~14 / ~8 | ~849 / ~1,613 | ~4.2 M / ~8.1 M |
| 120 | 0.3 / 0.7 | ~651 / ~1,275 | ~8 / ~4 | ~1,596 / ~3,126 | ~8.0 M / ~15.6 M |

The cast size of the cohort and `p` are **the dominant unknowns**; the table brackets them, it does not predict. The existing Person table (53,777 Persons) lowers `p` for top-billed names, but whether those Persons share the TMDB namespace is not verified.

### 5.3 Bottlenecks and what they are not

- **Upstream TMDB:** about 12 k requests. At Discovery's 200 ms spacing that is about **41 minutes** of spacing, about 3.4 hours at one request per second. TMDB's protective limit (about 40 requests per second) is quoted from the owner handoff in ADR 0219 and **could not be verified in this session** (the TMDB documentation host is not reachable); one request per scope at a time and the shared cooldown keep the producer far below it. Not a bottleneck on these numbers.
- **D1 statements and Workflow instances:** the dominant cost (table above). The statement budget per instance, not wall time, bounds an instance; **no wall-clock figure is claimed**, because D1 latency under this write mix is unmeasured.
- **D1 `rows_written`:** an assumed 3 rows per credit and 8 per new Person gives roughly 1 M to 13 M rows across the bracket. Workers Paid includes **50 M rows written per month, then $1.00 per million** (Cloudflare D1 pricing, read 26 Nov 2026), so the bracket sits inside the allowance **by itself**. The account's current usage is **unknown**, and per `AGENTS.md` this is a measurement, not a gate.
- **Workflow steps** are billed beyond 500,000 per month once billing starts (Cloudflare Workers pricing, read 26 Nov 2026); step counts are unmeasured.
- **Wikidata** is the unassessed upstream limit (G4).
- **Steady state is cheap:** 280 arrivals per day at the same model is about 28 k to 357 k statements per day.

## 6. Priority, fairness, rollout and rollback

**R1 (structural, from the accepted ADR text).** ADR 0219 decision 5 precedence (1): a positive live fact (availability in the pinned EPG generation) makes a Film **live whatever its cohort**; the live tier is ordered oldest-`due_since` first. A history Film airing today is therefore live. History rows bootstrapped at one instant share one `due_since`, so **new arrivals sort behind the airing history backlog** until it drains. If the overlap resembled the minimal cohort's (1,213 of 2,525, about 48%), that would be on the order of **5,900 Films** in the live tier. This is an extrapolation from one cohort, **not a measurement**. The one-in-eight background share protects the history Films that are *not* airing and does not apply to these.

Default engineering mitigation (no ADR change): the history bootstrap is **paced in bounded pages**, so only a bounded number of history rows are due at a time and arrivals are not starved. Decision rule: only if the AIR-605 harness shows that paced history work still delays new-arrival latency does it become an owner trade-off (section 9).

**Rollout (proposed for HR, each step with its own gate):**
1. Prerequisites G1 to G6 (section 8) satisfied and HR separately approved.
2. Add the history scope row, disabled; verify the dormant state.
3. **Pilot slice:** a small bounded set of Films of every shape (minimal, projector-era, large cast, airing and not airing), with readback of per-field completeness, receipt counts, statements per Film and `rows_written` against the model. The result replaces section 5's assumptions.
4. Run the paced bootstrap, then drain under the common priority rules; report per-class latency, oldest due age and per-field coverage.
5. Natural acceptance by the coverage predicates of section 7; retire nothing else.

**Rollback.** Disable the history scope (work stops, signals are held, the emitters keep recording) and, if needed, pause the control. **Written values stay**: they are corrected through the ADR 0214 owner and review routes or by a forward write. A code revert stops future runs and leaves the inbox harmless; it does not undo written data. Deleting what history wrote is a separate, explicitly approved operation (high-impact class), not part of rollback.

## 7. Coverage definitions for HR acceptance

Each is a separate predicate with its own denominator (the cohort at bootstrap), reported per field, not as one percentage:

- **core complete:** `film_metadata` row with the supported fields written by the producer under provenance, per Film;
- **credits complete:** every supported credit of the verified response present by person identity (ADR 0219 decision 8), **not** "at least ten exist";
- **localization:** a typed `ru` title written, an explicit `complete_with_gaps` absence, or an `ambiguous` item awaiting the owner;
- **deferred repair:** items in `deferred_repair`, with class and age, are reported, never counted as complete;
- **excluded:** Films that left the cohort (retirement, conflict, merge) are listed, not silently dropped.

## 8. Gates and dependencies for HR (none is granted by this report)

| # | Gate | Why |
| --- | --- | --- |
| G1 | [AIR-605](https://trello.com/c/jnqrdG71) delivered with its harness acceptance | provides the drainer, inbox, priority, recovery and full credits; replaces section 5 estimates by measurements |
| G2 | the operation-key apply (AIR-603, M1) and the separate apply of C1's own schema ([AIR-606](https://trello.com/c/ubBrQe49)), with readback | ADR 0207 decision 7: the producer fails closed without them; AIR-606's existing AIR-275 dependency is **not** changed here |
| G3 | [AIR-607](https://trello.com/c/Daq02gYy) and [AIR-636](https://trello.com/c/0jJADYxg) natural acceptance | ADR 0219: mass enrichment waits for them |
| G4 | assessed upstream limits for Wikidata, and TMDB's limit verified against its documentation | unassessed or unverified today |
| G5 | the canonical credit reader prerequisite (bounded ordered reads, [AIR-656](https://trello.com/c/Gmp2zxKL) with AIR-647/649), proven end to end for more than 200 credits | a Film over 200 credits makes the whole canonical read refuse (`CREDIT_READ_CAP`); ADR 0219 decision 8 |
| G6 | C3c-A (Discovery stream activation) before the history bootstrap, or an explicit fence | section 2 cohort boundary |
| G7 | HR's own owner-approved plan, activation and L2/L3 gates | ADR 0219: HR is not planned or authorized now |

## 9. Owner choices

**None is required to accept this plan.** The material directions (one producer, no payload adoption, priority and fairness, full credits, history needing its own approval) are accepted in ADR 0219 and are cited, not asked again.

**Conditional trade-off, only if measured.** If the AIR-605 harness shows that history work affects new-arrival freshness even when paced (R1), the owner would choose between (a) accepting a bounded delay of new arrivals while airing history drains, which maximizes history coverage speed, and (b) a cohort-aware rule that gives history Films a lower tier than stream arrivals, which needs an amendment to ADR 0219 decision 5. Recommendation: (a) with paced bootstrap, because the backlog is a one-off of about 44 days of arrivals. Not asked now, because no measurement exists.

## 10. Separately authorized census (proposal only, not run)

If the owner wants measured counts before HR, a bounded read-only census would need an explicit authorization. It should measure, on **indexed** predicates with `EXPLAIN` first and a stated `rows_read` ceiling, no correlated join and no `json_each` over `links.json` (two earlier statements timed out and one read 83,348,478 rows): (a) H's size after removing members of rated, Watchlist and any membership; (b) the airing share of H against one pinned published generation, which resolves R1; (c) credits per Film and distinct Persons already present, which fixes `c` and `p`; (d) the 221 gap between 9,730 and 9,951. It must not claim a point-in-time snapshot.

## 11. Limits

- All counts are dated 24–25 Nov 2026 and move daily; the cohort grows by the Discovery admission rate until C3c-A.
- Section 5 is a model with stated assumptions; real statements per Film, latency and `rows_written` are unmeasured.
- TMDB's rate limit is quoted from ADR 0219 and unverified here; Wikidata's is unassessed.
- The overlap of the 9,730 with rated and Watchlist, the 221 gap and the 12 Films without credits are unexplained.
- The live status of AIR-605, AIR-606, AIR-607, AIR-636 and AIR-656 was not read for this report.
- No production fetch, write, migration, activation, flag or Scheduled Task occurred.
