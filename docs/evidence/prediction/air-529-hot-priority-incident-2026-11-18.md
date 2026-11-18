# AIR-529 hot/cold priority incident, 18 November 2026

Status: offline fix and regression test. Production acceptance is pending a natural EPG, Discovery and Prediction run.

## Root cause (code)

`priorityRefreshDue` and `queueAdvanceGate` compared only `programmeRunId`. Discovery inserts `published_epg_show` rows (`basis='discovery'`) into the already published generation, so the completed programme gained showings while the queue kept ranking on the earlier basis. The Discovery comment that the runner "refreshes the queue on every step" was out of date after AIR-431. The incident trigger on the day (a rebuild at 11:56:57 Madrid) is not proven; the incident figures (hot 0 to about 3,000) are as recorded on the card and were not re-read here.

## Fix

- `PublishedEpg.assignedShowsSignature`: one statement reading the exact (film, channel, start) of the run's Discovery rows in generation-index order, hashed with SHA-256. A first version used a numeric aggregate (count, max rowid, sum); independent review showed it misses a reassignment because SQLite reuses a freed rowid, so it was replaced.
- The queue stores `showsSignature`; `batchPreflight` marks priority due on mismatch, on a missing stored value, and on an unreadable current value (`priorityCause`), so a start never silently selects cold when hot outstanding cannot be verified. The dry run reports the cause.
- No new schema or index. A revision counter on the generation would be cheaper per preflight but needs an owner decision and an ADR.

## Evidence

`tests/prediction-hot-reconcile-same-generation.mjs`: reassignment of the only slot to another film, channel and start changes; 3,600 assigned shows hashed by one statement in about 7 ms on the local stand-in (rows read: 3,600 per preflight; D1 production cost is not measured here); 3,200 catalog films under one generation go from 0 hot to 3,100 hot at the next natural start; unreadable signature blocks the cold manifest and the next start recovers; incremental Discovery chunks; an empty queue followed by a new Discovery admission and a same-generation show assignment answers `noop` before the fix and delivers the new film after it (zero quota stays the quota outcome and writes nothing); a signature that lands during a rebuild is picked up by the next start; rollover stays on the existing path.

## Cost bound and revisit trigger

Per batch preflight the signature is one D1 statement that returns the (film, channel, start) of the run's assigned rows (about 60 bytes of text each) and hashes them in Worker memory. At the 6,000 to 7,000 films in the window seen on 18 November that is on the order of 0.4 MB and the same number of rows read; the local stand-in hashes 3,600 rows in about 7 ms, which is a lower bound, not a D1 measurement. A start makes one preflight, plus one more after a rebuild, plus the lease re-check preflight, so up to three reads per start and no read on submit or complete. A hand-measured D1 figure is still owed from an authorized read-only probe. **Revisit** (replace the row hash with a revision counter on the generation, which needs an owner decision and an ADR) when assigned rows per generation pass about 20,000, when a preflight is measured above about 250 ms of D1 wall time, or when rows read per day from this statement exceed a few percent of the D1 daily budget.

## Clock-only transitions

The hot window is `start >= now-72h && start < now+24h` over show starts (lower bound inclusive, upper exclusive). The queue stores `priorityNextChangeAt`, the first instant an outstanding (not retry-exhausted) Film changes class: start-24h+1 ms (cold to hot) or start+72h+1 ms (hot to cold). A natural start whose clock has reached it, and whose queue was last rebuilt at least 15 minutes ago, rebuilds before it selects (`window_transition`).

Review history: the first version recorded the edge one millisecond early, so a rebuild exactly at the edge kept the old class and dropped that edge (fixed). A version without any minimum interval was exact but rebuilt the queue (about 38 D1 queries and one whole-catalog read on the local stand-in) at almost every natural start, because with thousands of outstanding Films an edge passes continuously. That conflicts with the card's "autonomous and cheap batch v2" requirement and has no production measurement.

**Owner decision, 18 November 2026 (given in the AIR-529 session):** the criterion for clock-only changes is relaxed from "hot before the next cold selection" to a **rate cap of 15 minutes between rebuilds**. Accepted consequence: within 15 minutes after a rebuild, a Film that became hot with the clock alone may sit behind cold picks; an edge reached inside the cap is reported by the dry run as `hotBasis` `window_transition_deferred`, never as a verified count. The 15 minutes is an executor choice, not a measured value; revisit it with the production D1 measurement. The relaxation does **not** apply to a changed or unreadable shows signature, which stay immediate.

`tests/prediction-hot-reconcile-same-generation.mjs` controls the clock for `Date.now()` and `new Date()` on one fixed generation and signature: exactly at an edge nothing is due and a rebuild there keeps the next edge scheduled; one millisecond past it, inside the cap, the rebuild is deferred and reported; the first start after the cap reconciles both directions; the third Film's edge inside a later cap is deferred and then reflected; no rebuild without a reached edge. Reintroducing the early edge, or removing the cap, fails the test (checked by hand). An earlier fixture controlled only `Date.now()`, so `refreshedAt` was real time and a restored cap went undetected; the constructor is now controlled too.

## Parity and acceptance

- **Same-semantics parity of hot outstanding (owner-approved scope change, 18 November 2026):** an independent read-only comparison of hot outstanding and the hot queue (window, Film IDs, freshness, retry-exhausted, deferred, eligibility) is **moved out of AIR-529 into a separate follow-up card**. This PR closes the reconciliation and clock criteria only. What is implemented is `hotBasis` in the dry-run answer (`degraded` with the cause), which says that the queue's own count does not rest on a current basis; it is not parity. **AIR-529 must not be marked Done before the follow-up is accepted.** The follow-up card does not exist yet; its creation is for the Planner or Controller.
- Production acceptance (after the natural EPG publication, after same-run Discovery assignments and at the next batch) is pending.

## Limits

D1 production read cost and walltime are not measured; the preflight reads the assigned rows once per batch start. Lost or duplicate checkpoints and CAS conflicts rely on the existing `prediction-queue-cas` and `prediction-queue-discovery-independence` tests. No ADR: local bugfix. No production action was taken.
