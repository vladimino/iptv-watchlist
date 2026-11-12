# Film/Person `prepared` loader: rated admission, retention and TMDB retirement

**Role:** the procedure and the offline tooling of [AIR-374](https://trello.com/c/ha7ais3w) P5 for the three D1 classes the projector does not write: `film_rated_admission` (expected 708 rows), `film_retention` (401) and `tmdb_retirement_decision` (4), 1,113 rows. They are empty while the marker is `prepared` and are the accepted gaps named in [ADR 0110](../adr/0110-film-person-operator-copy-and-accepted-discrepancies.md); the parent decision is [ADR 0099](../adr/0099-canonical-film-person-d1-authority.md). This page does not authorize a write.

Tooling: [`scripts/film-person-prepared-loader.mjs`](../../scripts/film-person-prepared-loader.mjs), tested by `tests/film-person-prepared-loader.mjs` (a sqlite file as production D1 with the migrated schema, the D1 stand-in applying the emitted statements, a read-only R2 double) and `tests/film-person-prepared-loader-mutation.mjs` (each mutant removes or inverts one guard; every one is killed). Nothing is bundled into the Worker and nothing in `src/` imports it.

## Accepted owner decision

**Owner decision 2 of 11 Nov 2026** ([AIR-374](https://trello.com/c/ha7ais3w), Trello comment): the three empty classes (`ratedAdmission` 708, `retention` 401, `retirement` 4; 1,113 rows) are loaded into D1 **while the marker is still `prepared`**, through a separately verified, bounded, idempotent loader with a dry run, receipts and a readback. **A live run needs its own owner GO**; this page and PR record only the offline tool. Until that run, the `d1` activation keeps these classes as open gaps.

## Why a separate writer

The fenced writers (`admitRatedFilm`, `retainFilm`, `recordRetirementDecision`) call `assertWritable`, which accepts only `open`, so they cannot run at `prepared`. The projector writes none of the three tables. The loader is not a second canonical writer: it never writes a Film, a Person, an identity row, a revision or the marker. It inserts rows of these three tables only, and only against a verified baseline.

## What the tool does and cannot do

| Command | Effect |
| --- | --- |
| `plan` | **Dry run, the default and only mode.** Reads the operator copy of D1 (SELECTs only) and three R2 objects, prints counts, digests and bounds. `--out` saves the private plan file. Writes nothing to any database. |
| `sql` | Needs `--apply` **and** `--plan-digest` equal to the digest of a plan it rebuilds from the current inputs. Then it renders the SQL of each batch into private files. It never executes anything: the tool has no write path to D1 or R2 and no connector call; the operator runs the SQL through the connector. |
| `verify` | Reads a copy taken after the run, builds the readback ledger and the receipt (counts and digests only). |

Sources (`--source-dir`, the operator-copy path, or `--r2`): `letterboxd/admissions/verified-films.json`, `enrichment/view-index.json` and `identity/tmdb-retirements.json`. The R2 client can only `HEAD` and `GET` those three keys (the same single allowlist and `limitedClient` as the [projector-input capture](film-person-baseline.md#stage-b-the-narrow-projector-input-capture-offline-code-nothing-executed)), each read as HEAD, conditional GET, HEAD; a moved ETag is a refusal, never a retry. A source file is accepted with its sha256 and enters the plan digest through the request ids.

### What is loaded

- **Rated admission.** Only an entry the fenced writer itself accepts (`verifiedAdmission`: verification time, short code, archive digest; no `watchlist` field). It needs an existing Film that holds the movie id as its one trusted, non-conflicting claim; an untrusted claim, a Film-less receipt and a redirect source are **counted and not loaded**. Request id `p5-load:<receipts sha16>:<receipt key>`.
- **Retention.** The `watchlist` boolean of each view-index entry, on the one Film that carries that Letterboxd id (two Films refuse the plan). Evidence is the view-index digest. `observed_at` is the pinned run instant. Request id `p5-load:<view-index sha16>:<film id>`.
- **Retirement.** The whole `tmdb-retirements.json` object validated by `prepareRetirementImport` (one invalid entry or a duplicate invalidates all), each decision normalized by the fenced writer's `normalizeDecision`; request ids `r2-import:<sha16>:<film id>`, origin `r2_import`, the owner confirmation of the object.

The plan refuses unless each class holds exactly the accepted count (`ACCEPTED_DISCREPANCIES.caps`, the 11 Nov 2026 measurement), so a source that moved is caught before any SQL exists.

### The fence is inside every row

A D1 statement that fails rolls its batch back whole. Every inserted row carries the whole fence in its own statement: the guard column `request_id` becomes `NULL` (a `NOT NULL` violation) when the guard is false. The guard asserts:

1. marker `prepared`/`open` at the planned generation, **and** baseline `verified` at the planned reference;
2. the projector lease of the run is live (`projection_run`, by the database clock) and, when the plan pins one, the projector window is held by that owner and live;
3. the class count lies in `[initial, expected - 1]`, so an unknown row makes the batch fail;
4. the identity the row stands on: the trusted movie id (or the Letterboxd id) held by exactly that Film, which is not a redirect source.

The assertion writes nothing. No table outside the three is written, no fence table, no `canonical_revision`, no Film or Person row; a test compares a digest of every other table before and after a full load at the accepted counts. A marker moved to `d1`, a generation bump, a changed baseline, a lost lease or window, a changed identity and a stale count each fail the batch; a test provokes every one on a fresh database and proves nothing of the batch was written.

### Bounded and idempotent

One batch is one atomic D1 batch with one statement per row: at most 40 rows (`BATCH_ROWS`, never above the fenced writers' cap of 60). One run (one plan, one pinned digest) holds at most 40 batches and 1,200 statements, which holds the 1,113 rows in 30 batches; what does not fit is `deferred` and goes into a later run planned from the then-current state. The plan is always rebuilt from the current state, so a loaded row is never planned again; request ids are content-derived and stable; a row that already exists with the same content is skipped by the statement itself, so **replaying the same emitted SQL is a no-op**. A stored row with other content (`mismatch`) or a stored row the plan does not know (`unknown_rows`) refuses the plan: nothing is ever updated or deleted.

### Receipts and readback

The durable record is (a) the stable request ids on the rows themselves and (b) the private receipt file written by `verify`: plan digest, source digests, the pinned gate, per class the expected count, the stored count and a digest of the stored rows, and the readback digest. Both the receipt and the readback are counts and digests only. The plan file holds rows and is **private**: every `--out` must be outside the repository. No new D1 table is added for this operation: the loader writes only the three tables, so the cross-domain operation receipts of owner decision 5 belong to the producer integrations, not here.

## Refusals

| Refusal | Meaning |
| --- | --- |
| `marker_not_prepared:<mode>/<cutover>`, `baseline_not_verified`, `schema_below_16`, `marker_unreadable` | the gate; any state but `prepared` over a verified baseline at schema 16 or above |
| `state_tables_missing`, `state_unreadable`, `state_malformed` | the copy cannot be read; a missing table is never an empty class |
| `copy_incomplete: <statement>` | a copy made by the connector tool whose log (`connector_copy_table`) does not mark every table behind the eight state statements done, or whose log cannot be read; `plan`, `sql` and `verify` all stop before reading any row, and the detail names a statement or `log`, never a value. A file with no copy log is read as before |
| `source_digest_mismatch:<id>`, `source_missing:<id>`, `source_malformed:<id>`, `source_changed`, `source_too_large` | the three R2 objects |
| `retirements_invalid:<n>` | the retirement object failed validation as a whole |
| `count_mismatch:<class>:<n>` | the planned rows are not the accepted count |
| `unknown_rows:<class>`, `mismatch:<class>` | the table holds a row the plan does not know, or one with other content |
| `retention_ambiguous`, `duplicate_source_code`, `duplicate_film:<class>` | identity evidence is ambiguous |
| `apply_required`, `plan_digest_required`, `plan_digest_mismatch`, `plan_tampered` | the `sql` command; an edited plan file never passes |

## The live run (separate owner GO, not authorized here)

Everything below is for the operator session and needs its own owner GO. This page prescribes nothing that can run before it.

1. The marker is `prepared`, the baseline `verified`, and the projector is idle ([baseline runbook](film-person-baseline.md#what-each-production-step-still-needs)). Take the projector lease (and the window if pinned) with the connector path's reviewed lease statements.
2. A fresh operator copy through the [connector path](film-person-baseline.md); `plan` with the pinned `--at` and `--lease-id`; review counts and digests.
3. `sql --apply --plan-digest <digest>`; run each batch file through the connector in order, each as one request, reading every result.
4. A copy after the run; `verify` with `--expect-generation` and `--expect-reference` and the same `--at`; keep the receipt.
5. Release the lease. A rerun of `plan` must report `noop`.

A failed or interrupted run needs no repair step: rebuild the plan from the current state and continue; a batch that failed wrote nothing.

## What this does not prove

The tests prove the tool against the sqlite stand-in and fixtures at the accepted counts. They do not prove that D1's multi-statement request rolls back exactly like the stand-in's transaction (the same assumption as the [baseline record and transition SQL](film-person-baseline.md#recording-paths-and-the-measuring-run-offline-code-nothing-executed)), that the real sources resolve to 708/401/4 (the plan refuses if they do not), or that the copy is current (the in-row guard re-checks identity, marker, baseline, lease and counts at run time). No production operation was run. Counts in this page are the accepted 11 Nov 2026 measurement; the dated offline evidence is [here](../evidence/d1-migration/air-374-p5-prepared-loader-offline-2026-11-11.md).
