# AIR-444: the 348 s `seal_stage` of the first bounded commit and its `epoch_mismatch` (11 November 2026)

**Captured:** 2026-11-11 (UTC; Madrid is UTC+1). **Method:** read-only observations only. Workers Observability through the Cloudflare API connector (`epg_phase` lines), the Workflow instance records of `iptv-epg` (`GET` only), a `SELECT` of `epg_orchestration_document` in D1, and `HEAD`/`GET` of R2 objects through the read-only client (timestamps and sizes, no payload printed). No EPG, Discovery, TMDB or model run, no retry, lease reset, flag change, schedule, migration or write. Offline tests and a code change follow in the same pull request.

## What happened (runs 0b508eb0… at 16:00 UTC and 06409ea3… at 17:00 UTC)

| Fact | Run 1 (`DISCOVERY_LEDGER_MODE=bounded`, cap 4,000) | Run 2 (flag back to frozen) | Source |
| --- | --- | --- | --- |
| `epg_input_scan` | 8.7 s, discovery 20,306 | 3.2 s, discovery 20,302 | `epg_phase` |
| `seal_stage` | enter 16:01:55.4, **error 16:07:43.3, 347,920 ms** | 89,456 ms, exit | `epg_phase` |
| Workflow instance | `epg_20261111_0`: step `act-2-1` 16:01:21.8 → 16:07:45.2, output `{"kind":"stop","reason":"epoch_mismatch"}`, then `stopped-3-1` | `epg_20261111_1` finished, published 17:34 UTC | Workflow instance record |
| Commit request | `epg_continuation` `failed`, HTTP 502, `durationMs` 380,251 | n/a | `epg_continuation` |
| Orchestration mode now | `epoch` **1**, mode revision **2**, `changedAt` 2026-11-08 12:41 UTC, `completedAt` 12:44 UTC; unchanged | same | D1 `epg_orchestration_document` key `mode` |

## Where the 348 s went (R2 object times of the commit, 1-second resolution)

| Part | Time (UTC) | Duration |
| --- | --- | --- |
| `seal_stage` enter to the first archive segment written | 16:01:55 → 16:02:44 | about 49 s (planner: scan, decision stream, re-entry; not split further, there was no inner marker) |
| 64 archive segments, one after another | first 16:02:44, last 16:07:17 | **273 s**; gaps between consecutive segments 4.0-5.0 s, mean 4.33 s (63 gaps); 50.2 MB, 554-606 observations and about 0.8 MB per segment |
| manifest (386 KB, 38,306 observations in total, 7,404 upserted) | 16:07:20 | 3 s after the last segment |
| archive pointer swap | 16:07:24 | 4 s after the manifest |
| generation document `discovery-latest.json` (50.9 MB) | 16:07:39 | 15 s after the pointer |
| seal payload (28.9 MB) | 16:07:42 | 3 s |
| refused write, `seal_stage` error | 16:07:43.3 | 1 s |

**The cost of a round is the fence, not the read or the put.** The manifest has a parent, so an archive already existed and each segment round also read the existing segment and rewrote it (read, merge, serialize, put of about 0.8 MB). The manifest write and the pointer swap are one full fence and one small put each, with no segment read, and each took 3-4 s; a segment round (a full fence plus read, serialize and put of about 0.8 MB) took 4.3 s. A full fence is `renewDiscoveryLease` (D1), the D1 authority and generation reads and two R2 reads; it ran before every one of the 64 writes. By arithmetic from the two small-put rounds, the fences were at least 3 of every 4.3 s, about 190-250 s of the step. The split of one round into its calls was not measured (there was no marker inside the loop); the new markers measure it on the next natural run.

**Why frozen is 89 s.** A frozen commit has no departures, so it writes no segments, no manifest and no pointer: the 273 s and 7 s do not exist. Its remaining part is the planner and the generation document, which are also in run 1. This is a comparison of two runs on different days and flags, not an A/B; the card's "frozen 89.5 s" is the whole step, and the planner share of run 1 (about 49 s) is below it as expected.

## Why it was reported as `epoch_mismatch`

