# Catalog seal round trips, 10 November 2026

[AIR-422](https://trello.com/c/yCWLsKyf) · 10 November 2026. Code reading of `main` `6d2ab29`, the production figures already recorded for [AIR-420](air-420-seal-ledger-round-trips-2026-11-10.md), and local measurement on the SQLite D1 stand-in. No production read or write was made for this report, and no EPG run was started.

## Baseline

From the AIR-420 record of the natural run of 10 November: the `catalog` phase wrote 8,312 films in 25 steps from 17:17 to 17:33 UTC (16 minutes, 285 to 399 films a step); on 9 November one step wrote 6,884 films in 31 s. Round trips cost about 17 ms on the fast day and 250 to 350 ms on the slow one.

The code explains the count. `sealCatalogStep` handed `upsertAdmissions` 19 films at a time (two statements a film under the 40-statement cap), and every batch read the authority first: four sequential reads (`schema_contract`, `sqlite_master`, `discovery_authority`, `discovery_transfer`) and one write. 8,312 films are 438 batches and 2,190 round trips: 0.6 min at 17 ms, 12.8 min at 350 ms, before the fixed reads of each of the 25 steps.

## Change

`upsertAdmissions` packs a batch to its caps and reads the authority once.

- Films go out as multi-row upserts of 12 rows (8 binds a row under the 100-bind cap), at most 19 upserts a batch (40 statements with the opening fence pair), 200 kB an upsert and 400 kB a batch. A film above a byte cap goes alone.
- The single-row fence (`ok=changes()`) proved one row. Each multi-row upsert is followed by `ok=(changes()=?)` with its row count, so a row the upsert's own `WHERE` left untouched (a film id arriving with another identity) fails the batch as before.
- The generation is carried from one batch to the next (each batch moves it by exactly one). What the authority read checked is now checked by the fence in the same transaction as the write: mode `d1`, cutover `open`, the generation, the live lease of this run, and a transfer that is not `loading`. A refusal drops the carried value and reads the authority again.
- A refused batch is first checked for having landed (one read per 100 films), then halved until the film that cannot be written stands alone; an identity owned by another film id is refused and the rest lands. An unknown outcome (a failed request) is not repeated inside the call: the next step computes the difference to D1 again.
- `sealCatalogStep` hands 2,000 films a call and stops at the step deadline between batches. Its phase log carries `items`, `batches`, `reads`, `writeMs`.

## Measurement (`tests/discovery-admission-packed.mjs`)

8,312 films of 913 bytes each (Cyrillic text), on the stand-in:

| | Before | After |
| --- | --- | --- |
| Films a batch | 19 | 225 |
| Batches | 438 | 37 |
| Round trips of the write | 2,190 | 41 (37 writes, 4 reads) |
| Write at 17 ms a round trip | 0.6 min | under 1 s |
| Write at 350 ms a round trip | 12.8 min | 0.24 min |

The "before" column is computed from the old batch shape (five round trips a batch), not measured; the "after" column is counted from the statements the stand-in received. Every film read back equal to what was sent; statements never exceed 40 and binds never exceed 100.

Other cases in the same file: films of 120 kB, 260 kB (above the upsert bytes, alone in its upsert) and 450 kB (above the batch bytes, alone in its batch); a foreign and an expired lease, a loading transfer and a held cutover with a carried generation (nothing written); a batch that landed and lost its response (the call throws, the replayed difference writes the rest, no duplicate row); a failed request that did not land; a generation moved by another writer between batches (re-read, every film written once); one identity owned by another film id inside a full batch (that film refused, 228 written, at most 24 batches); a deadline (one batch, the rest reported); more than 20,000 films (refused before any write).

## Whole run on a slow instance (estimate)

| Part | 10 Nov (measured) | After AIR-420 and this change (model) |
| --- | --- | --- |
| Start, metadata, wait for the source, EPG commit, staging | 8 min | 8 min |
| Ledger | 64 min | 1 to 3 min (AIR-420 model) |
| Catalog | 16 min | about 1 min: one writing step and one confirming step, each with its fixed reads, and the pause between steps |
| Publish, finalize, queue | 3 min | 3 min |
| Due to published | 96 min | about 13 to 15 min |

## Limits

- The estimate is a model from counted round trips and the latencies of 10 November; it is not a production measurement. The first natural EPG run after deploy shows the real `seal_catalog` figures (`items`, `batches`, `writeMs`).
- Staging (8 min) and the publication tail (3 min) are not changed. With them at 11 min, the 15-minute target on a slow instance has little margin and is not guaranteed by this change.
- The fixed cost of a catalog step (the payload read, two catalog reads and their authority reads) is unchanged; it now occurs twice instead of 25 times.
- `supersedeAdmissions` still reads the authority per 80 films; departed films are few and it was not changed.
- Real D1 limits on bound value size were taken from the caps the ledger seal already uses, not re-measured.
