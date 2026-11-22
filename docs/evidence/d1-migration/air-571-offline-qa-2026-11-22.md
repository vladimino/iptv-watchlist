# AIR-571 offline QA matrix and resource measurements (22 Nov 2026)

Offline evidence for the activation plan ([activation runbook](../../runbooks/letterboxd-activation.md)). Real repository, operator and Worker code on the sqlite D1 stand-in over the whole migration chain, an in-memory R2 stand-in and the bundled Worker in a vm. **No network, no Cloudflare, no production binding or data, nothing provisioned, no live writer.** It is not a runtime measurement and not an approval to activate anything.

## 1. The matrix against the go/no-go package (section 5)

| Requirement | Covered by | Result |
| --- | --- | --- |
| Four authority combinations (EPG checkpoint r2/d1 x Watchlist marker epg/d1) | `tests/letterboxd-qa-matrix.mjs` section 2 | (r2, epg) today: the forward path is refused (`checkpoint_not_d1`, O4 first); (d1, epg): hold and back out work; (d1, d1): a held marker refuses the snapshot, open serves 30 films; (r2, d1) forbidden: every checkpoint-dependent transition refuses, the read side stays independent of the checkpoint |
| EPG step in flight at the marker flip | same file, section 3a; `tests/watchlist-cutover.mjs` sections 3 to 8 | hold refused while the step lease is live or the control phase is running (`writer_active`); proceeds once settled; the guards re-assert liveness inside the batch |
| Failing R2 mirror after the flip | same file section 3b; `tests/watchlist-mirror.mjs` (T24) | three scans commit while the mirror is down; the mirror fails or backs off and never throws into a scan |
| 16:30 slot delayed past the 17:00 EPG start, pin of the last good snapshot | same file section 4 | the delayed slot stays inside its window; the EPG pin taken at 17:00 is version 1 and stays a value after the 17:05 promotion; the next read is version 2; staging is never visible |
| Stale snapshot | same file section 5; `tests/letterboxd-sync.mjs` (read model) | the last good list is served with a warning above 24 hours; no hard TTL |
| Unknown admission | same file section 6; `tests/letterboxd-sync-admission.mjs` | five unknown ids wait in the ledger; the next scan still promotes; an over-full ledger (more than 500 pending) is a visible `admission_ledger_full` refusal that writes nothing |
| Dynamic independence with an active Discovery lease | same file section 7 | a live Discovery lease neither gates a promotion nor is touched by it |
| Rollback and stale writers | `tests/watchlist-cutover.mjs` section 7 to 11; `tests/letterboxd-sync.mjs`; `tests/letterboxd-sync-repository.mjs` sections 8 and 9; `tests/watchlist-mirror.mjs` | covered by the D1, D2, M1 and M2 slices (each reviewed) |
| Root mirror outage over several slots, backlog collapse, `mirror_stale` | `tests/watchlist-mirror.mjs` | one write for the whole backlog; backoff; the signal is visible in the read model |
| Stale or fallback read of the standalone root (T21) | `tests/watchlist-routes.mjs` | a transient D1 fault answers only from a validated standalone mirror, never joined to a programme |
| Two independent Events per slot | `tests/letterboxd-sync-bundle.mjs` | exactly two Events per slot; an Event put failure never blocks a scan |
| Concurrent real admissions of one new Film by Letterboxd (the rated-archive admission, the ratings bridge) and by Discovery, no duplicate Film (T1, T22) | `tests/letterboxd-film-admission-race.mjs`: the REAL canonical Film tables, revision compare-and-swap and receipted writers, with the membership snapshot, the pending ledger and a live Discovery lease beside them | Three interleavings, each ending with exactly one canonical Film `film:tmdb:603`, one trusted tmdb id, one rated admission: (1) the rated admission commits between the Discovery plan and write: the stale Discovery write is refused by the revision CAS, the Discovery retry re-plans to a no-op (no receipt); (2) Discovery first: the stale rated admission is refused, its retry from the current revision admits only the rated row, a second identical admission is an idempotent replay; (3) both started from revision 0 with `Promise.all`, in both orders, the loser retries to the same end state. The pending ledger resolves once (a second settlement is a no-op, one row); the membership snapshot and the Discovery lease are byte-identical before and after |
| The canary hold (the single canary before the four-slot schedule) | `tests/letterboxd-sync.mjs` section 12; `tests/letterboxd-sync-bundle.mjs` (real Worker dispatch) | `ensure` claims only the named slot and records nothing for the others (no claim, no instance, no skipped slot); the hold survives drain, resume and an abort; `open_schedule` is the only way to the full schedule |

