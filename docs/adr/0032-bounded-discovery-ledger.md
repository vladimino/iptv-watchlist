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

Split the ledger into a **bounded active ledger** and a **segmented historical archive** with an addressable index. Nothing is deleted.

### 1. Active ledger (unchanged keys and record shape)

- `epg/discovery-latest.json` and `epg/generations/<runId>/discovery-latest.json` keep their name, object shape and record shape. **In bounded mode** they hold only the candidates of the **latest scan of that generation**: every key in the scan's `discovery` set, after non-film screening at scan time. Each record is merged exactly as today.
- New object-level fields:
  - `ledgerMode: "bounded"`;
  - `archive: {version, manifestEtag}`, naming the archive state the commit wrote against.
- **Boundary:** a candidate is active if and only if it is in the latest scan. "Has no shows" is not the boundary. A record in the latest scan whose shows fall outside the 72-hour/24-hour window stays active (`historical` activity), as today. A record leaves the active ledger only when a new scan no longer contains its key.
- Missing `shows` is availability, not identity. An archived record keeps its key, titles, year, durations and airing history. Its identity, decisions and catalogue entry are unchanged.

### 2. Historical archive (new objects)

- `epg/discovery-archive/v1/manifest.json`:
  - `schemaVersion`, `segmentCount`, `hash` (`fnv1a32-utf8`), `totals {items, bytes}`;
  - per segment `{segment, etag, items, bytes, updatedAt}`;
  - `lastWriterRunId`, `updatedAt`.
- `epg/discovery-archive/v1/segments/<nnn>.json`:
  - `{schemaVersion, segment, items: {<key>: <record>}}`, where `segment = fnv1a32(key) mod segmentCount`;
  - the initial `segmentCount` is fixed per archive version (proposed 64, confirmed by the AIR-220 benchmark).
- **The archived record is the full record as it left the active ledger** (lossless; no field is dropped), plus:
  - `archivedAt`;
  - `archivedFromProgrammeRunId`: the last generation that contained it.
- The archive is global, not generation-scoped. It only grows: no TTL and no deletion without a separate decision.
- **Re-sharding:** when a segment exceeds a measured size bound, a new archive version (`v2`) is written next to `v1` by an explicitly approved maintenance step. `v1` is not rewritten in place.

### 3. Writers and order (commit and manual scan)

Only the EPG commit and the manual scan write the ledger and the archive. Both hold the discovery lease, as `publishEpgGeneration` does today. In bounded mode:

1. **Previous active.** Read the previous active ledger (streamed, per AIR-211).
2. **Re-entry.** For every key in the new scan that is not in the previous active ledger, look it up in its archive segment. Segments are read one at a time, only those that hold such keys. The merge input for that key is the archived record, so the merged record equals what full mode would produce.
3. **Departures.** Upsert every previous active key that is absent from the new scan into its segment. Each upsert:
   - is an etag compare-and-swap per segment;
   - keeps the record with the later `lastSeenAt`, then the later `lastSeenProgrammeRunId`;
   - is idempotent on retry;
   - updates the manifest last, also by compare-and-swap.
4. **Publish** the generation with the new active ledger: pointer switch and copy into the shared objects ([ADR 0008](0008-atomic-epg-publication.md)), then queue discovery ([ADR 0030](0030-discovery-queued-at-publication.md)).

**Rule for duplicates:**

- The published active ledger is authoritative for every key it contains.
- The archive is authoritative only for keys absent from it.
- A record that is in both is a harmless leftover. This happens when step 3 completed but step 4 did not, or when a key re-entered. Readers ignore the archive copy, and the next departure of that key overwrites it.
- With this rule no two-phase commit is needed: a commit killed between steps leaves the previous generation authoritative, plus extra archive copies.

### 4. Readers

- **Discovery chunk:** active ledger only.
  - The AIR-94 screening loop and the verified-touch loop run over active rows only. Archived rows are not screened again until they re-enter, and on re-entry the loop screens them like any new row.
  - Existing `excluded_nonfilm` and other decisions are never removed by archiving.
- **Pipeline and enrichment status:** `discoveryCounts` over the active ledger, plus a new `archive` block taken from the manifest: items, segments, bytes, `updatedAt`. `ledgerTotal` becomes active plus archived items. Archived rows are reported as `archived`, not re-classified per call. Status never loads segments.
- **D1 backfill, offline audits, snapshot export:** read the active ledger and every archive segment. The importer treats an archived record exactly as a full-mode ledger row.
- **Canonicalization (`POST /api/enrichment/discovery/reconcile`)** rewrites keys. In bounded mode it returns `409` until an archive-aware re-key exists. Any change of key normalization ships one explicit migration that re-keys the active ledger, every archive segment and the decisions together, with an old-to-new alias map. A silent re-key is not allowed.

### 5. Mode and compatibility

