# ADR 0001: D1 schema v1 is unapplied

[AIR-49](https://trello.com/c/YNaLFwtW). The schema itself is [docs/d1-schema.md](../d1-schema.md).

## Decision

Schema v1 is `migrations/0001_schema_v1.sql`. The number is the version. Once this file is merged it is not edited. A later shape is a new numbered file.

`wrangler.jsonc` does not name a D1 database. Deploying Worker `iptv` does not create or migrate a database. The test applies the file to a local SQLite database and discards it.

The current EPG generation is the single `published_generation` row. Replacing that pointer does not delete the previous generation. A replaced prediction is a new immutable object plus `prediction_history.payload_json`, not an edit of the mutable `predictions.json` key.

R2 bucket `iptv` stays the production store. D1 and R2 are not one transaction. A future importer may fail after writing D1 and before `import_receipt`. The retry is the same source key and checksum. That failure does not roll back R2, and an R2 failure does not roll back a receipt that was not written.

## Recovery

This pull request has nothing to roll back in production. After a later card applies the schema, recovery is a new forward migration, not a change to `0001`. Dropping that future database loses only what production does not read yet. Rebuilding it is a new import from R2, checked by `import_receipt`, and is not this card.

## Consequences

[AIR-70](https://trello.com/c/8PRWRx2C), [AIR-71](https://trello.com/c/UAUUQ2jh), and [AIR-72](https://trello.com/c/MfAGc1Dd) can implement repositories against these tables. They still do not apply the migration to production. [AIR-74](https://trello.com/c/5AdAmKPe) is the first card that may write a production database, and only after [AIR-69](https://trello.com/c/FlcWZX7W).
