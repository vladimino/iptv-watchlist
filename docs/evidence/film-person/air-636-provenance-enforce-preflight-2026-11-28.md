# AIR-636: read-only preflight of the provenance `off → enforce` flip, 28 November 2026

[AIR-636](https://trello.com/c/0jJADYxg) · [ADR 0214](../../adr/0214-film-metadata-per-field-provenance.md) (PVE) · [runbook](../../runbooks/film-metadata-provenance-activation.md)

**Scope and limits.** Read-only observation (L0) between 06:44 and about 07:10 UTC on 28 November 2026: D1 `SELECT`s on database `iptv`, read-only IPTV MCP tools and one Cloudflare `GET` of the Worker deployments. **No production write, no flag, Scheduled Task, sync, fetch or refresh, and no flip.** This file proves the state at that time only; it is **not** the owner L3 GO and **not** the activation record. The flip needs its own GO and a second dated evidence file with its readback.

## Observed

| Item | Observation (28 Nov 2026) | Result |
| --- | --- | --- |
| Schema | all five provenance tables present: `film_metadata_field`, `film_metadata_history`, `film_metadata_owner_command`, `film_metadata_owner_release`, `film_metadata_provenance_control`; production schema 54 (AIR-603 window) | as expected |
| Control row | one row: `mode = off`, `revision = 1`, `updated_at = 2026-11-27T00:00:00.000Z`, `updated_by = migration:0049` | as expected |
| Release rows | `film_metadata_owner_release`: 0 rows | empty |
| Other provenance tables | `film_metadata_field`, `film_metadata_history`, `film_metadata_owner_command`: 0 rows each | nothing written at `off` |
| Feature flags | the mode is not a registered flag; registry read shows no provenance flag | no flag involved |
| Code | AIR-631 (PV1), AIR-633 (PV2), AIR-634 (PV3) and AIR-635 (PVU) are in `main` | merged |
| Deployed version | Worker `iptv`, newest deployment `bbaea9cc-0530-4cee-a793-735bc0289bc7` at 100 %, created 06:59:20 UTC, deployed from the `main` push of the AIR-664 evidence commit (CI/CD run 46118794413, success) | contains PV1-PV3 |
| Deploy churn | four deployments in about six hours (01:16, 01:30, 06:28, 06:59 UTC); the CI/CD run of AIR-609 (#1063, run 46119181804) was still `in_progress` at 07:00 UTC | **drain clock not satisfied** |
| Discovery / EPG | `epg_pipeline_status`: Discovery executor `phase: stopped`, `liveness: complete`, programme run `54ba0055-…` complete, queue `empty`, continuation `settled` | no instance running |
| Producer chain | newest `canonical_producer_chain` row: `owner_state = complete`, lease expired 2026-11-27 17:29 UTC, `owner_epoch` 10; newest `canonical_producer_run`: `pass_state = passed`, 4004 units, `n_failed = 0`, `open_at_completion = 0`, completed 2026-11-27 17:24 UTC | settled |
| Receipts | `canonical_write_receipt`: 4325 rows, 0 in `pending`, `failed` or `unknown`; newest update 06:44:42 UTC | no unsettled receipt |
| C1 producer | `catalog_enrichment_control`: 0 rows (C1 not activated); `catalog_enrichment_state` 0 rows, `catalog_enrichment_tick` 0 rows; `enrichment_signal`: 6 rows | no C1 unit in flight; no natural C1 traffic yet |
| Prediction runner | `enrichment_status` shows scheduled prediction runs ending `interrupted` / `lease_expired` (a separate pipeline, not the C1 producer, not read as part of this acceptance) | not a provenance prerequisite; noted only |

## Conclusion

Every static preflight condition holds (schema, control at `off`, empty release rows, PV1-PV3 deployed, no unsettled receipt, no running Workflow or Producer unit). **One condition is open: drain against the final deployed version.** The version `bbaea9cc-…` is only minutes old at observation time and the AIR-609 deployment was still in flight, so the "version at 100 % for longer than the longest unit or Workflow step bound" requirement cannot be shown yet. The preflight must be repeated live right before the GO.

Because `catalog_enrichment_control` is empty, no natural C1 traffic exists yet; acceptance after the flip waits for the ordinary event after C2 ([AIR-607](https://trello.com/c/Daq02gYy)) and is not forced.

## Not verified

- Longest unit or Workflow step bound versus the age of the final version (needs the final deployment and its time).
- The Cloudflare deployments read does not list Workflow instances; their absence is inferred from the Discovery executor and Producer chain state above.
- No `GET /api/admin/settings` read (Access login) was made; the `provenance` block was not read.
