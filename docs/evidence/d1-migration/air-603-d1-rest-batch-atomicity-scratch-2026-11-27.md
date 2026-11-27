# D1 REST batch atomicity on a scratch database (AIR-603, 27 Nov 2026)

**What this is:** a dated observation of the Cloudflare D1 REST `query` endpoint on a **one-off scratch database**, made to inform the review of the single migration window operator ([runbook](../../runbooks/d1-migration-window-v38-v54.md)). **What it is not:** a proof for the production database, a test of a lost connection or a timeout, or authorization of any production operation.

## Set-up

- Database `air603-atomicity-scratch`, created at 2026-11-27T21:50:10Z in the production Cloudflare account through the Cloudflare developer platform connector, with the owner's explicit permission in the executor session (the earlier scratch id in the environment no longer existed and the credentials guide forbids silently replacing it). It was not the production database (`iptv`): the script refused the production UUID and read the database name back from Cloudflare before writing (`air603-atomicity-scratch`, `is_production: false`, 0 tables). It was **deleted** through the same connector after the measurement. No production database, table, credential value or customer data was involved.
- Client: `createD1Adapter` of `scripts/d1-backfill.mjs` (the adapter the operator uses), zero retries. Table `air603_probe (id INTEGER PRIMARY KEY, v TEXT)` created and dropped by the script; the script is a throwaway and is not committed.

## Request shapes

- `executeRendered(statements)`: `POST /accounts/<account>/d1/database/<db>/query` with the JSON body `{"batch":[{"sql":"<statement 1>;"},{"sql":"<statement 2>;"}, ...]}`, one entry per statement. This is the shape the operator's per-file batch uses (`createPublishedBinding(...).batch`).
- `executeSql(statements)`: the same endpoint with the JSON body `{"sql":"<statement 1>;\n<statement 2>;\n..."}`, one multi-statement string.

## Observations (each after a statement error in the last statement)

| # | Request | Statements | Outcome | State read back afterwards |
| --- | --- | --- | --- | --- |
| 1 | `{batch}` | `INSERT ... VALUES (1,'a')`, `INSERT ... VALUES (2,'b')`, `INSERT ... VALUES (1,'dup')` (primary-key violation) | the adapter reported a statement error | `SELECT COUNT(*)` = **0**: the two valid inserts did not persist |
| 2 | `{sql}` multi-statement | the same three inserts | statement error | `COUNT(*)` = **0** |
| 3 | `{batch}` with DDL | `CREATE TABLE air603_t2 (x INTEGER)`, `CREATE TRIGGER air603_trg AFTER INSERT ON air603_t2 BEGIN SELECT 1; END`, `INSERT ... VALUES (9,'x')`, `INSERT ... VALUES (9,'dup')` | statement error | neither `air603_t2` nor `air603_trg` in `sqlite_master`, `COUNT(*)` = **0** |

Reading: for a statement error the service rolled the whole batch or multi-statement body back, DDL and a trigger body included, in both request shapes. Single runs, on one day, on a scratch database in the same account; nothing was measured for a connection that dies after the request is sent (the outcome of such a write stays unknown and the operator never retries it).

## Consequence for the operator

The operator does not rely on this observation. It keeps the guard-first statement, the version-update-last order, the exact readback against the pinned reference schema, `write_uncertain` for any unclear answer and no retry, and it treats a non-atomic transport as possible (tested offline with a transport that applies statements one by one and dies halfway).
