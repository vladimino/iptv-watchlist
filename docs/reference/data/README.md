# Data and storage contracts

- [D1 schema v1 and R2 mapping](d1-schema.md) — the D1 contract for the production database `iptv`; authority is per domain ([authority per domain](../../architecture/persistence-and-migration.md#authority-per-domain)) and the Worker reads D1 through the [D1 catalog views](../api/d1-catalog.md) and the domain adapters.
- [Producer run store](producer-run-store.md) — the dormant store layer of the durable EPG canonical producer pass (S4-3, [ADR 0128](../../adr/0128-epg-canonical-producer-durable-execution.md)); not wired.
- [Producer driver](producer-driver.md) — the dormant durable driver of the EPG canonical producer pass (S4-4, [ADR 0128](../../adr/0128-epg-canonical-producer-durable-execution.md)); not wired.
- [ADR-0001](../../adr/0001-d1-schema-v1.md): why this schema is versioned and frozen.
- [Staged generation import](d1-schema.md#staged-generation-import-schema-v2) — schema v2 (`migrations/0002_generation_stage.sql`) and the executor's staged path for [ADR-0021](../../adr/0021-staged-atomic-generation-import.md); not applied to any database.

No migration, binding or production access is authorized by this reference.
