# D1 migrations

| File | Schema version | Adds | Status |
| --- | --- | --- | --- |
| [0001_schema_v1.sql](0001_schema_v1.sql) | 1 | The frozen schema v1 ([ADR-0001](../docs/adr/0001-d1-schema-v1.md)) | Applied to production `iptv` on 2026-10-29 ([AIR-74](https://trello.com/c/5AdAmKPe)) |
| [0002_generation_stage.sql](0002_generation_stage.sql) | 2 | Staging tables for the staged generation import ([ADR-0021](../docs/adr/0021-staged-atomic-generation-import.md)); additive, changes nothing of `0001` | Applied to production `iptv` on 2026-10-29 ([AIR-74](https://trello.com/c/5AdAmKPe)) |
| [0003_candidate_show_identity.sql](0003_candidate_show_identity.sql) | 3 | Rebuilds `candidate_show` and `stage_candidate_show` with a unique identity over channel, start, end and EPG title ([ADR-0025](../docs/adr/0025-candidate-show-identity.md)); same columns, rows copied | Applied to production `iptv` on 2026-10-29 ([AIR-74](https://trello.com/c/5AdAmKPe)) |
| [0004_projection_state.sql](0004_projection_state.sql) | 4 | The enrichment projector's change keys, lease and lease fence ([ADR 0056](../docs/adr/0056-d1-enrichment-write-through.md)); additive | Applied to production `iptv` on 2026-10-30 |
| [0005_film_sync_state.sql](0005_film_sync_state.sql) | 5 | Metadata sync freshness clocks (`film_sync_state`) written by the same projector ([ADR 0070](../docs/adr/0070-metadatasync-freshness-clocks.md)); additive | Not applied. Applying it while the projector flag is `on` starts those writes; see the [backfill runbook](../docs/runbooks/d1-backfill.md#metadata-sync-clocks-schema-v5) |

Files apply in order; `0001` is never rewritten. Production D1 `iptv` carries `0001`–`0004` (schema v4). Migration `0005` is not applied; until it is, the projector does not write sync clocks. The Worker is bound to the database and reads none of these files. Applying a migration to the scratch database or to `iptv` is a separate, action-specific owner approval ([backfill runbook](../docs/runbooks/d1-backfill.md)). For `0005` that approval also covers the live sync-clock writes, because the projector flag is already `on`. The contract is the [D1 reference](../docs/reference/data/d1-schema.md).
