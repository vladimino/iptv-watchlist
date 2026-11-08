# Projector input and Discovery writer audit, with the measured rate of relevant writes (2026-11-08)

**Purpose:** the factual base for [ADR 0102](../../adr/0102-scoped-discovery-projector-revision.md). It records what the D1 enrichment projector reads, which code paths write the Discovery data it reads, and how often those writes happened on 2026-11-08. It decides nothing and authorizes no production operation.

**Method.** Code read at `origin/main` `ab36d05` (read-only; `main` has moved since, so every line number below must be re-checked by an implementation card). Production evidence is limited to read-only D1 `SELECT`s, aggregate counts only (every response `changed_db=false`, `rows_written=0`), taken between about 10:05 and 11:25 UTC. No R2 read, no projector, cron, Discovery or sync run, no flag, lease, Task or schedule change. No title, name or payload text is recorded.

## 1. Measured rates (D1, 2026-11-08)

| Quantity | Value | Source |
| --- | --- | --- |
| Window | 07:31–10:01 UTC (150 minutes), global generation 29,604 to 32,199 | `discovery_decision_history.written_at` per minute, `discovery_authority.generation` |
| Global generation bumps | 2,595, about 17.3 per minute (one per about 3.5 s) | generation range |
| Minutes without any Discovery write | 0 of 150 | per-minute counts of `discovery_decision_history` |
| Decision changes in the window | 1,429, each at its own generation | rows of `discovery_decision_history` with a generation in the range (the same 1,429 rows are the current `discovery_decision` rows stamped in the range) |
| Admission rows written in the window | at least 106 (rows of `discovery_admission` stamped in the range; later writes overwrite earlier stamps, so this is a lower bound) | `discovery_admission.generation` |
| Projector-relevant bumps | at least 1,435 of 2,595 (1,429 decisions plus at least 6 admission batches of up to 19 rows), at most about 1,535 if every admission row was its own bump; about 55–59 %, about 10 per minute, one per about 6 s | the two rows above; admission rows share a bump per batch, and overwritten stamps make both admission figures lower bounds |
| Other bumps (status, checkpoint, continuation, workflow, intent) | the remainder, about 7 per minute | by difference |
| Current rows | `discovery_admission` `state='current'` 5,809; `discovery_decision` 20,001 | `COUNT(*)` at about 11:20 UTC |

Consequence for the design: removing the irrelevant bumps with a scoped revision cuts the interruption rate by less than half. A scoped revision that must stay *unchanged* across the whole diff phase (21.2 s on the 08:37 UTC run, 10.6 s of it reading) still has a stable-window probability of about 3 % per attempt (see the model in section 5).

