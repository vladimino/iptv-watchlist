# D1 backfill dry-run on the production snapshot (local SQLite, NO-GO before any write)

**Captured:** 2026-10-26, 22:48:56–22:49:42 UTC, offline on the owner's machine; code at `main` `80712e7`  
**Command:** `node scripts/d1-backfill.mjs --snapshot <private snapshot> --output <private run dir> --target sqlite --database <private dry.sqlite>`, the SQLite file created from `migrations/0001_schema_v1.sql`; no R2 credential in the environment  
**Input:** the [AIR-175 snapshot](air-175-r2-snapshot-identity-2026-10-26.md), re-verified offline immediately before the run: `consistent_fenced`, 7,994 objects, 581,345,885 bytes, aggregate `f71eee103b8e45a696def1805d050454bf3721e0cd688dc041c16bddcc0bdeb3`, `manifest.json` SHA-256 `c26e04536ff2ebc047e731ad0b0e39eed51a9550bc921f457026de06c7b1865a`, fence ok, directory still write-protected  
**Scope:** local SQLite only; no Cloudflare D1 (production or scratch), no R2 request, no Worker route, no Scheduled Task, flag or Access change  
**Verdict:** **NO-GO** — `evidence_mismatch`: the executor refused the baseline before creating or writing anything; 79 stored discovery decisions carry an evidence key that differs from the key derived from the published generation. Parity, receipts, class C ledger and idempotent reruns could not be reached  
**Used by:** [AIR-74](https://trello.com/c/5AdAmKPe), [ADR-0019](../../adr/0019-live-d1-backfill-boundaries.md) G5 readiness

Aggregates only. The private `report.json` (it names candidate titles and channel slots) stays outside the repository.

## What ran

| Step | Result |
| --- | --- |
| `node tests/d1-backfill.mjs` | Passed |
| Snapshot `--verify` (offline, no credential) | Identity equal to AIR-175 |
| Dry-run, plain path (`0001`) | Exit `3`, `no_go`, `stopReasons: ["evidence_mismatch"]`, 46 s; probe, identity and result empty: nothing written to the SQLite file |
| Dry-run, staged path (`0001`+`0002`, `--staged-generation`) | Not run: the refusal (`refusal()` in `src/offline-importer.js`) is evaluated before the target mode or staging is reached, so it would stop identically |
| Two idempotent reruns | Not reachable |

## The blocker

The [D1 contract](../../reference/data/d1-schema.md) makes a stored decision evidence key that disagrees with the derived key a pre-write blocker; the acknowledged class C list cannot clear it.

| Measure | Value |
| --- | --- |
| Decisions in `epg/discovery-resolution.json` | 8,984 (verified 3,486, excluded_nonfilm 4,769, no_confident_match 662, ambiguous 43, duration_mismatch 23, needs_verification 1) |
| Decisions with a stored evidence key | 144 |
| Stored key equal to the derived key | 65 |
| **Stored key differs (`evidence_mismatch`)** | **79**: verified 33, no_confident_match 43, ambiguous 3 |
| Differing field | Airing slots in all 79; runtime additionally in 2; title and year in none |
| Derived key has no slot at all (film no longer in the published generation) | 21 |
| Slots partly overlap / derived slots all later than stored | 30 / 25 |
| Stored slots | all before `finishedAt` (range 2026-10-19 to 2026-10-26 19:27 UTC) |
| Decisions' `checkedAt` | 2026-10-22 23:44 to 2026-10-26 15:01 UTC |

**Reading.** The evidence key is title, year, runtimes and the exact airing slots (`candidateEvidence()` in `src/discovery.js`). Every published generation rolls the EPG window forward, so a decision taken against an earlier generation names airings that have since passed; the mismatch is ordinary drift, not corruption. The runtime already treats it that way: a `verified` or `excluded_nonfilm` decision stays final whatever the evidence, and any other decision whose evidence changed simply becomes actionable again (`resolutionActionability`). The importer's refusal is stricter than the runtime it copies, so a production baseline taken while EPG generations advance will normally contain such decisions; a new snapshot is unlikely to avoid it.

## Inventory and classes (computed in memory, no write)

`prepareImport` and `refusal` from the same code, run on the snapshot without a target:

| Measure | Value |
| --- | --- |
| Source keys | 7,994: mapped 4,688, R2-only 3,306, excluded 0, **unmapped 0** (no `unknown_key`) |
| Import units planned | 32,783 |
| Class A mandatory family `prediction` | 2,335 keys, portable, 0 unportable |
| Class B R2-only families | `derived_projection` 2,340 (read cutover), `run_record` 604 (legacy retirement), `user_state` 330 (read cutover, **decision required**: `started/` and `events/`), `archive` 23, `runtime_coordination` 9 |
| Class C ledger | Not produced (the run stops before the ledger) |

## Owner and coordinator decisions needed

1. **How the importer treats a decision whose stored evidence is older than the published generation.** Options: import it with its stored key and a `stale_evidence` provenance (matching runtime semantics), or make it a class C ledger record that the owner can acknowledge, instead of a pre-write refusal. Either changes the contract and the ADR-0019 boundary, so it needs a decision and a code PR with tests; this report changes nothing.
2. **`user_state` (330 keys)** still needs its read-cutover disposition before AIR-77, as recorded in AIR-74.

After the first decision is implemented, the dry-run is repeated on the same snapshot (plain and staged), followed by two reruns that must report `applied: 0`.

## Limits

- Parity, receipts audit, class C records, staged sizes and idempotency are **unmeasured** on real data; nothing here is evidence for G5.
- The snapshot is the production state at its `finishedAt`; the 79 count applies to that instant only.
