# AIR-549 stage 2: Started marks R2 to D1 cutover, production evidence

Date: 20 Nov 2026 (UTC; Madrid is UTC+1). Scope: the production cutover of the Started marks from the R2 objects `started/<id>.json` to D1 (schema v29), run from [the cutover runbook](../../runbooks/started-marks-cutover.md) after the dormant code of [PR 822](https://github.com/vladimino/iptv-watchlist/pull/822) (merge `5c778baca4456411dd8b966e87e01a8b87ca2f95`, post-merge CI/CD [44780700393](https://github.com/vladimino/iptv-watchlist/actions/runs/44780700393) all jobs SUCCESS, deployed 17:12:26 UTC) was live. Counts, digests, ETags and states only; no film ids, titles or event payloads are reproduced here.

## Result

D1 is the only authority for Started marks since the activation: marker `d1`, generation 1, writes `open`, schema `schema_contract` 29, 49 rows in `started_mark` (48 started, 1 tombstone), every row at revision 1. The Access-protected `GET /api/started` answers `200` with exactly the 48 started ids of the source, in the order of the R2 listing. The R2 objects are stale from that moment and were not changed by the cutover. The Filter presets marker is untouched (`d1`, generation 3, `open`, 3 rows).

**Not proved by this report (open acceptance):** one «Начал просмотр» set and one unset from the owner UI with the revision rising by one per write, the same repeated click returning the same event, the started filter and the Events screen showing the same marks. These need production writes by the owner and were not run by the executor. Stage 2 is therefore "cutover executed, owner acceptance pending", not accepted. The Events bootstrap (`POST /api/events/bootstrap`) was not run and is outside this flow.

## Preflight (read only)

| Check | Reading |
| --- | --- |
| `main` and deploy | `5c778bac`; Worker `iptv` deployed 17:12:26 UTC from PR 822; no later change to migrations, the Worker, the store module, the generator or the runbook |
| Worker bindings | `DB` is D1 `3fba0e0a-44e9-4a3a-a7ba-edaee6bcafcb` (equal to `wrangler.jsonc`), `BUCKET` is `iptv` |
| D1 before | `schema_contract` 28, no `started_*` table, the three `filter_preset*` tables and the downgrade trigger present |
| R2 `started/` listing | 49 objects, 11,303 bytes, largest 290 bytes, all keys of the form `started/<id>.json`, every ETag strong; inventory sha256 `502f123424616abaf59098d44589d110ac7700cdbc9fe933aeff98ba804bb53b` (key, ETag, size) |

**Deviation from the handoff.** The handoff expected the Filter presets marker at `d1`/1/`open`; it read `d1`/3/`open` (owner UI edits after the Filter presets cutover). Stage 1 is not affected.

## Steps

1. **Apply `migrations/0029_started_authority.sql`** (nine statements, verbatim from the file, one call). Readback: version 29 (one `schema_contract` row), marker `r2`/0/`open`, `started_cas.ok` 1, no `started_mark` row, Filter presets unchanged.
2. **Hold** (guarded update): `r2`/0/`held` at about 17:21:58 UTC.
3. **Drain and bound snapshot** (read only): a 2-minute wait, an opening complete listing, a conditional GET (`If-Match` the listed ETag, identity encoding) of every listed key, a closing listing. 49 of 49 answered `200` with the listed ETag, 0 failures; the closing listing equals the opening one and both equal the preflight inventory (sha256 above), so no R2 write happened between the preflight and the snapshot.
4. **Generator digest** (local): `digest` exit 0, count 49, started 48, sha256 `b70a2fa663f9ad875d955ab0182f6537facd82965f0c2e3e376f3403a2ad4d22`, `etagsSha256` `ba50e098b0b4f6c3a4cdfb9064cb415230b0e22e6cb98fe5bea386624ba84a3e`; no blocker. Composition: 44 objects with metadata `true` and body true, 1 tombstone (`false`/false), 4 legacy objects with no metadata and no `started` field (both legacy readers treat them as started), 45 with a stored `lastEvent`.
5. **Import** (51 statements: the guard to generation 1, the fence and 49 inserts; all `changes` 1). The SQL was passed to D1 by hand from the generated file, so parity was checked in full. Marker `r2`/1/`held`, 49 rows, 48 started, all revision 1.
6. **Parity** (read only): the full contents of all 49 rows (id, started flag, `started_at`, `last_event_json`) read back from D1 equal the normalized export byte for byte, in R2 key order. R2 after the import: the same inventory sha256, no write.
7. **Release** (owner message at 17:27:08 UTC, executed 17:27:09 UTC): `r2`/1/`open`. This was not the intended step (see the provenance table); it re-opened R2 mark writes for about 40 seconds.
8. **Second hold, drain and bound snapshot** (about 17:27:52 UTC to 17:30:07 UTC): hold `r2`/1/`held`, a 2-minute wait, the same bound snapshot: 49 of 49 conditional GETs, 0 failures, opening equal to closing equal to the first inventory (sha256 `502f1234…bb53b`) and the same `digest` (count 49, started 48, sha256 `b70a2fa6…ad4d22`). No R2 write happened in the release window, so the imported rows were still current.
9. **Activate** (between 17:30:07 UTC and 17:31:10 UTC): the generated `activate` SQL (49 per-row parity statements, then one guarded switch at generation 1 with 49 rows and 48 started, then the fence), passed by hand; all 51 statements `changes` 1. Readback: marker `d1`/1/`open`, 49 rows, 48 started, no row with a revision other than 1, `schema_contract` 29, `started_cas.ok` 1.
10. **API readback** (Access login by the owner at 17:33:35 UTC, then read only at about 17:33 UTC): `GET /api/started` answered `200`, `ids` of length 48, equal to the 48 started ids of the export in the order of the R2 listing. D1 after the read: unchanged (`d1`/1/`open`, 49 rows, maximum revision 1), so the read wrote nothing.

## Authorization provenance (operator-attested, not independently verified)

Each production step had an owner message in the executor chat; there is no linkable approval record outside it. The times are the server-recorded creation times of the owner's messages in the session transcript (UTC; Madrid is UTC+1). Per-step execution times are not separately recorded; each step ran after its message and before the next, apart from the approximate times above.

| Owner message | UTC | Madrid | Step it covered |
| --- | --- | --- | --- |
| "GO-1" | 2026-11-20 17:21:23 | 18:21:23 | The bounded package: apply 0029, hold, drain, bound snapshot, digest, import, parity (stop before activation) |
| "release" | 17:27:08 | 18:27:08 | Release of the hold (step 7) |
| "стоп" | 17:27:30 | 18:27:30 | Stop; nothing further was running |
| "я хотел Activate" | 17:27:40 | 18:27:40 | Activation. The executor treated it as the activation GO including the re-hold, drain and snapshot that the activation guard requires after the release; those steps were not named in the earlier GO-2 proposal |
| "вошел" | 17:33:35 | 18:33:35 | The owner completed the Access login; the read-only `GET` followed |

The release in step 7 came from an owner message sent while the executor had proposed "GO-2 or release"; the owner then said the intent had been to activate. The interpretation of the last message is the executor's and is stated here so the reviewer can object.

## Not done

- The owner UI set and unset, the repeated-click check, the started filter and the Events screen check (open acceptance above).
- The R2 `started/` objects were neither deleted nor changed; decommissioning needs its own GO. The event journal `events/items/` was not read for comparison and not written by the cutover.
- Stage 2 is not accepted; AIR-549 stays in progress and AIR-275 stays blocked.

## Limits

The deployed bundle was not inspected for `StartedD1`; its presence follows from the successful post-merge deploy and from the route answering from the D1 rows. The statements of steps 1, 5 and 9 were typed into the D1 call by hand from generated files; the full-content parity of step 6 and the per-row guards of step 9 are what prove they match. A code revert does not return the data; returning to R2 is the separate fenced procedure in the runbook. Marks written in D1 after the activation exist only in D1.
