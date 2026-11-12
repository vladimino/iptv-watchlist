# Film/Person E6: read-only budget measurement for the EPG producer (GO package; first production run performed 12 Nov 2026, see the status update)

**Status update (12 Nov 2026):** the package was prepared and not executed until that day; the first production measurement with this procedure was performed on 12 Nov 2026 under an owner GO that covered that one run only; it is not a standing authorization and a repeat needs its own GO. Result: [evidence record](../evidence/d1-migration/air-374-e6-production-measurement-2026-11-12.md). The procedure below is unchanged.

**Role:** the exact scope, statements, caps, stop rules, output format and owner GO text for the separate read-only diagnostic that decision E6 of the [holdpoint decision pack](film-person-holdpoint-decision-pack.md) asks for ahead of P3a ([AIR-374](https://trello.com/c/ha7ais3w)): the real volume of Film and Person units per EPG run, the D1 round trips one unit costs, and from them the real per-run unit limit. The owner decided on 12 Nov 2026 that this is step 2: a SEPARATE read-only diagnostic, and only then the choice of the per-run limit. The provisional ceiling of 50 units stays provisional and is not a production acceptance.

**This page authorizes nothing, and nothing in the pull request that adds it authorizes a production read.** The offline tool [`scripts/film-person-e6-measure.mjs`](../../scripts/film-person-e6-measure.mjs) touches no network, D1, R2, Cloudflare or connector. A production run of section 4 needs its own owner GO (section 8); a pass of the tool is evidence, never a GO. Every value that describes production here is "not measured" until that run; unmeasured values are marked so.

## 1. What is measured, and why now

The dormant EPG producer layer of P3a ([`src/canonical-epg-producer.js`](../../src/canonical-epg-producer.js), [ADR 0125](../adr/0125-epg-producer-layer-film-facts.md); that ADR and code are the authority, not this page) applies one `film_facts` unit per Film that an EPG run observed and one release-only unit per departed member, through `applyFilmFacts` of [`src/canonical-producer-adapters.js`](../../src/canonical-producer-adapters.js) ([ADR 0123](../adr/0123-producer-receipt-adapter-film-facts.md)). It carries a PROVISIONAL hard ceiling of 50 units per call and a default of 25. Its own comment estimates about 10 D1 round trips per changed Film against the repository's 800-query run budget. Two things are unmeasured: how many units a real run has, and what a unit really costs. The first needs production counts; the second does not, and section 3 measures it offline.

## 2. Questions, sources and what only production can answer

| Question | Answered by | Production only? |
| --- | --- | --- |
| Films observed per published generation (programme members, watchlist members, union, shows) | `generation_members`, newest 8 generations | Yes: counts of the published generation |
| Films that joined and departed between consecutive generations (departed members) | `membership_delta_1`, `membership_delta_2` (two run pairs, counted inside SQL, only counts leave it) | Yes |
| How many generations are retained at all | `generation_summary` | Yes (retention is not documented; the sample may be fewer than 8) |
| Watchlist size, Film, Person, credit, metadata, sync-clock and dimension counts | `table_counts` | Yes |
| Credits per watchlist Film, distribution; Persons credited, credit rows | `credits_histogram`, `persons_of_watchlist` | Yes |
| Films per Person, distribution (the fan-out of a Person unit) | `person_credit_fanout` | Yes |
| Films and Persons the current writer touched per day (a proxy for changes) | `film_updates_by_day`, `person_updates_by_day` | Yes; a proxy only, see below |
| State preconditions: schema 19, marker not held, published EPG authority `d1` / `open`, receipts empty (a stop, not a note) | `schema`, `film_person_marker`, `epg_authority`, `receipt_rows`, `receipt_states` | Yes |
| D1 round trips of ONE `applyFilmFacts` unit: new or changed Film, unchanged Film | The sqlite stand-in, pinned by [`tests/film-person-e6-measure.mjs`](../../tests/film-person-e6-measure.mjs) section 6 | No: deterministic, the same code; a safe copy would give the same counts |
| Wall time per D1 round trip inside the Worker | Not measurable by a D1 read (the response `meta.duration` is the database side only) | Yes; not measured here. [ADR 0106](../adr/0106-bulk-projector-write-path.md) records about 50 ms from the projector path: an input to be confirmed, not a result |
| CPU time of one unit and the fixed CPU of an EPG step | Not measurable by a read; only a run of the producer (its own dry run, a later and separately authorized step) or Workers metrics of a real step | Yes; **unknown**, so the tool proposes no ceiling while it is missing |
| The share of units that really change content (`changedShare`) | Only a producer dry run: membership change is not content change | Yes; unknown, the tool then assumes every unit applies (worst case) and says so |

The membership delta is a lower-resolution fact than the number of `film_facts` units that apply: a Film that stays in the generation can still have changed facts, and a Film that joined can already be current in D1 (the projector writes it today). The day counts of `updated_at` are the projector's writes, not the producer's.

## 3. Cost of one unit, measured offline

`tests/film-person-e6-measure.mjs` runs the real `applyFilmFacts` against the sqlite stand-in on the full migration chain, with the marker at `d1`/`open`, counting every D1 round trip (a `first`, `all` or `run` is one; a `batch` is one, as in [ADR 0106](../adr/0106-bulk-projector-write-path.md)):

| Unit | Queries | Batches | Round trips |
| --- | --- | --- | --- |
| New or changed Film (`applied`: route read, pre-plan, receipt insert, writer batch with the applied receipt, readback) | 36 | 2 | **38** |
| Unchanged Film (ends in the pre-plan, no receipt) | 14 | 0 | **14** |

These are pinned in `UNIT_COST` of the tool and asserted against the code by the test, so a change of the adapter fails the test until the number is updated. They are round-trip counts, not times. These are `applyFilmFacts` (Film-facts) costs only, not a bound for the other producer kinds. Consequence for the provisional ceiling: 50 changed Film-facts units alone are about 1,900 round trips (38 x 50), before loop and step overhead, Person/credits work and retries, not the roughly 500 the P3a comment assumes; whether that is a problem depends on the per-step limits of section 9, which are unknown. The route gate is read again on every unit (it is part of the 14 and the 38); the P3a pass also reads it once before the loop. A saving there is a code question for P3a, not for this measurement.

## 4. The read channel and the classification of each statement

All statements go through the Cloudflare D1 read path, the same channel as the preflight of the [0019 procedure](film-person-0019-apply.md#4-read-only-preflight-immediately-before-the-apply-every-statement-is-one-select) (the Cloudflare Developer Platform connector `d1_database_query`, or the Cloudflare API connector `execute`), one statement per request, `SELECT` only. No MCP read tool and no Worker route is used: not `GET /api/enrichment/*`, `GET /api/events`, `epg_pipeline_status` or `ratings_sync_status`. The optional L0 records `feature_flags` and `epg_status` of [read side effects](../reference/api/read-side-effects.md) (both audited as writing nothing) may be noted for the evidence, they are not part of the GO.

Classification against [read side effects](../reference/api/read-side-effects.md): that page inventories Worker routes and MCP tools. A connector D1 read is not on it: no Worker code, Workflow, continuation or `waitUntil` runs, so none of its entries (the one registered outbound TMDB probe included) applies. What does apply: the connector accepts arbitrary SQL, so the guarantee that nothing writes is the statement text, enforced three ways: the tool refuses anything that is not one `SELECT` (`assertReadOnly` of [`scripts/schema-preflight.mjs`](../../scripts/schema-preflight.mjs): no `;`, no write or DDL keyword, no `PRAGMA`), the operator pastes the emitted text without editing it (the digest below proves it), and `verify-step` and `verify` refuse a state or a bundle whose digest differs. A potentially writing probe would be L2/L3 under [authorization](../process/authorization-and-escalation.md); none is emitted. No statement selects a payload, title, name, URL or identifier column: sets are compared inside SQL and only counts, timestamps, rank numbers, day strings and enum words leave it.

Statements digest (sha256 over the ordered ids, texts and row caps): `38d50e82d454633ec9370f2981e05b88498a2a00809fdc2fb83b87bf2fe54543`. `node scripts/film-person-e6-measure.mjs emit-sql` prints the exact texts.

| Statement | Answers | Row cap |
| --- | --- | --- |
| `schema` | schema version (stop rule: not 19) | 1 |
| `film_person_marker` | Film/Person marker state (stop rule: held) | 1 |
| `epg_authority` | published EPG authority (stop rule: not d1 / open) | 1 |
| `table_counts` | Film, Person, credit and watchlist counts; receipts must be 0 (no producer wired) | 1 |
| `generation_summary` | how many published generations exist (retention) and the anchor of the newest | 1 |
| `generation_members` | observed Films per published generation (programme and watchlist members, union, shows), newest 8 | 8 |
| `membership_delta_1` | Films that joined and departed between the newest and the previous generation (departed members) | 3 |
| `membership_delta_2` | the same for the previous pair (a second run) | 3 |
| `film_updates_by_day` | Films whose row the current writer (the projector) touched per day: a proxy for changed Films per run, NOT the number of producer units | 15 |
| `person_updates_by_day` | Persons touched per day (the same proxy) | 15 |
| `credits_histogram` | credits per watchlist Film (histogram, 100 means 100 or more) | 101 |
| `persons_of_watchlist` | distinct Persons credited by the watchlist and their credit rows | 1 |
| `person_credit_fanout` | Films per Person (histogram, 50 means 50 or more): the fan-out of a Person unit | 51 |
| `receipt_states` | receipt states (expected: no rows while no producer is wired) | 10 |

Statements run in this order. Each is one `SELECT` with a literal `LIMIT` or a single aggregate row. `membership_delta_*` compare two membership sets with `NOT IN` over the unique index of `published_epg_member`, the heaviest statements. The tool enforces the gate before them: `verify-step generation_members` answers STOP with `delta_gate_closed` unless the sample holds at least 3 published generations (two genuine consecutive pairs) and every member count is at or below the size cap of section 5, and `next-step` refuses a delta statement until that gate is open (section 7).

## 5. D1 read budget and caps (proposals for the GO; the owner may lower them)

**Read this first: almost every cap here is checked AFTER the statement has run.** The D1 response reports `meta.rows_read` and `meta.duration` only once the `SELECT` has finished, so a cap can stop the NEXT statement; it cannot prevent the statement that already ran from reading more than the cap or taking longer. The table separates the two kinds.

| Cap | Value | Kind | Where it is checked |
| --- | --- | --- | --- |
| Rows returned per statement | the `Row cap` column above (1 to 101) | **Hard bound by statement shape** (a literal `LIMIT`, a single aggregate row, or a bucketed histogram), not a runtime check | also `verify-step` / `verify`: `row_cap:<id>` |
| Members of a generation for which the delta statements may be sent | 20,000 | **Before-the-fact gate**: decided from `generation_members` (a cheap, bounded statement) before either delta statement exists on the wire | `verify-step generation_members`: `delta_gate_closed:<n>`; `next-step` refuses the delta statements until it is open; `verify`: `delta_ran_over_size_cap:<id>` |
| At least 3 published generations | 3 | **Before-the-fact gate**, from `generation_summary` | `verify-step generation_summary`: `insufficient_generations:<n>` |
| `rows_read` per statement (D1 response `meta`) | 300,000 | After the fact | `verify-step` / `verify`: `rows_read_cap:<id>` |
| Database time per statement (`meta.duration`, ms) | 5,000 | After the fact | `verify-step` / `verify`: `duration_cap:<id>` |
| `rows_read` in total | 1,500,000 | After the fact, cumulative: stops the statement AFTER the one that crossed it | `verify-step`: `rows_read_total:<n>` (state file); `verify` |
| Database time in total (ms) | 60,000 | After the fact, cumulative | `verify-step`: `duration_total:<n>`; `verify` |

**What actually bounds one statement in practice, and what is not known.** A single statement can overshoot its `rows_read` or time cap by an unknown amount before any stop is possible; the tool cannot prevent that. What limits it: (a) every statement is one `SELECT` that returns at most 101 rows, so the output is small whatever it reads; (b) the cheap statements are single-row counts or index-ordered reads; (c) the heavy ones are the two `membership_delta_*`, whose cost scales with the members of two generations: each of their three branches runs about four subqueries, two of them `NOT IN` against the unique index of `published_epg_member`. From the statement shape alone a generation of 20,000 members could cost on the order of a few hundred thousand rows read per delta statement, which is the same order as the 300,000 per-statement cap; that is an estimate from the SQL text, **not a measurement**, and the gate value of 20,000 is a proposal the owner may lower (a smaller gate costs nothing but coverage). The D1 per-statement time limit, the per-query row-read limit and the price of rows read are **not documented in this repository and not verified here**: treat them as unknown, and treat a response that arrives late as the only evidence of a slow statement. The table sizes have not been read; the first statements (`table_counts`, `generation_summary`, `generation_members`) are the cheap ones that bound the rest, which is why the delta statements are last among the heavy ones and gated.

If a statement exceeds a cap, the operator cannot know beforehand: the guard is that the run STOPS at the first response over a cap and the following statements are not sent (`verify-step` answers STOP, records it in the state file and refuses every later step). The results must be pasted as D1 response envelopes (`[{success, results, meta}]`) so the caps are provable; plain rows are accepted by `verify --allow-plain-rows` as a shape diagnostic only (`ok` is then always false), and `verify-step` refuses them.

## 6. Stop rules

Stop at the first of these and record it; do not retry, rewrite or work around it:

- any statement is refused, errors or returns `success: false`; any cap of section 5 is exceeded; the Row cap is reached on a histogram (it cannot be: they are bucketed);
- `receipts_present` or `receipt_states_present`: any receipt row exists although the producer is dormant (the measurement's premise is gone: record it, do not proceed);
- `insufficient_generations`: fewer than 3 published generations, so no two genuine consecutive pairs exist: no budget is claimed (the result is INCOMPLETE, not a smaller sample); `generation_count_mismatch`, `generation_ranks_invalid`, `generation_anchor_null` and `generation_order_invalid` are the same family;
- `delta_gate_closed`: a generation has more members than `caps.membersForDelta`; the delta statements are not sent;
- `schema.version` is not 19; the marker `cutover` is `held`; the published EPG authority is not `d1` / `open`;
- a result contains anything that looks like an identifier, title, URL or payload (`payload_pattern`): do not paste it anywhere, discard it and report only that the rule fired;
- the statements digest of the bundle differs from the one in the GO (`statements_digest_mismatch`);
- `generation_moved`, `delta_members_mismatch`, `delta_kinds_invalid`, `delta_counts_impossible`, `delta_pair_missing`: a generation was published between two statements (ranks shifted) or a delta answer does not fit the sample; the run is repeated once outside the EPG daily window, not patched;
- `state_invalid`, `out_of_order`, `already_stopped`, `statements_digest_mismatch` of the step validator (section 7).

A stop is not a failure to hide: it is recorded with the reason in the evidence note.

## 7. Output format and where results are recorded

- **Stepwise holdpoint (during the run).** After EACH statement the operator saves that one D1 response as a JSON file and runs `node scripts/film-person-e6-measure.mjs verify-step <statement-id> <response.json> --state <state.json>`. The answer is `CONTINUE` (with `next`, the statement to send) or `STOP` (with named `reasons`; exit status 1). The state file (named by the operator, the only file the tool writes) carries the statements digest, the position, the running `rows_read` and time totals, the generation summary and sample (counts and timestamps only) and the delta gate. `node scripts/film-person-e6-measure.mjs next-step --state <state.json>` says whether the next statement may be sent: it refuses `membership_delta_1` and `membership_delta_2` (`delta_gate_closed`) until `generation_members` has opened the gate, and after any STOP it refuses everything (`already_stopped`). A statement is only sent when the previous `verify-step` said CONTINUE and `next-step` names it. These checks are after the fact for caps (section 5); the gates before the delta statements are real before-the-fact gates.
- Raw results: one JSON file `{"_statementsDigest": "...", "_capturedAt": "<ISO UTC>", "<statement id>": [<D1 envelope>]}` assembled from the saved responses, kept on the operator's machine, NOT committed and NOT posted (it holds counts only, but also database timing). `node scripts/film-person-e6-measure.mjs verify <file>` is the FINAL judgement and must say `ok: true`; then `summarize <file> --limits <limits.json>`. A step-wise CONTINUE of every statement is not the final judgement.
- The summary (counts, percentiles p50/p90/p95/p99/max, the proposed ceiling and its unknowns) goes into ONE dated evidence note under [`docs/evidence/d1-migration/`](../evidence/d1-migration/README.md) with the README row, in UTC, with no id, title, name or payload, and into the AIR-374 Trello card as a Russian comment with Madrid times (Controller).
- A refusal or stop is recorded the same way, with its reason codes.

## 8. The owner GO text (to be shown to the owner; fill the brackets from live reads)

> GO for a read-only measurement of the Film/Person/EPG budget (E6), production D1 database `iptv` (id `[from the account listing]`), executed by `[who: the assistant through the Cloudflare D1 read path, or the owner]`: the 14 statements of `node scripts/film-person-e6-measure.mjs emit-sql` from `main` `[sha]`, statements digest `38d50e82d454633ec9370f2981e05b88498a2a00809fdc2fb83b87bf2fe54543`, each as one request with no edit, `SELECT` only, in the printed order, once (a second run only after a `generation_moved` stop, in the same window), between `[start]` and `[end]` Europe/Madrid (`[UTC]`), outside the hourly tick at minute `:00`, the daily EPG run (`[time of the daily run: not verified]`) and any publication in flight. Hard bounds (before the fact): one `SELECT` per request, rows returned per statement as printed (at most 101), the delta statements sent only when `verify-step generation_members` opened the gate (at least 3 published generations and every generation member count at most 20,000), the next statement sent only after the previous `verify-step` said CONTINUE. Thresholds checked only AFTER the statement ran (a single statement may overshoot before the stop is possible; the amount is unknown, the D1 per-statement time and row-read limits are not verified in the repository): `rows_read` 300,000 per statement and 1,500,000 in total, database time 5,000 ms per statement and 60,000 ms in total; the run STOPS at the first response over one and sends nothing further. Stop rules: section 6 of the runbook, including any receipt present, fewer than 3 published generations and any `state_invalid`. Results: the raw file stays local; counts and percentiles only go into one evidence note and one Trello comment. This GO does NOT authorize: any write, DDL, lease, receipt, marker, flag, Scheduled Task, cron, Workflow, sync, projector, discovery or EPG run, any GET route or MCP tool beyond the two optional L0 records, any R2 access, a different or edited statement, reading any identifier, title or payload, a producer dry run, or choosing the ceiling.

Under [authorization levels](../process/authorization-and-escalation.md) this is a bounded production READ with a scope that is not on the existing proven L0 list, so it needs the owner's explicit approval with these parameters. The signature covers the reads and the recording; the choice of the ceiling is a later decision with its own review.

## 9. From the measurement to the per-run ceiling

`summarize` computes, per resumable step (one Worker invocation or Workflow step), with `U` the units of a run (`observed` Films of the newest generation plus `departed`, the larger of the two sampled run pairs), `applied` and `noop` from section 3 and `safety` the margin (default 0.5, an input, not a measured value):

```
qUnit   = changedShare * applied + (1 - changedShare) * noop
cQuery  = floor((queryBudget * (1 - safety) - fixedQueries)  / qUnit)
cWall   = floor((wallMs      * (1 - safety) - fixedMs)       / (qUnit * roundTripMs))
cCpu    = floor((cpuMs       * (1 - safety) - fixedCpuMs)    / cpuMsPerUnit)
ceiling = min(cQuery, cWall, cCpu)           stepsPerRun = ceil(U / ceiling)
```

The limits come from `--limits <file>` and are never defaulted by the tool: **every input must be present as an explicit finite non-negative number** (`queryBudgetPerStep`, `wallMsPerStep`, `roundTripMs`, `cpuMsPerStep`, `cpuMsPerUnit` at least their stated minimum; `fixedQueries`, `fixedMs`, `fixedCpuMs` and `changedShare` explicit, `0` allowed only as a stated value). An input that is missing, `null`, a string, `NaN`, infinite, negative or out of range leaves the ceiling at `null` (status `incomplete`) with `upperBoundWithoutUnknowns` for the known constraints, which ignores the unknown fixed parts and is therefore only an upper bound; `safety` (a proposal, default 0.5 when absent) must be a number in [0, 1) once given, `changedShare` a number in [0, 1], otherwise the result is `refused`. An unknown fixed part is never treated as zero. The sources the inputs must cite, and what is not known:

| Input | Source in this repository | Status |
| --- | --- | --- |
| `queryBudget` | 800 queries per projector run (`D1_ENRICHMENT_QUERY_BUDGET`, [ADR 0106](../adr/0106-bulk-projector-write-path.md): self-imposed, not a platform limit; a `db.batch()` counts as one query) | Does not apply to the EPG step by itself: **unknown** which budget an EPG Workflow step gets |
| platform subrequests | [ADR 0024](../adr/0024-letterboxd-scan-summary.md) cites a default of 10,000 per paid invocation, read 2026-10-27, "dated verification not recorded" | **Not verified now**; whether D1 round trips count against it and what applies to a Workflow step is unknown |
| `wallMs` | The projector uses 60 s (`D1_ENRICHMENT_WALL_MS`, self-imposed); [ADR 0106](../adr/0106-bulk-projector-write-path.md) states the platform allows a 15 minute cron run | The wall budget of an EPG step is **unknown** ([ADR 0100](../adr/0100-epg-cloudflare-workflow-executor.md): step behaviour unobserved) |
| `cpuMs` | `limits.cpu_ms` 120000 in `wrangler.jsonc` (the configured Worker limit) | Per-step CPU of a Workflow step **unknown** |
| `roundTripMs` | about 50 ms per round trip in [ADR 0106](../adr/0106-bulk-projector-write-path.md) (projector path) | An input to confirm; not measured on the EPG path |
| `cpuMsPerUnit`, `fixedCpuMs`, `fixedQueries`, `fixedMs` | none | **Unknown**; the fixed parts of an EPG step (fetch, publication, mirror reconcile) are not measured |
| `changedShare` | none | **Unknown**; only a producer dry run measures it |
| `safety` | owner choice | Default 0.5 is a proposal |

So after the section 8 run the tool will report the real `U` and a ceiling only as an upper bound without CPU, per-step limits and `changedShare`. That is the intended outcome: the measurement turns the 50 from a guess into a number with named unknowns, and the owner decides whether to close them (a producer dry run for CPU and `changedShare`, Workers metrics of a real EPG step for the fixed parts) before the ceiling is chosen. The 50-unit ceiling remains provisional until then.

## 10. What is verified and what is not

Verified offline (sqlite stand-in on the real migration chain, including fixtures with one and two published generations, [`tests/film-person-e6-measure.mjs`](../../tests/film-person-e6-measure.mjs), with a mutation guard [`tests/film-person-e6-measure-mutation.mjs`](../../tests/film-person-e6-measure-mutation.mjs)): every statement is one `SELECT` that leaves a seeded database byte-identical and answers what it claims on a fixture, the unit costs of section 3, every refusal and stop rule of `verify` and of the stepwise `verify-step` / `next-step` (order, gate, running totals, state file, receipts, generation history), the percentile and ceiling arithmetic including every missing or invalid input, and the CLI exit codes. As of the offline verification before 12 Nov 2026, not verified: that the statements run within the caps on the production tables (not established by the first production run of 12 Nov 2026 either, which verified only the 14 statements against the caps and returned counts; the evidence is an operator attestation, not an independent replay), the D1 behaviour of the delta statements at production size, the table sizes, the retention of published generations, every platform value of section 9, and anything about CPU.
