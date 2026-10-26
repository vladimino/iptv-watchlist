# Programme generation unit size and staged import rehearsal (synthetic, local)

**Captured:** 2026-10-26, code at `main` 2652401 plus the [AIR-167](https://trello.com/c/6ZaRfXWL) design branch  
**Scope:** synthetic generations only, generated in memory; no R2 read, no D1 request, no production payload  
**Verdict:** **the current generation unit cannot run on D1 at production size; the staged design fits the proven request size** — a design input for [ADR-0021](../../adr/0021-staged-atomic-generation-import.md), not evidence about Cloudflare D1 timing  
**Used by:** [AIR-167](https://trello.com/c/6ZaRfXWL), [AIR-74](https://trello.com/c/5AdAmKPe) G4/G5

## Method

`node scripts/d1-generation-size.mjs --films F --shows-per-film sf --candidates C --shows-per-candidate sc` runs the real `publishGeneration` of `src/epg-repository.js` against a recording adapter and renders each statement with the backfill executor's own `renderSql`. Titles and keys are 24 characters, channels 18. `tests/staged-generation.mjs` checks that the measured count equals `3 + F + F·sf + (sf > 0 ? F : 0) + 2C + C·sc + 1`. The size inputs are the readiness assessment's order of magnitude: 22,199 candidates in the latest generation, and 2,300 films (the current prediction count) as an upper bound for films in one generation; the real show counts per film and candidate were not read.

## Today's unit (`publishGeneration`, one request)

| F / sf / C / sc | Statements | Bytes | Largest statement |
| --- | --- | --- | --- |
| 2,300 / 1 / 22,199 / 1 | 73,501 | 66,146,623 (63.1 MiB) | 710,511 bytes, `UPDATE candidate` (absent marking with every key listed) |
| 2,300 / 2 / 22,199 / 2 | 98,000 | 69.0 MiB | 710,511 bytes |
| 2,300 / 3 / 22,199 / 3 | 122,499 | 74.9 MiB | 710,511 bytes |

Candidate upserts are about 44.3 MiB of each total. For comparison, the owner's scratch probe proved 1,000 statements and 954,893 bytes atomic, and the [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) page (read 26 October 2026) caps each statement in a batch at 100,000 bytes and a Cloudflare API batch call at 30 seconds.

## Staged rehearsal on local SQLite (`sqlite3` CLI), 1.25× candidates

2,300 films with 2 shows each, 27,749 candidates with 2 shows each, over a prior generation of 22,199 candidates; prototype statements from `docs/reference/data/staged-generation.sql`.

| Step | Result |
| --- | --- |
| Staged rows | 90,147 statements, 40,647,294 bytes; largest staged statement 873 bytes |
| Chunks at 950 statements | 95 requests; largest chunk 445,436 bytes |
| Staging, all chunks | 3.1 s locally |
| Commit | 12 statements, 4,392 bytes, 0.7 s locally; 27,749 candidates, 55,498 candidate shows and 4,600 film shows committed |

Local SQLite does no replication; D1 timings will be higher. The commit duration on D1 is the open measurement of the scratch verification plan in ADR-0021.

## Uncertainty

The real generation's film count and show distribution; D1 per-request latency and commit duration; undocumented limits below the proven request size.
