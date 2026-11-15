# ADR 0145: After ADR 0142 decision 13, the EPG seal stages only the publication; no catalog staging, no availability input, no `seal_catalog`

**Status:** Accepted as DESIGN (2026-11-15; implementation started 2026-11-15 after the owner GO on AIR-485; no production operation authorized by this record)
**Original decision date:** 2026-11-15
**Recorded at:** 2026-11-14
**Approval source:** Product Owner decision of 2026-11-15 recorded in [AIR-485](https://trello.com/c/qulgP9a8), following [independent technical review of PR #638](https://github.com/vladimino/iptv-watchlist/pull/638#pullrequestreview-5907764074): final layout D is accepted as an architectural design; C+/D+ and abandoned-object cleanup are deferred. The [owner sequencing of 2026-11-14](https://github.com/vladimino/iptv-watchlist/pull/638#issuecomment-6885539218) remains binding: AIR-480's ADR 0142 decision 13 (M5) code contract must reach `main` before AIR-485 implementation. Acceptance of this ADR is not implementation, deploy or production authorization.
**Related work:**
- [AIR-485](https://trello.com/c/qulgP9a8), with [offline comparison evidence](../evidence/orchestration/air-485-seal-staging-comparison-2026-11-14.md).
- [AIR-480](https://trello.com/c/ZS0Xdrlq): implements ADR 0142 and is the prerequisite.
- [AIR-460](https://trello.com/c/ZXySuCJk) and [AIR-462](https://trello.com/c/w73gROBl): seal OOM investigation.
- [AIR-484](https://trello.com/c/CDvqIdUn): the ADR 0144 implementation, merged in [PR #636](https://github.com/vladimino/iptv-watchlist/pull/636).
- ADRs: [ADR 0079](0079-d1-authoritative-published-epg.md), [ADR 0092](0092-resumable-bounded-ledger-seal.md), [ADR 0096](0096-bounded-seal-publication-steps.md), [ADR 0099](0099-canonical-film-person-d1-authority.md), [ADR 0140](0140-producer-workflow-adaptive-successor-chain.md), [ADR 0142](0142-epg-owned-generation-addressed-discovery-slots.md), [ADR 0144](0144-epg-seal-successor-workflow-instance.md).

**Supersedes:** None.
- ADR 0144 keeps the staged payload unchanged and leaves its format to this record.
- When this record is delivered, it qualifies the phase list of ADR 0092 and 0096: `seal_catalog` is removed. Those records are not edited.

**Superseded by:** None

## Context

### The staged payload today

`stageSealedGeneration` (`src/worker.js`) is the last part of `epg_commit`. It streams the generation ledger to R2. Then it writes one object, `epg/seal/<runId>/payload.json`, with six fields: `report`, `catalog`, `watchlist`, `uncertain`, `fence` and `expectedProgrammeRunId`. Last, it saves `sync.json` at `stage: seal`. The seal phases are `ledger`, `catalog`, `publish`, `finalize` and `queue` (ADR 0092, 0096). Every phase after `ledger` parses the whole object:

- **`seal_catalog`** reads only `catalog`. It reads the D1 catalog twice per step: once as the merge base, once as the diff base.
- **`seal_publish`, `seal_finalize` and `seal_queue`** drop `catalog` right after the parse.
- **`seal_queue`** deletes the object when the run completes. An abandoned run's object is never deleted.

At the volumes of 13-14 November the object is 14.2-14.9 MiB, of which the catalog is about 10.7 MiB. Parsing it adds 58 MiB of RSS in workerd ([stream measurements](../evidence/orchestration/air-460-seal-stream-workerd-2026-11-14.md)).

**The staged catalog is the scan-time D1 catalog plus availability, nothing more.** `epgSync` reads `epg/discovered-films.json` (D1 `discovery_admission` in D1 mode) as `cache` before the scan. The scan receives copies (`{...f, catalogOnly: true}`), so `cache` is not changed. The staged value is `replaceCatalogAvailability(cache, scan observations, runId).catalog`, which writes only `shows`, `epgLastAiring` and `showsProgrammeRunId`. The stamp touches every Film with a `tmdbId`, so all 9,226 admissions change in every run ([M3 step metrics](../evidence/d1-migration/air-374-m3-epg-step-metrics-2026-11-13.md)).

### What M5 changes

[ADR 0142](0142-epg-owned-generation-addressed-discovery-slots.md) decision 13 (Accepted) derives a catalog Film's showings from the slots and stops writing the availability fields into Films, after the consumer list. Its affected-writers table names `replaceCatalogAvailability` and `mergeCatalogIdentity` in `src/sources.js`: "availability fields stop being written after the consumer list; identity merge unchanged".

**Inference from the code reading above.** Once the EPG sync writes no availability, the staged catalog equals the scan-time copy of D1. Then `seal_catalog` has nothing of its own to write. It can only rewrite D1 rows with an older copy of themselves:
- a concurrent identity change is lost;
- a Film admitted after the scan gets `shows: []`;
- a Film superseded after the scan is sent back to `upsertAdmissions`.

**State of `main` at `00d3f162` (14 November 2026).** M5 is **not** delivered:
- `epgSync` still calls `replaceCatalogAvailability`;
- `sealCatalogStep` still writes the difference.

AIR-480 stage 4b-1 ([PR #637](https://github.com/vladimino/iptv-watchlist/pull/637)) changed only the presentation of catalog Films in `GET /api/programme`. Whether a later AIR-480 stage delivers the M5 code contract has to be verified on `main` itself, not from the card's list position.

### Producers, readers and authority

| Data | Produced by | Read by | Authority and lifetime |
| --- | --- | --- | --- |
| `report` (the programme) | The `epgSync` scan | The `pointer` unit (generation `programme.json`, D1 stage rows through `PublishedEpg.publishGeneration`), `mirrors` (`programme.json` mirror), `finalize` (`persistWatchlist`, `persistScan`, `persistEvents`), `queue` (`refreshPredictionQueue`, `prepareEpgCompletion`) | After the pointer, the D1 `published_epg_document`, `_member` and `_show` rows are authoritative (ADR 0079). The staged copy is a run-scoped input. |
| `catalog` | `replaceCatalogAvailability` over the scan-time catalog | `seal_catalog` only | D1 `discovery_admission` is authoritative (ADR 0085). The staged copy is a stale duplicate of D1 plus the scan's availability. |
| `watchlist` | `epgSync` (`{updatedAt, films: run.watchlist}`) | The `pointer` (D1 watchlist document), `mirrors` (`watchlist.json`), the `intent` fallback | D1 after the pointer. The same Film list also rides in `sync.json` as `run.watchlist`. |
| `uncertain` | The scan | The `intent` unit (`uncertain.json`) | R2 `uncertain.json`; small. |
| `fence`, `expectedProgrammeRunId` | `PublishedEpg.currentGeneration` at `seal_stage` | The `pointer` unit (CAS of the published pointer) | The D1 `published_epg_authority` row; the staged values are the expected state. |
| Generation ledger `epg/generations/<runId>/discovery-latest.json` | `seal_stage` (streamed with a known length; etag kept in `run.seal.etag`, key in `run.seal.sourceKey`) | `seal_ledger` (range reads, etag-checked) → D1 ledger tables; `copy` → `epg/discovery-latest.json` mirror | The R2 object is an immutable run input. After the seal the D1 ledger is authoritative and `epg/discovery-latest.json` is a mirror. |
| `sync.json` | Every EPG step | Every action: about three reads and at least one write | The R2 run checkpoint. It carries `run.seal`: phase, units, the ledger's `sourceKey` and `etag`, and after this record `layout`, `publicationKey` and `publicationEtag`. |
| `epg/seal/<runId>/payload.json` | `seal_stage`; also `epg-diagnostic-run.js` through the same function | The seal phases after `ledger` | An immutable run-scoped R2 input, deleted at completion. |

### Measured

All figures are V8 heap in Node from the [offline comparison](../evidence/orchestration/air-485-seal-staging-comparison-2026-11-14.md), with an 8.9 MiB baseline. They rank layouts; they are not workerd isolate headroom.

D's object is byte for byte C's `publication.json`, so D's `publish`, `finalize` and `queue` cells are C's measured cells. D has no `seal_catalog` step.

| Step | A0 `main` | A1 one D1 read | B R2 split | C interim | **D final (this record)** | C+ D1 pre-staged |
| --- | --- | --- | --- | --- | --- | --- |
| `seal_catalog` | 63 | 64 | 55 | 40 | **none** | 40 |
| `seal_publish` | 44-46 | 44-46 | 31 | 31 | **31** | 18 |
| `seal_finalize` / `seal_queue` | 44 | 44 | 15 | 18 | **18** | 18 |

Traffic per `seal_catalog` step:

| | A0 | A1, B, C | D |
| --- | --- | --- | --- |
| D1 reads | 16 MiB | 8 MiB | none |
| R2 read | 14.2 MiB | 14.2 (A1), 10.7 (B), 0.8 (C) MiB | none |

- **Each later step** reads 14.2 MiB from R2 in A0, against 3.6 MiB in C and D.
- **D1 writes.** In `seal_catalog` they are equal in A0 to C. In D they disappear with the phase. That the daily rewrite of 9,226 admissions disappears at all is M5's effect, not this record's.
- **C+** moves 2,064 statements and 2.3 MiB of D1 writes out of `seal_publish`, into a step whose peak was not measured.

**Not addressed by any layout.** The 14 November OOMs were in `seal_ledger` and at `seal_publish_copy` ([AIR-462 correlation](../evidence/orchestration/air-462-epg-oom-natural-run-2026-11-14.md)). `seal_ledger` reads no payload. During the copy, every layout holds `report` and `watchlist`. This record lowers the parse peaks and the garbage of the steps after the ledger seal, and the bytes `seal_stage` serialises. It is **not** claimed as an OOM fix.

## Decision (accepted design; implementation conditional on M5)

0. **Prerequisite and order.** Nothing in this record is implemented before the M5 code contract of ADR 0142 decision 13 is on `main`. The contract is verified in the code, not from a Trello list:
   - `epgSync` writes no availability fields into catalog Films;
   - no reader depends on them, per the consumer list;
   - the availability work of `seal_catalog` has been removed or reduced to nothing.

   An AIR-480 card waiting in `Верификация` for a natural run is not treated as Done. The implementation of this record needs only the code contract on `main`, plus the owner's go-ahead.
1. **Only the publication is staged.** `seal_stage` writes one run-keyed object, `epg/seal/<runId>/publication.json`, instead of `payload.json`. It holds `runId`, `report`, `watchlist`, `uncertain`, `fence` and `expectedProgrammeRunId`, with today's meaning.
   - The object is written before `sync.json` moves to `stage: seal`.
   - `run.seal` records `layout: 2` and two new fields, `publicationKey` and `publicationEtag`. The existing ledger fields `run.seal.sourceKey` and `run.seal.etag` keep their meaning and values: they belong to the generation ledger, and `readSealedItems` fences every ledger read with them. No new field reuses them.
   - Every read of `publication.json` checks `publicationEtag` and fails closed on a missing object or a mismatch, before the step writes anything. Ledger reads keep checking `run.seal.etag`. The two checks are independent: a mismatch on one never rewrites or relaxes the other.
   - Nothing of the catalog is staged: no catalog copy, no `availability.json`, no D1 BLOB or JSON document.
2. **The `catalog` seal phase is removed.** A finished `ledger` phase moves straight to `publish`. The EPG sync then writes nothing into `discovery_admission` during the seal, and D1 stays the only copy of the catalog. The catalog read the scan needs to match catalog-only Films is unchanged.
3. **The later phases read only `publication.json`.** That covers `seal_publish` (`pointer`, `mirrors`, `copy`, `intent`), `seal_finalize` and `seal_queue`.
   - The commit point is unchanged: the single fenced `PublishedEpg` batch that moves the pointer, inserts the generation and copies the staged rows.
   - The units, their idempotence, and the `fence` and `expectedProgrammeRunId` checks stay as in ADR 0096.
4. **Legacy reader.** A run whose `run.seal` has no `layout` was staged by earlier code. It is finished from `payload.json`:
   - in phase `catalog`, it moves straight to `publish`, because after M5 that phase has nothing of its own to write;
   - in the later phases, from the same object with `catalog` dropped, as today.

   The reader is removed only after the retirement condition in the rollout.
5. **Mixed versions fail closed; deploy and rollback at a drain holdpoint.**
   - **Old code on a `layout: 2` run** still runs `seal_ledger`, whose input is unchanged. It then enters `catalog` or `publish`, finds no `payload.json` and throws before that step writes anything. The step keeps its phase, and the hourly `ensure` (ADR 0100, 0144) retries.
   - **No dual write.** No layout writes both forms, because that would bring back the bytes this record removes.
   - **Holdpoint.** A deploy that introduces or removes `layout: 2`, and its rollback, happens only at the ADR 0144 drain holdpoint ([deployment runbook](../runbooks/deployment.md)). It is a separate deploy from the M5 deploy. Before merging the deploy and before reverting it, the read-only EPG status must show all three of:
     1. no unfinished handoff claim in `orchestration.handoff`, meaning no `handoff.sealRunId` whose `sync.json` is still at `stage: seal`;
     2. `orchestration.syncRun.stage` not `seal`;
     3. `orchestration.owner.liveness` `finished` or `absent` for the recorded instance. This is read in every control phase, including `done` and `stopped`, because a successor still running its last step reads `alive` (`drainState: instance_live`).

     A stage that is not `seal` does not prove the holdpoint by itself. Any other value, such as `alive`, a pending claim, or an unreadable or unknown field, means the holdpoint is not proven, and the deploy or rollback does not proceed. While a claim is pending, the natural run or the hourly `ensure` recovery finishes it, and the three checks are read again. The check is read-only; it authorizes no run, flag or write.
6. **Retention.** At completion `seal_queue` deletes every object of the run's seal prefix (`payload.json`, `publication.json`), where today it deletes one. Objects of abandoned runs already accumulate today. Removing them needs a new R2 delete writer and is **not** decided here.
7. **Relation to ADR 0144.** The successor instance finishes the seal from the run-keyed object and `run.seal`, both durable in R2; the hand-off is unchanged. Any code that names the seal phases must drop `catalog` in the same change. That covers the Workflow progress count and the read models, which the implementation lists exhaustively.

**Not decided here:**
- the cleanup of abandoned seal objects;
- whether `seal_finalize` and `seal_queue` read `report` from the generation's `programme.json` instead, which would save about 1.5 MiB per step;
- dropping the `run.watchlist` copy in `sync.json` during the seal;
- the step count or budget of the seal;
- any OOM mechanism;
- the M5 consumer list itself, which belongs to ADR 0142 and AIR-480.

## Alternatives considered

- **A0, keep the single payload.** This is today's code. It parses 14.2 MiB in every seal step after the ledger.
- **A1, the single payload with selective optimisations.**
  - Reading the D1 catalog once halves `seal_catalog`'s D1 read volume and wall time, but the peak stays (63 to 64 MiB). The first read is garbage before the second is parsed.
  - A selective or streaming parse of the one object would still read and scan all 14.2 MiB, and it adds a field-skipping parser to a format that is retiring.
  - After M5 both are moot, because the phase goes away.
- **B, an R2 split with a manifest.** After `seal_catalog` it is close to D: 31 MiB in publish, 15 in finalize. But it keeps a 10.7 MiB R2 copy of a D1-owned domain and a phase that after M5 can only write stale data. It also adds a manifest and four objects to retain. Not chosen.
- **C, interim: stage a compact availability input and apply it to the live D1 rows.** It measures 40 MiB in `seal_catalog`, 31 in `seal_publish` and 18 in finalize and queue. It also fixes today's overwrite of concurrent changes ("the live row wins").
  - Under the owner's order, M5 lands first. C's `availability.json`, its etag, its equivalence with today's merge and its semantic change would be built only to be removed.
  - Its only advantage over D is that it could ship before M5, and that is not the chosen order.
  - Not chosen. It stays recorded in case the owner later wants the memory gain before M5.
- **C+ (or D+), pre-staging the publication rows in `published_epg_stage`.** It lowers `seal_publish` to 18 MiB by moving the stage work (2,064 statements, 2.3 MiB) to an earlier step. That step's own peak would be about today's `pointer` unit. Its costs:
  - the claim TTL (15 minutes, at most 60) would have to outlive `seal_ledger`;
  - a rescan of the same run would meet a validated stage with a different `payload_sha256` (`published_epg_conflict`), and a reset path would be needed;
  - every abandoned run would leave validated stage rows behind.

  Not chosen now; it can be reconsidered with measurements after D.
- **One D1 BLOB or JSON document replacing the payload.** Excluded by the card, and it would move the same parse to a D1 read.
- **Deriving the availability from the generation ledger (C only).** Not equivalent: the ledger merges the earlier generation's candidates (`mergeDiscoveryCandidates`), while `replaceCatalogAvailability` takes only this scan's observations.
- **Reusing the rejected ADR 0144 Part B.** Not reused. This record is derived from the measurements above.

## Consequences

- **Memory.** Measured in Node (via C's identical object), `seal_publish` drops from 44-46 to 31 MiB, and `seal_finalize` and `seal_queue` from 44 to 18. The 63 MiB `seal_catalog` step disappears. Inferred: `seal_stage` serialises 3.6 MiB instead of 14.2 MiB.
- **D1.** No catalog reads or admission writes during the seal: per `seal_catalog` step that is 8-16 MiB of reads and the write batches. No new D1 table, migration or contention.
- **Semantics.** The EPG sync no longer writes the catalog during the seal. The stale-copy overwrite, empty `shows` and re-sent supersession described under *What M5 changes* are gone without a new rule. No live-row-wins merge is needed, because nothing is merged.
- **Smaller than C.** One object and one new etag field (`publicationEtag`), no availability format, no equivalence proof to maintain.
- **Restart and crash points.**
  - **Mid-write in `seal_stage`.** A crash before `sync.json` moves to `seal` leaves an object the next attempt rewrites under the same key, because the run rescans.
  - **Inside the seal.** A crash re-reads the same immutable, etag-checked object.
  - **`pointer`.** It moves exactly once (ADR 0096).
- **Cross-midnight.** The object is keyed by `runId`, not by date. A run adopted the next day (ADR 0144, `T35c`) reads the same object.
- **Compatibility.** Old code fails closed on a new run, and new code reads both layouts; the drain holdpoint is therefore a hard requirement. `epg-diagnostic-run.js` stages through the same function and follows automatically.
- **Dependency.** D cannot ship before M5. Until then the seal keeps today's memory profile.

## Recovery and migration boundary

- **No data change.** No D1 schema change, migration, flag, Task, Access or authority marker.
- **Rollback.** A code rollback at the drain holdpoint of decision 5 (all three checks) is enough. `layout: 2` objects left behind are inert, because old code never reads them.
- **Rollback is not reversed by M5.** Rolling back this record restores `seal_catalog` with whatever `main` then contains. After M5 that phase writes no availability.
- **Hard boundary.** A deploy or rollback with a run at `stage: seal`, a pending handoff claim or a live successor instance would let mixed-version code run that seal, or block it until the matching code returns. That is what the three checks of decision 5 protect. An unknown value fails closed.
- **No operation authorized.** This record authorizes no implementation, deployment or production operation. Each step below needs its own owner approval where the card process requires one.

### Staged rollout

1. **M5 on `main`.** AIR-480 delivers the ADR 0142 decision 13 code contract, verified in code as decision 0 requires, with its own deploy.
2. **Owner decision (accepted 2026-11-15).** D is the final layout; C+/D+ are deferred, and abandoned-object cleanup remains a separate undecided item. Acceptance of this design does not waive the M5 code prerequisite.
3. **Offline implementation PR.** It contains decisions 1-7 and the legacy reader. The closed set of `epg_memory_boundary` names drops `seal_catalog_payload` and `seal_catalog_merge` in the reference. Tests:
   - old code failing closed on a `layout: 2` run;
   - a `publicationEtag` mismatch or a missing `publication.json` failing closed without writing, while `run.seal.etag` (ledger) stays unchanged and is still checked; both etags are validated independently;
   - a crash at every write point of `seal_stage`, including the boundary between the `publication.json` write and the `sync.json` checkpoint;
   - `ledger` → `publish` with no `catalog` phase;
   - a legacy run in each seal phase;
   - after M5, no catalog Film loses its slot availability through a D seal;
   - next-day adoption by the successor instance;
   - deletion at completion;
   - the three-condition drain gate of decision 5, each condition failing alone and an unknown value, before a mixed-version deploy or rollback.

   The benchmark stays as the regression measure. The same PR updates the architecture seal diagram, `docs/reference/orchestration-reliability.md` and the deployment runbook holdpoint.
4. **Deploy at the drain holdpoint of decision 5.** All three read-only checks must hold. Acceptance on a natural run:
   - `seal_payload_text` bytes fall from about 14.9 M to about 3.6 M characters;
   - no `seal_catalog` phase appears;
   - the seal completes;
   - the published generation matches today's shape.

   Until that run, the card waits in `Верификация`.
5. **Retire the legacy reader** after one natural run completed on `layout: 2`, with no `layout`-less run at `stage: seal`.
6. **Separate later decision:** the cleanup of abandoned seal objects.

## Evidence

- **Original decision:** Accepted as DESIGN on 2026-11-15 by the Product Owner (recorded in [AIR-485](https://trello.com/c/qulgP9a8)), after [review PASS](https://github.com/vladimino/iptv-watchlist/pull/638#pullrequestreview-5907764074); owner sequencing on [PR #638](https://github.com/vladimino/iptv-watchlist/pull/638#issuecomment-6885539218). Implementation and production actions are not authorized by this acceptance alone.
- **Implementation:** none.
- **Dated verification:** [offline comparison, 14 November 2026](../evidence/orchestration/air-485-seal-staging-comparison-2026-11-14.md) (`scripts/epg-seal-staging-bench.mjs`, `origin/main` `f5c57498`). The seal steps it measures are unchanged at `00d3f162`.
- **Uncertainty:**
  - Node heap is not workerd isolate accounting.
  - No production payload size or seal step count was read.
  - That the post-M5 `seal_catalog` has nothing of its own to write is a code reading of the ADR 0142 contract, not a measurement of the delivered M5 code.
  - The peak of a pre-staging step was not measured.
  - No OOM mechanism is established.

## Follow-ups

- The implementation card after M5 and the owner decision.
- The cleanup of abandoned seal objects.
