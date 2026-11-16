# Film/Person migration 0023: owner GO and apply procedure (not applied)

**Status:** prepared offline for [AIR-497](https://trello.com/c/xNqCjZgu) / [ADR 0141](../adr/0141-producer-workflow-chain-protocol.md) (Accepted as DESIGN). **Not applied to production D1 `iptv`.** This page, the file [`migrations/0023_canonical_producer_chain.sql`](../../migrations/0023_canonical_producer_chain.sql), a merge, a deploy and a green CI are not the owner GO. Applying it is a separate L3 operation on AIR-499 (or a later owner-named GO). Counts and identifiers only in any evidence.

## What the migration is, and is not

- One file: a refuse-insert unless schema is a complete version 22 with the listed tables, `CREATE TABLE canonical_producer_chain` (STRICT, empty), marker-open insert/update triggers, no-delete, insert birth shape, immutable id/created_at, revision +1, epoch monotone, `schema_contract` to version 23.
- It writes no data row except the `schema_contract` version and note.
- `wrangler.jsonc` has no migrations directory. CI applies nothing. The Worker never applies SQL files.
- After an apply the table stays empty while the Film/Person marker is not `d1`/`open`. `reconcileProducerChain` is still dormant until that marker **and** `PRODUCER_WORKFLOW` exist. The apply does not authorize AIR-499 cutover, a marker move, a flag, a cron or a Scheduled Task.

## GO (do not use until the owner names this operation)

The signed GO must name the live git blob of the file on `main`, the production D1 id, the live marker (`mode`/`cutover`/`generation`), the current `schema_contract.version` (must be 22), and a Madrid window. It authorizes one D1 execution of that file only, then a readback of version 23, an empty `canonical_producer_chain`, and an unchanged Film/Person marker. It does not authorize a second apply, a Time Travel restore, or any producer write.

## Readback (after a future apply)

`SELECT version, note FROM schema_contract WHERE id = 1` → 23 and the v23 note. `SELECT COUNT(*) FROM canonical_producer_chain` → 0. `SELECT mode, cutover, generation FROM film_person_authority WHERE id = 1` unchanged from the preflight.
