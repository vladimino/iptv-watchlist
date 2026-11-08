# Projector exclusive window: dormant implementation evidence (2026-11-08)

**Purpose:** record what the dormant implementation of [ADR 0103](../../adr/0103-projector-exclusive-window.md) covers, how it was checked offline, and what is not yet measured. It is repository evidence from code reading and offline tests only. **No production system was read or written for this page, nothing was applied, and no flag was switched.**

**Not active.** The table of migration `0018` is not applied anywhere. The flag `D1_ENRICHMENT_WINDOW` defaults to `off`. With the table absent or the flag off every Discovery path and the projector behave as before (covered by tests).

## 1. Coverage matrix

| Writer or reader | Quiet by | Test |
| --- | --- | --- |
| Lease holders (Discovery chunk, seal, owner correction, publish handoff) | lease row holds the projector id during `held`, so every lease-fenced batch fails in SQL; admission is closed while `requested` | `tests/projector-window.mjs` sections 2, 4, 5 |
| Lease-free generation writers `writeContinuation`, `writeWorkflow`, `importSegment` | `windowHeldGuard` predicate in the same statement | sections 4 and 5 (structural check of every `generation=generation+1` statement) |
| Stalled former lease holder | its fenced batch fails once the lease row changed owner | section 4 |
| Discovery Workflow state write | typed `discovery_window`, handled softly (no write, no recovery charge) | `tests/projector-window-epg.mjs` section 6 |
| EPG publication (`publishD1Generation`, `publishEpgGeneration`, `stageSealedGeneration`), `epg_sync_step`, seal | typed `ProjectorWindowBusy`, structured 200 busy with `nextCatchUpAt` = deadline + 3 s | `tests/projector-window-epg.mjs` sections 1 to 5 |
| `advanceDiscovery` | `stage:'busy'`, branch `projector_window`, `nextCatchUpAt` = deadline | `tests/projector-window-epg.mjs` section 7 |
| Projector | requests only after the writer-idle checks, runs under the unchanged strict fences plus a per-batch assertion that it owns an unexpired `held` window | `tests/projector-window.mjs` sections 7a to 7j |

A seeded 1,000-tick model is in `tests/projector-window.mjs`. It is a model of the protocol, **not a measurement**.

## 2. R2 side effects of a Discovery chunk (code reading, not a test)

Every R2 write in `src/discovery.js` that touches an object the projector reads (`epg/discovered-films.json`, `programme.json`, `epg/discovery-resolution.json`, the generation copies) goes through `fence()` first. During `held` the lease row names the projector, so a chunk cannot pass it. Under a D1 authority the catalog and decisions are D1-routed and have no R2 source for the projector. The lease-free R2 writers (continuation, workflow state, diagnostics) are not projector inputs: the projector reads only the lease and `sync.json` of those. The projector's own `etag` check stays as backstop and defers with `input_changed`.

**Limit:** this is code reading. No enumerating test proves that no other Discovery path writes a projector input in R2, and that is still open before activation.

## 3. Not measured (do not quote as facts)

- Lease hold times, projector run time under the wait, cut and diff durations; the 300 s, 120 s and 60 s values are proposals.
- The backlog estimate of 16 to 20 ticks and the 800-query figure.
- The interaction with the daily EPG publication at the shared 17:00 Europe/Madrid tick.
- Whether the Workflow idles to the deadline during a window.

## 4. Blocker for activation (owner GO needed, nothing changed)

The external daily ChatGPT Scheduled Task waits about 93 s once and only for `lease_held` on the seal. A window busy answer can last up to the 300 s deadline, so the Task contract does not cover it. The Task prompt was not edited. Changing it, applying the migration and switching the flag are separate owner GOs.
