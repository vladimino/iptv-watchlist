# ADR 0142: Only the EPG sync moves the programme generation; Discovery assigns a Film to one addressed broadcast slot of the pinned run

**Status:** **Proposed** (2026-11-14; the product direction is the owner's, the mechanism below is a proposal that the owner has not yet accepted)
**Original decision date:** 2026-11-14 (owner product directive; mechanism not yet decided)
**Recorded at:** 2026-11-14
**Approval source:** Owner product directive of 14 November 2026 (Europe/Madrid) recorded on [AIR-479](https://trello.com/c/KLilv4Pc): the programme is one ordered set of broadcast elements, Discovery turns one element into a Film in place, and only the EPG sync controls the programme generation. The directive fixes the target contract. It does NOT accept the mechanism of this record and does NOT authorize code, a merge without review, a D1 or R2 change, a schema change, a Task, a cron, a manual EPG or Discovery run, a flag, a cutover or a rollback.
**Related work:** [AIR-479](https://trello.com/c/KLilv4Pc), implementation follow-up [AIR-480](https://trello.com/c/ZS0Xdrlq), [AIR-374](https://trello.com/c/ha7ais3w), [PR #618](https://github.com/vladimino/iptv-watchlist/pull/618) (ADR 0141 draft, Proposed, not merged), [ADR 0079](0079-d1-authoritative-published-epg.md), [ADR 0085](0085-d1-authoritative-discovery.md), [ADR 0128](0128-epg-canonical-producer-durable-execution.md), [ADR 0135](0135-epg-priority-discovery-pause.md), [ADR 0140](0140-producer-workflow-adaptive-successor-chain.md)
**Supersedes:** None. It qualifies one sentence of [ADR 0079](0079-d1-authoritative-published-epg.md) decision 4 and the reading of the generation in [ADR 0128](0128-epg-canonical-producer-durable-execution.md) decision 11 and [ADR 0140](0140-producer-workflow-adaptive-successor-chain.md) decision 7 (section "Revised invariants"). Those records are not edited. The qualifications take effect only when this record is accepted AND its implementation is delivered and accepted
**Superseded by:** None

## Context

**Owner directive (target, not the present state).** The programme is one ordered set of broadcast elements. Each element is either a broadcast or a Film with a showing. When Discovery recognises a broadcast, that element becomes a Film in the same place; no other element and no programme version changes. Only the EPG sync publishes a programme generation. Consumers and migrations adapt to this, not the reverse.

**What exists on `main` (commit `3c01e23f`, read from code).** There is no single list. The retained EPG scope of one run lives in three stores:

| Part | Store | Written by |
| --- | --- | --- |
| Watchlist Film with the showings the scan matched (window from 72 hours back to 7 days ahead) | Programme document in `published_epg_document`: every watchlist Film in watchlist order, each with `shows`. The same facts as `published_epg_member` and `published_epg_show` rows | EPG sync publish commit (`commitPublish`) |
| Broadcast the scan could not match to exactly one watchlist Film (55 to 300 minutes, from 72 hours back to 24 hours ahead) | `discovery_observation` and `discovery_observation_show`, active rows of the run, grouped by `normalizedTitle\|year` | EPG sync ledger seal |
| Catalog Film (not on the watchlist) with showings | `discovery_admission.payload_json.shows` | EPG sync (`replaceCatalogAvailability`) and Discovery (`upsertAdmissions`) |

Broadcasts that the scan screens as non-film, that are shorter than 55 or longer than 300 minutes, that are on `XX:` channels or that fall outside the window are not retained anywhere (`scanEPG`, `src/sources.js:257` to `281`).

1. **A slot already has a de facto address.** Every stored showing carries `channelId` and `start`. `dedupeShows` keys on them, `published_epg_show` has them in its primary key, and `discovery_observation_show` stores them per row. Within one run the scan puts a slot either under exactly one Film or under exactly one observation, never both.
2. **Discovery republishes the programme to attach one showing.** When a verified candidate is a Film already on the watchlist, `attachWatchlistShowing` (`src/discovery.js:605` to `636`, called at `820` and `978`) loads the whole programme document, changes one Film (`shows`, `aliases`, `hotEnteredAt`, `showsProgrammeRunId`, `epgLastAiring`) and calls `PublishedEpg.patchProgramme`. `commitReplace` (`src/published-epg.js:318` to `343`) then deletes and rewrites the programme document, all `programme` members and ALL show rows of the run, and sets `generation = generation + 1`. The R2 `programme.json` mirror and the generation copy are written as well (`src/published-epg.js:447` to `448`). Every attach is one new published generation.
3. **Discovery does not move the generation for a catalog Film.** For a Film that is not on the watchlist the chunk writes `discovery_admission` and `discovery_decision`. These move only `discovery_authority.generation`.
4. **A stored decision is not re-applied to a watchlist Film.** `resolutionActionability` returns `false` for a `verified` decision, and the cheap pass (`src/discovery.js:694` to `715`) touches only catalog Films. The scan's title index comes from the Letterboxd metadata, not from the aliases the attach wrote. So after the next EPG run the same broadcast is an observation again, and nothing puts it back on the watchlist Film.
5. **All programme readers use one read seam.** `/api/programme`, `/api/watchlist`, the catalog routes, the prediction queue, the Admin snapshot and the enrichment projector read the document through `PublishedEpg.readDocument`, `readDocumentAt` or `authoritativeSnapshot` (`src/worker.js:17` to `29`, `447`, `528`, `1786` to `1816`; `src/enrichment.js:1866`; `src/admin/read.js:232`; `src/d1-enrichment.js:190`). No runtime reader reads `published_epg_show`.
6. **The watchlist tail.** The EPG publish commit stores the watchlist with `updatedAt` equal to the programme's (`src/worker.js:1731`). `persistWatchlist` (`src/worker.js:711`) calls `saveWatchlist`, a second `generation + 1`, only when the stored `updatedAt` differs. By this code reading it writes nothing after a sealed D1 publication. This was not checked against production evidence.
7. **Producer input (dormant).** `planEpgUnits` (`src/canonical-epg-producer.js`) plans one `film_facts` unit per observed Film (`film`, `dimensions`, `localization`, `metadata`, `sync`, `watchlist`) and one release unit per departed member. Showings are not an input. The ADR 0141 draft labels a pass `P:g` and needs a pre-cutover gate (G-P) because "Discovery can increment `g` per attach".

## Decision

Terms. **Slot:** one retained broadcast element of one EPG run. **Sealed part:** the documents, members and show rows that the EPG sync published for a run. **Assigned row:** a `published_epg_show` row written by Discovery (`basis = 'discovery'`).

1. **Slot contract.** A slot is addressed by `(programme_run_id, channel_id, start_ms)`. Its coordinates (`channel_id`, `channel`, `start_ms`, `end_ms`, EPG title) are set by the scan and are never changed by anyone but a new EPG run. The order of the programme is `(start_ms, channel_id)`, derived from the coordinates, so no write can reorder it. A slot is a **Film** when a `published_epg_show` row exists for its address (provenance: `basis` is `title_year`, `title_unique` or `title_duration` for the scan, `discovery` for an assigned row), a **catalog Film** when its observation has a verified decision for a Film that is not a programme member, and a **broadcast** otherwise (provenance: the observation key). The single ordered list is this logical view over the existing tables. It is not a new stored object and no response shape changes.
2. **Ownership.** Only the EPG sync writes `published_epg_authority.programme_run_id`, `generation` and `watchlist_generation`, the documents, the members and the sealed show rows. Discovery owns decisions, admissions and assigned rows. After the implementation the only runtime statements that increment `generation` are the publish commits of the EPG sync. The owner-run activation and revert procedures of ADR 0079 are unchanged.
3. **Addressed write.** When a verified decision names a Film that is a `programme` member of the pinned run `P`, Discovery inserts one assigned row per slot of that observation. Each insert is one statement that writes only if all of the following hold in the same statement: the published authority is `d1` / `open` and still points at `P`; the Film is a `programme` member of `P`; the slot is an active observation slot of `P`; no row of any Film exists for that slot (the compare-and-set). The batch is a Discovery write: it runs under the Discovery lease with the Discovery fence, so it advances `discovery_authority.generation` like every Discovery write and it never advances the published generation. Illustration (AIR-480 fixes the exact statements):

   ```sql
   INSERT INTO published_epg_show
     (programme_run_id, film_id, channel_id, start_ms, end_ms, channel, epg_title, basis, match_reason)
   SELECT :P, :film, :channel_id, :start_ms, :end_ms, :channel, :epg_title, 'discovery', :observation_key
   WHERE EXISTS (SELECT 1 FROM published_epg_authority
                 WHERE id = 1 AND mode = 'd1' AND cutover = 'open' AND programme_run_id = :P)
     AND EXISTS (SELECT 1 FROM published_epg_member
                 WHERE programme_run_id = :P AND kind = 'programme' AND film_id = :film)
     AND EXISTS (SELECT 1 FROM discovery_observation o JOIN discovery_observation_show s
                   ON s.source_key = o.source_key AND s.observation_key = o.observation_key
                 WHERE o.source_key = 'active' AND o.programme_run_id = :P AND o.observation_key = :observation_key
                   AND s.channel_id = :channel_id AND s.start_ms = :start_ms)
     AND NOT EXISTS (SELECT 1 FROM published_epg_show
                     WHERE programme_run_id = :P AND channel_id = :channel_id AND start_ms = :start_ms);
   ```

   Discovery no longer calls `patchProgramme`, no longer writes the programme document, the members, the sealed rows, a Film field of the programme or an R2 programme object. A grouped observation with several showings writes one row per slot; each slot keeps its own coordinates and position.
4. **Reads.** The reader-facing read of the programme (`readDocumentAt`, `authoritativeSnapshot`, the Admin snapshot read and the mirror comparison of `repairMirrors`) returns the sealed document with each member Film's `shows` completed by the assigned rows of the same run, sorted by `(start, channelId)`, and `availableUntil` recomputed from the completed list. The assigned rows are read by one statement after the document, and the existing generation check before and after the read stays. Every current reader goes through this seam, so `/api/programme`, the catalog routes, the prediction queue and the projector need no change of their own. The raw sealed read stays for the publish, verification and revert paths. `/api/watchlist` is unchanged.
5. **Replay, concurrency and a stale writer.** Replaying an assignment inserts nothing (the slot already has a row). Two decisions for the same slot: the first commit wins, the second inserts nothing and reports `slot_taken`. A Discovery chunk that still holds an older run after a new EPG publication inserts nothing (`stale_run`); the published pointer guard is inside the statement, so no check-then-write window exists. An insert of zero rows is a counted outcome, not an error, and never reaches the EPG run.
6. **Wrong match and owner correction.** The decision stays the record of identity and stays Discovery-owned. When a decision that produced assigned rows changes (owner correction in `src/admin/discovery-recovery.js`, or a resolver change), the same fenced batch deletes the assigned rows of that observation for the pinned run (`basis = 'discovery'` and the observation key) and, if the new decision names a programme member, inserts the new rows. Discovery can delete only assigned rows; a sealed row is corrected only by the next EPG run. Coordinates do not change in either case.
7. **Unknown element and non-member Film.** A decision whose slot is not an active slot of the pinned run writes nothing (`slot_absent`). A decision for a Film that is not a programme member writes nothing to the published tables (`not_member`) and follows the existing catalog admission path, which already preserves slots and moves only the Discovery generation. In both cases the decision is kept.
8. **New EPG publication.** Assigned rows are keyed by run, so a new run starts with its sealed part only and old rows are never read through the new pointer. After Discovery pins the new run, its cheap pass re-applies stored verified decisions that name programme members to the slots of the new run, inside its existing per-chunk bounds and without a TMDB call. This closes the gap of Context item 4. [ADR 0135](0135-epg-priority-discovery-pause.md) is unchanged and sufficient: assigned rows are written only inside a Discovery chunk under the lease, so the EPG priority pause stops them, and they hold no EPG stage, claim or fence.
9. **Change signal for readers.** The published fence `d1:<generation>:<run>` identifies the sealed part only. A reader that caches, compares or labels programme CONTENT may claim "unchanged" only when the fence is equal AND either `discovery_authority.generation` is equal or a digest of the returned content is equal. The projector already re-checks the Discovery generation after its reads (`src/d1-enrichment.js:150`) and the Admin snapshot already compares a content digest (`src/admin/read.js:236`); AIR-480 proves by test that both still detect an assignment made during or between their reads once they read through decision 4. The Producer plan does not contain showings, so its label stays `P:g`.
10. **Watchlist tail.** One EPG sync produces one increment of `generation`. The watchlist is published by the publish commit; the tail must not make a second one. AIR-480 adds the test for this and removes the tail's write on the D1 path if the test shows it reachable.
11. **Not decided, not authorized.** No physical single-list table, no new endpoint, no migration, no flag, no scheduler, no Workflow. The R2-mode branch of `attachWatchlistShowing` (authority not `d1`) is outside this record. Nothing here runs in production.

### Data and contracts, before and after

| Event: Discovery verifies broadcast `O` as watchlist Film `F` in run `P`, generation `g` | Before (main) | After (this record) |
| --- | --- | --- |
| `published_epg_authority` | `generation = g + 1` | unchanged (`g`, `P`) |
| `published_epg_document` (programme), `published_epg_member`, `published_epg_generation.payload_sha256` | deleted and rewritten for the whole run | unchanged |
| `published_epg_show` | all rows of `P` deleted and re-inserted, plus the new showings | one inserted row per slot of `O`, `basis = 'discovery'` |
| R2 `programme.json` mirror and generation copy | written by Discovery in the same call | written only by the hourly EPG reconcile (`repairMirrors`), up to about one hour later |
| `discovery_decision`, `discovery_authority.generation` | decision written, Discovery generation advanced | the same |
| `GET /api/programme`, Film `F` | `shows` include the slots of `O` | the same `shows`; fence unchanged |
| After the next EPG run `P'` | the slots of `O` are broadcasts again and stay so | the cheap pass assigns them again in `P'` |

### Affected writers and readers

| Code | Change |
| --- | --- |
| `src/discovery.js` `attachWatchlistShowing` (D1 branch) and its call sites at `820` and `978` | replaced by the addressed write of decision 3 |
| `src/discovery.js` cheap pass (`694` to `715`) | re-applies stored verified decisions for programme members (decision 8) |
| `src/published-epg.js` | new addressed insert and delete; completed read (decision 4); `patchProgramme` loses its only caller and is removed |
| `src/admin/discovery-recovery.js` owner identity correction | removes the assigned rows of the corrected observation in its fenced batch (decision 6) |
| `src/worker.js` `persistWatchlist` | test of decision 10; write removed on the D1 path if reachable |
| `src/worker.js` `loadJSON`, `/api/programme`, catalog routes; `src/enrichment.js:1866`; `src/admin/read.js:232`; `src/d1-enrichment.js` | no own change; they read the completed view through the seam |
| EPG sync (`commitPublish`, seal steps), `EpgOrchestration.ensure`, `DiscoveryAuthority.writeDecisionDelta`, `upsertAdmissions`, `/api/watchlist` | unchanged |

### Deterministic acceptance examples

Setup: run `P1`, `generation = 41`; programme members `F1`, `F2`, `F3`; sealed row `(P1, F2, ch7, T1, title_year)`; active observation `O` of `P1` with slots `(ch3, T2)` and `(ch9, T3)`, `T1 < T2 < T3`.

1. **Assign.** Discovery verifies `O` as `F1`. Result: rows `(P1, F1, ch3, T2, discovery)` and `(P1, F1, ch9, T3, discovery)`; `generation = 41`, `programme_run_id = P1`, `watchlist_generation`, the documents, the members and `payload_sha256` are byte-identical; the read returns `F1.shows = [(ch3, T2), (ch9, T3)]` and `F2.shows = [(ch7, T1)]`; the slot order `T1, T2, T3` is the same before and after.
2. **Replay.** The same write again changes zero rows and the read is identical.
3. **Stale run.** The EPG sync publishes `P2` (`generation = 42`) before the write. The write changes zero rows (`stale_run`); no row of `P2` exists for `O`; `generation` stays 42.
4. **Re-application.** `O` is active in `P2` with slot `(ch3, T4)`; the stored decision is `verified` for `F1`. The next Discovery chunk that pins `P2` inserts `(P2, F1, ch3, T4, discovery)` with no TMDB call; `generation` stays 42.
5. **Slot taken.** A second decision names `F3` for `(ch3, T2)` after example 1. Zero rows change (`slot_taken`); `F1` keeps the slot.
6. **Non-member.** `O` is verified as a Film that is not on the watchlist. No published table changes; the admission and the decision are written as today.
7. **Owner correction.** The owner corrects `O` from `F1` to `F3`. One batch deletes the two rows of example 1 and inserts `(P1, F3, ch3, T2, discovery)` and `(P1, F3, ch9, T3, discovery)`; coordinates and order are the same; `generation = 41`. A correction to "not a film" only deletes; both slots are broadcasts again.
8. **Change signal.** Before and after example 1 the fence is `d1:41:P1`; `discovery_authority.generation` and the content digest differ. A reader that reports "unchanged" from the fence alone fails the test.
9. **EPG priority.** During the pause of ADR 0135 no assigned row is written. At the store level, an assigned-row insert between the read of the fence and `commitPublish` leaves that commit's compare-and-set valid: the fence is still `d1:41:P1`.
10. **One increment per sync.** One EPG sync with a changed watchlist moves `generation` by exactly 1.

### Shortest implementation (estimate for AIR-480)

Existing D1 tables and code only: no migration, no index, no flag, no second publish pipeline, no shared snapshot, no continuous sync, no scheduler, no overlay store. `published_epg_show` already has every needed column (`basis` and `match_reason` are free text; no reader interprets `match_reason`), and its existing index `(programme_run_id, start_ms)` serves the slot check and the read. The change is confined to the files of the table above plus tests for the ten examples. The architecture and reference pages that describe the attach ([EPG and availability](../architecture/epg-and-availability.md), [discovery and resolution](../architecture/discovery-and-resolution.md), [persistence](../architecture/persistence-and-migration.md), the [D1 schema reference](../reference/data/d1-schema.md)) change in the implementation PR, not here, because no flow changes until then.

### Revised invariants

- **[ADR 0079](0079-d1-authoritative-published-epg.md) decision 4**, "A programme patch records the generation it read and commits only that generation; success is that generation plus one": qualified. Discovery makes no programme patch. Decision 1, "Show rows are the availability facts", becomes literally true for assigned rows. Decision 5 (D1 is the published generation for every reader) is kept and is how decision 4 of this record reaches the readers.
- **[ADR 0128](0128-epg-canonical-producer-durable-execution.md) decision 11 and [ADR 0140](0140-producer-workflow-adaptive-successor-chain.md) decision 7**: unchanged in text. The fact they rest on changes: the published generation moves only at an EPG sync, so a completed pass can become `lagging` only because of a new EPG publication, and the Producer yields to Discovery only for D1 contention, not because Discovery moves its input.
- **ADR 0141 draft ([PR #618](https://github.com/vladimino/iptv-watchlist/pull/618), head `9b770734`), G-P and T-4**: the draft's premise that a same-`P` Discovery `commitReplace(programme)` increments `g` per attach, and the watchlist `commitReplace` after a sync, stop being true once AIR-480 is delivered and accepted. Whether G-P is then narrowed or dropped, and how T-4 is decided, belongs to AIR-374 and that pull request. This record does not edit the draft, and AIR-374 resumes only after the mechanism is implemented and accepted, not on this text.

### Material choices for the owner

| # | Choice | Recommendation |
| --- | --- | --- |
| M1 | Where the assigned identity lives | Assigned rows in the existing `published_epg_show` (this record). Alternatives below |
| M2 | Who puts a known broadcast back on its Film after a new EPG run | Discovery's cheap pass (decision 8). The alternative, the EPG commit reading Discovery decisions, makes the publication depend on Discovery |
| M3 | Catalog Films (not on the watchlist) | Keep the existing admission path; it already satisfies the directive |
| M4 | R2 compatibility mirrors | Follow through the existing hourly reconcile (lag up to about one hour); Discovery writes no R2 programme object |
| M5 | Film fields the attach wrote into the programme (`aliases`, `hotEnteredAt`, `showsProgrammeRunId`, `epgLastAiring`) | No longer written. `shows` and `availableUntil` are derived at read. AIR-480 lists every consumer before removal; the one found here is `hotEnteredAt` as a late tie-breaker of the prediction queue order (`src/enrichment.js:1526`) |

## Alternatives considered

- **Derive at read, write nothing** (join `discovery_decision`, active `discovery_observation` and `discovery_observation_show` on every programme read). No write at all, but every programme read crosses into the Discovery authority, the active rows move to the new run before the published pointer does during the daily seal, and `discovery_decision` has no index for the lookup. Not recommended.
- **A physical slot table for every retained broadcast.** It would store the single list literally. It needs a migration, a second copy of the observation slots and a change of the EPG publish commit. Not the shortest path and not needed for the contract.
- **Keep the generation increment and make consumers tolerate it** (the G-P route of the ADR 0141 draft). Excluded by the owner directive.
- **Teach the scan the Discovery aliases** so that the EPG sync itself seals the showing. It changes title matching quality and scope; it is a possible later step and does not remove the need for an in-run assignment.

## Consequences

- One Discovery attach costs a few small inserts instead of a rewrite of the document, the members and every show row plus two R2 writes, and it can no longer change the published fence that an EPG publication captured or the `P:g` label of a Producer pass.
- A programme read costs one more indexed statement over the show rows of the run. The E6 measurement of 12 November 2026 saw 971 to 1,951 show rows per generation. The added latency is not measured.
- The sealed document no longer contains every showing a reader sees. Anything that reads the raw document (revert, verification, an R2 mirror not yet reconciled) sees the sealed part only.
- `published_epg_show` gets a second writer. The boundary is the `basis` value and the insert guards; a test must prove Discovery cannot change a sealed row.
- `basis = 'discovery'` and the observation key in `match_reason` reuse existing columns. This avoids a schema change at the cost of a convention that the reference page must state.
- A recognised broadcast is a broadcast again for the first Discovery chunks after each EPG run, until the cheap pass reaches it. Today it stays a broadcast for the whole run.

## Recovery and migration boundary

This record changes no code and no data. The implementation needs no migration and adds rows only to an existing table; a code rollback leaves assigned rows that the older code never reads through its runtime paths and deletes at its next programme patch of that run, and the next EPG run starts without them. Programme documents already patched by the present attach stay valid as sealed parts of their runs. An authority revert of the published EPG keeps its own fenced, owner-approved procedure and exports the sealed part only. Acceptance of this record, the implementation PR, its deployment and any production observation are separate steps with their own approvals.

## Evidence

- **Original decision:** owner directive on [AIR-479](https://trello.com/c/KLilv4Pc), 14 November 2026.
- **Implementation:** none. Follow-up [AIR-480](https://trello.com/c/ZS0Xdrlq).
- **Dated verification:** code reading of `main` at `3c01e23f` on 2026-11-14 (files and lines cited above); row counts from the [E6 production measurement](../evidence/d1-migration/air-374-e6-production-measurement-2026-11-12.md). No production read or write was made for this record.
- **Uncertainty:** how often Discovery attaches in production is not measured; the no-op of the watchlist tail is a code reading; the cost of the completed read and of the re-application per chunk is not measured; the consumers of the Film fields of M5 are not fully enumerated; the legacy whole-ledger chunk (`src/discovery.js:978`) is assumed to be replaced the same way as the paged one.

## Follow-ups

- [AIR-480](https://trello.com/c/ZS0Xdrlq): minimal implementation, tests for the ten examples, reference and architecture pages.
- [AIR-374](https://trello.com/c/ha7ais3w) and [PR #618](https://github.com/vladimino/iptv-watchlist/pull/618): G-P and T-4 after the mechanism is implemented and accepted.
