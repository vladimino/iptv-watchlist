# AIR-426: rehearsal of the transition from a frozen to a bounded discovery ledger under D1 authority

**Captured:** 2026-11-10 and 2026-11-11 (UTC). **Method:** offline only, plus read-only production aggregates. The real planner (`planDiscoveryLedger` through `stageSealedGeneration`) and the real ledger seal (`sealLedgerStep`) were run against a sqlite stand-in of D1 and an in-memory bucket, in `tests/discovery-bounded-d1-rehearsal.mjs`; the memory of the first bounded commit was measured with `scripts/discovery-bounded-transition-benchmark.mjs` on synthetic records. Production was read, never written: three D1 `SELECT` aggregates (counts only, no key, title or id), MCP `feature_flags`, and the code at `main` `6ff0ac2`. Card: [AIR-426](https://trello.com/c/Jf6G2IiP); follows [AIR-423](air-423-ledger-generation-diff-2026-11-10.md) and [AIR-427](https://trello.com/c/aDqfFIH1).

This record decides nothing. It states what was proven offline, what was not, and the plan that follows from it ([runbook](../../runbooks/discovery-ledger.md#switching-frozen-to-bounded-under-d1-authority)). No flag was set, no run started, no D1 or R2 write was made.

## Production state at capture

| | |
| --- | --- |
| `DISCOVERY_LEDGER_MODE` | absent (effective `full`; with the archive pointer present the planner runs `frozen`) |
| Active observations / seen in the latest scan | 47,059 / 20,568 |
| D1 archive rows | 0 (the R2 archive holds the history; D1 stores neither the mode nor the archive size) |
| Stored decisions | 32,530: 27,535 belong to an active observation, 18,524 to a seen one, **4,995 to a key that has no active observation** |
| D1 transfer / seal | `committed` / `done` |

## What was rehearsed and what holds

Ten generations of deterministic scans through the real planner and seal, in the order production would meet them: a full ledger installed as a cutover leaves it, a first `bounded` commit, two `frozen` commits, `bounded`, `bounded`, `frozen`, the flag set to `frozen` explicitly, `bounded`, `bounded`. After every generation the checks are the same:

- **Conservation.** The active ledger plus exactly the archive manifest it names holds every key ever seen, and no other, with payloads equal to those of one ever-growing ledger (R2). In D1 the active rows are the document's items, every one of the current run, none left `retiring`, show rows equal, nothing deleted.
- **A bounded active ledger is exactly the latest scan**, every row seen; a `frozen` or `full` commit archives nothing and leaves the archive pointer alone; the pointer moves exactly when something departs.
- **One D1 archive row per departure.** A key that departs again gets another row (the archive key carries the run and the generation); nothing is overwritten.
- **Re-entry.** A key that returns takes its record from the R2 archive, equal to the ever-growing ledger's, and is listed as also archived. Its old D1 archive row stays.

| Day | Mode | Active | Keys ever seen | Departed | Re-entered | D1 archive rows |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | full | 75 | 75 | 0 | 0 | 0 |
| 2 | bounded | 54 | 82 | 28 | 0 | 28 |
| 3 | frozen | 74 | 89 | 0 | 13 | 28 |
| 4 | frozen | 81 | 96 | 0 | 0 | 28 |
| 5 | bounded | 54 | 97 | 34 | 6 | 62 |
| 6 | bounded | 54 | 98 | 20 | 19 | 82 |
| 7 | frozen | 74 | 99 | 0 | 19 | 82 |
| 8 | frozen (flag set) | 81 | 100 | 0 | 6 | 82 |
| 9 | bounded | 53 | 100 | 34 | 6 | 116 |
| 10 | bounded | 52 | 100 | 20 | 19 | 136 |

The first `bounded` commit after a frozen period archives the accumulated absent rows (day 5: 34), as the transition would.

**Stops and rollback, each leaving state unchanged or resumable:**

- The manifest the archive pointer names is missing: the commit stops before any write.
- The published generation moved under the commit: the archive fence stops it and the pointer is not swapped.
- The commit dies after the archive pointer moved and before the generation document is stored: the previous generation stays published with a newer archive, D1 is untouched, a reader of the published generation finds every object it needs, and a retry of the same day completes with the same result as an uninterrupted commit.
- The seal is interrupted between steps: the same run resumes (with the packed batches of AIR-420, kills inside a step are covered by `tests/discovery-seal-resume.mjs` and `tests/discovery-seal-throughput.mjs`).
- Rollback: the flag back to unset. The commit acts as `frozen`, writes no archive, archives no D1 row, and re-entry still reads the archive. Nothing is rebuilt or deleted.

## A defect that the rehearsal found, and its fix

With 20,000 active rows (`READ_CAP`) or fewer, the D1 ledger is read **whole**, and the discovery chunk took the whole-ledger path, which loads the whole decision map and saves it back. A whole-map save fails closed in two ways: `discovery_bounded` above 20,000 decisions (32,530 are stored) and `discovery_fence` for any decision whose observation is not in the active ledger (4,995 today). A frozen ledger (47,059 rows) never reaches that path. A bounded one has the size of one scan: 20,568 on 10 November, 20,506 and 19,821 in earlier scans, so a scan under 20,000 would have stopped every chunk of its series. The rehearsal reproduced the failed save on a small ledger after a decided key departed.

The fix is one routing line in `resolveDiscoveryChunk`: a ledger read from D1 goes to the paged chunk whatever its size, with the descriptor the reader already gives above `READ_CAP`. It changes nothing for a ledger above `READ_CAP`, so the production path of today is untouched; below it, the chunk now behaves as in production instead of as in the legacy R2 path. The rehearsal asserts the route and that the decision of a departed key survives departure and re-entry. It needs to be deployed before the flag is set.

## Memory of the first bounded commit

`scripts/discovery-bounded-transition-benchmark.mjs`, synthetic records (about 1.2 kB each, larger than the production average of 739 bytes, so conservative in bytes), a frozen store of 47,059 active observations of which 20,568 are in the scan and 18,348 already archived. The smallest V8 old space at which the commit completes through the planner:

| Commit | Smallest old space | Wall without a limit |
| --- | --- | --- |
| Frozen (what runs daily now) | 173 MB | 17.0 s |
| **First bounded** (26,491 absent observations depart in one request) | **216 MB** | 18.0 s |
| Bounded after that | 114 MB | 9.9 s |

The first bounded commit needs about 25 % more than the commit that runs daily; the archive it writes grows from 32.0 to 78.0 MB (64 segments), the active ledger falls from 76.6 to 36.5 MB. The extra is the departures, which the planner holds as objects before it writes the segments. For reference the October rehearsal on the then ledger measured 139 MB frozen and 135 MB bounded.

**Not known:** the absolute headroom of the Workers isolate. Node's old space is a relative figure, and the daily commit runs in production at a Node-relative 173 MB, so the real limit is not 128 MB of Node heap. If the daily commit uses X of the isolate, the first bounded commit would use about 1.25 X in this model; nothing offline says whether X leaves that room. A commit that exceeds the isolate is killed and leaves the run in stage `epg`; by the code the executor retries it within its failure budget, so it would be killed again until the flag is reverted or the run is quarantined. That sequence was read from the code and not exercised.

## Work of the first bounded commit (stand-in, same 47,059 / 20,568 shape)

| | Frozen commit | First bounded | Bounded after |
| --- | --- | --- | --- |
| R2 objects / bytes written | 3 / 56.6 MB | 69 / 63.1 MB (64 segments, manifest) | 3 / 27.5 MB |
| Archive written | none | 26,491 observations, 34.8 MB | none |
| Staging wall (stand-in, no network) | 21.0 s | 21.8 s | 11.8 s |
| D1 seal batches / round trips | 290 / 341 | 211 / 686 | 158 / 209 |
| D1 rows after | 47,059 active | 20,568 active, 26,491 archive | 20,568 active, archive unchanged |

The first bounded seal writes 20,568 observations and archives 26,491 rows in batches of 500. Its 686 round trips model to about 8 s at 11 ms a round trip, 137 s at 200 ms and 240 s at 350 ms, plus the gaps between steps: minutes, not an hour. The cost of an archive batch against real D1 (an `UPDATE` with a subselect over 500 rows and their shows) has not been measured.

## What the status will say

After AIR-427 the D1 reader no longer claims a mode: `ledgerMode` is `unknown` from D1 and the status proves the mode and the R2 archive size from the generation document of the completed seal. The rehearsal asserts the D1 side: archive figures are named D1 rows, the distinct keys archived only in R2 each have a D1 row in this world, and a key that departed twice has two rows. After the transition the status is the observation that the mode really is `bounded` (a read of two short ranges of the generation document).

## Variants

| | Variant | Verdict |
| --- | --- | --- |
| A | Set the flag; the Worker's own commit makes the first archive | Executable as is. The one unproven step is the isolate memory of the first commit (above). Failure is recoverable by the flag, with the EPG publication blocked until then |
| B | An offline split of the published generation, as in October | Not available: the split tool stops on an existing archive, and one exists. A tool for a second split would be new work |
| C | Cap the departures a commit archives, so the ledger drains over several commits | Removes the memory step. A code change and a change of the ADR 0034 boundary (an active record is not only a scan record while it drains): an owner decision, not made here |

## Limits

- The stand-in has no network: wall times are of the stand-in, round trips and bytes are the portable figures.
- Synthetic scans for the rehearsal; synthetic records for the benchmark. Production aggregates were not copied into any fixture.
- Isolate memory, the cost of a real archive batch and the Discovery behaviour on the first bounded series were not measured; none can be without running the commit.
- One decision, the choice of variant and the flag itself, belongs to the owner.
