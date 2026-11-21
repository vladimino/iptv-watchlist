# EPG checkpoint D1 cutover: H-0a resource measurements (read-only) and H-1 status

Date: 21 Nov 2026, 08:57 UTC (09:57 Madrid, UTC+01:00). Scope: [AIR-551](https://trello.com/c/YAVPlcAe), step H-0a of the merged plan ([preflight and L3 plan](air-551-epg-checkpoint-preflight-and-l3-plan-2026-11-21.md)). **Only L0 observation was made.** No production write, no migration, no Workflow or lease action. **H-1 (the scratch D1 preflight) was NOT executed:** see section 4. Base: `main` at `dc03b1e` (the operator tooling of slice A is merged).

## 1. Method and source of truth

- **Path.** `scripts/epg-checkpoint-production.mjs` in its default `status` mode, run with the owner-credentialed, bucket-scoped **Object Read only** R2 key (`R2_SNAPSHOT_*`) and the D1 operator token. In this mode the script sends only R2 `HEAD`/`GET` for the two keys `sync.json` and `watchlist-ingest.json` (the store is built without an allowed-write list, so a `PUT` would be refused before a request exists) and D1 `SELECT` statements plus the Time Travel bookmark `GET`. The core test `tests/epg-checkpoint-production.mjs` asserts that `status` writes nothing and prints no payload; the reported `writeState` was `none` and `writes` was `false`. No other key and no other route was read. No payload, credential or secret is recorded here.
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

## 4. H-1 status: not executed (blocked)

H-1 needs one new disposable scratch D1 database. The creation was **denied by the permission classifier of this session** ("destructive or unwanted action": creating a Cloudflare resource). The owner's decision in the AIR-551 handoff authorizes exactly one scratch database, but the classifier does not accept it as given in this session, and nothing here works around it: no database was created by any other route, no migration was applied anywhere, and `iptv` was not written. `D1_BACKFILL_SCRATCH_DATABASE_ID` in the environment is stale (the account lists only `iptv`) and was not used. There is therefore **no scratch database to clean up**.

Consequently none of the real-D1 measurements exists yet: statement, row and byte budgets of `createRun` staging (batches of 50), a 24-film metadata save, `completeRun`, a full `loadRun`, the `ON CONFLICT` upsert and the triggers, crash and oversize refusal, parity. The Worker CPU and memory of `loadRun` additionally cannot be measured over the REST transport the operator tools use (no scratch Worker is allowed), so they stay unproven even after H-1.

## 5. Verdict and next decisions

- **O2 = UNPROVEN.** The body figure is real; the film count and the maximum film entry are not. A later H-1 run on synthetic data sized from the proxy would be **LIMITED**, not a PASS.
- **To obtain the real figures:** a natural in-progress run exists from 16:00 UTC (17:00 Madrid) for roughly 12 minutes (the previous run completed 11 minutes after its start). Running the same read-only command repeatedly in that window reports `measure.watchlist.films` and `measure.watchlist.maxFilmChars` of the live checkpoint. No manual EPG run is needed or allowed.
- **Gates now prepared:** the H-0a body and ingest sizes, the read-only access path and the same-day H0 contract. **Still unknown:** film count, maximum entry, real D1 budgets, Worker CPU and memory, the live Workflow version at H0.
- **Owner decision needed:** allow the creation of the one scratch D1 in this session (or create it and hand over its id), and say whether to wait for the 16:00 UTC window before H-1 so that the surrogate uses real figures.
