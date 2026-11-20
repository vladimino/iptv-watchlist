# Filter presets: R2 to D1 cutover

Procedure for moving the saved main-page filter presets from the R2 object `ui/filter-presets.json` to D1 (schema v28). **Every production step below needs its own operation-specific owner GO** ([authorization](../process/authorization-and-escalation.md), L2/L3). Deploying the code applies nothing, loads nothing and switches nothing; reading this page authorizes nothing. Contract and states: [programme filters](../reference/domain/programme-filters.md#saved-filter-presets-api-and-storage-contract), schema: [D1 schema](../reference/data/d1-schema.md#filter-presets-authority-schema-v28-repository-only), architecture: [persistence](../architecture/persistence-and-migration.md#filter-presets-authority-schema-v28-dormant).

## What is safe before any GO

The code is dormant. Without the v28 tables, or with the marker in `mode r2` and writes `open`, the route serves R2 exactly as before; the only added cost is one `sqlite_master` read and one marker read per presets request. A D1 error on that read answers `503` for the presets routes only. The route never reads or writes D1 preset rows while the marker is `r2`.

## Preconditions (read-only, each recorded in the evidence)

1. The deployed Worker contains `src/filter-presets-d1.js` (the bundle names it `FilterPresetsD1`); `Deploy to Cloudflare` succeeded for the exact commit.
2. D1 `iptv` reports `schema_contract.version = 27` and none of the three `filter_preset*` tables; or, after step 1 below, version 28 with the marker `r2`, generation 0, writes `open`, and `SELECT COUNT(*) FROM filter_preset` equal to 0.
3. A fresh read of the R2 object (`ui/filter-presets.json`) through the approved read-only export ([R2 snapshot export](r2-snapshot-export.md)): save its content locally as `r2-export.json` and record its ETag and byte size. An absent object is a valid state only if the export procedure proves absence; an unreadable or partial object is a **blocker**, never a reason to import an empty set.
4. `node scripts/filter-presets-d1-sql.mjs digest r2-export.json` prints `{count, sha256}` and exits 0. Exit 2 is a blocker (the Worker itself could not read that document).

## Steps

Each numbered step is one GO. Apply SQL with the approved D1 execution path (`wrangler d1 execute iptv --remote --file ...`); every file is guarded so that a wrong state aborts it before it changes anything.

1. **Apply `migrations/0028_filter_preset_authority.sql`.** It refuses anything but a complete version 27. Readback: version 28; marker `r2`, generation 0, writes `open`; three tables; zero rows. The code and R2 continue to serve; nothing else changes.
2. **Hold presets writes.** `node scripts/filter-presets-d1-sql.mjs hold` prints one guarded update (`writes='held'` only from `r2`/`open`/generation 0). From now on every preset write answers `503` ("temporarily read-only"); reads still come from R2. This is the fence against a concurrent edit: no writer can change the R2 object while writes are held. Re-read the R2 object and compare its ETag with the one recorded in precondition 3; if it differs, run `release`, start over from precondition 3.
3. **Import.** `node scripts/filter-presets-d1-sql.mjs import r2-export.json > import.sql`, review it (one guarded update to generation 1, the fence, then one `INSERT` per preset in document order), apply it. The generator writes the presets as the Worker serves them (normalized), at most 30. The file is guarded: it changes nothing unless the marker is `r2`, writes `held`, generation 0 and the table is empty, so a repeat, a retry after a crash or a double apply is refused by its own guard and never duplicates a row. The marker stays `r2`: D1 does not serve yet.
4. **Parity readback (read-only).** Compare `SELECT id,position,name,query,created_at,updated_at FROM filter_preset ORDER BY position` with the export: same count, same order, same fields. Marker: `r2`, generation 1, writes `held`.
5. **Activate.** `node scripts/filter-presets-d1-sql.mjs activate r2-export.json > activate.sql`, apply it. One guarded update switches `mode` to `d1` and `writes` to `open` only when the generation is 1 and the rows equal the export row by row; a mismatch changes nothing. Readback: marker `d1`, generation 1, writes `open`; `GET /api/ui/filter-presets` through the Access-protected read (the [Access read skill](../../.claude/skills/cloudflare-access-read/SKILL.md)) returns the same presets and the ETag `"d1:1"`.
6. **Acceptance.** A client that held an R2 token gets `412` with the current document and refreshes; one create/rename/delete from the owner UI is confirmed in the rows and the revision rose by one per write. Record all readbacks in a dated evidence report. The R2 object is neither deleted nor changed by this procedure; decommissioning it is a separate GO.

## Recovery and rollback limits

- **Before step 5 (activation):** `node scripts/filter-presets-d1-sql.mjs release` restores writes (`open`) while the marker is `r2` (generation 0 or 1). R2 was never changed, so nothing is lost. Imported rows may stay (a later import is refused only if they differ) or be removed by the owner's explicit decision.
- **A failed or partial apply of step 3:** the fence stops the file before any row; a file that stopped after some rows leaves the marker at generation 1 with a partial table. Do not activate (the parity guard refuses it): compare with the export, and either complete the missing rows under a new GO or reset the table (marker back to generation 0, `DELETE FROM filter_preset`) under a new GO, then repeat step 3.
- **After activation:** D1 is the only authority and R2 is stale from that moment. A code revert does **not** move data and does not restore R2 as the authority; the route keeps reading the marker. Returning to R2 is a separate fenced, owner-approved procedure: hold writes, export the D1 document, write it to R2, set the marker back to `r2`. Presets written in D1 after activation exist only in D1 until then.
- **Never** copy the R2 object over D1 or D1 over R2 after activation without the hold, and never delete the marker or a table to "reset" a domain: with a table present and the marker unreadable the route answers `503` on purpose.
- Lost replies: step 3 and 5 are idempotent through their guards; read the marker and the row count before repeating anything.

## Out of scope

Started marks, the Events journal and any other R2 object; those are separate domains with their own contracts and GOs.
