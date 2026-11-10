# AIR-423: what changes between two generations of the discovery ledger

**Captured:** 2026-11-10, 20:40 to 21:00 UTC. **Method:** read-only. The two immutable generation documents `epg/generations/<run>/discovery-latest.json` of 9 November (`e38e3f5c…`) and 10 November (`6d9e3c36…`) and a `HEAD` of the archive pointer, read from R2 with the Object Read token (2 `GET`, 1 `HEAD`, no list); MCP `feature_flags`; the code at `main` `6d2ab29`. The documents were compared in a private scratch directory and deleted; only aggregates are recorded, no key, title or id. No write, start, step, flag or migration.

This is the investigation the card asks for before any design. It records no decision.

## The ledger mode: `frozen`, and the status label is not the mode

- `DISCOVERY_LEDGER_MODE` is **absent** in the deployed Worker (effective default `full`). The archive pointer `epg/discovery-archive/v1/current.json` exists (written 28 October 2026 by the split install), so the planner runs as **`frozen`** (`planDiscoveryLedger`: `mode==='bounded'?'bounded':startId?'frozen':'full'`). Both generation documents record `ledgerMode: "frozen"`.
- `frozen` is the documented state after the split ([runbook](../../runbooks/discovery-ledger.md): no new archive write, departures stay in the active ledger). So 26,491 observations that the latest scan did not see stay active **by design of the mode**, not by a defect in it. Nothing has left the active ledger since the split: every one of the 44,924 keys of 9 November is in the document of 10 November.
- The `ledgerMode: "bounded"` that `epg_pipeline_status` shows comes from the D1 read path, which answers the literal `'bounded'` whenever a programme run is set (`readLedger` and `streamActiveLedger` in `src/discovery-authority.js`). It is a label of the D1 reader, not the planner's mode. The same read path counts the archive from D1 rows (`residence='archive'`), which are zero, while the R2 archive the generation document names holds 33,525 items in 64 segments (18,348 only archived, 15,177 also active). The status therefore under-reports both the mode and the archive. This is a reporting gap; whether the D1 ledger should hold the archive rows is a question for the D1 cutover records, not answered here.

## The difference between the two generations

47,059 observations on 10 November against 44,924 on 9 November. Payload is the item without its `shows`, as the seal stores it; bytes are UTF-8.

| Group | Observations | Payload identical | Shows identical | Payload bytes | Show rows |
| --- | --- | --- | --- | --- | --- |
| Not seen on either day | 21,673 (46.1 %) | 21,673 | 21,673 | 23.8 MB | 0 |
| Seen on 9 Nov, not seen on 10 Nov (first absent day) | 4,818 (10.2 %) | 0 | 0 | 5.1 MB | 0 |
| Seen on both days | 16,489 (35.0 %) | 0 | 8,658 | 17.0 MB | 33,364 |
| Not seen on 9 Nov, seen again on 10 Nov | 1,944 (4.1 %) | 0 | 0 | 2.0 MB | 2,314 |
| New key | 2,135 (4.5 %) | n/a | n/a | 2.1 MB | 3,747 |
| **Total** | **47,059** | **21,673** | | **49.9 MB** | **39,425** |

- **Byte-identical, payload and shows: 21,673 observations (46.1 %), 23.8 MB (47.7 % of the payload bytes).** These are exactly the observations absent on both days. `seen_in_latest = 0` alone over-counts by the 4,818 of the first absent day, whose payload changed once (`seenInLatestSnapshot` and the emptied shows).
- An observation seen on both days always differs: `lastSeenProgrammeRunId` is the new run in all 16,489. For 8,982 of them that field is the **only** payload difference, and 7,548 of those also have identical shows (7.5 MB). They are not byte-identical and are not counted as reusable.
- No key left the ledger and no key is duplicated. The common keys keep their relative order and the new keys are at the tail of the document.
- Of the 26,491 not-seen observations, 657 were last seen less than a day ago, 1,173 one to two days, 10,303 three to six days, 10,978 seven to thirteen days and 3,380 two to four weeks ago; 2,943 carry a confirmed TMDB id.

The seal's 47,059 is the evidence ledger. It is not Discovery work: the resolver's backlog was 12,069 unresolved candidates on 10 November (AIR-420 evidence), handled in bounded chunks that write decisions, not observations.

## What reuse would save, after PR #490

Statements of the packed seal for this generation: 5,229 upserts (9 observations each), 589 show deletes (80 keys each), 2,464 show inserts (16 rows each), about 245 batches of 40 statements.

Re-attributing the 21,673 byte-identical observations by key (`UPDATE … SET residence='active', programme_run_id=? WHERE … observation_key IN (…)`, 98 keys a statement) replaces 2,408 upserts and 271 deletes by 222 updates:

| | Packed seal (now) | With reuse of identical rows |
| --- | --- | --- |
| Statements | 8,282 | 5,825 |
| Batches (round trips) | about 245 | about 167 (−32 %) |
| Payload uploaded | 49.9 MB | 26.1 MB (−48 %) |
| Rows written in `discovery_observation` | 47,059 | 47,059 (the same; a row is still updated) |
| Ledger phase at 17 / 200 / 350 ms a round trip | 5 s / 67 s / 144 s | about 4 s / 46 s / 98 s |

So the gain in publication time is about 20 to 45 seconds on a slow instance and nothing measurable on a fast one. The gain in uploaded bytes is about 24 MB a day. Both are models from the document diff, not measurements.

## What the growth costs

In `frozen` mode the active ledger only grows: +2,135 keys from 9 to 10 November (+4.8 %), 42,566 on 8 November. Every seal, every ledger walk and the generation document (57 MB) grow with it, whether or not rows are reused. The mode that stops the growth exists (`bounded`, [ADR 0034](../../adr/0034-bounded-discovery-ledger.md)): on 10 November it would keep the 20,568 observations of the latest scan active and archive the rest. It is a flag and an operation of its own, with its own preconditions; this record does not propose or authorize it. Its behaviour under the D1 authority (the seal archives the rows left `retiring`) is covered by tests and has not run in production.

## Limits

- One pair of generations. The share of identical rows depends on how many observations are absent, which depends on the mode.
- The comparison is of the R2 documents. The D1 rows of 9 November were overwritten by the seal of 10 November and were not compared; the seal writes the document's items, so they should agree.
- The savings table assumes the reuse statement and its fence cost one statement per 98 keys and no extra read.