Separate defect, tracked as [AIR-386](https://trello.com/c/z4tQryUa): `discovery_decision` holds 20,001 rows and `readDecisions` throws `discovery_bounded` above `READ_CAP = 20000` (`src/discovery-authority.js` lines 15 and 235). The projector's last stored run (started 10:37 UTC) ended `failed` with `input_invalid: epg/discovery-resolution.json`, which is what the projector's mapping of an unknown Discovery error code produces. The cause is an inference from the count, the key and the mapping; the thrown code was not read from a log.

## 2. What the projector reads (`src/d1-enrichment.js`, `d1EnrichmentStore`)

| Input | Reader | Backing store | Fence today |
| --- | --- | --- | --- |
| Published programme and watchlist | `PublishedEpg.authoritativeSnapshot` (D1 `published_epg_document`), else R2 | `published_epg_*` | published-EPG generation read before and after, repeated by the projector |
| Discovered-films catalog of the published run | `DiscoveryAuthority.routeRead`, key `epg/generations/<run>/discovered-films.json` | `discovery_admission WHERE state='current'` only (run id is a precondition, not a filter) | global generation read before and after the one `SELECT` |
| Shared decisions | `routeRead`, key `epg/discovery-resolution.json` | `discovery_decision` only | its own global-generation bracket |
| `metadata.json` | raw R2, replaced by `MetadataCache.useAuthoritativeMetadata` when the cache marker is `d1` | `metadata_cache` | R2 etag; **D1 mode has no generation bracket** (marker read once, one `SELECT`) |
| `titles.json`, `people.json`, diary history, TMDB retirements, view index, verified-films admissions | raw R2 | none | etag, re-checked after the reads |
| Owner reviews | `OwnerReview.readFenced` (D1) or R2 mirror | `owner_review_entry` | marker generation before and after, two retries |

Facts that shape the design:

- The two Discovery reads are **two independent brackets**: the catalog and the decisions are each consistent, and nothing proves them mutually consistent.
- Only `discovery_admission` and `discovery_decision` feed the projector. The observation ledger, status, checkpoint, score, continuation, workflow, lease, segment and intent tables do not.
- The projector's write batches carry **no reference to any Discovery generation**. The only re-check is one `d1EnrichmentHandoffGuard` call before the first batch; the write phase (up to 60 s) is unchecked against Discovery.
- The reader is **not key-local**. `readLifecycle` iterates every catalog record in id order and links each one against Films already built (`src/domain/film-person-reader.js` lines 341–360); the Film list is also built from a scan (line 232). A Film's projection depends on records with the same id or the same trusted TMDB id, and on the order in which they are processed. This is why a per-entity dependency set cannot be assumed; it has to be derived and proven by test (ADR 0102, decision 4).

## 3. Writers of the projector's Discovery inputs

Every runtime path commits through `commit()` (one `db.batch`, at most `STATEMENT_CAP = 40` statements, `BIND_CAP = 100` parameters). Two bump idioms exist: `fence()` (lease-fenced, line 181) and `loadingFence()` (transfer `loading`, line 338); both end with `FENCE_SQL` (`UPDATE discovery_cas SET ok=changes() WHERE id=1`), which aborts the batch when the bump changed no row. "Relevant" means the write changes what `readCatalog` or `readDecisions` returns, or moves the programme the catalog key is checked against.

| # | Path (`src/discovery-authority.js` unless noted) | Reached by | Tables written | Bumps `generation` today | Relevant |
| --- | --- | --- | --- | --- | --- |
| 1 | `putIntent` (1087) | owner confirm routes | `discovery_intent` | no | no |
| 2 | `markIntentRunning` (1109) | owner execute routes | `discovery_intent` | yes (1116) | no |
| 3 | `commitOwnerWrite` (1157) | owner correction, reconsider, identity assign/reject | `discovery_decision_history`, `discovery_decision`, `discovery_intent` | yes (1165) | **yes** (decisions) |
| 4 | `writeDecisionDelta` (777) | ordinary paged resolver chunk | `discovery_decision_history`, `discovery_decision` | yes, one bump per key | **yes** |
| 5 | `upsertAdmissions` (824) | paged resolver chunk; seal catalog phase (`src/worker.js`) | `discovery_admission` | yes, one bump per batch of up to 19 films | **yes** (catalog) |
| 6 | `supersedeAdmissions` (700) | seal catalog phase | `discovery_admission` (current to superseded) | yes | **yes** |
| 7 | `replaceCatalog` (730) via `routeWrite` | document-path resolver; non-sealed publish; `updatePublishedFiles` | `discovery_transfer`, `discovery_admission` | yes, opening batch and every flush | **yes** |
| 8 | `writeDecisions` (184) via `routeWrite` | document-path resolver; canonical reconcile route | `discovery_transfer`, `discovery_decision_history`, `discovery_decision` | yes, opening batch and every flush | **yes** |
| 9 | `writeStatus` (249) | resolver status writes | `discovery_status`, `discovery_checkpoint` | yes (260) | no |
| 10 | `writeScores` (270) | `saveScorePreview` | `discovery_score` | yes | no |
| 11 | `writeContinuation` (1013) | resolver checkpoint | `discovery_continuation` | yes (1025), **no lease** | no |
| 12 | `writeWorkflow` (1040) | `src/discovery-workflow.js` state writes | `discovery_workflow` | yes (1052), **no lease** | no |
| 13 | `replaceLedger` / `ingestLedger` via `beginLedgerSeal` (344) | handoff and publish paths | `discovery_lease`, `discovery_transfer`, observations, `discovery_authority.programme_run_id` and `published_programme_run_id` | yes, every flush and the final batch | **programme move only** (final batch) |
| 14 | `sealBegin` (595) | seal ledger phase | lease, transfer, observations, `discovery_seal` | yes | no |
| 15 | `sealWrite` (624) | seal ledger flush | observations, lease, `discovery_seal` | yes | no |
| 16 | `sealArchive` (662) | seal ledger phase | observations, `discovery_seal`, lease; final batch moves the programme ids and sets transfer `committed` | yes | **programme move only** (final batch) |
| 17 | `importSegment` (883) | **no caller in `src/` or `scripts/`** | `discovery_segment`, archive observations, transfer | yes, requires no live lease | no |
| 18 | `acquireLease` (949), `renewLease` (971), `releaseLease` (985) | every chunk, seal, publish | `discovery_lease` | no | no |

Offline scripts (SQL rendered and sent with owner confirmation; read, never run):

| # | Script | Effect | Bumps | Relevant |
| --- | --- | --- | --- | --- |
| S1 | `scripts/discovery-production.mjs` `--load` | loads the ledger; sets `generation=1` | sets, does not add | no |
| S2 | same, `--reset-load` | sets `generation=0` | sets | no |
| S3 | `scripts/discovery-cutover.mjs` `--import` | first catalog and decisions content, mode `r2` | **none** (rows stamped with the marker's generation) | **yes** |
| S4 | same, `--hold` and `--activate` | flips `mode`/`cutover` | none | authority state, not data |
| S5 | same, `--reset-import` | **deletes** catalog and decisions rows, mode `r2` | **none** | **yes** |

Other findings:

1. `catalogPosterApply` (`src/discovery.js` lines 326–350) writes the R2 copies of `discovered-films.json` directly with `env.BUCKET.put`, not through `routeWrite`. Under a D1 Discovery authority those copies are not the projector's source, so it does not affect the projector, but it is a catalog write that no D1 revision would ever see.
2. The catalog is not generation-scoped in SQL; `readCatalog` returns the one set of `current` rows and the run id only gates the early `null` return (`readKey`, line 146).
3. In the seal flow the catalog changes land before the published-EPG pointer flips, and `published_programme_run_id` moves before the pointer, so the global generation cannot stand for "the published generation".
4. Two resolver implementations exist (paged deltas, rows 4 and 5; document path, rows 7 and 8). A revision has to cover both.
5. `discovery_decision.generation` and `discovery_admission.generation` are stamped `gate.generation + 1` at write time. They change on every write of the row and only ever increase, which makes them usable as per-row version tokens; a multi-flush load stamps rows with a value that later flushes overtake, so equality, not ordering, is the only safe use.
6. The manual `reconcile` and `scan` routes reach `saveJSON` with no lease; under D1 authority `routeWrite` throws `discovery_lease`, so by code they fail closed.

## 4. Not measured

- The duration of the Discovery reads alone (catalog 5,809 rows, decisions 20,001 rows). The only timing is the whole 10.6 s load phase.
- Whether one `db.batch` is a snapshot. D1 documents a batch as a transaction; no test in the repository establishes it for reads, so it is treated as unproven.
- The inter-arrival distribution of relevant writes within a minute (only per-minute counts were read), so the Poisson model is an assumption.
- Whether any non-projector writer changes Film, Person, credit or alias rows between a projector's read and write (the AIR-286 credit script, the offline importer, owner reviews); not traced here.
- The thrown code behind the 10:37 UTC `input_invalid` (see AIR-386).

## 5. Model: probability that an unchanged-revision window holds

Assumption: relevant writes arrive as a Poisson process at 10 per minute (a lower rate than the 17 per minute of all bumps). The chance that no relevant write lands in a window of `T` seconds is `exp(-10 T / 60)`; with `n` independent attempts it is `1 - (1 - p)^n`.

| Window T | 1 attempt | 2 | 3 | 4 |
| --- | --- | --- | --- | --- |
| 1 s | 0.846 | 0.976 | 0.996 | 0.999 |
| 2 s | 0.717 | 0.920 | 0.977 | 0.994 |
| 3 s | 0.607 | 0.845 | 0.939 | 0.976 |
| 5 s | 0.435 | 0.680 | 0.819 | 0.898 |
| 8 s | 0.264 | 0.458 | 0.601 | 0.706 |
| 12 s | 0.135 | 0.252 | 0.354 | 0.441 |
| 21 s (whole diff phase today) | 0.030 | 0.059 | 0.088 | 0.115 |

A check that must hold for 40 s between a cut and a write (a check that needs the revision unchanged since the cut) succeeds with probability 0.1 %; for 10 s 18.9 %; for 2 s 71.7 %. These figures are the reason the design bounds the unchanged-revision requirement to the Discovery read itself and protects each later write with a per-entity check instead.
