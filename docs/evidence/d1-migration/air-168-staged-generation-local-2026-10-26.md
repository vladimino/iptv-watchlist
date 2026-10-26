# Staged generation import: local rehearsal at 1.25× (synthetic, SQLite)

**Captured:** 2026-10-26, code of the [AIR-168](https://trello.com/c/984pXiL6) branch on `main` 7140b34  
**Scope:** `tests/generation-stage.mjs` and `tests/d1-backfill.mjs` on local SQLite through the executor's dry-run adapter and a local fake of the D1 HTTP API; synthetic generations only; no R2 read, no Cloudflare D1 request, no production payload  
**Verdict:** **implementation behaves as ADR-0021 specifies on SQLite; D1 timing unknown** — not the G4 scratch verification, which needs real D1 and a separate owner approval  
**Used by:** [AIR-168](https://trello.com/c/984pXiL6), [ADR-0021](../../adr/0021-staged-atomic-generation-import.md), [AIR-74](https://trello.com/c/5AdAmKPe) G4

## Scale

A prior published generation of 22,199 candidates and 2,300 films (two shows each), ten candidates with seeded attempts, retry times and terminal reasons, then a generation of 27,749 candidates and 2,300 films, two shows each, five with changed evidence keys. A withheld generation of the same size over the same prior.

## Result of the published 1.25× generation

| Measure | Value |
| --- | --- |
| Staged rows | 90,147 |
| Chunks | 96 requests at ≤ 950 statements, largest 443,091 bytes; 40,557,717 bytes in total |
| Largest staged row statement | 881 bytes (cap 90,000) |
| Interruption | a lost response at the middle chunk stopped the run with no final-table change; the next run resumed at the first chunk without a receipt |
| Read-back | 90,147 staged rows compared field by field, equal |
| Commit | 12 statements, 4,381 bytes; 408–687 ms on local SQLite across runs |
| Final tables | identical, row for row, to the legacy `publishGeneration` write (published and withheld) |

Phase durations on local SQLite in one run: staging 1.3–1.6 s, validation under 0.1 s, read-back 1.1–1.4 s, post-commit verification 1.9–2.9 s. Local SQLite does no replication and no network round trips, so these are lower bounds and say nothing about the 10-second D1 commit budget.

## Fault matrix (small synthetic generation, 10 chunks)

Each passed with the final tables unchanged until a successful commit, and equal to the legacy write after it: a lost response and a 500-after-commit at every chunk, each followed by a resume; a failing last statement in a chunk (no row and no receipt of that chunk); a 500 after the commit (next run is a replay) and a lost commit (stage stays `validated`, next run commits); a stale pointer and a concurrent commit of another run (`pointer_moved`, stage failed); a repeated commit and a late chunk (refused); another baseline, another owner token, a changed plan, a tampered receipt checksum and a receipt gap (refused before writing); mutated, extra and missing staged rows (stage failed, final tables unchanged); an oversized and a repeated row (refused before any write); bounded cleanup, refused for a live or committed stage, removing a failed stage and keeping a superseded stage's record. The executor path additionally refused a target without migration `0002` or with schema version 1 before any write, and an unapproved cleanup.

## Uncertainty

D1 per-request latency, commit duration and any limit below the proven request size; the real generation's film and show counts.
