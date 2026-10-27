# ADR 0032: Bound the active discovery ledger and keep history in a segmented archive

**Status:** Proposed  
**Original decision date:** 2026-10-27 (proposed)  
**Recorded at:** 2026-10-27  
**Approval source:** pending owner review of this ADR ([AIR-219](https://trello.com/c/AKHjmhXR)); the [AIR-211 review](https://github.com/vladimino/iptv-watchlist/pull/164) asked for a bounded active ledger that keeps resolution and history and lets earlier candidates return safely, without automatic pruning  
**Related work:** [AIR-211](https://trello.com/c/UHYcomzg) ([evidence](../evidence/epg-memory-pressure-2026-10-27.md)), [AIR-199](https://trello.com/c/GCfptxao), [AIR-212](https://trello.com/c/c1NQNHRa) ([ADR 0030](0030-discovery-queued-at-publication.md)), implementation [AIR-220](https://trello.com/c/uPvMc5ww), rehearsal [AIR-221](https://trello.com/c/9ZiVygrd), rollout [AIR-222](https://trello.com/c/9Y4G9DG6)  
**Supersedes:** None. Refines [ADR 0007](0007-persistent-discovery-evidence.md) (persistent observations) without removing any of its guarantees.  
**Superseded by:** None

## Context

[ADR 0007](0007-persistent-discovery-evidence.md) keeps every EPG observation in one persistent ledger, `epg/discovery-latest.json` (plus its copy in each published generation), keyed by `normalizedTitle|year`. Decisions live separately in `epg/discovery-resolution.json`.

`mergeDiscoveryCandidates` (`src/sources.js`) folds the previous ledger into each new scan. A candidate absent from the new scan stays forever, with `shows: []` and `seenInLatestSnapshot: false`. On 27 October 2026 the ledger was 63.4 MB and growing by about 3 MB per day ([AIR-211](../evidence/epg-memory-pressure-2026-10-27.md)). The published generation then held about 22,000 candidates, which is far fewer than the ledger total.

Every failing path parses the whole object:

- the EPG commit (`epgSync`): previous ledger, merge, publish;
- the manual scan (`POST /api/enrichment/discovery/scan`);
- each discovery chunk (`resolveDiscoveryChunk`);
- the pipeline and enrichment status reads.

The Worker's memory need grows linearly with the ledger, and since 21 October these paths have ended with `exceededMemory`. Constant-factor savings (streaming parse, byte copy; prototype in the AIR-211 report) buy days, not a bound.

What the code needs from candidates that left the EPG, and what it does not:

- `candidateActivity` classifies a candidate with `seenInLatestSnapshot === false` as `historical` or `expired`. `resolutionActionability` acts only on `current` candidates. A candidate that left the EPG is therefore never resolved, retried or screened into work.
- It is still used:
  - **on re-entry**, `mergeDiscoveryCandidates` folds the old record's `rawTitles`, `durations`, `firstAiring`, `airings` and `description` into the new observation;
  - **in the status counters** of `discoveryCounts`: `ledgerTotal`, `historicalUnresolved`, `expiredInactive`, `rejectedNonfilm`;
  - **in the AIR-94 screening loop** of a chunk, which records `excluded_nonfilm` decisions for every ledger row;
  - **by the D1 backfill** (`src/offline-importer.js` into the `candidate` tables, [D1 schema](../reference/data/d1-schema.md)) and the offline audit scripts.
- Decisions, the verified catalogue (`epg/discovered-films.json`), retries (`retryAt`, `attempts`, `terminalReason`) and the cold prediction backlog (catalogue films) are separate objects keyed by candidate key or film id. None of them is stored in the ledger.

## Decision

Split the ledger into a **bounded active ledger** and a **versioned, segmented historical archive** with an addressable index. Nothing is deleted.

### 1. Active ledger (unchanged keys and record shape)

- `epg/discovery-latest.json` and `epg/generations/<runId>/discovery-latest.json` keep their name, object shape and record shape. **In bounded mode** they hold only the candidates of the **latest scan of that generation**: every key in the scan's `discovery` set, after non-film screening at scan time. Each record is merged exactly as today.
- New object-level fields:
  - `ledgerMode: "bounded"`;
  - `archive: {version, manifestId, alsoArchived, uniqueArchivedItems}`:
    - `manifestId`: the immutable archive manifest this active ledger was written against (section 3);
    - `alsoArchived`: the sorted list of this ledger's keys that also have a (leftover) archive copy. It is bounded by the active size;
    - `uniqueArchivedItems` = the manifest's `totals.items` − `alsoArchived.length`: the number of archived keys that are **not** in this active ledger.
- **Boundary:** a candidate is active if and only if it is in the latest scan. "Has no shows" is not the boundary. A record in the latest scan whose shows fall outside the 72-hour/24-hour window stays active (`historical` activity), as today. A record leaves the active ledger only when a new scan no longer contains its key.
- Missing `shows` is availability, not identity. An archived record keeps its key, titles, year, durations and airing history. Its identity, decisions and catalogue entry are unchanged.

### 2. Archive objects: immutable versions behind one pointer

All archive objects except the pointer are **write-once**: never overwritten, never deleted by the Worker.

- **Segment version:** `epg/discovery-archive/v1/segments/<nnn>/<writeId>.json`, holding `{schemaVersion, segment, writeId, items: {<key>: <archived record>}}`.
  - `segment = fnv1a32(utf8(key)) mod segmentCount`. The initial `segmentCount` is fixed per archive version (proposed 64, confirmed by the AIR-220 benchmark).
  - `writeId` is unique per writer attempt.
- **Manifest version:** `epg/discovery-archive/v1/manifests/<manifestId>.json`, holding:
  - `schemaVersion`, `manifestId`, `parentManifestId`, `segmentCount`, `hash: "fnv1a32-utf8"`;
  - for **every** segment `{segment, object, sha256, items, bytes}`, where `object` names the segment version in force;
  - `totals {items, bytes}`;
  - `upsertedKeys`: the sorted keys this version wrote, i.e. the writer's departures. Bounded by one scan's departures;
  - the writer fence: `writerRunId`, `kind` (`commit` or `scan`), `basedOnProgrammeRunId`, `basedOnPointerEtag`, `leaseId`, `writtenAt`.
- **Pointer:** `epg/discovery-archive/v1/current.json`, holding `{manifestId}`. It is the **only** mutable archive object, and changes only by etag compare-and-swap.
- **Archived record = payload + envelope.**
  - The payload is exactly the candidate record as it left the active ledger: every field, none dropped.
  - The envelope holds `archivedAt`, `archivedFromProgrammeRunId` (the last generation that contained it) and `archiveWriteId`.
  - In a segment the record is stored as `{payload, envelope}`. Every comparison with full mode is on the **payload** only.
- **Retention:** no TTL and no deletion by the Worker. Segment and manifest versions that no retained manifest references are unreferenced garbage. Removing them is a separate, owner-approved maintenance decision.
- **Re-sharding:** a new archive version (`v2`) is written next to `v1` by an explicitly approved maintenance step. `v1` is not rewritten in place.

### 3. Write protocol (commit and manual scan)

A writer is the EPG commit of run `R` (target: the new generation `R`), or, once it is made archive-aware, the manual scan (target: the generation currently published). Until then the manual scan returns `409` in bounded mode.

**Fence read at the start.** The writer reads and keeps:

- the discovery lease it holds (as `publishEpgGeneration` does today);
- the published pointer `epg/published-generation.json`: its etag `E0` and generation `P`;
- the archive pointer: its etag `A0` and manifest `M0`;
- the previous active ledger, which is the active ledger of `P`.

**Steps:**

1. **Re-entry.** For every key of the new scan that is not in `P`'s active ledger, read that key's segment version named by `M0`. Segments are read one at a time, only those that hold such keys. The merge input for a key found there is its payload, so the merged record equals what full mode would produce.
2. **Departures.** For every key of `P`'s active ledger that is absent from the new scan, build a new version of its segment from the version named by `M0`:
   - upsert `{payload, envelope}` for the departing key, keeping the record with the later `lastSeenAt`, then the later `lastSeenProgrammeRunId`;
   - keep every other key unchanged, including archive copies of keys that re-entered; those are removed only by a later departure that overwrites them.
   - Write each new segment version under a fresh `writeId`. Untouched segments keep their `M0` object.
   - **Reconcile against the fenced starting manifest.** `P`'s `alsoArchived` is exact only for the manifest `Mp` that `P` names. `M0` can be newer: a writer that swapped the archive pointer and then died before publishing (crash window 3) added copies of keys that are still in `P`'s active ledger.
     - Walk `parentManifestId` from `M0` back to `Mp`. Every key in those versions' `upsertedKeys` that is in `P`'s active ledger is also archived.
     - The walk is bounded: normally zero or one version, each with one scan's departures.
     - If the chain is longer than a fixed bound (proposed 8 versions), or does not reach `Mp`, recompute instead. Read every segment of `M0` one at a time and collect its keys that are in `P`'s active ledger. Memory stays at one segment plus the active key set.
   - Compute the new `alsoArchived`:
     - start from `P`'s list plus the keys found by the reconciliation, and keep those still in the new scan;
     - add the re-entered keys found in step 1;
     - drop the departing keys, whose archive copy is now the current record.
3. **Archive commit point.** Write manifest version `M1` with `parentManifestId = M0`, the writer fence and the full segment table. Then:
   - re-read the published pointer and the lease;
   - only if the pointer etag is still `E0` and the lease is still held, swap the archive pointer `A0 → M1` by compare-and-swap.
   - If the pointer moved, the lease was lost or the archive CAS lost, the writer stops. Its segment and manifest versions stay unreferenced, and nothing is published.
4. **Publish.** Write the new active ledger with `archive.manifestId = M1` and `uniqueArchivedItems`.
   - A commit publishes generation `R` by the existing pointer compare-and-swap from `E0` ([ADR 0008](0008-atomic-epg-publication.md)), then queues discovery ([ADR 0030](0030-discovery-queued-at-publication.md)).
   - The manual scan updates `P`'s files under the existing `updatePublishedFiles` check that the pointer etag is still `E0`.

**Generation fence.** The writer's archive write is valid **before** publication because it is fenced on its predecessor, not on its own generation:

- the published pointer must still be `E0`, the same `P` it read;
- it must hold the discovery lease;
- for a commit, `sync.json` must still name run `R` in stage `epg`.

A stale commit is rejected at step 3: its predecessor was already superseded by another publication, so the pointer etag is no longer `E0`. Two writers race on the archive pointer: one CAS wins, and the loser stops before publication.

**Crash windows.** Every outcome leaves a consistent state:

| Killed after | State left | Recovery |
| --- | --- | --- |
| step 1 or 2 (new segment versions written, pointer not swapped) | `current.json` still names `M0`; the new segments are unreferenced | none needed; the retry starts from `M0` |
| step 3, before the manifest CAS | as above, plus one unreferenced manifest | none needed |
| the archive CAS, before publication | archive at `M1`; generation `P` still published. Departures of the failed run are archived **and** still in `P`'s active ledger; re-entries are unchanged | the next writer starts from `M1` and `P`. Duplicates resolve by rule D below |
| publication | ADR 0008/0030 states; the published active names `M1` | as today (AIR-159 handoff, ADR 0030 enqueue) |

**Rule D (duplicates).** For a key present in a published active ledger, that ledger is authoritative. The archive copy is authoritative only for keys absent from it. Leftover copies are harmless and are never counted twice (section 4).

### 4. Readers and consistent snapshots

**A consistent read** is one published active ledger, plus the manifest version it names (`archive.manifestId`), plus exactly the segment versions that manifest names. All of these are immutable, so a reader never sees a half-written archive, whatever writer runs at the same time. Readers never follow `current.json` for history: it is the writers' compare-and-swap point.

- **Discovery chunk:** active ledger only.
  - The AIR-94 screening loop and the verified-touch loop run over active rows only. Archived rows are not screened again until they re-enter, and on re-entry the loop screens them like any new row.
  - Existing `excluded_nonfilm` and other decisions are never removed by archiving.
- **Pipeline and enrichment status:** `discoveryCounts` over the active ledger, plus an `archive` block from the active ledger's own `archive` field and its manifest: `manifestId`, segments, bytes, `uniqueArchivedItems`.
  - `ledgerTotal` = active items + `uniqueArchivedItems`, i.e. the number of unique keys in active ∪ archive. Leftover duplicate copies are not counted.
  - The writer computes `uniqueArchivedItems` from the `alsoArchived` list, reconciled against its fenced starting manifest (section 3, step 2). It is exact after any aborted writer, normally without scanning segments. Status never loads segments.
- **Re-entry (writer step 1):** reads from `M0`, the manifest the writer fenced on.
- **D1 backfill, offline audits, R2 snapshot:**
  - read the published active ledger and its manifest and segment versions;
  - deduplicate by rule D;
  - compare payloads.

  A fenced R2 snapshot ([runbook](../runbooks/r2-snapshot-export.md)) includes `epg/discovery-archive/` and adds `current.json` to its fence keys, so a snapshot cannot mix archive versions silently. The importer refuses a snapshot whose published active ledger names a manifest or segment that is missing or fails its `sha256`.
- **Canonicalization (`POST /api/enrichment/discovery/reconcile`)** rewrites keys. In bounded mode it returns `409` until an archive-aware re-key exists. Any change of key normalization ships one explicit migration that re-keys the active ledger, every archive segment and the decisions together, with an old-to-new alias map. A silent re-key is not allowed.

### 5. Modes, compatibility and rollback

`DISCOVERY_LEDGER_MODE` has three values:

- `full` (default; today's behaviour);
- `bounded`;
- `frozen`: stop archiving. New departures stay in the active ledger, as in full mode, but the archive stays authoritative history and is still read for re-entry and counts.

Compatibility:

- A bounded-mode Worker reads a full-mode ledger without migration: a record absent from the latest scan is archived at its next commit.
- A Worker in `full` mode that meets an active ledger with `ledgerMode: "bounded"` behaves as `frozen`. It **never** rebuilds the full ledger inside a Worker invocation, because that would recreate the AIR-211 memory problem.

**Rollback** has two levels, both owner-approved:

- **R1 (operational).** Switch `bounded` to `frozen`. Nothing is rebuilt or deleted. The active ledger grows again from that point, as today.
- **R2 (code).** Revert to an archive-unaware Worker. Only after an **offline**, fenced reconstruction:
  - take a consistent snapshot (section 4);
  - rebuild the full ledger locally, with payload parity against active ∪ archive;
  - have a GO/NO-GO reviewed; then write it under a separate approval.

  **GO requires** the rebuilt ledger's measured commit and chunk memory to be within the proven Workers bound. Otherwise R2 is **NO-GO**, and the system stays on bounded or frozen code. A plain code revert without this step would drop archived history and is not allowed.

### Invariants (test contract for AIR-220)

1. **No loss.** After every completed or killed writer, the unique keys of the published active ∪ its manifest's segments ⊇ the previous unique keys ∪ the keys of the published scans.
2. **Exact boundary.** Active keys = keys of the latest scan. No key appears twice in an active ledger.
3. **Full-mode parity.** For every key, the active record, or else the archived **payload**, deep-equals the record full mode would hold after the same sequence of published scans. Envelope fields and order are not part of the comparison.
4. **Unique counts.** `ledgerTotal` = |unique keys of active ∪ archive|, whatever leftover duplicates exist. This includes copies left by a writer that swapped the archive pointer and died before publishing.
5. **Decisions untouched.** `epg/discovery-resolution.json` changes only through the resolver, never by archiving. Every verified, ambiguous, retry, terminal and `excluded_nonfilm` decision survives archive and re-entry unchanged, and re-attaches by key.
6. **Idempotence.** Re-running a writer after a kill at any step yields the same unique keys and payloads.
7. **Fencing.**
   - The archive pointer moves only while the published pointer still has the etag the writer read (`E0`), and only while the writer holds the lease.
   - A stale commit, a lost lease or a lost CAS publishes nothing.
   - Chunks never write the archive.
8. **Snapshot consistency.** Any reader that follows section 4 sees one manifest version and its segment versions only. An unreferenced version is never read as history.
9. **Bounded reads.**
   - Chunk and status paths read no segment.
   - A writer holds at most one segment in memory at a time.
   - The memory need of these paths does not grow with the archive.
10. **Re-entry safety.** A key that left and re-entered gets back its merged history, and its decisions apply unchanged.
11. **Rollback.** The offline reconstruction from a consistent snapshot equals the full-mode ledger record for record (payloads), and passes or fails the R2 GO criterion explicitly.

**Kill-window tests required in AIR-220:**

- a kill after each step of section 3, including between a segment write and the next one, and between the manifest write and the archive CAS;
- a kill after the archive CAS but before publication, followed by the next commit. Specifically: `P` is published; run `R` archives departing key `K`, swaps `current.json` and dies before publication; the next run `S` keeps `K` in its scan. Expect `ledgerTotal` = the exact number of unique keys of active ∪ archive, `K` in `alsoArchived`, and payload parity;
- the same with a chain longer than the bound or a missing manifest version, which forces the segment-by-segment reconciliation, with its peak memory measured;
- a stale commit whose predecessor was superseded;
- two writers racing on the archive pointer (commit and archive-aware scan);
- a retry of the same run;
- a reader taking a snapshot during a writer;
- a snapshot with a missing or corrupt segment version.

The size budget for the active ledger (10–15 MB was the working hypothesis) is **not** a contract of this ADR. AIR-220 measures the active size and the peak memory at realistic sizes. If the active ledger alone stays too large, field compaction of the active rows is a separate decision.

**Not decided here:** no code, migration, flag change, archive creation, production write, sync, TMDB call, D1 change or Task change. The initial split of the existing production ledger is AIR-222 and needs its own owner approval.

## Alternatives considered

- **Compact ledger** (keep departed rows but drop their bulky fields). Rejected as the primary fix. The ledger still grows with every new title, so it is a constant factor. It also loses `description` and title history that re-entry merges and the D1 import use.
- **Partition by generation** (archive per `programmeRunId`). Rejected. Re-entry would have to search an unbounded number of generations, and the same record would be duplicated across them.
- **Lazy archive** (archive only when a size threshold is crossed). Rejected. It makes memory depend on when the threshold last fired, and the archived set becomes hard to test and reason about.
- **Mutable segments with a manifest updated last.** Rejected after review. A kill between segment and manifest writes leaves a manifest whose etags and totals do not match the segments, and a concurrent reader can see a half-written state.
- **Streaming parse and byte copy only** (AIR-211 prototype). Kept as a complementary implementation detail, not as the bound: memory still grows linearly.
- **One archive JSON.** Rejected by the card: it would be the next unbounded object.
- **Move the ledger to D1 now.** Out of scope: D1 is not production authority, and the AIR-74 gates are open.
- **Rebuild the full ledger inside the Worker on rollback.** Rejected after review: it reproduces the AIR-211 memory failure.

## Consequences

- The chunk, status and commit memory need tracks the size of the current scan, not the history of every scan.
- New objects, write-once versions, an archive pointer CAS, a re-entry lookup at commit and a mode flag add code and test surface.
- Storage grows with every writer by the segment versions it rewrites. Cleaning up unreferenced versions is a later, separately approved decision.
- Changes in the status contract:
  - `ledgerTotal` counts unique active ∪ archived keys;
  - per-activity counters cover the active ledger;
  - a new `archive` block is added;
  - `rejectedNonfilm` counts screened rows in the active ledger only.
- The D1 backfill (AIR-74) and the R2 snapshot classification must map the `epg/discovery-archive/` prefix, and the snapshot fence gains `current.json`.
- Canonicalization, and the manual scan until it is archive-aware, are unavailable in bounded mode.

## Recovery and migration boundary

- **Reversible without data loss.** Archive objects are additive and write-once. The previous full ledgers stay in their immutable generation copies until a separate cleanup decision.
- **Rollback** follows R1 (`frozen`) or R2 (offline reconstruction with a GO/NO-GO), never an in-Worker rebuild and never a plain code revert.
- This ADR authorizes no flag change, archive creation, migration of the existing ledger, R2 or D1 write, sync, TMDB call or Task change.

## Evidence

- **Original decision:** pending owner approval on the AIR-219 delivery. The first independent review ([PR #167](https://github.com/vladimino/iptv-watchlist/pull/167)) raised the crash consistency, payload parity and unique counts, rollback, fencing and snapshot consistency points addressed above. A re-review raised the duplicate count after an aborted archive write, addressed by reconciling `alsoArchived` against the fenced starting manifest.
- **Implementation:** not started ([AIR-220](https://trello.com/c/uPvMc5ww))
- **Dated verification:** the [AIR-211 report](../evidence/epg-memory-pressure-2026-10-27.md) (sizes and growth on 27 October 2026, offline replay). No implementation has been measured.
- **Uncertainty:**
  - the real share of the ledger that is in the latest scan, and so the active size (the item composition was not read);
  - the right `segmentCount` and re-shard bound;
  - the storage growth of write-once segment versions;
  - whether the active ledger alone fits the Workers limit with margin.

## Follow-ups

- [AIR-220](https://trello.com/c/uPvMc5ww): implementation, kill-window tests and offline benchmark against the invariants above.
- [AIR-221](https://trello.com/c/9ZiVygrd): fenced offline rehearsal of the split and parity.
- [AIR-222](https://trello.com/c/9Y4G9DG6): owner-approved production split and rollout.
- AIR-74: class A/B mapping of the archive prefix and the snapshot fence key.
