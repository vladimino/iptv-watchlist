# D1 migrations

| File | Schema version | Adds | Status |
| --- | --- | --- | --- |
| [0001_schema_v1.sql](0001_schema_v1.sql) | 1 | The frozen schema v1 ([ADR-0001](../docs/adr/0001-d1-schema-v1.md)) | Not applied to any database |
| [0002_generation_stage.sql](0002_generation_stage.sql) | 2 | Staging tables for the staged generation import ([ADR-0021](../docs/adr/0021-staged-atomic-generation-import.md)); additive, changes nothing of `0001` | Not applied to any database |
| [0003_candidate_show_identity.sql](0003_candidate_show_identity.sql) | 3 | Rebuilds `candidate_show` and `stage_candidate_show` with a unique identity over channel, start, end and EPG title ([ADR-0025](../docs/adr/0025-candidate-show-identity.md)); same columns, rows copied | Not applied to any database |

Files apply in order; `0001` is never rewritten. The Worker has no D1 binding and reads none of these files. Applying a migration to the scratch database or to `iptv` is a separate, action-specific owner approval ([backfill runbook](../docs/runbooks/d1-backfill.md)). The contract is the [D1 reference](../docs/reference/data/d1-schema.md).
