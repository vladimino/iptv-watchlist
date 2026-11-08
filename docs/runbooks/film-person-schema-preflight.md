# Film/Person schema 13–16: read-only preflight and apply sequence

**Role:** the procedure for the first production step of [AIR-373](https://trello.com/c/ugu3sQmp): bringing the production D1 `iptv` from its recorded schema to 16 (migrations `0013` to `0016`, [ADR 0099](../adr/0099-canonical-film-person-d1-authority.md)). Applying the schema moves no authority: the marker stays `r2`, R2 stays authoritative and the enrichment projector stays the only canonical Film/Person writer. This page authorizes nothing by itself: the preflight is an observation, **each apply is a separate operation-specific owner decision**, and the schema state is never inferred from older documents.

Offline helper: [`scripts/schema-preflight.mjs`](../../scripts/schema-preflight.mjs) (tested by `tests/schema-preflight.mjs`). It touches no network or database; it generates the exact `SELECT` statements from the migration files and judges the rows an authorized reader brings back.

## 1. Read-only preflight (immediately before any apply)

Every statement is one `SELECT` (the helper refuses anything else). Run them in this order and keep the rows as evidence; write nothing, run no write-bearing GET (`GET /api/programme`, `GET /api/watchlist` and Admin can call `repairMirrors`).

1. **Code and target.** The current `main` SHA and the deployed Worker version (a Workers deployments list or the post-merge `Deploy to Cloudflare` run), and that the target is the D1 database named `iptv` (database id from the account listing).
2. **Schema.** `preflightSteps()` gives `version` (`schema_contract`: exactly one row), `prerequisites` (the twelve tables of a complete v12), `inventory` (which of the objects of `0013` to `0016` exist) and `projector_lease`. When the version is at least 13 and the `0013` tables exist, `MARKER_STEPS` gives `marker`, `fence` and `baseline`.
3. **Verdict.** Convert each query response with `unwrap` (the rows of a successful single-statement D1 response; an error envelope or `success: false` gives nothing) and pass the rows to `evaluatePreflight`, which fails closed: a missing, null, non-array or failed probe result (`version`, `prerequisites`, `inventory`, `projector_lease`, and from version 13 `marker`, `fence`, `baseline`) is a blocker (`result_missing:<probe>`, state `incomplete`) and never an empty read; a verified empty `projector_lease` (`[]`, no run recorded) stays distinct from an absent one, and a lease row that cannot be dated counts as live. It returns `ready_v12`, `at_v13`…`at_v15`, `complete` or `inconsistent`/`unknown`, the single next migration and the blockers. `inconsistent` (a migration partly applied, a version that skips one, a missing object, a version row problem) means **stop and escalate**: no apply, no repair and no retry is proposed.
4. **Writers and leases.** The enrichment projector lease must not be live (`projector_lease_live` blocks and the apply waits for it to expire or release; the lease is never reset). Also record the Discovery lease, the `sync.json` stage (through `epg_status`) and the owner-review and metadata-cache authority generations, as in the earlier preflights.
5. **Recovery point.** The D1 Time Travel bookmark for `iptv` (`wrangler d1 time-travel info iptv`, a read), recorded before the apply, with the boundary: restoring a bookmark restores the whole database and loses every later write of every domain, so it is an owner decision and never an automatic step.

## 2. Owner decision before each apply

Present the preflight rows and verdict and ask for a GO naming **exactly one file**, for example "apply `migrations/0013_film_person_authority.sql` to production D1 `iptv`". A GO for development, for ADR 0099, for a merged PR or for the preflight is not that decision, and a GO for one file is not a GO for the next. The four files are applied in order, one at a time, each with its own readback (the files refuse any other starting version, so a skipped or repeated apply fails before it creates a table).

## 3. Apply and readback (only after that GO)

Use the method recorded for the previous schema apply ([AIR-357 `0012` apply](../evidence/d1-migration/air-357-0012-apply-2026-11-05.md)): one D1 execution of exactly the checked-in file, no other statement. On an unknown outcome run the readback first and never retry blindly. The readback re-runs the preflight statements and expects:

| After | `schema_contract.version` | New objects | Marker (`0013` onwards) |
| --- | --- | --- | --- |
| `0013` | 13 | `film_person_authority`, `film_person_cas`, `film_person_baseline`, `canonical_revision` and their triggers | `r2` / `open` / generation 0, fence `ok` 1, baseline `empty` |
| `0014` | 14 | `film_localization_source`, `person_localization_source` (empty) | unchanged |
| `0015` | 15 | `film_rated_admission`, `film_retention`, two unique indexes (empty) | unchanged |
| `0016` | 16 | `tmdb_retirement_decision`, its indexes and triggers, `tmdb_retirement_current` (empty) | unchanged |

A mismatch or an inconsistent verdict stops the sequence and is escalated: no automatic downgrade, reset or rollback of the whole database. A schema apply does not start a writer, move the marker or change any R2 or D1 row.

## 4. What stays out of this step

A bounded baseline import and reconciliation, the `r2` to `prepared` move and every later step are separate operation-specific owner decisions after a proven schema (AIR-373 continues, then AIR-374). The producer writes that no fenced mutation covers yet ([AIR-371 evidence](../evidence/d1-migration/air-371-producer-routing-offline-2026-11-07.md)) block the cutover, not the staging of the schema while authority stays R2. A code rollback reverts neither the schema nor any row.
