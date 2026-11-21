# EPG checkpoint D1 cutover: H-0a resource measurements (read-only) and H-1 scratch preflight

Date: 21 Nov 2026. H-0a at 08:57 UTC (09:57 Madrid, UTC+01:00), H-1 at 09:02-09:08 UTC (10:02-10:08 Madrid). Scope: [AIR-551](https://trello.com/c/YAVPlcAe), steps H-0a and H-1 of the merged plan ([preflight and L3 plan](air-551-epg-checkpoint-preflight-and-l3-plan-2026-11-21.md)). H-0a is **L0 observation only** (no production write). H-1 wrote **only** to one disposable scratch D1 database (section 4); production `iptv`, R2, the Worker, Workflows, leases, flags and Tasks were not written. Verdicts: **H-1 PASS on the D1 engine over the REST transport, with synthetic data (LIMITED); O2 UNPROVEN; Worker CPU and memory UNPROVEN; one blocker found in the operator tooling (section 5).** Base: `main` at `dc03b1e` (the operator tooling of slice A is merged).

## 1. Method and source of truth

- **Path.** `scripts/epg-checkpoint-production.mjs` in its default `status` mode, run with the owner-credentialed, bucket-scoped **Object Read only** R2 key (`R2_SNAPSHOT_*`) and the D1 operator token. The script reads the two checkpoint objects, `sync.json` and `watchlist-ingest.json`, via R2 `HEAD`/`GET`, and reads D1 through `SELECT` plus a Time Travel bookmark `GET`. If a completed run has `watchlistEventFixed` and a watchlist event, the `status` drain proof can additionally issue a read-only R2 `HEAD` for that event's `events/items/...` journal key; the capture did not retain a per-key request trace, so an assertion that **only** the two checkpoint keys were accessed is not independently established. The R2 store has no allowed-write list, so `PUT` is refused locally before any request exists. The core test `tests/epg-checkpoint-production.mjs` asserts that `status` writes nothing and prints no payload; the reported `writeState` was `none` and `writes` was `false`. No R2 or production D1 writes, payload, credential or secret are recorded here.
- **Consistency.** Each object is read with `HEAD`, then `GET`, and the script refuses (`source_changed`) when ETag or size differ between them.
- **Separate read-only D1 `SELECT`s** (Cloudflare D1 connector, `changed_db=false`, `rows_written=0`) for the published watchlist proxy in section 3.

## 2. Observed values (real data, dated observations)

| Object | Size (bytes) | ETag | SHA-256 |
| --- | --- | --- | --- |
| `sync.json` | 4,202 | `976471e1ed575f823ff98880bcc92dd0` | `a12a95f5a28b1cd03ad23cef849c898d009466339506b5cf707ddebdd8ae5953` |
| `watchlist-ingest.json` | 78 | `b957862ebd5159e0083c8dff4ca3ca97` | `b4c350c7180922d01e441c7767303f62e29e09e38be780ca9756afea48b69329` |

- `sync.json` is a **completed** run (`stage=complete`), so it carries **no `watchlist`**: the serialized body without the watchlist is **4,202 characters**, the whole object. Against the ADR 0185 caps this is 0.47% of the 900,000-character body budget.
- D1 at the same time: schema version **29**, no `epg_checkpoint_*` table (the checkpoint is still R2-authoritative), Discovery EPG-priority pause `clear`. These ETags and digests are observations of that moment only; a natural run changes both objects, and the cutover identity is captured at H0, never reused from here.
- The drain proof reported `run_not_current_day`, `control_not_current_day` and `workflow_evidence_missing`, which is the intended result for a run of the previous Madrid day and a call without Workflow evidence: the tool refuses outside the same-day boundary.

## 3. What is real and what is a proxy

| Quantity | Status | Value |
| --- | --- | --- |
| Body size without the watchlist (completed run) | **observed** | 4,202 characters |
| Ingest document size | **observed** | 78 bytes |
| `film_count` of the ingest watchlist | **not observed** (a completed run has no watchlist) | proxy only: 395 published watchlist members |
| Largest serialized film entry of `sync.json.watchlist` | **not observed** | proxy only, see below |
| Body size of an in-progress run | **not observed** | none |

**Proxy (clearly not the checkpoint shape).** The published watchlist of the current programme run, from D1: 395 `published_epg_member` rows of kind `watchlist`, stored in 22 `published_epg_document` chunks of at most 54,018 characters (average 52,095, total 1,146,109 characters), which is about **2,900 characters per published film**. This is the published, deduplicated form, not the ingest entry of `sync.json`, so it bounds neither the real film count nor the real maximum entry. It is the only retained source found; no other retained copy of `sync.json.watchlist` exists, because completion deletes it.

## 4. H-1: bounded scratch preflight on a real Cloudflare D1

**Scratch identity (no secret).** Database `iptv-air551-h1-scratch-20261121`, uuid `dad6ed12-b150-484e-a893-ca93a1d1deba`, created 09:02 UTC in region ENAM (production `iptv` is in WEUR), no Worker binding, no flag, no deploy. Exactly one database was created and the account then listed exactly two (`iptv` and the scratch). The first creation attempt of this step was refused by the permission classifier of the session and was not worked around; the creation succeeded only after the owner's explicit authorization in the chat. Every write of the harness goes to a URL built from the scratch uuid; the harness first reads the database by uuid and name and aborts unless both equal the scratch values and the name is not `iptv`.

**Cleanup.** After the evidence was recorded, the scratch database was deleted by uuid and name (both read back first and equal to the values above), and the account then listed only `iptv`. No scratch resource remains.

**Method.** A harness kept outside the repository (not committed; it needs its own tests and reviewable scope if the owner wants it kept) applies the migration chain to the scratch and then calls the **real functions** of `src/epg-checkpoint-d1.js` (`createRun`, `loadRun`, `saveRun`, `completeRun`, `recordIngestFailure`, `readIngest`) and `PublishedEpg.certifyUpdateStatements` through a small D1 REST binding (`POST /query`, one `batch` request per repository batch). Every request records wall time, bytes, statement count and the `rows_read`, `rows_written` and SQL duration of the D1 response. No request was retried; no write outcome was unknown. The payload is **synthetic**: a film entry is `{id, title, peopleVersion, metadata:{synopsis (padding), credits}}` padded to a target size; a run body carries the pending id list. No R2 payload was copied.

**Schema.** Migrations 0001 to 0029 applied without error, then 0030 with a depth-aware splitter (see section 5): schema version 30, the 7 tables, the index and the 2 triggers present. The marker was set directly to `d1/open/generation 1` in the scratch (it is its own database), with a mode document, a lease for holder `h1` and the published-EPG authority row seeded.

**Measured cases** (a full run each: `createRun` with staging batches of 50 and one switch batch, `loadRun` of the whole list with deep-equality parity, one 24-film metadata save, a stage save, a seal save, `completeRun` with the certificate and pause-clear statements, `loadRun` of the completed run). All four cases passed with parity, the certificate was written and the pause cleared in the completion batch, and no film row remained after completion.

| Case (synthetic) | Film entry | Watchlist chars | `createRun` | `loadRun` | 24-film save | `completeRun` |
| --- | --- | --- | --- | --- | --- | --- |
| C1: 395 films (published-watchlist proxy count) | 2,900 | 1.15 M | 16 requests, 1.7 s, 438 statements (max 53 per batch), 1.27 MB, 1,221 rows written, SQL 32 ms | 104 ms, 400 rows read | 96 ms, 57 statements, 86 KB, 58 rows written | 96 ms, 12 statements, 407 rows written |
| C2: 1,000 films (count margin) | 2,900 | 2.9 M | 28 requests, 3.0 s, 1,079 statements, 3.2 MB, 3,072 rows written, SQL 96 ms | 123 ms, 1,005 rows read | 95 ms, 57 statements, 95 KB | 98 ms, 12 statements, 1,013 rows written |
| C3: 395 films (entry margin) | 12,000 | 4.7 M | 16 requests, 1.65 s, 438 statements, 4.9 MB (max 614 KB per request), SQL 56 ms | 136 ms | 101 ms, 304 KB | 92 ms |
| C4: 120 films (near the 90,000 cap) | 85,000 | 10.2 M | 11 requests, 1.9 s, 148 statements, 10.2 MB (max 4.26 MB per request), SQL 51 ms | 248 ms | 283 ms, 2.05 MB | 105 ms |

Reading: the largest single request accepted over REST was 4.26 MB (50 entries of 85,000 characters). A film entry costs about three rows written on creation (the row and its two indexes). The 24-film metadata save is 57 statements in one batch whatever the entry size.

**Negative and semantic outcomes on the real engine** (all as designed):

| Check | Outcome |
| --- | --- |
| Two writers on one revision | the second gets `conflict`, nothing changed |
| Step lease of another holder; stale EPG mode revision; lease expiring before the write boundary | each `conflict`, run digest unchanged |
| Film entry over 90,000 characters; body over 900,000 characters | `budget`, refused before any statement is sent |
| A statement over 100 KB | refused by D1 (`SQLITE_TOOBIG`); a statement of 90,000 characters is accepted |
| Batch atomicity: a valid insert followed by a failing `CHECK` in one request | the whole batch is rolled back, no probe row left, the fence row restored to `ok=1` |
| Orphan film rows of an interrupted creation | removed by the next creation |
| Triggers | stage regression, revision jump and deletion of the fence row are refused (`epg_checkpoint_regress`, `epg_checkpoint_cas_required`) |
| `ON CONFLICT` upsert with the row-value comparison | newer failure applied, older attempt superseded, same attempt repeated is idempotent, a newer success resets the counter |

One check of the harness was a no-op (a regression `UPDATE` whose `WHERE` matched no row because the run was already at `metadata`); the equivalent check from `epg` is in the table. The classification of an unknown outcome by receipt could not be provoked over REST (no lost reply) and stays covered only by the offline tests.

## 5. Blocker found: the operator's statement splitter breaks migration 0030

`migrationStatements` (shared by the production operator scripts) counts every `END` as the end of a trigger body. Migration 0030 contains `CASE ... END` inside the trigger `epg_checkpoint_run_order`, so the function cuts that trigger into two statements (16 statements instead of 15). Sent as separate batch entries, as the REST batch does, the first piece fails with `incomplete input`. The scratch apply of 0030 failed exactly this way (atomically: nothing of 0030 was applied) until the harness used a depth-aware splitter. The offline test of `--apply` did not catch it because its sqlite stand-in re-joins the pieces into one script. Consequence: **`--apply` of `scripts/epg-checkpoint-production.mjs` must not be run against production until `migrationStatements` is fixed** (BEGIN and CASE open, END closes) and a test checks each statement on its own. This is a code change, so it is proposed as a separate follow-up PR; nothing in this report changes code.

## 6. Verdict and what is left

- **H-1: PASS (LIMITED).** The repository batches, fences, triggers, upsert and atomicity behave on a real D1 as designed, with budgets far below the observed request and statement limits at every tested size. The film count and the film entry size are surrogates, so this does **not** certify O2.
- **O2 = UNPROVEN.** The real film count and maximum entry still need the read-only `status` observation of a natural in-progress run from 16:00 UTC (17:00 Madrid), about 12 minutes; no manual EPG run is needed or allowed. The tested envelope is 1,000 films at 2,900 characters, 395 at 12,000 and 120 at 85,000.
- **Unproven, not measurable over REST:** Worker CPU and memory of `loadRun` (a whole watchlist rehydrated in memory: 10 MB in C4), the number of D1 queries a Worker invocation may issue (C2 needs 1,079 statements in 28 round trips to create a run), and latency from a Worker in WEUR (the scratch was in ENAM, from a container). A scratch Worker is outside the authorization.
- **Gates now prepared:** read-only access path, body and ingest sizes, the real-D1 behavior of every statement shape of ADR 0185, the same-day H0 contract. **Still open:** the splitter fix before `--apply`, the real film figures, the Worker budgets, the live Workflow version at H0.
