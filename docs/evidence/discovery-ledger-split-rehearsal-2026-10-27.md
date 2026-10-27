# Discovery ledger split: offline rehearsal, 27 October 2026

[AIR-221](https://trello.com/c/9ZiVygrd) · offline. Rehearses the split of [ADR 0034](../adr/0034-bounded-discovery-ledger.md) that [AIR-222](https://trello.com/c/9Y4G9DG6) would apply in production. Procedure: [discovery-ledger runbook, offline split](../runbooks/discovery-ledger.md#offline-split-air-221-rehearsal).

**Captured at:** 2026-10-27, AIR-221 branch on top of `main` `286724c`. **Command:** `node scripts/discovery-ledger-split.mjs rehearse --snapshot <snapshot> --output <private dir> --heap`. **Scope:** a production-shaped synthetic snapshot built with the AIR-220 benchmark shapes; the [AIR-175 snapshot](d1-migration/air-175-r2-snapshot-identity-2026-10-26.md) run is pending (below). **Evidence lifecycle:** dated measurement of this code on this input. **Operational authority:** none. No production read or write, no flag, no Task, no D1.

## What the rehearsal does

The rehearsal works on a verified `consistent_fenced` snapshot in a copy-on-write store. The snapshot itself is never written. All steps run the Worker's own code (`src/*.js` in a `vm` context) with no network.

1. **Plan.** Every candidate of the published full ledger with `seenInLatestSnapshot: true` stays active. Every other candidate moves **verbatim**: no re-merge, no re-key, nothing dropped. It goes into 64 write-once segment versions, then a manifest and the archive pointer, and finally the new active ledger.
   - The plan is deterministic: its ids derive from the source ledger's SHA-256.
   - The plan stops on: a duplicate key, an unmarked record, an active record of another run, a root ledger that differs from its generation copy, an existing archive, or a snapshot that is not `consistent_fenced`.
2. **Install and read back.**
   - Apply the plan (`applySplit`), then read it back as an offline reader does: active ledger, the manifest it names, that manifest's segments with checksums.
   - Payload parity of active ∪ archive with the source ledger is the R2 rollback reconstruction of ADR 0034.
   - `ledgerCounts` must give the source's unique total.
   - Decisions and the generation copy must be untouched.
3. **Replay** the same plan on the installed state.
4. **Resume.** Kill after the first, a middle and the last segment, after the manifest and after the archive pointer, then rerun. Each final state must be byte-identical to an uninterrupted run.
5. **Refusals.** Each of these must stop with zero planned writes:
   - the published generation changed;
   - the source ledger changed;
   - an EPG commit is in progress;
   - the discovery lease is held;
   - a conflicting archive object exists;
   - a planned object is corrupt.
6. **Next commit.**
   - The day-after scan: every 20th active candidate leaves, every 20th archived candidate returns, and every show moves a day later.
   - It runs as a `full` commit on the untouched snapshot and as a `bounded` commit on the installed split.
   - Required: payload parity, an exact boundary, exact unique counts, and decisions unchanged.
7. **One discovery chunk** after that commit in both modes. TMDB is unreachable, so the chunk ends after its reads and writes. Active candidates' decisions must agree, and the bounded chunk must read no archive object.
8. **`--heap`.** The smallest V8 old space for the commit and the chunk in each mode.

## Production-shaped synthetic snapshot

The ledger has 58,173 candidates and is 52.7 MB. 22,000 of them are in the published scan, with two shows each. It comes with the catalogue, programme and decisions at the sizes AIR-211 recorded.

| Check | Result |
| --- | --- |
| Plan | READY, no stop. 22,000 active (23.7 MB) and 36,173 archived (37.2 MB in 64 segment versions, largest 0.64 MB, manifest 1.3 MB). 67 writes, 62.2 MB |
| Install | 67 writes. Boundary exact. Decisions and generation copy untouched |
| Reconstruction (R2 rollback) | 58,173 of 58,173 payloads equal: 0 missing, 0 differing, 0 extra. `ledgerTotal` 58,173 = source |
| Replay | 0 writes, 67 skipped |
| Resume | 5 kill points: each stopped, resumed and was byte-identical; `ledgerTotal` stayed 58,173 while stopped |
| Refusals | 6 of 6 refused, 0 planned writes |
| Next commit | 1,100 leave, 1,809 return. Parity exact over 57,973 keys, boundary exact (22,636 active). `alsoArchived` 1,926 equals the leftover duplicates; `ledgerTotal` equals full mode |
| Chunk | HTTP 200 in both modes. 0 active decisions differ; 0 archive reads (see the finding below for archived keys) |
| Old space, commit (full / bounded) | 238 / 186 MB |
| Old space, chunk (full / bounded) | 154 / 79 MB |
| Wall time / peak RSS | 170 s / 1.25 GB (rehearsal process) |

**Verdict on this input: GO.**

### Findings

- **Non-idempotent canonicalization (finding, not a stop).** `canonicalDiscoveryCandidate` is not idempotent for a title that ends in a year-like number: "Title 1901 (2001)" is stored as `title 1901|2001`, which canonicalizes again to `title|2001`.
  - Full mode re-keys such a record at every commit. The archive keeps it verbatim.
  - The synthetic ledger has 200 such keys, all active. The next commit re-keys them identically in both modes, so parity stays exact.
  - The plan counts such keys per side. An archived one would keep its key until re-entry, which full mode would have changed. Any parity effect shows in the next-commit check. Making canonicalization idempotent is a separate change.
- **Deferred decisions for archived rows (ADR 0034 section 4, expected).** In full mode, one chunk records decisions for history rows that are not current. In bounded mode these rows are not visited until they re-enter.
  - The writes full mode made here: 2,295 `verified` from `confirmedTmdbId`, and 671 `excluded_nonfilm` by the AIR-94 screen. It also overwrote 82 stored `ambiguous` or `not_found` decisions with `excluded_nonfilm`.
  - No decision is deleted. None of these rows is actionable, because a non-current candidate is never resolved, and on re-entry the chunk screens and touches them like any new row.
- **Memory.** The bounded commit right after the split needs 186 MB here, more than the 114 MB of the AIR-220 benchmark. This commit re-enters 1,809 archived candidates and rewrites all 64 segment versions, reading and writing one segment at a time. The chunk falls from 154 to 79 MB.
  - As in AIR-220, these are Node numbers, not the Workers isolate limit.

## AIR-175 production snapshot

**Pending.** The owner runs `rehearse --heap` locally on the AIR-175 snapshot (26 October 2026, `consistent_fenced`, 7,994 objects, aggregate `f71eee10…`); that snapshot never enters this container. Its aggregates (`report.json`) are added here before review. The GO/NO-GO for AIR-222 is taken on that run, not on the synthetic one.

## Not covered

- The production write path of AIR-222: the S3/R2 writer and its credential. `applySplit` takes an R2-binding-like store; production use needs a separate approval and adapter.
- Real composition beyond the AIR-175 cut. The ledger grows about 3 MB per day, so AIR-222 needs a fresh fenced snapshot and a new plan; a plan is bound to its snapshot's ETags.
- The Workers isolate margin for the first bounded commit, which this harness measures only in Node.

**Used by:** [AIR-221](https://trello.com/c/9ZiVygrd), [ADR 0034](../adr/0034-bounded-discovery-ledger.md). **Superseded by:** none recorded.
