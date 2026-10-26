# Data and storage contracts

- [D1 schema v1 and R2 mapping](d1-schema.md) — a staged **unapplied** D1 migration; R2 remains authoritative until an explicitly approved cutover.
- [ADR-0001](../../adr/0001-d1-schema-v1.md): why this schema is versioned and frozen.
- [Staged generation import](d1-schema.md#staged-generation-import-schema-v2-not-applied) — schema v2 (`migrations/0002_generation_stage.sql`) and the executor's staged path for [ADR-0021](../../adr/0021-staged-atomic-generation-import.md); not applied to any database.

No migration, binding or production access is authorized by this reference.
