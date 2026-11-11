# ADR 0112: A bounded discovery ledger archives its backlog in a capped number of observations per commit

**Status:** Proposed  
**Original decision date:** 2026-11-11  
**Recorded at:** 2026-11-11  
**Approval source:** the owner's review of [PR #505](https://github.com/vladimino/iptv-watchlist/pull/505) chose a departure budget (variant C) over setting the flag and letting the first bounded commit archive everything, and asked for a superseding ADR ([AIR-429](https://trello.com/c/HD3hVd7F)). This record is **not yet accepted**: acceptance and any production switch are separate owner decisions.  
**Related work:** [AIR-429](https://trello.com/c/HD3hVd7F), [AIR-426](https://trello.com/c/Jf6G2IiP), [AIR-423](https://trello.com/c/NpeuCGhK), [ADR 0034](0034-bounded-discovery-ledger.md), [ADR 0085](0085-d1-authoritative-discovery.md), [ADR 0092](0092-resumable-bounded-ledger-seal.md), [dated evidence](../evidence/discovery/air-429-bounded-drain-2026-11-11.md)  
**Supersedes:** [ADR 0034](0034-bounded-discovery-ledger.md) section 1 (the active-ledger boundary) in part: while a backlog remains, the active ledger is the latest scan plus that backlog, not the scan alone. The archive objects, their fences, re-entry and every other decision of that record stay.  
**Superseded by:** None

## Context

[ADR 0034](0034-bounded-discovery-ledger.md) bounds the active ledger to the latest scan: in `bounded` mode every active observation that the new scan does not contain departs into the write-once archive, in the commit that publishes the new generation. Production runs `frozen` since the split of 28 October 2026: nothing departs, the active ledger only grows. On 10 November it held 47,059 observations of which 20,568 were in the latest scan and 26,491 were not, and it grew by 2,135 keys in a day ([AIR-423 evidence](../evidence/discovery/air-423-ledger-generation-diff-2026-11-10.md)).

Switching to `bounded` would make the first commit archive all 26,491 in one request. [AIR-426](../evidence/discovery/air-426-bounded-transition-rehearsal-2026-11-11.md) measured that commit at 216 MB of Node old space against 173 MB for the daily frozen commit, because the planner holds the departures as objects before it writes the segments; the headroom of the Workers isolate is not known, and a commit that exceeds it is killed and retried by the executor until the flag is reverted. The offline split that replaced the first bounded commit in October is not available any more: its tool stops on an existing archive.

## Decision

1. **Two kinds of departure.** In `bounded` mode an active observation of the published generation that the new scan does not contain is either a **fresh departure** (it was in the published generation's scan: `seenInLatestSnapshot` is `true`) or **backlog** (it was already absent from it). The flag is written by the merge of every scan; the production ledger carries it (20,568 seen of 47,059 on 10 November). An observation without the flag counts as backlog, so a ledger lacking it would only archive more slowly, never lose anything.
2. **Fresh departures are archived by this commit, always.** They are the daily turnover. A steady bounded commit archives exactly these, so they add nothing to what the mode costs once the ledger has drained.
3. **At most `ledgerDrainCap()` of the backlog is archived per commit**, the lowest keys first in UTF-16 code-unit order. The selection is a function of the published ledger and the scan alone (not of the order of the ledger), so a retry of a stopped commit selects the same observations. The cap is a constant of the code (4,000 observations); it is not a flag, a setting or a schedule.
4. **The boundary while draining.** After a commit the active ledger is the latest scan **plus** the backlog that was not archived. When any remains, the generation document carries `"drain":{"backlog":N,"cap":C}` between `ledgerMode` and `archive`; when none remains the field is absent and the active ledger is exactly the latest scan, the boundary of ADR 0034. A status that reads the document reports `ledgerMode: bounded` together with `drain`; it never describes a draining ledger as the scan.
5. **Progress.** Fresh departures never join the backlog, so the backlog falls by `min(cap, absent backlog)` in every commit, whatever left the scan the day before and however large that flow is. A backlog of B drains in at most `ceil(B / cap)` commits; fewer when its observations return to the scan (a returning observation is simply seen again). The guarantee holds for a flow larger than the cap.
6. **Nothing else changes.** The commit still writes the archive (segment versions, manifest, then the compare-and-swap of the archive pointer) before the generation document, under the same lease and fences, and a stopped commit leaves the previous generation published with an archive it can read. Re-entry, `alsoArchived`, the D1 seal (a held backlog observation is written as an active, not-seen row; the departed ones are archived by `sealArchive`), decisions, the catalog and the discovery chunk (which selects only seen observations) are unchanged. Nothing is deleted; active ∪ archive holds every observation ever seen.
7. **`frozen` and `full` are unchanged** and write no `drain`. A cap larger than the backlog is the plain bounded mode of ADR 0034.

Not decided here: setting `DISCOVERY_LEDGER_MODE`, a production cutover, any change of the cap, a schedule or a manual run. This record authorizes none of them.

## Alternatives considered

- **Set the flag and let the first commit archive everything (ADR 0034 as written).** Rejected by the owner's review of PR #505: unmeasured isolate memory and D1 load for 26,491 departures at once.
- **An offline split of the published generation.** Not available: the split tool stops on an existing archive, and one exists.
- **Cap the total departures of a commit, flow included.** Considered during implementation and not adopted: when a day's flow reaches the cap the backlog does not move, so no finite drain can be promised.
- **Stream the departures per archive segment to lower the memory without a drain.** Considered during implementation and not adopted: a larger change of the planner (several passes over the published ledger) for the same result the cap gives with a selection.

## Consequences

For several generations after the switch the active ledger is larger than the scan and the status says so. Counters that cover the active ledger (`historicalUnresolved`, `expiredInactive`, `rejectedNonfilm`) include the held backlog and fall as it drains. A held observation is never resolved (the chunk selects seen observations), as in a frozen ledger. The first bounded commit holds at most the flow plus the cap of departures instead of the whole backlog; the measured peak is in the [evidence](../evidence/discovery/air-429-bounded-drain-2026-11-11.md). The drain takes `ceil(B / cap)` commits at most, one per natural EPG publication. This constant has to be kept consistent with the memory it was chosen against: raising it is a change of this record.

## Recovery and migration boundary

Code only. A deploy changes nothing while the flag stays unset; the switch is a Worker variable under its own owner approval ([runbook](../runbooks/discovery-ledger.md#switching-frozen-to-bounded-under-d1-authority)). Rollback is rollback R1 of ADR 0034: unset the flag and the next commit acts as `frozen`; a backlog still held then stays active, nothing is rebuilt or deleted, and re-entry still reads the archive. A code rollback does not undo an archive, a D1 archive row or the flag. A generation document written with `drain` is read by an older Worker as an ordinary document with an extra field (the status of the version before this record reports the mode as unknown for it).

## Evidence

- **Original decision:** the owner's review of [PR #505](https://github.com/vladimino/iptv-watchlist/pull/505); card [AIR-429](https://trello.com/c/HD3hVd7F)
- **Implementation:** the AIR-429 pull request
- **Dated verification:** [AIR-429 evidence](../evidence/discovery/air-429-bounded-drain-2026-11-11.md), 11 November 2026, offline
- **Tests:** `tests/discovery-bounded-drain.mjs` (the active ledger against an independent model after every generation, the cap, the progress under a flow above the cap, the bound `ceil(B / cap)`, a stop behind the archive pointer retried to the result of an uninterrupted twin, fail-closed stops, the memory bound), `tests/epg-status-ledger-mode.mjs` (the `drain` header), `tests/discovery-bounded-d1-rehearsal.mjs`
- **Uncertainty:** the isolate headroom and the cost of a D1 archive batch are not measured; a production switch has not happened

## Follow-ups

The production switch and its natural-run acceptance are a separate owner decision after delivery.
