# ADR 0145: The EPG seal stages no catalog; `seal_catalog` applies the scan's availability to the live D1 rows

**Status:** Proposed (2026-11-14; awaiting the owner's design decision; no implementation, deployment or production operation authorized)
**Original decision date:** not decided
**Recorded at:** 2026-11-14
**Approval source:** not documented (design gate of [AIR-485](https://trello.com/c/qulgP9a8))
**Related work:**
- [AIR-485](https://trello.com/c/qulgP9a8), with [offline comparison evidence](../evidence/orchestration/air-485-seal-staging-comparison-2026-11-14.md).
- [AIR-460](https://trello.com/c/ZXySuCJk) and [AIR-462](https://trello.com/c/w73gROBl) (seal OOM investigation).
- [AIR-484](https://trello.com/c/CDvqIdUn) (implements ADR 0144).
- [AIR-480](https://trello.com/c/ZS0Xdrlq) (implements ADR 0142).
- ADRs: [ADR 0079](0079-d1-authoritative-published-epg.md), [ADR 0092](0092-resumable-bounded-ledger-seal.md), [ADR 0096](0096-bounded-seal-publication-steps.md), [ADR 0099](0099-canonical-film-person-d1-authority.md), [ADR 0140](0140-producer-workflow-adaptive-successor-chain.md), [ADR 0142](0142-epg-owned-generation-addressed-discovery-slots.md), [ADR 0144](0144-epg-seal-successor-workflow-instance.md).

**Supersedes:** None. ADR 0144 keeps the staged payload unchanged and leaves its format to this record; nothing in ADR 0092, 0096 or 0144 is edited.
**Superseded by:** None

## Context

### The staged payload today

`stageSealedGeneration` (`src/worker.js`) is the last part of `epg_commit`. It streams the generation ledger to R2, then writes one object, `epg/seal/<runId>/payload.json`, with six fields: `report`, `catalog`, `watchlist`, `uncertain`, `fence` and `expectedProgrammeRunId`. It then saves `sync.json` at `stage: seal`. Every later seal step (ADR 0092, 0096) parses that whole object:

- **`seal_catalog`** reads `catalog` only. It reads the D1 catalog twice per step: once as the merge base, once as the diff base.
- **`seal_publish`, `seal_finalize` and `seal_queue`** drop `catalog` right after the parse.
- **`seal_queue`** deletes the object when the run completes. An abandoned run's object is never deleted.

At the volumes of 13-14 November the object is 14.2-14.9 MiB, of which the catalog is about 10.7 MiB. Parsing it adds 58 MiB of RSS in workerd ([stream measurements](../evidence/orchestration/air-460-seal-stream-workerd-2026-11-14.md)).

The catalog it carries is a copy of a domain D1 owns. In D1 mode, `epg/discovered-films.json` is routed to `discovery_admission`. The copy is `replaceCatalogAvailability(scan-time catalog, scan observations)`, which writes `shows`, `epgLastAiring` and `showsProgrammeRunId` into every Film with a `tmdbId`. So all 9,226 admissions change in every run ([M3 step metrics](../evidence/d1-migration/air-374-m3-epg-step-metrics-2026-11-13.md)).

### Producers, readers and authority

| Data | Produced by | Read by | Authority and lifetime |
| --- | --- | --- | --- |
| `report` (the programme) | `epgSync` scan | The `pointer` unit (generation `programme.json`, D1 stage rows through `PublishedEpg.publishGeneration`), `mirrors` (`programme.json` mirror), `finalize` (`persistWatchlist`, `persistScan`, `persistEvents`), `queue` (`refreshPredictionQueue`, `prepareEpgCompletion`) | After the pointer, the D1 `published_epg_document`, `_member` and `_show` rows are authoritative (ADR 0079). The staged copy is run-scoped input. |
| `catalog` | `replaceCatalogAvailability` over the catalog read at scan time | `seal_catalog` only | D1 `discovery_admission` is authoritative (ADR 0085). The staged copy is a stale duplicate of D1 plus the scan's availability. |
| `watchlist` | `epgSync` (`{updatedAt, films: run.watchlist}`) | The `pointer` (D1 watchlist document), `mirrors` (`watchlist.json`), the `intent` fallback | D1 after the pointer. The same Film list also rides in `sync.json` as `run.watchlist`. |
| `uncertain` | The scan | The `intent` unit (`uncertain.json`) | R2 `uncertain.json`; small |
| `fence`, `expectedProgrammeRunId` | `PublishedEpg.currentGeneration` at `seal_stage` | The `pointer` unit (CAS of the published pointer) | The D1 `published_epg_authority` row; the staged values are the expected state |
| Generation ledger `epg/generations/<runId>/discovery-latest.json` | `seal_stage` (streamed, known length; etag kept in `run.seal`) | `seal_ledger` (range reads, etag-checked) → D1 ledger tables; `copy` → `epg/discovery-latest.json` mirror | The R2 object is an immutable run input. The D1 ledger is authoritative after the seal, and `epg/discovery-latest.json` is a mirror. |
| `sync.json` | Every EPG step | Every action, about three reads and at least one write | The R2 run checkpoint. It carries `run.seal` (phase, units, ledger key and etag). |
| `epg/seal/<runId>/payload.json` | `seal_stage`; also `epg-diagnostic-run.js` through the same function | The seal steps after `seal_ledger` | An immutable run-scoped R2 input, deleted at completion |

### Measured

All figures are V8 heap in Node from the [offline comparison](../evidence/orchestration/air-485-seal-staging-comparison-2026-11-14.md), with a 8.9 MiB baseline. They rank layouts; they are not workerd isolate headroom.

| Step | A0 `main` | A1 one D1 read | B R2 split | C this record | C+ D1 pre-staged |
| --- | --- | --- | --- | --- | --- |
| `seal_catalog` | 63 | 64 | 55 | **40** | 40 |
| `seal_publish` | 44-46 | 44-46 | 31 | **31** | 18 |
| `seal_finalize` / `seal_queue` | 44 | 44 | 15 | **18** | 18 |

The traffic changes in the same direction:

- **`seal_catalog`, D1 reads:** 16 MiB in A0, 8 MiB in A1, B and C.
- **`seal_catalog`, R2 read:** 14.2 MiB in A0 and A1, 10.7 in B, 0.8 in C.
- **Each later step, R2 read:** 14.2 MiB in A0 against 3.6 in C.

D1 writes are equal in all layouts. C+ moves 2,064 statements and 2.3 MiB of D1 writes out of `seal_publish`, into a step whose peak was not measured.

**Not addressed by any layout.** The 14 November OOMs were in `seal_ledger` and at `seal_publish_copy` ([AIR-462 correlation](../evidence/orchestration/air-462-epg-oom-natural-run-2026-11-14.md)). `seal_ledger` reads no payload. During the copy, `report` and `watchlist` are resident in every layout. This record lowers the parse peaks and the garbage of the steps after the ledger seal, and the bytes `seal_stage` serialises. It is **not** claimed as an OOM fix.

## Decision (proposed)

1. **No catalog in the staged publication.** `seal_stage` writes two run-keyed objects instead of `payload.json`:
   - `epg/seal/<runId>/publication.json` with `runId`, `report`, `watchlist`, `uncertain`, `fence` and `expectedProgrammeRunId`. The fields keep today's meaning.
   - `epg/seal/<runId>/availability.json`, the scan's confirmed availability: the `[{confirmedTmdbId, shows}]` pairs that `replaceCatalogAvailability` consumes today, and nothing else.

   Both are written before `sync.json` moves to `stage: seal`. `run.seal` records `layout: 2` and both etags. Every read checks its etag, as `seal_ledger` does for the ledger, and fails closed on a missing or changed object. The catalog is not staged anywhere: not in R2, and not as a D1 BLOB or JSON document.
2. **`seal_catalog` applies the availability to the live rows.** It reads the D1 catalog once (`live`) and builds `next = replaceCatalogAvailability(live, availability, runId).catalog`. It writes the difference between `next` and `live` in today's bounded batches (`upsertAdmissions`, carried generation, lease) and is done when a step finds no difference. Two consequences:
   - **Equivalence.** With D1 unchanged since the scan, `next` equals today's merged catalog. The evidence asserts this.
   - **When D1 changed between the scan and the step, the live row wins.** An owner or Discovery edit to a Film's identity is kept. A Film superseded meanwhile is not written again. A Film admitted meanwhile gets the scan's availability when the scan confirmed its `tmdbId`. Today the staged scan-time Film overwrites the live identity fields, a newly admitted Film gets empty `shows`, and a Film superseded meanwhile is sent back to `upsertAdmissions`. Whether that last write is refused there was not checked.
3. **The later steps read only `publication.json`.** That covers `seal_publish` (`pointer`, `mirrors`, `copy`, `intent`), `seal_finalize` and `seal_queue`. The commit point is unchanged: the single fenced `PublishedEpg` batch that moves the pointer, inserts the generation and copies the staged rows. The units, their idempotence and the `fence` / `expectedProgrammeRunId` checks stay as in ADR 0096.
4. **Legacy reader.** A run whose `run.seal` has no `layout` was staged by today's code. It is finished from `payload.json` exactly as today, catalog included. That reader is removed only after the retirement condition in the rollout.
5. **Mixed versions fail closed; deploy and rollback at a drain holdpoint.**
   - **Old code on a `layout: 2` run** still runs `seal_ledger`, whose input is unchanged. It stops at the first step that reads `payload.json`: it finds no object and throws before that step writes anything. The step keeps its phase and the hourly `ensure` (ADR 0100, 0144) retries.
   - **No dual write.** No layout writes both forms, because that would bring back the bytes this record removes.
   - **Holdpoint.** A deploy that introduces or removes `layout: 2`, and its rollback, therefore happens only when a read-only EPG status shows no run at `stage: seal`. This is the same discipline as ADR 0144. The two implementations (this one and ADR 0144's) are deployed separately, each at its own holdpoint.
6. **Retention.** At completion `seal_queue` deletes every object of the run's seal prefix (`payload.json`, `publication.json`, `availability.json`), where today it deletes one. Objects of abandoned runs already accumulate today. Removing them needs a new R2 delete writer and is **not** decided here.
7. **Interim by design.** ADR 0142 decision 13 (Accepted) removes the availability fields from the Films, after the consumer list of its implementation. When that cleanup lands, the `availability.json` input and the availability work of `seal_catalog` go with it. The EPG sync then has nothing left to write into the catalog, and `seal_catalog` has no work. This record therefore adds no catalog format that would outlive that cleanup.
8. **Relation to ADR 0144.** The successor instance finishes the seal from the run-keyed objects and `run.seal`, both of which are durable in R2. The hand-off is unchanged. ADR 0144's "the staged payload is unchanged" stays true until this record is accepted and delivered.

**Not decided here:**
- the cleanup of abandoned seal objects;
- whether `seal_finalize` and `seal_queue` read `report` from the generation's `programme.json` instead (it would save about 3 MiB);
- dropping the `run.watchlist` copy in `sync.json` during the seal;
- the step count or budget of the seal;
- any OOM mechanism.

## Alternatives considered

- **A0, keep the single payload.** This is today's code. It parses 14.2 MiB in every seal step after the ledger.
- **A1, the single payload with selective optimisations.** Reading the D1 catalog once halves the D1 read volume and the wall time of `seal_catalog`, but the peak stays (63 to 64 MiB). The first read is garbage before the second is parsed. It is kept, as part of decision 2. A selective or streaming parse of the one object would avoid materialising the catalog, but the step would still read and scan all 14.2 MiB, and it adds a field-skipping parser to a format that is retiring. Not chosen.
- **B, an R2 split with a manifest.** It is close to C after `seal_catalog`: 31 MiB in publish, 15 in finalize. But `seal_catalog` still parses a 10.7 MiB R2 copy of a D1-owned domain (55 MiB), with today's overwrite semantics. It also adds a manifest, its consistency checks and four objects to retain. Not chosen; it stays the fallback if the owner rejects the semantics of decision 2.
- **C+, C plus D1 pre-staging of the publication rows.** It lowers `seal_publish` to 18 MiB by moving the stage work (2,064 statements, 2.3 MiB) to an earlier step, whose own peak would be about today's `pointer` unit. Its costs:
  - The claim TTL (15 minutes, at most 60) would have to outlive `seal_ledger` and `seal_catalog`.
  - A rescan of the same run would meet a validated stage with a different `payload_sha256` (`published_epg_conflict`), and a reset path would be needed.
  - Every abandoned run would leave validated stage rows behind.

  Not chosen now. It can be reconsidered with measurements once this record is delivered.
- **One D1 BLOB or JSON document replacing the payload.** Excluded by the card, and it would move the same parse to a D1 read.
- **Deriving the availability from the generation ledger instead of staging it.** Not equivalent: the ledger merges the earlier generation's candidates (`mergeDiscoveryCandidates`), while `replaceCatalogAvailability` takes only this scan's observations.
- **Reusing the rejected ADR 0144 Part B.** Not reused. This record is derived from the measurements above.

## Consequences

- **Memory.** Measured in Node, `seal_catalog` drops from 63 to 40 MiB, `seal_publish` from 44-46 to 31, and `seal_finalize` and `seal_queue` from 44 to 18. Inferred: `seal_stage` serialises 4.4 MiB instead of 14.2 MiB.
- **D1.** `seal_catalog` reads 8 instead of 16 MiB per step. The admission writes are unchanged: the daily rewrite of all 9,226 Films stays until ADR 0142 decision 13. There is no new D1 table, migration or contention.
- **Semantics.** The live D1 row wins over the scan-time copy when the two differ (decision 2). This is a behaviour change. The owner accepts it as part of this record, or chooses B.
- **Restart and crash points.**
  - **Mid-write in `seal_stage`.** A crash before `sync.json` moves to `seal` leaves objects the next attempt rewrites under the same keys, because the run rescans.
  - **Inside the seal.** A crash re-reads the same immutable, etag-checked objects.
  - **`seal_catalog`.** It converges from what D1 holds, as today.
  - **`pointer`.** It moves exactly once (ADR 0096).
- **Cross-midnight.** The objects are keyed by `runId`, not by date. A run adopted the next day (ADR 0144, `T35c`) reads the same objects.
- **Compatibility.** Old code fails closed on a new run, and new code reads both layouts. This is why the drain holdpoint is a hard requirement. `epg-diagnostic-run.js` stages through the same function and follows automatically.
- **New complexity.** Two objects and two etags instead of one object. The legacy reader stays until it is retired.

## Recovery and migration boundary

- **No data change.** No D1 schema change, migration, flag, Task, Access or authority marker.
- **Rollback.** A code rollback at the drain holdpoint is enough. `layout: 2` objects left behind are inert; old code never reads them.
- **Hard boundary.** A deploy or rollback with a run at `stage: seal` would block that run until the matching code returns. That is the boundary that needs the holdpoint, read from the EPG status.
- **No operation authorized.** This record authorizes no implementation, deployment or production operation. Each step below needs its own owner approval where the card process requires one.

### Staged rollout

1. **Owner decision** on this record: C, or B instead; C+ deferred; abandoned-object cleanup left open.
2. **Offline implementation PR.** It contains decisions 1-6, the legacy reader, and new `epg_memory_boundary` names for the availability read, added to the closed set in the reference. Tests:
   - equivalence of C with today's merge when D1 is unchanged;
   - the live-row-wins semantics under a concurrent change;
   - old code failing closed on a `layout: 2` run;
   - a crash at every write point of `seal_stage`;
   - next-day adoption;
   - deletion at completion.

   The benchmark stays as the regression measure.
3. **Deploy at a drain holdpoint.** Acceptance on a natural run:
   - `seal_payload_text` bytes fall from about 14.9 M to about 3.6 M characters;
   - the seal completes;
   - the published generation matches today's shape.

   Until that run, the card waits in `Верификация`.
4. **Retire the legacy reader** after one natural run completed on `layout: 2` and no `layout`-less run is at `stage: seal`.
5. **Separate later decisions:** the cleanup of abandoned seal objects, and the removal of `availability.json` with ADR 0142 decision 13.

## Evidence

- **Original decision:** not decided (design gate on [AIR-485](https://trello.com/c/qulgP9a8))
- **Implementation:** none
- **Dated verification:** [offline comparison, 14 November 2026](../evidence/orchestration/air-485-seal-staging-comparison-2026-11-14.md) (`scripts/epg-seal-staging-bench.mjs`, `origin/main` `f5c57498`)
- **Uncertainty:**
  - Node heap is not workerd isolate accounting.
  - No production payload size, seal step count or concurrent-change frequency was read.
  - The live-row-wins analysis is a code reading.
  - The peak of a C+ staging step was not measured.
  - No OOM mechanism is established.

## Follow-ups

- The implementation card after the owner decision.
- The cleanup of abandoned seal objects.
- The `availability.json` removal under the ADR 0142 decision 13 cleanup.
