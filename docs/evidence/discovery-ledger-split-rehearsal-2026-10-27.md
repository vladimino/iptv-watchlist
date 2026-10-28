# Discovery ledger split: offline rehearsal, 27 October 2026

[AIR-221](https://trello.com/c/9ZiVygrd) · offline. Rehearses the split of [ADR 0034](../adr/0034-bounded-discovery-ledger.md) that [AIR-222](https://trello.com/c/9Y4G9DG6) would apply in production. Procedure: [discovery-ledger runbook, offline split](../runbooks/discovery-ledger.md#offline-split-air-221-rehearsal).

> **Correction (28 October 2026, [AIR-222](https://trello.com/c/9Y4G9DG6)).** The plan rehearsed here replaced only the root key `epg/discovery-latest.json` and kept the published generation's copy. The Worker reads the generation copy (`loadJSON` pins it), so the installed split would have been ignored and the first bounded commit would still have parsed the full ledger. The data results below remain valid: partition, parity, counts, resume and fences. The commit memory and its "bounded" path do not. The corrected plan and its numbers are in the [AIR-222 stage 1 evidence](discovery-ledger-split-air-222-stage-1-2026-10-28.md).

**Captured at:** 2026-10-27, AIR-221 branch on top of `main` `286724c`. **Command:** `node scripts/discovery-ledger-split.mjs rehearse --snapshot <snapshot> --output <private dir> --heap`. **Scope:** the [AIR-175 production snapshot](d1-migration/air-175-r2-snapshot-identity-2026-10-26.md), run by the owner on their machine on 2026-10-27 at the PR head (the snapshot never left that machine; only `report.json` aggregates were shared), and a production-shaped synthetic snapshot built with the AIR-220 benchmark shapes. **Evidence lifecycle:** dated measurement of this code on this input. **Operational authority:** none. No production read or write, no flag, no Task, no D1.

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

**Input.** The snapshot taken on 26 October 2026 (`finishedAt` 22:19:31.757 UTC): `consistent_fenced`, 7,994 objects, aggregate `f71eee103b8e45a696def1805d050454bf3721e0cd688dc041c16bddcc0bdeb3`, verified again by the tool before planning. The published full ledger holds 51,643 candidates and is 60.3 MB.

**Run.** On the owner's machine with Node 20, in 73 s at a peak RSS of 1.33 GB.

**Plan: READY.** No stops: 0 duplicate keys, 0 unmarked records, 0 active records of another run, 0 non-canonical keys on either side. The root ledger equals its generation copy.

| | Candidates | Size | Activity | Decisions |
| --- | ---: | ---: | --- | --- |
| Source ledger | 51,643 | 60.3 MB | 16,891 current, 1,111 historical, 33,641 expired | 3,486 verified, 4,769 `excluded_nonfilm`, 728 other, 42,659 none |
| Active (the published scan) | 17,890 | 23.8 MB | 16,891 current, 999 historical | 2,440 verified, 5 `excluded_nonfilm`, 427 other, 15,018 none |
| Archived | 33,753 | 44.7 MB in 64 segment versions (largest 0.75 MB), manifest 1.8 MB | 33,641 expired, 112 historical | 1,046 verified, 4,764 `excluded_nonfilm`, 302 other, 27,641 none |

- "Other" decisions are `no_confident_match`, `ambiguous`, `duration_mismatch` and `needs_verification`.
- 1,020 archived candidates carry a `confirmedTmdbId`. 27,925 archived candidates would be resolver work again if they re-entered (no decision, or neither verified nor excluded).
- 18 archived candidates match the current non-film screen without an `excluded_nonfilm` decision. They are screened if they re-enter.
- The plan has 67 writes totalling 70.2 MB.

| Check | Result |
| --- | --- |
| Install | 67 writes. Boundary exact (17,890 active). Decisions and generation copy untouched |
| Reconstruction (R2 rollback) | 51,643 of 51,643 payloads equal: 0 missing, 0 differing, 0 extra. `ledgerTotal` 51,643 = source |
| Replay | 0 writes, 67 skipped |
| Resume | Kill after writes 1, 32, 64 (last segment), 65 (manifest) and 66 (archive pointer): each stopped, resumed and was byte-identical. `ledgerTotal` stayed 51,643 while stopped |
| Refusals | 6 of 6 refused with 0 planned writes: published generation changed, source ledger changed, EPG commit in progress, lease held, conflicting archive object, corrupt planned object |
| Next commit | 18,683 scanned: 895 leave, 1,688 return. Parity exact over 51,643 keys. Boundary exact. `alsoArchived` 1,688 = leftover copies of the returning candidates. `ledgerTotal` equals full mode. All 1,688 re-entered from the archive. Decisions untouched. Two archive manifests |
| Chunk | HTTP 200 in both modes. 0 active decisions differ, 0 archive reads. Full mode alone recorded 23 `excluded_nonfilm` decisions for archived, non-current candidates; bounded defers them to re-entry |
| Old space, commit (full / bounded) | 262 / 194 MB |
| Old space, chunk (full / bounded) | 166 / 79 MB |

**Verdict on the AIR-175 snapshot: GO for the split.** These are proven on the production cut:

- no data loss: the reconstruction and next-commit parity are exact;
- exact counts;
- idempotent replay and resume;
- refused stale fences;
- decisions untouched;
- the chunk reads no archive and its active decisions are unchanged.

**Memory is not part of this GO.** The numbers are Node old space, not the Workers isolate limit:

- The chunk halves, 166 → 79 MB.
- The first bounded commit falls only by about a quarter, 262 → 194 MB. It carries 1,688 re-entries (5 % of the archive, a rehearsal assumption) and rewrites all 64 segment versions; later commits touch fewer.
- AIR-211 recorded production commits killed with `exceededMemory` and one retry that succeeded where this kind of model predicted more than 128 MB. Whether the first bounded commit fits the isolate with margin is therefore **not shown**.
- AIR-222 has to settle it before activation, with a production measurement or a smaller first commit (for example, a re-entry and segment budget). That is an owner decision.

## Not covered

- The production write path of AIR-222: the S3/R2 writer and its credential. `applySplit` takes an R2-binding-like store; production use needs a separate approval and adapter.
- Production after the AIR-175 cut. The ledger grows about 3 MB per day, so AIR-222 needs a fresh fenced snapshot and a new plan; a plan is bound to its snapshot's ETags.
- The Workers isolate margin for the first bounded commit, which this harness measures only in Node.

**Used by:** [AIR-221](https://trello.com/c/9ZiVygrd), [ADR 0034](../adr/0034-bounded-discovery-ledger.md). **Superseded by:** none recorded.
