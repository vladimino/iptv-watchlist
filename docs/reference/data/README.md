# Data and storage contracts

- [D1 schema v1 and R2 mapping](d1-schema.md) — a staged **unapplied** D1 migration; R2 remains authoritative until an explicitly approved cutover.
- [ADR-0001](../../adr/0001-d1-schema-v1.md): why this schema is versioned and frozen.
- [Staged generation prototype](staged-generation.sql) — design prototype of [ADR-0021](../../adr/0021-staged-atomic-generation-import.md) (accepted conceptually, conditional on the scratch G4 gate), executed only by `tests/staged-generation.mjs` on local SQLite; not a migration.

No migration, binding or production access is authorized by this reference.
