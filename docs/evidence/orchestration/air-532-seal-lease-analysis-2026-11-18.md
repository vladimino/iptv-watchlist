# AIR-532: is the Discovery lease needed while `finalize` runs the watchlist retention?

**Date:** 2026-11-18 (UTC). **Method:** code reading of `main` plus the dated [AIR-420 evidence](air-420-seal-finalize-scan-natural-run-2026-11-18.md). No production read, write, flag, Task or lease operation was made for this note. Owner request: comment on [AIR-532](https://trello.com/c/mGPwomMX) of 18 November 2026, Madrid.

## Verdict

**The lease can be narrowed for `finalize_scan`; the data to say by how much, and that it matters, is insufficient.** Nothing in the retention path reads or asserts the lease. What the lease does protect for `finalize` is the single-flight of seal steps on the unfenced `sync.json`. That is a real invariant, so the lease must be replaced by an equivalent fence before it is dropped. This is a recommendation for a separate ADR and owner decision, not a change made here.

## Proven from code

1. **`sealStep` takes the lease for every phase.** `src/worker.js` `sealStep` calls `DiscoveryAuthority.acquireLease(env,{programmeRunId:null,role:'epg'})`, sets `env.discoveryLease`, and releases it in `finally`. `sealFinalizeStep(env,run,deadline)` receives no lease argument.
2. **Retention does not use it.** `persistScan` → `applyRatedAdmissionRetention` → `retainFilm` / `receiptedWrite` contain no reference to `discovery_lease` or `env.discoveryLease`. Their fences are the Film/Person marker generation, the per-Film `canonical_revision`, and the receipt. `leaseOf(env)` is read only inside `src/discovery-authority.js` (Discovery writers) and in `src/discovery.js`.
3. **The other `finalize` units do not use it either.** `persistWatchlist` writes the published watchlist through its own `published_epg` fence (or the R2 mirror), `persistEvents` writes R2 event objects, handover enqueues removal refs. None writes a Discovery table.
4. **What the lease does protect in `finalize`.** `sync.json` is saved with an unconditional `put` (`saveJSON`; no `etagMatches`). The `persistScan` cursor (`run.ratedAdmissionScan.cursor`) and `ratedAdmissionIntent` live in it. Two concurrent seal steps would race on that object. Today the single-flight is the lease for every executor, plus `EpgOrchestration.assertStep` for the Workflow path (`epgStepGuard`, only when `env.epgStep` is set).
5. **Discovery is already paused for most of the run.** [ADR 0135](../../adr/0135-epg-priority-discovery-pause.md): admission of a new Discovery lease closes at 16:55 Madrid and stays closed until the owed day is published and the Discovery pin names that run. `role: 'epg'` is exempt. The pause lifts when the pointer batch writes `madrid_run_key`, which is the `publish` step, so before `finalize`. From then on a Discovery chunk can compete with `finalize` slices for the same row.
6. **Lease TTL is 90 s** (`LEASE_TTL_MS`). A seal step that takes 75–80 s (the full `finalize_scan` slice) holds it for nearly the whole TTL each time.

## Measured (AIR-420, 18 November, not re-measured here)

- 34 `seal_finalize_scan` executions, 2 642 s in total, typical full slice 75–80 s.
- One `step_lease_held` sleep of 175 s after an attempt that the platform killed inside the callback (the dead attempt's lease had to expire first). This is the seal's own lease, not Discovery's.

## Not established

- How long each phase holds the lease on average, and how often Discovery actually found it held between 16:12 and 18:35 on 18 November. The `sleep` reason of the retries and the `acquire` outcome are not logged.
- Whether the 268 s, 211 s and 118 s idle times are the platform or a wait on the lease (stated as unknown in the AIR-420 report).
- Any Discovery starvation. The lease is released between steps; the contention is potential, not shown.

## Options (not decided)

| Option | Gain | Condition |
|---|---|---|
| A. Keep as is | None | The delta and batching already cut `finalize_scan` from ~44 min to a few slices, so each hold becomes short anyway. |
| B. Narrow the hold: take the lease only for the cursor/`sync.json` save, run retention slices outside it | Removes the 75–80 s hold | A replacement single-flight for `sync.json`, e.g. a conditional put (`etagMatches`) of the run record, so a replay of a crashed step reads the saved cursor and re-applies the same request ids. Retention is already idempotent: same request id, receipt, per-Film revision fence, monotonic `observed_at` (ADR 0173). |
| C. No lease in `finalize` | Zero Discovery contention | Same replacement fence as B, plus an ADR: it changes the lease protocol and the guarantee that seal steps are single-flight. |

Crash and retry under B or C: a slice that died after some Film writes leaves receipts and revisions that make the replay a no-op (`noop` or `already`); a cursor not yet saved only repeats no-op work. Concurrent Discovery writes touch other tables and other keys. Generation order is unaffected because retention never moves a generation.

## Recommendation

Do not change the lease in this delivery. First let the delta and batching (ADR 0173 and the read batching) land and measure the real hold per `finalize` slice and the Discovery `busy` rate on a natural run, with bounded observability. Only if the hold stays above a few seconds or Discovery measurably waits, open a separate ADR for B, which needs the owner's decision because it changes the lease and single-flight guarantees.
