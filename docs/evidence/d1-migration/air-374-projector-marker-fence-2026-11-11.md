# AIR-374 P1: projector marker and generation fence (offline evidence)

**Date:** 2026-11-11 UTC. Offline tests only; no production read or write, no flag, no marker move.

| Check | Result |
| --- | --- |
| `tests/projector-marker-fence.mjs` | pass: bulk off/on x marker d1, held, unknown, foreign cutover, malformed generation, missing row, unreadable: nothing written, no batch sent |
| Marker or generation moved before a batch | whole batch fails, `authority_moved`, zero rows |
| Move after two committed batches | no further batch sent |
| r2 gen 0, r2 gen 5, prepared gen 1 | statements equal the legacy run plus the guard; batch and statement counts unchanged |
| `tests/projector-marker-fence-mutation.mjs` | 17 of 17 mutants killed |
| Budget | guard adds 0 round trips; marker read adds 1 query per `on` run; existing budget tests unchanged |
