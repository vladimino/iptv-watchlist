# Watchlist membership projection, migration 0037: operator, prerequisites, quiet window, readback and the read-only baseline preflight (each production step needs its own owner GO)

**Status:** prepared on 23 Nov 2026 under [AIR-572](https://trello.com/c/ugyHjnc4) for [ADR 0203](../adr/0203-watchlist-membership-letterboxd-single-writer-projection.md) (Accepted, contract A). **Applied to production D1 `iptv` on 23 Nov 2026 20:07 UTC** under the owner GO, schema 36 to 37, marker `producer` / 0 ([evidence](../evidence/d1-migration/air-572-0037-apply-2026-11-23.md)); `0036` was applied before it ([evidence](../evidence/d1-migration/air-579-0036-apply-2026-11-23.md)). The baseline apply, the marker switch and the Producer hold lift remain separate owner GOs. **This runbook authorizes no further operation.**

## The operator

`scripts/watchlist-membership-0037-production.mjs` (offline tests: `tests/watchlist-membership-0037-production.mjs`). Same contract as the `0036` operator: the production target is pinned (account, database name and UUID, each checked against Cloudflare before any statement), the exact bytes of the migration are pinned independently of the caller (SHA-256 `e9b2f61156477c60461eb239b3c1bd1f7fb83d534621ca8d62742dab9f7fb60e`, Git blob `277741025209209e9aceaac31e747197e21c4996`, merged on `main` `ec41ad7`), the D1 adapter runs with zero retries, and the API token is never printed.

```bash
node scripts/watchlist-membership-0037-production.mjs --target iptv --status
```

```bash
node scripts/watchlist-membership-0037-production.mjs --target iptv --baseline-dry-run
```

```bash
node scripts/watchlist-membership-0037-production.mjs --target iptv --apply --confirm apply --migration-sha256 <FULL_SHA256_FROM_STATUS>
```

- `--status` (default) only reads: the migration digest and pins, `schema_contract`, the two `0036` indexes, the six tables `0037` needs, whether any `0037` object or the scratch table `watchlist_effect_v37` already exists, whether `watchlist_effect` already accepts `membership`, the Watchlist drain state (`version`, `effects_drained_version`, pending effects), `watchlist_authority`, `published_epg_authority`, the count of `watchlist_film`, and the decision with its reason. Counts only, never a Letterboxd id or a Film id.
- `--baseline-dry-run` only reads: the one-time baseline plan of ADR 0203 (the current snapshot against `watchlist_film`, through the same trusted identity resolver the projection uses: `membershipBaseline().dryRun` of `src/watchlist-membership.js`). It answers `already_current` or `drift` with counts of `add`, `remove`, `keep` and `unresolved`. It needs neither `0036` nor `0037` and can run today. It refuses `effects_pending` while effects of the current version are not done.
- `--apply` sends **one** atomic D1 batch of the 15 statements `migrationStatements()` extracts from the unchanged file; each statement is checked against its expected shape and position (`DROP` and `ALTER` occur only as the rebuild of `watchlist_effect`). It is never split and never retried; an unclear answer is `write_uncertain`. The Time Travel bookmark is read before and after.
- **Not in this operator:** the baseline **apply** and the marker **switch** to `sync`. Both write under the Letterboxd Sync epoch fence (`LetterboxdSync.FENCE_GUARD_SQL`) and therefore run inside the Worker, through the owner-only MCP tool `watchlist_membership_operator` ([MCP reference](../reference/api/mcp.md), [sequence](watchlist-authority-d1.md#membership-projection-schema-37-adr-0203)).

## Decisions of `--status` / `--apply`

| Decision | Meaning |
| --- | --- |
| `apply` | Schema 36 with both `0036` indexes, every needed table, no `0037` object, every effect of the current Watchlist version done |
| `predecessor_0036_not_applied` | Schema 35: apply `0036` first (its own GO) |
| `predecessor_incomplete` / `needed_objects_missing` | A `0036` index, a needed table or the `watchlist_effect` trigger is missing |
| `partial_schema` | Some `0037` object, the scratch table or the `membership` effect already exists at schema 36, or schema 37 is incomplete |
| `watchlist_effects_pending` | A Letterboxd slot is mid-drain (pending effect, or `effects_drained_version` below `version`): wait for the drain |
| `already_applied` | Schema 37 complete |
| `migration_not_approved` / `migration_sha256_mismatch` | The file bytes or the caller's pin differ from the approved file |

## Prerequisites (checked immediately before the GO is used)

1. `0036` applied and read back (schema 36, both indexes). It currently waits for the end of the Discovery queue.
2. `--status` reads `apply`, and the GO names the migration SHA-256 printed by `--status` and the production D1 id.
3. A quiet window for the Letterboxd Sync: no slot running or about to start, every effect of the current version done (`--status` checks the drain; the slot schedule is checked by the operator of the GO). The rebuild of `watchlist_effect` is one transaction and copies every row, but a slot writing between the before-state and the readback makes the readback differ (`write_uncertain`, never a silent success).
4. No other migration, import or cutover in flight.

## Readback (the operator checks all of it; record it in a dated evidence page)

Schema 37 with one `schema_contract` row; the three new tables, three new triggers and the handoff index exist; the scratch table is gone; `watchlist_effect` accepts `membership` and keeps its `watchlist_effect_monotonic` trigger; **every** `watchlist_effect` row is unchanged (row count and a digest over every column); the marker reads `producer`, generation 0, no baseline; `watchlist_authority`, `watchlist_current`, `published_epg_authority` and the `watchlist_film` count are unchanged; both `0036` indexes are still present.

## What it does, and does not

- **Does:** one execution of `migrations/0037_watchlist_membership_projection.sql`. After it the Worker behaves exactly as before: three effects per promotion, the EPG Producer (held by `PRODUCER_DELIVERY_HOLD`) owns membership.
- **Does not:** write `watchlist_film`, a Film, a claim, a show or a rating; record a baseline; switch the marker; lift the Producer hold; change a flag, Task or cron.

## Rollback and forward recovery

There is no undo: `schema_contract.version` never goes down and the rebuild of `watchlist_effect` is roll-forward. The marker stays `producer`, so the new tables are inert. After a failed or unclear execution read the state back with `--status` first and never re-run blindly (the file refuses anything but a complete schema 36).