- The EPG step takes a 5-minute lease (`LEASE_MS`) at its start (16:01:22) and renews it only when a mutation boundary calls `assertStep` after half of it is spent. `stageSealedGeneration` called it once at its start; the archive loop called none of its own (its fence renewed the separate 90 s Discovery lease). After 16:06:21 (plus the 15 s margin) the step lease was expired; the first boundary afterwards, the final `saveJSON('sync.json')` at 16:07:43, was refused with `epg_step_fenced`.
- `classifyThrown` mapped every `epg_step_fenced` to `epoch_mismatch`, and the executor stops the instance on that class without retry. The stored epoch was 1 throughout, so no epoch mismatch happened: the label was wrong, the fail-closed stop was right.
- Consequence for the day: the pointer of the archive had already moved to the new manifest (16:07:24) while the generation was never published; run 2 (frozen) continued from the previous published ledger with the archive's `alsoArchived` reconciliation, as ADR 0034 provides. No data was lost (not re-verified here beyond the object times above).

## Not established

- Production latency of one D1 round trip, one R2 get and one R2 put separately, and so the split of one segment round into fence, read, serialize and put (only the upper bound of about 1.3 s for read, serialize and put together follows from the rounds above).
- The planner share inside the 49 s.
- Whether any `exceededMemory` in run 2 (card note) relates to the ledger mode. No isolate memory was measured for either run.
- The exact owner-visible Events/footer effect of the stop (not part of this card).

## Change in this pull request

- `src/worker.js`: the archive segment writes take the full fence on the first write and then every 8 writes or 20 s (the Discovery lease lives 90 s); the manifest write and the pointer swap keep the full fence; every full fence also calls the EPG step guard, so a step that keeps writing renews its 5-minute lease; sanitized markers `seal_stage_plan`, `seal_stage_archive` (segments, fences, skipped, bytes and the non-overlapping `fenceMs`, `readMs`, `putMs`; an error marker with a closed reason and the counters so far when the loop stops) and `seal_stage_emit`.
- `src/epg-orchestration.js`, `src/domain/orchestration-policy.js`: a lease that ran out is `step_lease_expired` (same stop, same unsafe class, no quarantine, no retry), a moved mode revision or a lost lease stays `epoch_mismatch`.
- Tests: `tests/discovery-bounded-fence.mjs` (fence count against the old one-per-write, time bound with a clock that spends 6 s a write, a lost Discovery lease and a lost step lease stop the archive before the manifest and the pointer, the step guard is part of every full fence, the markers are sanitized; five mutations killed) and `tests/epg-orchestration.mjs` (`lease_expired` → `step_lease_expired`, `lease_lost`, mode and untagged → `epoch_mismatch`, epoch unchanged, no quarantine; two mutations killed).

## Expected effect (a model, not a measurement)

Offline, in `tests/discovery-bounded-fence.mjs`, 33 of 64 segments are rewritten on a 100-row universe and the full fences fall from 35 to 7. For the production commit the same cadence gives about 10 full fences instead of 66. With the fence at 3-4 s and read, serialize and put together at most about 1.3 s per segment (the upper bound the rounds above allow), the archive loop would be at most about 120 s instead of 273 s and `seal_stage` about 195 s instead of 348 s, under the 300 s lease. This estimate needs the next natural bounded run (which requires a separate owner decision) to confirm; no benchmark here reproduces D1 or R2 latency, and Node is not the Workers isolate.

## GO / NO-GO for `bounded` (a recommendation, the decision is the owner's)

- **Code fixes in this PR: GO to merge** (review and CI first). They are fail-closed, change no stored shape, add no flag and are inert while `DISCOVERY_LEDGER_MODE` is unset.
- **Switching `bounded` on again: NO-GO until the owner decides on a measured natural run.** Open points: (1) the first commit still writes 64 segments and 50 MB, at most about 195 s of a 300 s lease by the model above, a margin of about 105 s that is not measured; (2) a steady bounded commit also rewrites most segments each day (4,818 departures a day spread over 64 hashed segments) and reads each one first, as this commit did, so its cost should be like this commit's; (3) isolate memory is unmeasured. Options if the margin is not enough, each needing its own decision: write the segments with bounded parallelism (2-4); make the archive its own resumable step like the ledger seal ([ADR 0092](../../adr/0092-resumable-bounded-ledger-seal.md)); or fewer, larger segments (a format change for new archives).
- **Not authorized and not done here:** any run, flag, retry, lease reset, write or schedule.
