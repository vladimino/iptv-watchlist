# AIR-373: offline evidence of the read-only schema preflight kit (no production read)

**Captured:** 2026-11-08 (UTC). **Method:** offline tests (`tests/schema-preflight.mjs`), the full `npm test` and `npm run build`. **No production read or write was made.** A read-only `SELECT` of `schema_contract` and of the `sqlite_master` inventory through the Cloudflare D1 query connector was attempted for the preflight and was refused by the session's permission layer ("Production Reads"); it was not retried by another route or another tool. The production schema version, the existence of the objects of migrations `0013` to `0016`, the marker, the leases and the Time Travel bookmark therefore remain **UNVERIFIED**, and no apply decision can be requested as preflight-complete from this evidence.

## What was verified (offline)

- The statements are generated from the checked-in migration files (every table, index, trigger and view of `0013` to `0016`, without the shared `schema_contract_no_downgrade` trigger) and each is one read-only `SELECT`; an `UPDATE`, a second statement, `PRAGMA`, a leading `CREATE` or a data-modifying CTE is refused, as is an unexpected object name.
- `evaluatePreflight` judges: clean v12 (`ready_v12`, next `0013`), each `at_v13` to `at_v15` (only the next migration is named), `complete` v16 (nothing to apply), a version that skips a migration, a half-applied migration, an object missing after its version, an invalid or duplicated `schema_contract`, a database below v12 or without the twelve prerequisite tables, a live projector lease, an unread marker, a moved marker and an authority moved before the schema is complete. On an inconsistent state it suggests no next step.
- The kit contains no network, D1, shell or environment access.

## Not verified

Everything about production: version, objects, marker, leases, deployed SHA, the recovery bookmark and its boundaries. The procedure is in [the runbook](../../runbooks/film-person-schema-preflight.md); the owner's GO for each apply is separate and absent.
