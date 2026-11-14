# ADR 0142: Only the EPG sync moves the programme generation; Discovery assigns a Film to one addressed broadcast slot of the pinned run

**Status:** **Proposed** (2026-11-14; the product direction is the owner's, the mechanism below is a proposal that the owner has not yet accepted; amended after the independent review of head `bc89f9bb`)
**Original decision date:** 2026-11-14 (owner product directive; mechanism not yet decided)
**Recorded at:** 2026-11-14
**Approval source:** Owner product directive of 14 November 2026 (Europe/Madrid) recorded on [AIR-479](https://trello.com/c/KLilv4Pc): the programme is one ordered set of broadcast elements, Discovery turns one element into a Film in place, and only the EPG sync controls the programme generation. The directive fixes the target contract. It does NOT accept the mechanism of this record and does NOT authorize code, a merge without review, a D1 or R2 change, a schema change, a Task, a cron, a manual EPG or Discovery run, a flag, a cutover or a rollback.
**Related work:** [AIR-479](https://trello.com/c/KLilv4Pc), implementation follow-up [AIR-480](https://trello.com/c/ZS0Xdrlq), [AIR-374](https://trello.com/c/ha7ais3w), [PR #618](https://github.com/vladimino/iptv-watchlist/pull/618) (ADR 0141 draft, Proposed, not merged), [independent review of PR #622](https://github.com/vladimino/iptv-watchlist/pull/622#issuecomment-6879406073), [ADR 0079](0079-d1-authoritative-published-epg.md), [ADR 0085](0085-d1-authoritative-discovery.md), [ADR 0128](0128-epg-canonical-producer-durable-execution.md), [ADR 0135](0135-epg-priority-discovery-pause.md), [ADR 0140](0140-producer-workflow-adaptive-successor-chain.md)
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

1. **A slot has a de facto address, but nothing makes it unique.** Every stored showing carries `channelId` and `start`. `dedupeShows` keys on them per Film and `discovery_observation_show` stores them per row. The primary key of `published_epg_show` is `(programme_run_id, film_id, channel_id, start_ms)`, so it allows two Films on one slot. The scan does not check the slot across owners: two feed elements with the same channel and start but different titles are retained under two Films, two observations, or a Film and an observation.
2. **Discovery republishes the programme to attach one showing.** When a verified candidate is a Film already on the watchlist, `attachWatchlistShowing` (`src/discovery.js:605` to `636`, called at `820` and `978`) loads the whole programme document, changes one Film (`shows`, `aliases`, `hotEnteredAt`, `showsProgrammeRunId`, `epgLastAiring`) and calls `PublishedEpg.patchProgramme`. `commitReplace` (`src/published-epg.js:318` to `343`) then deletes and rewrites the programme document, all `programme` members and ALL show rows of the run, and sets `generation = generation + 1`. The R2 `programme.json` mirror and the generation copy are written as well (`src/published-epg.js:447` to `448`). Every attach is one new published generation.
3. **The attach is not tied to the committed decision.** The paged resolver attaches the showing (`src/discovery.js:820`) BEFORE it writes the decision (`saveCandidate`, called at `831`, writing at `784`). `writeDecisionDelta` can skip that decision (`conflict`, `observation_gone`, `evidence_changed`), and the attached showing stays. An owner correction (`DiscoveryAuthority.ownerDecision`, `commitOwnerWrite`) changes only the decision.
4. **The decision and the programme use different Film ids.** A programme member carries its watchlist id and a `tmdbId`. A decision carries `tmdb_id` and a `film_id` that is the watchlist id only when the resolver found the Film on the watchlist; an owner assignment always stores `tmdb_<id>`. The link between them is the TMDB id (`knownTmdb`, `src/discovery.js:680`).
5. **Discovery does not move the generation for a catalog Film.** For a Film that is not on the watchlist the chunk writes `discovery_admission` and `discovery_decision`. These move only `discovery_authority.generation`.
6. **A stored decision is not re-applied to a watchlist Film.** `resolutionActionability` returns `false` for a `verified` decision, and the cheap pass (`src/discovery.js:694` to `715`) touches only catalog Films, without comparing evidence. The scan's title index comes from the Letterboxd metadata, not from the aliases the attach wrote. So after the next EPG run the same broadcast is an observation again, and nothing puts it back on the watchlist Film.
7. **All programme readers use one read seam, and so do the mirrors and the revert.** `/api/programme`, `/api/watchlist`, the catalog routes, the prediction queue, the Admin snapshot and the enrichment projector read the document through `PublishedEpg.readDocument`, `readDocumentAt` or `authoritativeSnapshot` (`src/worker.js:17` to `29`, `447`, `528`, `1786` to `1816`; `src/enrichment.js:1866`; `src/admin/read.js:232`; `src/d1-enrichment.js:190`). `repairMirrors` compares the R2 mirrors with `readDocument`, and `revertPublished` calls `repairMirrors` and then compares the mirror with `readDocument` again (`src/published-epg.js:520` to `540`, `666` to `692`). No runtime reader reads `published_epg_show`.
8. **The watchlist tail.** The EPG publish commit stores the watchlist with `updatedAt` equal to the programme's (`src/worker.js:1731`). `persistWatchlist` (`src/worker.js:711`) calls `saveWatchlist`, a second `generation + 1`, only when the stored `updatedAt` differs. By this code reading it writes nothing after a sealed D1 publication. This was not checked against production evidence.
9. **Producer input (dormant).** `planEpgUnits` (`src/canonical-epg-producer.js`) plans one `film_facts` unit per observed Film (`film`, `dimensions`, `localization`, `metadata`, `sync`, `watchlist`) and one release unit per departed member. Showings are not an input. The ADR 0141 draft labels a pass `P:g` and needs a pre-cutover gate (G-P) because "Discovery can increment `g` per attach".

## Decision

Terms. **Slot:** one retained broadcast element of one EPG run. **Sealed part:** the documents, members and show rows that the EPG sync published for a run. **Assigned row:** a `published_epg_show` row written by Discovery (`basis = 'discovery'`, the observation key in `match_reason`). **Member:** a Film of the `programme` members of a run; its TMDB id comes from the sealed document of that run.

1. **Slot contract and uniqueness.** A slot is addressed by `(programme_run_id, channel_id, start_ms)`. Its coordinates (`channel_id`, `channel`, `start_ms`, `end_ms`, EPG title) are set by the scan and are never changed by anyone but a new EPG run. The order of the programme is `(start_ms, channel_id)`, derived from the coordinates, so no write can reorder it. A slot has at most ONE owner, enforced in two places and without an index:
   - **Scan (EPG sync).** `scanEPG` records the owner (one Film, or one observation key) of every `(channelId, start)` it retains. A second element with the same slot and the same owner is ignored. A slot claimed by two different owners is ambiguous: after the stream it is removed from every owner, is not retained, is counted in `stats` and is listed in `uncertain` with the reason `duplicate_slot`. So no sealed row and no active observation slot of a run shares its address with another owner.
   - **Assignment.** The insert of decision 3 writes only when no row of any Film holds the slot.

   A slot is a **Film** when a `published_epg_show` row exists for its address (provenance: `basis` is `title_year`, `title_unique` or `title_duration` for the scan, `discovery` for an assigned row), a **catalog Film** when its observation has a verified decision whose TMDB id is not a member's, and a **broadcast** otherwise (provenance: the observation key). The single ordered list is this logical view over the existing tables. It is not a new stored object and no response shape changes.
2. **Ownership.** Only the EPG sync writes `published_epg_authority.programme_run_id`, `generation` and `watchlist_generation`, the documents, the members and the sealed show rows. Discovery owns decisions, admissions and assigned rows. After the implementation the only runtime statements that increment `generation` are the publish commits of the EPG sync.
3. **Agreement invariant and addressed write.** *Invariant:* an assigned row `(P, F, slot)` of observation `O` exists only while the stored decision of `O` is `verified` with the TMDB id of member `F`. It is kept by an order and two rules:
   - **Decision first.** The resolver writes the decision through the unchanged compare-and-set of `writeDecisionDelta`. It assigns only for a key that write reports as `written`, never for a skipped one, and never before it.
   - **Conditional insert.** One assigned row per slot of `O`, each by a statement that writes only if ALL of the following hold inside that statement: the published authority is `d1` / `open` and still points at `P`; `F` is a `programme` member of `P`; the stored decision of `O` is `verified`, has that TMDB id and has the exact `decision_hash` the writer evaluated; `O` is an eligible observation of `P` (`source_key = 'active'`, `residence = 'active'`, `seen_in_latest = 1`) whose `evidence_key` is the one the writer evaluated; the slot is one of its slots; no row of any Film holds the slot. The batch runs under the Discovery lease with the Discovery fence, so it advances `discovery_authority.generation` like every Discovery write and never the published generation.
   - **Removal with the decision.** Every writer of a decision (`writeDecisionDelta`, the whole-map `writeDecisions`, the owner's `commitOwnerWrite`) that changes the verified identity of `O` (the status leaves `verified`, or the TMDB id changes) deletes the assigned rows of `O` for the published run IN THE SAME fenced batch as the decision write. The batch commits or fails as a whole, so no assigned row outlives the decision it came from.

   Illustration (AIR-480 fixes the exact statements):

   ```sql
   INSERT INTO published_epg_show
     (programme_run_id, film_id, channel_id, start_ms, end_ms, channel, epg_title, basis, match_reason)
   SELECT :P, :film, :channel_id, :start_ms, :end_ms, :channel, :epg_title, 'discovery', :observation_key
   WHERE EXISTS (SELECT 1 FROM published_epg_authority
                 WHERE id = 1 AND mode = 'd1' AND cutover = 'open' AND programme_run_id = :P)
     AND EXISTS (SELECT 1 FROM published_epg_member
                 WHERE programme_run_id = :P AND kind = 'programme' AND film_id = :film)
     AND EXISTS (SELECT 1 FROM discovery_decision
                 WHERE observation_key = :observation_key AND status = 'verified'
                   AND tmdb_id = :tmdb_id AND decision_hash = :decision_hash)
     AND EXISTS (SELECT 1 FROM discovery_observation o JOIN discovery_observation_show s
                   ON s.source_key = o.source_key AND s.observation_key = o.observation_key
                 WHERE o.source_key = 'active' AND o.residence = 'active' AND o.seen_in_latest = 1
                   AND o.programme_run_id = :P AND o.observation_key = :observation_key
                   AND o.evidence_key IS :evidence_key
                   AND s.channel_id = :channel_id AND s.start_ms = :start_ms)
     AND NOT EXISTS (SELECT 1 FROM published_epg_show
                     WHERE programme_run_id = :P AND channel_id = :channel_id AND start_ms = :start_ms);

   -- in the batch of a decision write that changes the verified identity of :observation_key
   DELETE FROM published_epg_show
   WHERE programme_run_id = (SELECT programme_run_id FROM published_epg_authority WHERE id = 1)
     AND basis = 'discovery' AND match_reason = :observation_key;
   ```

   Discovery no longer calls `patchProgramme`, no longer writes the programme document, the members, the sealed rows, a Film field of the programme or an R2 programme object. A grouped observation with several showings writes one row per slot; each slot keeps its own coordinates and position.
4. **Replay repair and re-application.** One path repairs a missing assignment, whatever its cause (a crash or a lost response between the decision and the insert, an owner assignment, a new EPG run): the cheap pass of every Discovery chunk visits the current verified observations it already pages through and runs the conditional insert of decision 3 for those whose TMDB id is a member's. No TMDB call, inside the existing per-chunk bounds. It does not reuse an older `verified` blindly. An observation is eligible only when:
   - the stored decision is `verified` now (pinned by its hash in the statement);
   - the observation is eligible in the pinned run (`active`, `seen_in_latest = 1`; pinned by its evidence key in the statement);
   - **the evidence agrees:** the title, the year and the duration set of the current observation equal those of the evidence key recorded on the decision. Only the show list may differ, because it is the per-run part that is being assigned. A decision that records no evidence key is eligible only when the owner assigned it (`identitySource = 'owner'`) or the scan of the pinned run confirmed the same TMDB id on the observation (`confirmed_tmdb_id`).

   Otherwise nothing is written (`evidence_changed`), the decision is untouched and the slots stay broadcasts. A `verified` decision is never sent to TMDB again by today's rules, so such an observation stays a broadcast until the owner confirms it (choice M2).
5. **Outcomes, concurrency and a stale writer.** Replaying an assignment inserts nothing. Every refusal is a counted outcome named by the guard that failed (`stale_run`, `not_member`, `decision_changed`, `observation_inactive`, `evidence_changed`, `slot_absent`, `slot_taken`); it is not an error and never reaches the EPG run. Two decisions cannot both hold one slot: the scan gives a slot one owner, and the insert guard refuses a second Film. A Discovery chunk that still holds an older run after a new EPG publication inserts nothing; the pointer guard is inside the statement, so no check-then-write window exists.
6. **Wrong match and owner correction.** The decision stays the record of identity and stays Discovery-owned. A correction is a decision write, so the removal rule of decision 3 applies to it: the owner's batch deletes the assigned rows of the observation, and the new rows (if the new identity is a member) come from the conditional insert, at once under the same lease or by the repair of decision 4. Discovery can delete only assigned rows; a sealed row is corrected only by the next EPG run. Coordinates do not change in either case.
7. **Unknown element and non-member Film.** A decision whose slot is not a slot of an eligible observation of the pinned run writes nothing. A decision whose TMDB id is not a member's writes nothing to the published tables and follows the existing catalog admission path, which already preserves slots and moves only the Discovery generation. In both cases the decision is kept.
8. **New EPG publication.** Assigned rows are keyed by run, so a new run starts with its sealed part only and old rows are never read through the new pointer. After Discovery pins the new run, decision 4 assigns the eligible observations again. [ADR 0135](0135-epg-priority-discovery-pause.md) is unchanged and sufficient: assigned rows are written only inside a Discovery chunk under the lease, so the EPG priority pause stops them, and they hold no EPG stage, claim or fence.
9. **Two reads, one rule.** The **sealed read** (`readDocument`) returns the stored document. The **completed read** returns the sealed document with each member's `shows` completed by the assigned rows of the same run, sorted by `(start, channelId)`, and `availableUntil` recomputed.

   | Read | Callers |
   | --- | --- |
   | Completed | `readDocumentAt`, `authoritativeSnapshot`, the Admin snapshot (`src/admin/read.js:232`), `repairMirrors` (the only source of a mirror rewrite between publications), the programme comparisons of `revertPublished` and `activatePublished`, and the mirror parity checks of `scripts/published-epg-production.mjs` |
   | Sealed | staging and the publish commit, `replacePart` for the watchlist, `payload_sha256`, and the membership checks (members against the document's Film list, which assigned rows never change) |

   The rule: everything a reader or an R2 mirror sees is the completed programme; the sealed read is internal to publication. `/api/watchlist` is unchanged.
10. **Consistency of the completed read without an EPG generation bump.** The sealed part cannot change while `(P, g)` holds, and the existing generation check before and after the read proves that. The assigned rows are read by exactly ONE statement, and every writer changes the assigned rows of an observation in one transaction. So a completed read is the sealed part plus the assigned set of one instant: it never mixes two states of a correction. A caller that compares and then acts uses content, not the fence:
    - **Readers that cache or label content** may claim "unchanged" only when the fence is equal AND a digest of the completed content is equal (the Admin snapshot already digests the body it serves) or `discovery_authority.generation` is equal (the projector already re-checks it, `src/d1-enrichment.js:150`). The Producer plan does not contain showings, so its label stays `P:g`.
    - **Mirrors** contain the completed programme, as they contain attached showings today. `repairMirrors` compares mirror text with the completed read and rewrites on a difference; an assignment that lands after its read is picked up by the next hourly tick.
    - **Revert** must be exact. `revertPublished` reads `discovery_authority.generation`, reconciles the mirrors, compares the mirror with the completed read, and its mode flip adds the guard that the Discovery generation is still the one it read. Every assignment and every correction advances that generation, so any of them between the comparison and the flip fails the revert with `published_epg_fence` and nothing is flipped; the operator retries. After the flip the insert guard (`mode = 'd1'`) refuses every assignment, so R2 holds exactly what readers saw.
11. **Watchlist tail.** One EPG sync produces one increment of `generation`. The watchlist is published by the publish commit; the tail must not make a second one. AIR-480 adds the test for this and removes the tail's write on the D1 path if the test shows it reachable.
12. **Not decided, not authorized.** No physical single-list table, no new endpoint, no migration, no index, no flag, no scheduler, no Workflow, no second published snapshot. The R2-mode branch of `attachWatchlistShowing` (authority not `d1`) is outside this record. Nothing here runs in production.

### Data and contracts, before and after

| Event: Discovery verifies broadcast `O` as watchlist Film `F` in run `P`, generation `g` | Before (main) | After (this record) |
| --- | --- | --- |
| Order of writes | attach, then the decision; the attach stays if the decision is skipped | the decision, then the conditional insert |
| `published_epg_authority` | `generation = g + 1` | unchanged (`g`, `P`) |
| `published_epg_document` (programme), `published_epg_member`, `published_epg_generation.payload_sha256` | deleted and rewritten for the whole run | unchanged |
| `published_epg_show` | all rows of `P` deleted and re-inserted, plus the new showings | one inserted row per slot of `O`, `basis = 'discovery'` |
| R2 `programme.json` mirror and generation copy | completed content, written by Discovery in the same call | completed content, written only by the hourly EPG reconcile, up to about one hour later |
| `discovery_decision`, `discovery_authority.generation` | decision written, Discovery generation advanced | the same, plus one more advance for the insert batch |
| `GET /api/programme`, Film `F` | `shows` include the slots of `O` | the same `shows`; fence unchanged |
| The decision of `O` is corrected later | the attached showings stay on `F` | the assigned rows are deleted with the decision write |
| After the next EPG run `P'` | the slots of `O` are broadcasts again and stay so | assigned again in `P'` if the evidence agrees (decision 4) |

### Affected writers and readers

| Code | Change |
| --- | --- |
| `src/sources.js` `scanEPG` | one owner per slot; an ambiguous slot is not retained (decision 1) |
| `src/discovery.js` `attachWatchlistShowing` (D1 branch) and its call sites at `820` and `978` | removed; the conditional insert runs after `saveCandidate` reports the decision written (decision 3) |
| `src/discovery.js` cheap pass (`694` to `715`) | repair and re-application for members (decision 4) |
| `src/discovery-authority.js` `writeDecisionDelta`, `writeDecisions`, `commitOwnerWrite` | delete the assigned rows of an observation whose verified identity changes, in the same batch (decision 3) |
| `src/admin/discovery-recovery.js` owner identity correction | runs the conditional insert after its decision write, or leaves it to the repair |
| `src/published-epg.js` | conditional insert; completed read; `repairMirrors`, `revertPublished` and `activatePublished` compare with the completed read; revert guard on the Discovery generation; `patchProgramme` loses its only caller and is removed |
| `src/admin/read.js:232` | reads the completed programme |
| `scripts/published-epg-production.mjs` | its mirror parity and revert readback compare with the completed read |
| `src/worker.js` `persistWatchlist` | test of decision 11; write removed on the D1 path if reachable |
| `src/worker.js` `loadJSON`, `/api/programme`, catalog routes; `src/enrichment.js:1866`; `src/d1-enrichment.js` | no own change; they read the completed view through the seam |
| EPG publish commit (`commitPublish`, seal steps), `EpgOrchestration.ensure`, `upsertAdmissions`, `/api/watchlist` | unchanged |

### Deterministic acceptance examples

Setup: run `P1`, `generation = 41`; members `F1`, `F2`, `F3`; sealed row `(P1, F2, ch7, T1, title_year)`; eligible observation `O` of `P1` with slots `(ch3, T2)` and `(ch9, T3)`, `T1 < T2 < T3`.

1. **Assign.** Discovery verifies `O` as `F1`; the decision is written, then the rows `(P1, F1, ch3, T2, discovery)` and `(P1, F1, ch9, T3, discovery)`. `generation = 41`, `programme_run_id = P1`, `watchlist_generation`, the documents, the members and `payload_sha256` are byte-identical; the completed read returns `F1.shows = [(ch3, T2), (ch9, T3)]` and `F2.shows = [(ch7, T1)]`; the slot order `T1, T2, T3` is the same before and after.
2. **Replay.** The same insert again changes zero rows and the read is identical.
3. **Stale run.** The EPG sync publishes `P2` (`generation = 42`) before the insert. Zero rows change (`stale_run`); no row of `P2` exists for `O`; `generation` stays 42.
4. **Re-application.** `O` is eligible in `P2` with slot `(ch3, T4)` and the same title, year and durations; the stored decision is `verified` for `F1`. The next Discovery chunk that pins `P2` inserts `(P2, F1, ch3, T4, discovery)` with no TMDB call; `generation` stays 42.
5. **Slot taken.** After example 1 an insert names `F3` for `(ch3, T2)`. Zero rows change (`slot_taken`); `F1` keeps the slot.
6. **Non-member.** `O` is verified as a Film that is not on the watchlist. No published table changes; the admission and the decision are written as today.
7. **Owner correction.** The owner corrects `O` from `F1` to `F3`. The decision batch deletes the two rows of example 1; the insert then writes `(P1, F3, ch3, T2, discovery)` and `(P1, F3, ch9, T3, discovery)`; coordinates and order are the same; `generation = 41`. A correction to "not a film" only deletes; both slots are broadcasts again.
8. **Change signal.** Before and after example 1 the fence is `d1:41:P1`; `discovery_authority.generation` and the content digest differ. A reader that reports "unchanged" from the fence alone fails the test.
9. **EPG priority.** During the pause of ADR 0135 no assigned row is written. At the store level, an assigned-row insert between the read of the fence and `commitPublish` leaves that commit's compare-and-set valid: the fence is still `d1:41:P1`.
10. **One increment per sync.** One EPG sync with a changed watchlist moves `generation` by exactly 1.
11. **Failed decision compare-and-set.** The resolver verifies `O` as `F1`, and `writeDecisionDelta` skips the key (`conflict`). No insert is attempted; no published table changes.
12. **Crash between the writes.** The decision of example 1 commits and the process stops before the insert. Stored state: decision `verified`, no assigned row. The cheap pass of the next chunk inserts the two rows; the result equals example 1.
13. **Racing owner correction.** The resolver holds decision hash `h1` (`F1`). The owner's correction to `F3` commits first. The resolver's insert with `h1` changes zero rows (`decision_changed`). At no time does a row of `F1` exist for `O` after the owner's batch.
14. **Changed evidence.** In `P2` the observation `O` has a duration that the decision's evidence does not contain. Zero rows change (`evidence_changed`); the decision is unchanged; the slots are broadcasts.
15. **Inactive or stale observation.** `O` has `seen_in_latest = 0`, or its `residence` is not `active`: zero rows change (`observation_inactive`). Its evidence key changed after the writer read it: zero rows change (`evidence_changed`).
16. **Duplicate slot.** The feed has two elements at `(ch7, T1)`, one matching `F2` and one matching `F3` (or one matching `F2` and one unmatched). The scan retains neither; `uncertain` lists the slot with `duplicate_slot`; no sealed row and no observation slot exists for `(ch7, T1)`. Property test: no two retained slots of a scan share `(channelId, start)`.
17. **Read during a correction.** The correction of example 7 commits while a completed read is between its statements. The read returns the rows of `F1`, or no row of `O`, or the rows of `F3`; never rows of both Films. The fence is `d1:41:P1` in all three.
18. **Mirror reconciliation.** After example 1 the hourly reconcile finds the mirror text different from the completed read and writes `programme.json` and the generation copy with `F1`'s two showings; `generation = 41`. The next tick is aligned and writes nothing.
19. **Revert after an assignment.** A revert after example 1 leaves R2 with `F1`'s two showings. A Discovery write between the revert's comparison and its flip fails the revert (`published_epg_fence`); the mode stays `d1`. After a completed revert an assignment insert changes zero rows.

### Shortest implementation (estimate for AIR-480)

Existing D1 tables and code only: no migration, no index, no flag, no second publish pipeline, no shared snapshot, no continuous sync, no scheduler, no overlay store. `published_epg_show` already has every needed column (`basis` and `match_reason` are free text; no reader interprets `match_reason`), and its existing index `(programme_run_id, start_ms)` serves the slot check and the read. `discovery_decision.decision_hash`, `discovery_observation.evidence_key` and `discovery_authority.generation` already exist and carry the guards. The change is confined to the files of the table above plus tests for the nineteen examples. The architecture and reference pages that describe the attach ([EPG and availability](../architecture/epg-and-availability.md), [discovery and resolution](../architecture/discovery-and-resolution.md), [persistence](../architecture/persistence-and-migration.md), the [D1 schema reference](../reference/data/d1-schema.md)) change in the implementation PR, not here, because no flow changes until then.

### Revised invariants

- **[ADR 0079](0079-d1-authoritative-published-epg.md) decision 4**, "A programme patch records the generation it read and commits only that generation; success is that generation plus one": qualified. Discovery makes no programme patch. Decision 1, "Show rows are the availability facts", becomes literally true for assigned rows. Decision 5 (D1 is the published generation for every reader) is kept; what readers and mirrors receive is the completed read of decision 9.
- **[ADR 0128](0128-epg-canonical-producer-durable-execution.md) decision 11 and [ADR 0140](0140-producer-workflow-adaptive-successor-chain.md) decision 7**: unchanged in text. The fact they rest on changes: the published generation moves only at an EPG sync, so a completed pass can become `lagging` only because of a new EPG publication, and the Producer yields to Discovery only for D1 contention, not because Discovery moves its input.
- **ADR 0141 draft ([PR #618](https://github.com/vladimino/iptv-watchlist/pull/618), head `9b770734`), G-P and T-4**: the draft's premise that a same-`P` Discovery `commitReplace(programme)` increments `g` per attach, and the watchlist `commitReplace` after a sync, stop being true once AIR-480 is delivered and accepted. Whether G-P is then narrowed or dropped, and how T-4 is decided, belongs to AIR-374 and that pull request. This record does not edit the draft, and AIR-374 resumes only after the mechanism is implemented and accepted, not on this text.

### Material choices for the owner

| # | Choice | Recommendation |
| --- | --- | --- |
| M1 | Where the assigned identity lives | Assigned rows in the existing `published_epg_show` (this record). Alternatives below |
| M2 | Who puts a known broadcast back on its Film after a new EPG run, and on what evidence | Discovery's cheap pass, only when title, year and durations agree with the decision (decision 4). Cost: the broadcast is a broadcast for the first chunks after each EPG run, and stays one when its evidence changed, until the owner confirms. Stricter (identical evidence key) re-applies less; looser (the key alone) is the blind reuse the review rejected. The alternative writer, the EPG commit reading Discovery decisions, makes the publication depend on Discovery |
| M3 | Catalog Films (not on the watchlist) | Keep the existing admission path; it already satisfies the directive |
| M4 | R2 compatibility mirrors | They contain the completed programme and follow through the existing hourly reconcile (lag up to about one hour); Discovery writes no R2 programme object |
| M5 | Film fields the attach wrote into the programme (`aliases`, `hotEnteredAt`, `showsProgrammeRunId`, `epgLastAiring`) | No longer written. `shows` and `availableUntil` are derived at read. AIR-480 lists every consumer before removal; the one found here is `hotEnteredAt` as a late tie-breaker of the prediction queue order (`src/enrichment.js:1526`) |
| M6 | A slot the feed gives to two different owners | Not retained, counted and listed as `duplicate_slot` (decision 1). It can hide a real showing of a watchlist Film on a malformed feed; keeping the first element instead would keep the showing with an arbitrary identity |

## Alternatives considered

- **Derive at read, write nothing** (join `discovery_decision`, active `discovery_observation` and `discovery_observation_show` on every programme read). No write at all, but every programme read crosses into the Discovery authority, the active rows move to the new run before the published pointer does during the daily seal, and `discovery_decision` has no index for the lookup. Not recommended.
- **A physical slot table for every retained broadcast.** It would store the single list literally. It needs a migration, a second copy of the observation slots and a change of the EPG publish commit. Not the shortest path and not needed for the contract.
- **Keep the generation increment and make consumers tolerate it** (the G-P route of the ADR 0141 draft). Excluded by the owner directive.
- **Teach the scan the Discovery aliases** so that the EPG sync itself seals the showing. It changes title matching quality and scope; it is a possible later step and does not remove the need for an in-run assignment.
- **One batch for the decision and the assignment.** It removes the repair path for a crash, but the repair path is needed anyway for a new EPG run, and one batch would join the decision write to the published tables for every decision. Decision first plus the conditional insert was chosen as the smaller change.

## Consequences

- One Discovery attach costs a few small inserts instead of a rewrite of the document, the members and every show row plus two R2 writes, and it can no longer change the published fence that an EPG publication captured or the `P:g` label of a Producer pass.
- An assignment can no longer outlive or precede its decision; a corrected identity removes its showings in the same transaction.
- A programme read costs one more indexed statement over the show rows of the run. The E6 measurement of 12 November 2026 saw 971 to 1,951 show rows per generation. The added latency is not measured.
- The sealed document no longer contains every showing a reader sees. Only publication internals read it; a caller that compares with a mirror or serves a reader must use the completed read, and a test must fail when one does not.
- `published_epg_show` gets a second writer. The boundary is the `basis` value and the insert guards; a test must prove Discovery cannot change a sealed row.
- `basis = 'discovery'` and the observation key in `match_reason` reuse existing columns. This avoids a schema change at the cost of a convention that the reference page must state.
- The decision writers of Discovery gain a statement on a published table. It is a delete of Discovery's own rows, inside the batch that already holds the Discovery fence.
- A revert can fail and be retried while Discovery is writing. It is an owner-run procedure, and a quiet Discovery is already its normal condition.
- The scan drops a slot that a malformed feed gives to two owners. How often the production feed does that is not measured.
- A recognised broadcast is a broadcast again for the first Discovery chunks after each EPG run, until the cheap pass reaches it. Today it stays a broadcast for the whole run.

## Recovery and migration boundary

This record changes no code and no data. The implementation needs no migration and adds rows only to an existing table; a code rollback leaves assigned rows that the older code never reads through its runtime paths and deletes at its next programme patch of that run, and the next EPG run starts without them. After such a rollback readers and mirrors lose the showings the new code assigned in the current run: the older code serves the sealed document and rewrites the mirrors from it at its next reconcile. Programme documents already patched by the present attach stay valid as sealed parts of their runs. An authority revert of the published EPG keeps its own fenced, owner-approved procedure; with decision 10 it leaves R2 with the completed programme, exactly what readers saw under D1. Acceptance of this record, the implementation PR, its deployment and any production observation are separate steps with their own approvals.

## Evidence

- **Original decision:** owner directive on [AIR-479](https://trello.com/c/KLilv4Pc), 14 November 2026.
- **Implementation:** none. Follow-up [AIR-480](https://trello.com/c/ZS0Xdrlq).
- **Dated verification:** code reading of `main` at `3c01e23f` on 2026-11-14 (files and lines cited above); row counts from the [E6 production measurement](../evidence/d1-migration/air-374-e6-production-measurement-2026-11-12.md); [independent review](https://github.com/vladimino/iptv-watchlist/pull/622#issuecomment-6879406073) of head `bc89f9bb`, whose three contract gaps are answered by decisions 1, 3, 4, 9 and 10. No production read or write was made for this record.
- **Uncertainty:** how often Discovery attaches in production is not measured; how often the feed repeats a slot under two owners is not measured; how often an observation's duration set changes between runs, which decides how much decision 4 re-applies, is not measured; the no-op of the watchlist tail is a code reading; the cost of the completed read, of the delete in a decision batch and of the re-application per chunk is not measured; the consumers of the Film fields of M5 are not fully enumerated; the legacy whole-ledger chunk (`src/discovery.js:978`) is assumed to be replaced the same way as the paged one.

## Follow-ups

- [AIR-480](https://trello.com/c/ZS0Xdrlq): minimal implementation, tests for the nineteen examples, reference and architecture pages.
- [AIR-374](https://trello.com/c/ha7ais3w) and [PR #618](https://github.com/vladimino/iptv-watchlist/pull/618): G-P and T-4 after the mechanism is implemented and accepted.