- `DISCOVERY_LEDGER_MODE` = `full` (default; today's behaviour) or `bounded`.
- A bounded-mode Worker reads a full-mode ledger without migration: a record absent from the latest scan is moved to the archive at its next commit.
- A full-mode Worker that finds `ledgerMode: "bounded"` must not publish a ledger that silently drops archived history. In full mode the commit therefore first rebuilds the full ledger from active plus archive. That rebuild is the rollback path (section Recovery).

### Invariants (test contract for AIR-220)

1. **No loss.** After every commit, the keys of active ∪ archive ⊇ the keys of the previous active ∪ archive ∪ the new scan.
2. **Exact boundary.** Active keys = keys of the latest scan. No key appears twice in the active ledger.
3. **Full-mode parity.** For every key, the record in the active ledger, or else in the archive, deep-equals the record full mode would hold after the same sequence of scans. Order is not part of the contract.
4. **Decisions untouched.** `epg/discovery-resolution.json` changes only through the resolver, never by archiving. Every verified, ambiguous, retry, terminal and `excluded_nonfilm` decision survives archive and re-entry unchanged, and re-attaches by key.
5. **Idempotence.** Re-running a commit, or any prefix of its steps, leaves the same active ∪ archive content.
6. **Fencing.**
   - Archive writes require the discovery lease and the commit's generation, and use etag compare-and-swap.
   - A commit of a generation that is no longer the one being published writes nothing to the archive.
   - Chunks never write the archive.
7. **Bounded reads.**
   - Chunk and status paths read no segment.
   - A commit holds at most one segment in memory at a time.
   - The memory need of these paths does not grow with the archive.
8. **Re-entry safety.** A key that left and re-entered gets back its merged history, and its decisions apply unchanged. Its record equals the full-mode record (invariant 3).
9. **Rollback reconstruction.** Active ∪ archive reconstructs the full-mode ledger record for record.

The size budget for the active ledger (10–15 MB was the working hypothesis) is **not** a contract of this ADR. AIR-220 measures the active size and the peak memory at realistic sizes. If the active ledger alone stays too large, field compaction of the active rows is a separate decision.

**Not decided here:** no code, migration, flag change, archive creation, production write, sync, TMDB call, D1 change or Task change. The initial split of the existing production ledger is AIR-222 and needs its own owner approval.

## Alternatives considered

- **Compact ledger** (keep departed rows but drop their bulky fields). Rejected as the primary fix. The ledger still grows with every new title, so it is a constant factor. It also loses `description` and title history that re-entry merges and the D1 import use.
- **Partition by generation** (archive per `programmeRunId`). Rejected. Re-entry would have to search an unbounded number of generations, and the same record would be duplicated across them.
- **Lazy archive** (archive only when a size threshold is crossed). Rejected. It makes memory depend on when the threshold last fired, and the archived set becomes hard to test and reason about.
- **Streaming parse and byte copy only** (AIR-211 prototype). Kept as a complementary implementation detail, not as the bound: memory still grows linearly.
- **One archive JSON.** Rejected by the card: it would be the next unbounded object.
- **Move the ledger to D1 now.** Out of scope: D1 is not production authority, and the AIR-74 gates are open.

## Consequences

- The chunk, status and commit memory need tracks the size of the current scan, not the history of every scan.
- New objects, segment compare-and-swap, a re-entry lookup at commit and a mode flag add code and test surface.
- Changes in the status contract:
  - `ledgerTotal` is active plus archived;
  - per-activity counters cover the active ledger;
  - a new `archive` block is added;
  - `rejectedNonfilm` counts screened rows in the active ledger only.
- The D1 backfill (AIR-74) and the R2 snapshot classification must list the `epg/discovery-archive/` prefix as a mapped source.
- Canonicalization is unavailable in bounded mode until it is archive-aware.

## Recovery and migration boundary

- **Reversible.** Archive objects are additive. The previous full ledgers stay in their immutable generation copies until a separate cleanup decision. Switching `DISCOVERY_LEDGER_MODE` back to `full` makes the next commit rebuild the full ledger from active ∪ archive (invariant 9). That rebuild parses the archive once, a one-off heavy step that needs its own owner approval.
- **Not by code rollback alone.** Reverting the code to a Worker that does not know about the archive would drop archived history from the next ledger it writes. Before such a revert, run the rebuild first (owner-approved), or keep the bounded-aware code.
- This ADR authorizes no flag change, archive creation, migration of the existing ledger, R2 or D1 write, sync, TMDB call or Task change.

## Evidence

- **Original decision:** pending owner approval on the AIR-219 delivery
- **Implementation:** not started ([AIR-220](https://trello.com/c/uPvMc5ww))
- **Dated verification:** the [AIR-211 report](../evidence/epg-memory-pressure-2026-10-27.md) (sizes and growth on 27 October 2026, offline replay). No implementation has been measured.
- **Uncertainty:**
  - the real share of the ledger that is in the latest scan, and so the active size (the item composition was not read);
  - the right `segmentCount` and re-shard bound;
  - whether the active ledger alone fits the Workers limit with margin.

## Follow-ups

- [AIR-220](https://trello.com/c/uPvMc5ww): implementation and offline benchmark against the invariants above.
- [AIR-221](https://trello.com/c/9ZiVygrd): fenced offline rehearsal of the split and parity.
- [AIR-222](https://trello.com/c/9Y4G9DG6): owner-approved production split and rollout.
- AIR-74 class B/A mapping of the archive prefix.
