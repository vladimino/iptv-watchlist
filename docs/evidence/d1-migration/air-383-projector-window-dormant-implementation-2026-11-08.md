# Projector exclusive window: dormant implementation evidence (2026-11-08)

**Purpose:** record what the dormant implementation of [ADR 0103](../../adr/0103-projector-exclusive-window.md) covers, how it was checked offline, and what is not yet measured. It is repository evidence from code reading and offline tests only. **No production system was read or written for this page, nothing was applied, and no flag was switched.**

**Not active.** The table of migration `0018` is not applied anywhere. The flag `D1_ENRICHMENT_WINDOW` defaults to `off`. With the table absent or the flag off every Discovery path and the projector behave as before (covered by tests).

## 1. Coverage matrix

| Writer or reader | Quiet by | Test |
| --- | --- | --- |
| Lease holders (Discovery chunk, seal, owner correction, publish handoff) | lease row holds the projector id during `held`, so every lease-fenced batch fails in SQL; admission is closed while `requested` | `tests/projector-window.mjs` sections 2, 4, 5 |
| Lease-free generation writers `writeContinuation`, `writeWorkflow`, `importSegment` | `windowHeldGuard` predicate in the same statement | sections 4 and 5 (structural check of every `generation=generation+1` statement) |
| Stalled former lease holder | its fenced batch fails once the lease row changed owner | section 4 |
| Discovery Workflow state writes (progress, wait, busy, start, rollover, stop, recovery arming and successor) | typed `discovery_window` becomes a value at every caller; the loop sleeps to the window expiry, retries the checkpoint, charges no stall or recovery | `tests/discovery-workflow.mjs` section 16 (real loop interleavings), `tests/projector-window-epg.mjs` section 6 |
| Window parameters | `requestProjectorWindow` and `grantProjectorWindow` refuse non-finite, non-integer, zero, negative and over-300 s values before any statement; the table repeats the bound as a CHECK | `tests/projector-window.mjs` section 3b |
| R2 writes reachable from Discovery | classified against the projector inputs, guard checked, unclassified or stale sites fail | `tests/projector-window-r2-writes.mjs` |
| EPG publication (`publishD1Generation`, `publishEpgGeneration`, `stageSealedGeneration`), `epg_sync_step`, seal | typed `ProjectorWindowBusy`, structured 200 busy with `nextCatchUpAt` = deadline + 3 s | `tests/projector-window-epg.mjs` sections 1 to 5 |
| `advanceDiscovery` | `stage:'busy'`, branch `projector_window`, `nextCatchUpAt` = deadline | `tests/projector-window-epg.mjs` section 7 |
| Projector | requests only after the writer-idle checks, runs under the unchanged strict fences plus a per-batch assertion that it owns an unexpired `held` window | `tests/projector-window.mjs` sections 7a to 7j |

A seeded 1,000-tick model is in `tests/projector-window.mjs`. It is a model of the protocol, **not a measurement**.

## 2. R2 side effects of a Discovery chunk (structural test)

`tests/projector-window-r2-writes.mjs` finds every R2 write call site (`env.BUCKET.put` or `delete`, `saveJSON`, `mergeStoredJSON`) in the three files that hold the Discovery chunk, Workflow and admin-recovery paths (`src/discovery.js`, `src/discovery-workflow.js`, `src/admin/discovery-recovery.js`; 35 sites). It requires each one to be classified against the projector's own input list, which the test reads from `src/d1-enrichment.js` instead of typing it. It requires the guard (lease fence, lease renewal, D1 compare-and-swap) to stand in the code just before the write, and requires every projector input written there to be routed to D1 under a D1 authority or lease-fenced. A new, unclassified or stale site fails the test, and the projector inputs that are not Discovery's (`metadata.json`, `titles.json`, `people.json`, `watchlist.json`, diary, view index, verified films, owner reviews) must not be named in those files. Mutation check: a `saveJSON(env,'metadata.json',…)` added to `src/discovery.js` fails the test.

Result: the Discovery files write the shared decisions, the catalog and the programme only behind the lease (or D1 routing), and the lease is the row the window takes over. The lease-free R2 writers (continuation, diagnostics, Workflow state) are not projector inputs and carry the `windowHeldGuard` predicate in D1 mode. One quirk found and left as is: the admin recovery writes an R2 copy of `epg/discovery-resolution.json` after renewing the lease; the projector never reads that copy under a D1 authority.

**Limit:** the unit of the test is a file, a conservative superset of what a chunk reaches, not a call graph or a run. Writes made by other files that a chunk calls into (the metadata cache, the Film and Person domain code) are not enumerated here, and no run was instrumented.

## 3. Not measured (do not quote as facts)

- Lease hold times, projector run time under the wait, cut and diff durations; the 300 s, 120 s and 60 s values are proposals.
- The backlog estimate of 16 to 20 ticks and the 800-query figure.
- The interaction with the daily EPG publication at the shared 17:00 Europe/Madrid tick.
- Whether the Workflow idles to the deadline during a window.

## 4. Blocker for activation (owner GO needed, nothing changed)

The external daily ChatGPT Scheduled Task waits about 93 s once and only for `lease_held` on the seal. A window busy answer can last up to the 300 s deadline, so the Task contract does not cover it. The Task prompt was not edited. Changing it, applying the migration and switching the flag are separate owner GOs.
