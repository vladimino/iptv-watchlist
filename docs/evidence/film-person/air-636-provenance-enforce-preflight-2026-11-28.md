# AIR-636: preliminary read-only observation before the provenance `off → enforce` flip, 28 November 2026

[AIR-636](https://trello.com/c/0jJADYxg) · [ADR 0214](../../adr/0214-film-metadata-per-field-provenance.md) (PVE) · [runbook](../../runbooks/film-metadata-provenance-activation.md)

**Scope and limits.** A **preliminary** read-only observation (L0) between 06:44 and about 07:30 UTC on 28 November 2026: D1 `SELECT`s on database `iptv`, read-only IPTV MCP tools and one Cloudflare `GET` of the Worker deployments. No production write, flag, Scheduled Task, sync, fetch or refresh, and no flip. It is **not** the final preflight, **not** the owner L3 GO and **not** the activation record. The final preflight is run only after the deployment of the pull request that merges this runbook, and again immediately before the statement, as the runbook requires. A later flip gets its own dated evidence file.

## Verified by a live read

| Item | Observation | Notes |
| --- | --- | --- |
| Schema | `schema_contract` id 1, version 54; the five provenance tables exist | version at least 53 required by the runbook |
| Migration 0053 constraints | `film_metadata_field.language` carries the two-letter check and no longer the `'ru','en'` list; `film_metadata_history.old_language` and `new_language` carry the two-letter check | the language schema of ADR 0224 is in place |
| Control row | one row: `mode = off`, `revision = 1`, `updated_at = 2026-11-27T00:00:00.000Z`, `updated_by = migration:0049` | |
| Release rows | `film_metadata_owner_release`: 0 | |
| Other provenance tables | `film_metadata_field`, `film_metadata_history`, `film_metadata_owner_command`: 0 rows each | nothing written at `off` |
| Feature flags | the registry read shows no provenance flag | the mode is the D1 control row |
| Authority marker | `film_person_authority`: `mode = d1`, `cutover = open`, `generation = 2` | read at about 07:15 UTC |
| Receipts | `canonical_write_receipt`: 4325 rows, 0 in `pending`, `failed` or `unknown` | read at about 06:50 UTC; the newest update was at 06:44:42 UTC, so receipts were still being written by other work |
| Producer chain (control rows only) | newest `canonical_producer_chain` row `owner_state = complete`, lease expired 2026-11-27 17:29 UTC; newest `canonical_producer_run` `pass_state = passed`, `n_failed = 0`, `open_at_completion = 0` | these are **terminal control rows, not proof that no instance is live** |
| Discovery executor status | `epg_pipeline_status`: executor `phase: stopped`, `liveness: complete`, programme run complete | a status report, not an instance inventory |
| C1 producer | `catalog_enrichment_control`, `catalog_enrichment_state` and `catalog_enrichment_tick`: 0 rows each (C1 not activated, no natural C1 traffic yet) | not an activation blocker |
| Newest deployment | Worker `iptv`, one version `bbaea9cc-0530-4cee-a793-735bc0289bc7` at 100 %, deployment `created_on` 2026-11-28T06:59:20Z; the push run of the AIR-664 evidence commit (CI/CD run 46118794413) completed successfully at 06:59:24Z | the version-to-commit tie is by timing only, see below |

## Not established (open, not implied)

- **Compatible deployment by commit ancestry.** The four ancestry checks of the runbook (PV1 `d5a1fe0`, PV3 `855d68e`, PV2 `4ce0074`, AIR-693 `2b13828`) were not run against the deployed commit, and the deployment was tied to its CI run by timing, not by the Version ID in the job log. Earlier today there were four deployments (01:16, 01:30, 06:28, 06:59 UTC); whether all are compatible, and so the date `T0` of the unbroken compatible run, was not computed. No eligibility time `T0 + B` is claimed.
- **Workflow instance inventory.** The six-status paginated listing for `iptv-epg`, `iptv-producer` and `iptv-catalog-enrichment` was **not read**. "No running instance" is therefore not established; only the terminal control rows above were seen.
- **Wall-time bound.** Derived in the runbook (`B = 3,910 s` from the documented platform default step configuration, which the code does not enforce); not measured here.
- **Authority and projector detail.** Not read: a held projector window, any recorded running owner operation, the ADR 0211 control generation (C1 has no control row), and Worker invocation logs for old-version writer invocations.
- **`GET /api/admin/settings`.** No Access login was made; the `provenance` block was not read, and in any case it is a retained newest-500-tick aggregate, not an interval proof.
- The prediction runner shows scheduled runs ending `interrupted` / `lease_expired`; a separate pipeline that is not a provenance prerequisite, noted only.

## Conclusion

Schema, the 0053 language constraints, the control row at `off` revision 1, empty release rows, the Film/Person marker `d1`/`open` and clean receipts were observed at the times above. **Drain is not established**: neither the compatible-deployment ancestry nor the instance inventory was read, and the final preflight, the owner GO naming the version, commit, revision and `T0`, and the recheck before the statement are all still to come.
