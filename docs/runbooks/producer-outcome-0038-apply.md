# Canonical Producer outcome outbox, migration 0038: operator, preflight, quiet window, readback (the apply needs its own owner GO)

**Status:** prepared on 24 Nov 2026 under [AIR-594](https://trello.com/c/iPaLDfzP) for [ADR 0208](../adr/0208-producer-outcome-events-delivery-store.md) (Accepted, option B). **Not applied.** A read-only preflight on the deployed `main` read `apply` on 24 Nov 2026 12:22 UTC ([evidence](../evidence/d1-migration/air-594-0038-preflight-2026-11-24.md)). **This runbook authorizes no operation;** the apply is one separate owner GO.

## What the apply does, and does not

- **Does:** one execution of `migrations/0038_canonical_producer_outcome.sql` (schema 37 to 38): the empty STRICT table `canonical_producer_outcome`, its pending index, the six outbox triggers (marker fences, birth shape, no delete, immutable payload, one-way delivery), the downgrade trigger `IF NOT EXISTS`, and the version update. From the next Workflow invocation and the next hourly reconcile on, the deployed code proves the table active and every Producer outcome is written in the batch of its transition and delivered to the Events Log.
- **Does not:** write a row, a marker, an authority, a lease, a receipt, a Film or a Person; start, stop or recover a Producer chain; change a flag, Task, cron or Workflow; backfill any outcome (an outcome before activation is never reported).

## The operator

`scripts/producer-outcome-0038-production.mjs` (offline tests: `tests/producer-outcome-0038-production.mjs`). Same contract as the `0036` and `0037` operators: the production target is pinned (account, database name and UUID, each checked against Cloudflare before any statement), the exact bytes of the migration are pinned independently of the caller (SHA-256 `bf5d70c117d0155b8168df6b82e99fa682b85db1b6e2e92255c83872a3a91900`, Git blob `d04330c9e0d8d8a685d4a41c5e0833aa03fdb675`, merged on `main` `26cfd115`), the D1 adapter runs with zero retries, and the API token is never printed. Credentials: `D1_BACKFILL_ACCOUNT_ID` and `D1_BACKFILL_API_TOKEN` ([credentials](../../.claude/skills/iptv-credentials/SKILL.md)); behind the container proxy add `NODE_USE_ENV_PROXY=1`.

```bash
node scripts/producer-outcome-0038-production.mjs --target iptv --status
```

```bash
node scripts/producer-outcome-0038-production.mjs --target iptv --apply --confirm apply --migration-sha256 <FULL_SHA256_FROM_STATUS>
```

- `--status` (default) only reads: the digest and pins, `schema_contract` (one row, an integer version), every object named `canonical_producer_outcome%`, the six predecessor tables, the Film/Person, published EPG and Watchlist membership markers, the open Producer chains and their live owner leases, the chain and run counts and revision sums, the **runtime schema probe** (`readOutcomeSchema`, the same code the Worker runs: `absent` before, `active` after) and the decision.
- `--apply` re-reads the same state, requires the decision `apply` and the caller's SHA-256, and sends **one** atomic D1 batch of the 11 statements `migrationStatements()` extracts from the unchanged file, each checked against its expected shape and position. It is never split and never retried: an unclear answer is `write_uncertain`. The Time Travel bookmark is read before and after.

## Decisions

| Decision | Meaning |
| --- | --- |
| `apply` | Schema 37 (one integer contract row), no outbox object, the runtime probe reads `absent`, every predecessor table, Film/Person and published EPG `d1`/`open`, no Producer chain with a live owner lease, not within 5 minutes of a full UTC hour |
| `producer_busy` | A chain is `pending` or `active` with an unexpired owner lease: an instance may be mid-invocation (it probed `absent` and would finish its terminal batches without outcome rows). Wait until no lease is live |
| `hourly_tick_window` | Within 5 minutes before or after a full UTC hour: the hourly reconcile probes the schema once per tick. Retry the status outside the window |
| `partial_schema` | Some outbox object exists at 37, or schema 38 without the whole outbox |
| `probe_not_absent` / `schema_unexpected` / `schema_contract_unexpected` | The runtime probe does not prove absence, the version is not 37, or the contract row is missing, duplicated or not an integer |
| `predecessor_incomplete` / `film_person_not_open` / `published_not_open` / `state_unreadable` | A needed table or marker is missing or not open, or a read failed |
| `already_applied` | Schema 38 with the whole outbox and the probe `active` |
| `migration_not_approved` / `migration_sha256_mismatch` | The file bytes or the caller's pin differ from the approved file |

## Prerequisites (checked immediately before the GO is used)

1. The deployed Worker is `main` at or after `26cfd115` (the code that probes the schema and writes outcomes), with post-merge CI/CD 4/4.
2. `--status` reads `apply`, and the GO names the migration SHA-256 printed by `--status` and the production D1 id.
3. Quiet window: no live Producer owner lease (`producer.liveLeases` 0), outside :55–:05 UTC, no EPG publication in progress (not around the 17:00 Madrid due) and no other migration, import or cutover in flight. A chain that starts between the status and the batch is not harmful to the data (the batch is schema-only and atomic), but its outcome may be missed (ADR 0208: outcomes of an inactive moment are not reported).

## Readback (the operator checks all of it; record it in a dated evidence page)

Schema 38 with one `schema_contract` row; the runtime probe reads `active`; exactly the eight outbox objects, and the stored `CREATE` text of the table, the index and each of the six triggers equals the statement of the file (whitespace-normalized); the table has 0 rows; the Film/Person, published EPG and Watchlist membership markers and the chain and run counts and revision sums are unchanged. Then, separately: `--status` again (`already_applied`) and an independent read-only `SELECT` through another channel. Any mismatch is `write_uncertain`: read the state back, never re-run blindly.

## After the apply (no operation of its own)

- The Monitor fact `canonical_producer.facts.outcomeDelivery.active` turns `true` at the next hourly `Monitor.run`.
- Acceptance is natural: the next real Producer outcome (a completed pass, a stop, a superseded in-flight chain or a held retry) writes one row, the next hourly reconcile delivers it to `events/items/`, and the owner checks the card under «Обогащение каталога». Read-only checks only: the row by id in `canonical_producer_outcome`, the journal item, `facts.outcomeDelivery`. Never run the Producer, the reconcile or an insert to produce an event.

## Rollback and forward recovery

There is no undo: `schema_contract.version` never goes down and the table refuses DELETE. The empty table is harmless; reverting the code stops new rows and new events and leaves the table, its rows and the journal entries in place. After a failed or unclear execution read the state back with `--status` first and never re-run blindly (the file refuses anything but a complete schema 37).
