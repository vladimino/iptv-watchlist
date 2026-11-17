# Film/Person migration 0023: owner GO and apply procedure (applied)

**Status:** applied to production D1 `iptv` on 16 Nov 2026 (about 00:34–00:36 UTC) as one execution after the owner GO; schema version 23, empty `canonical_producer_chain`, Film/Person marker unchanged ([evidence](../evidence/d1-migration/air-499-0023-apply-2026-11-16.md)). Prepared offline for [AIR-497](https://trello.com/c/xNqCjZgu) / [ADR 0141](../adr/0141-producer-workflow-chain-protocol.md) (Accepted as DESIGN); the apply is the first L3 holdpoint of [AIR-499](https://trello.com/c/8ifHCioP). This page, the file [`migrations/0023_canonical_producer_chain.sql`](../../migrations/0023_canonical_producer_chain.sql), a merge, a deploy and a green CI are not a second GO. Counts and identifiers only in any evidence.

## What the migration is, and is not

- One file: a refuse-insert unless schema is a complete version 22 with the listed tables, `CREATE TABLE canonical_producer_chain` (STRICT, empty), marker-open insert/update triggers, no-delete, insert birth shape, immutable id/created_at, revision +1, epoch monotone, `schema_contract` to version 23.
- It writes no data row except the `schema_contract` version and note.
- `wrangler.jsonc` has no migrations directory. CI applies nothing. The Worker never applies SQL files.
- After the apply the table stays empty while the Film/Person marker is not `d1`/`open`. `reconcileProducerChain` is still dormant until that marker **and** `PRODUCER_WORKFLOW` exist. The apply does not authorize AIR-499 cutover, a marker move, a flag, a cron or a Scheduled Task.

## GO (used 16 Nov 2026; do not reuse)

The signed GO named the live git blob of the file on `main` (`5976714f4d91689bd9950ff858eab5e5dcf041fa`, 7193 bytes, `main` `6f61e0198f0c1b14cee45c30b447d94f58c7de84`), the production D1 id `3fba0e0a-44e9-4a3a-a7ba-edaee6bcafcb`, the live marker (`prepared` / `open` / generation 1), `schema_contract.version` 22, and the Madrid window around 01:33. It authorized one D1 execution of that file only, then a readback of version 23, an empty `canonical_producer_chain`, and an unchanged Film/Person marker. It did not authorize a second apply, a Time Travel restore, or any producer write.

## Readback (16 Nov 2026)

`SELECT version, note FROM schema_contract WHERE id = 1` → 23 and the v23 note. `SELECT COUNT(*) FROM canonical_producer_chain` → 0. `SELECT mode, cutover, generation FROM film_person_authority WHERE id = 1` → `prepared` / `open` / 1, unchanged from the preflight.
