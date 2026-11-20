# AIR-549 stage 1: Filter presets R2 to D1 cutover, production evidence

Date: 20 Nov 2026 (UTC). Scope: the production cutover of the saved filter presets from R2 `ui/filter-presets.json` to D1, run from [the cutover runbook](../../runbooks/filter-presets-cutover.md) after the code of [PR 811](https://github.com/vladimino/iptv-watchlist/pull/811) (merge `26e0ee38c82e05d699344830bb196e6bc2042f06`) was deployed. Each production step had its own owner GO given in the executor session. Private preset content (names and queries) is not reproduced here; only counts, digests, ETags and states are.

## Result

D1 is the only authority for presets since the activation: marker `d1`, generation 1, writes `open`, 3 rows. The Access-protected `GET /api/ui/filter-presets` answers `200` with `schemaVersion` 1, the three presets in the imported order and the ETag `"d1:1"`. The R2 object is stale from that moment and was not changed by the activation.

**Not proved by this report (open acceptance):** a stale R2 `If-Match` answering `412` against production, and one create, rename or delete from the owner UI with the revision rising by one. Both need a production write; the owner chose to record this evidence without the UI check. Stage 1 is therefore "cutover executed, owner acceptance pending", not accepted.

## Preflight (read only)

| Check | Reading |
| --- | --- |
| Worker `iptv` binding `DB` | D1 `3fba0e0a-44e9-4a3a-a7ba-edaee6bcafcb`, equal to `wrangler.jsonc` and to the database `iptv` |
| `schema_contract` | version 28, three `filter_preset*` tables |
| Marker | `r2`, generation 0, writes `open`; `filter_preset` 0 rows; `filter_preset_cas.ok` 1 |
| R2 `ui/filter-presets.json` | ETag `c9e2fab3b9b2237003b3262627948905`, 1525 bytes, raw sha256 `9f4557933509967e8e2d23e3e22b67fc2584ccbcebb65ab4307e8802ef3d2737`; `digest` exit 0, count 3, sha256 `8ff4117e2f68b0777faadcd2535571dccb0da34074c953824843ca461d698abc` |

**Deviation.** The handoff said migration 0028 had not been applied. It had already been applied to production D1 by someone other than this executor, before the preflight; the state was exactly the post-0028 state (marker `r2`/0/`open`, no rows). The "apply 0028" step was therefore skipped, and who applied it and when is not recorded here.

## Hold and R2 fence

- Hold: the guarded `hold` update, both statements `changes=1`; readback `r2`, generation 0, writes `held`, CAS 1, 0 rows.
- Fence, first attempt: the `R2_INSTALL_*` credential was refused by the bucket on the first GET (HTTP 401/403); no write happened (`puts` 0).
- Fence, second attempt with the read-write pair `R2_RW_ACCES_KEY_ID` and `R2_RW_ACCESS_SECRET_ACCESS_KEY` (values never printed): the stored raw bytes plus one trailing newline, written conditionally on the ETag just read. Old ETag `c9e2fab3…` became `afa0bf35aa53240d70884823ef41a0d5`; 1526 bytes, raw sha256 `7f885be26d9b1b8f44f9fe050b556b9039fe0d3cfadea64251c3faa1776f218b`. The ETag changed, a HEAD matched the PUT reply, and a GET returned the fenced bytes exactly. `digest` of the fenced export: count 3, sha256 `8ff4117e…` (the same set as before the fence). The fenced export, not the first read, is the import source.

## Import and parity

- The generated `import` SQL (1,802 bytes: marker update to generation 1, fence, three inserts in document order) was applied in one call; all five statements `changes=1`. The SQL was passed to D1 by retyping it from the generated file, not by executing the file, so parity was checked in full.
- Readback: `r2`, generation 1, writes `held`, CAS 1, 3 rows at positions 0 to 2, all `generation` 1. Id, order, name, query, `createdAt` and `updatedAt` of every row equal the fenced export.

## Activation and readback

- The generated `activate` SQL (three row guards, one guarded switch, the fence) was applied the same way; all five statements `changes=1`.
- Readback: marker `d1`, generation 1, writes `open`, CAS 1, 3 rows.
- `GET /api/ui/filter-presets` through Cloudflare Access (a read-only route in the [read side-effects baseline](../../reference/api/read-side-effects.md)): HTTP 200, ETag `"d1:1"`, `schemaVersion` 1, three presets equal to the fenced export. D1 after the GET: unchanged, generation 1, no write.
- R2 after the activation: ETag `afa0bf35…`, raw sha256 `7f885be2…`, byte-equal to the fenced export (no write by the activation).

## Not done

- The stale R2 `If-Match` check and the owner UI mutation (above).
- Decommissioning or changing the R2 object, which needs its own GO.
- Stage 2 (Started marks) is not started. AIR-549 stays in progress; AIR-275 stays blocked.

## Limits

The deployed bundle was not inspected for `FilterPresetsD1`; its presence follows from the successful post-merge deploy and from the route answering the D1 ETag. Evidence of the owner's grants is the executor chat, not a separate record. A code revert does not return the data; returning to R2 is the separate fenced procedure in the runbook.