## 2. A real defect found and fixed by this QA

`WatchlistD1.publishSnapshot` read the admission ledger with `SELECT ... WHERE lid IN (?, ?, ...)` over EVERY added id. D1 allows 100 bound parameters per statement, so a promotion that added more than 99 ids in one scan (a real possibility after an outage or on a first large change) would have failed with `unavailable` ("too many SQL variables") on a real D1, while the unconstrained stand-in accepted it. The read is now chunked (90 ids per statement, `LIMITS.inChunk`) and `tests/letterboxd-qa-matrix.mjs` section 1 runs the stand-in with the 100-parameter limit emulated (a promotion adding 300 ids passes; the test fails if the chunk is raised). Related finding, not a defect: a first scan that adds more than `pendingCap` (500) unresolved ids is refused (`admission_ledger_full`), so a list of 700 rows enters through the bootstrap import (no ledger rows), not through a scan.

## 3. Resource measurements: a SURROGATE, not a Cloudflare runtime measurement

`node scripts/measure-watchlist-promotion.mjs 700 100` (real `src/watchlist-d1.js` on the sqlite stand-in with the 100-parameter limit emulated, in a private scratch directory).

| Figure | Value (700-row list, 100 films replaced) | Representative of Cloudflare? |
| --- | --- | --- |
| D1 round trips of one promotion | 17 batches + 10 single reads = 27 queries (a batch counts as one query against the per-invocation limit) | **Yes** (counted from the code's own calls) |
| Statements | 1,026 (1,326 when 300 ids are added); the largest batch has 308 statements | Yes |
| Largest statement text and bound parameters | 585 characters; 90 parameters (300 before the fix) | Yes (D1: 100 KB, 100 parameters) |
| Rows inserted | 700 members, 200 changes, 100 pending admissions, 3 effects, 1 staging, 1 snapshot = about 1,005, plus pointer updates; 1,305 when 300 ids are added | Yes (D1 billing is by rows written: the free plan allows 100,000 rows written per day, the paid plan 50 million per month; four slots of at most about 1,300 rows are far below both) |
| A `no_change` scan | 1 batch, 4 statements, no row inserted | Yes |
| Worker-side list work (normalize and SHA-256 of the 700-film list) | about 0.5 ms in Node | **Order of magnitude only** (Node, not workerd) |
| List payload size | about 84 KB for 700 films (the serialized length of the generated list, 86,471 bytes) | Estimate; the Worker limit is 128 MB of memory |
| Wall time and process CPU of the whole promotion | 36 to 53 ms wall, 23 to 41 ms process CPU | **No**: the stand-in spawns a sqlite process per call; Cloudflare D1 latency and workerd CPU are different |
| Heap deltas | not meaningful (garbage collection noise; negative values observed) | No |

**What is NOT measured and not claimed:** workerd CPU time, wall time and memory of a whole slot (the scan of up to 100 Letterboxd pages, the promotion, the effects and the Events), D1 round-trip latency, and Cloudflare Workflow step behavior. Those need a scratch Cloudflare environment (a separate Worker, D1 and R2 with no production binding) and a separate owner-approved plan; none was provisioned. The documented limits that frame them: a scheduled Worker has 15 minutes of wall time and up to 15 minutes of CPU per invocation (the `ensure` tick is one bounded pass), a Workflow step has the configured CPU limit, and D1 allows 100 bound parameters and 50 MB per result.

## 4. Not done here

Real D1 or Miniflare validation of the statements (the `SELECT changes()` result shape inside a batch, the 100-parameter limit, the batch size): not available in this environment, listed as an open item for the scratch Cloudflare plan. The affected-row decoder is strict (an explicit numeric 0 or 1, anything else unproven), so a different real shape fails safe.
