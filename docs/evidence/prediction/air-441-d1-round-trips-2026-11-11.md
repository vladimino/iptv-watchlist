# AIR-441: fewer D1 round trips in prediction `next` and `submit`

**Captured:** 11 November 2026 (UTC). **Method:** code reading of `main` at `09d6113`, an offline run of the real Worker code in D1 mode over a sqlite D1 stand-in and an in-memory R2 (`tests/prediction-d1-flow-lib.mjs`), and read-only production reads of `prediction_step_timing` lines and invocation records through Workers Observability. No prediction run, Scheduled Task, flag, lease or writer was started or touched.

This record decides nothing. The production result of the change is a post-deploy gate that is not read yet (section 6).

## 1. What production showed before the change

From the [AIR-438 evidence](air-438-step-latency-and-batch-sizing-2026-11-11.md) telemetry (two natural runs, 130 lines) as reported on the AIR-441 card: in the slow run `next` p50/p95 was 37.8/56.3 s with D1 busy about 23.9 s over about 262 D1 calls, in the fast run 12.3/17.5 s with D1 busy about 1.9 s over about 253 calls. One `next` repeated `schema_contract` about 53 times, `sqlite_master` about 53, `prediction_domain_authority` about 49, `prediction_pointer` and `prediction_fingerprint` about 26 each. Class sums overlap and are not shares of wall time.

A later read of 40 lines on the Worker that follows (a `next` with 239 D1 calls and a `submit` with 103, steady across versions `acb5ad0f` and `c3513423`) shows the same counts.

**The timer.** The AIR-441 card asks whether `unattributedMs: 0` in every line is accurate. It is a property of the Workers clock, not an absence of compute. In the same read, the line's `wallMs` matched the platform's `wallTimeMs` of the invocation within 9 to 74 ms in all twelve pairs checked, while the platform's `cpuTimeMs` for the same invocations was 0.39 to 1.59 s and `unattributedMs` stayed 0. `Date.now()` in a Worker advances across I/O and not during synchronous execution, so the intervals of consecutive calls abut and the remainder is zero whatever the CPU time is. `unattributedMs` therefore does not show compute; the platform's `cpuTimeMs` does. The reference and runbook say so.

## 2. The call graph

Every routed read and every write of a prediction object (`routeRead`, `saveMutable`, `openQueue`, `openLease`, `writeQueue`, `writeLease`, the overlay of the view index) begins with `readPredictionAuthority`, which ran three statements in sequence: `schema_contract` (version), `sqlite_master` (are the ten tables there), and the `prediction_domain_authority` row (mode, generation, queue and profile generation, writes). A `next` makes about forty of these and a `submit` about twenty, which is the repetition seen in production: the three counts are the same call made three times as many times as there are routed operations, not three separate checks. The film state reads (`prediction_pointer`, `prediction_fingerprint`, `prediction_lineage`, one set per selected film) are distinct reads of different rows and are not repeated checks; they are left as they are.

Offline, in D1 mode, selection batch 12, one item per step, on `main` `09d6113`:

| Round trips (a statement on its own or a batch) | `next` | `submit` |
| --- | --- | --- |
| `main` | 189 | 93 |
| Change 1: the three authority statements in one batch | 101 | 47 |
| Change 1 and change 2: the authority answer held for the request | 65 | 34 |

The authority statements are 132 of the 189 in `next` (44 times three) and 69 of the 93 in `submit`. The number of SQL statements is the same after change 1 (205 and 115); only the round trips fall.

## 3. The changes

1. **One batch for the three reads** (`readAuthorityTogether` in `src/prediction-d1.js`). The same three statements, in one D1 batch, which D1 runs in one round trip. Any refusal of the batch (a table of the domain missing, a binding that cannot batch, an answer of another shape) falls back to the old one-at-a-time reading and its classification of failures, so an uninstalled or partly installed domain behaves as before. It reads nothing the old function did not, and its freshness is the old one (a batch is one snapshot, so it is, if anything, more consistent than three statements).
2. **The answer held inside one request** (`scopeRequest`, used by `timedPredictionStep` for `next` and `submit` only). The request's database is wrapped; the first read of the marker is remembered; callers that ask while it is in flight share it; the answer is dropped as soon as the request's own database does anything other than a plain read (only a single `SELECT` with nothing before it is one; a `WITH`, which SQLite allows to end in `UPDATE`, `INSERT` or `DELETE ... RETURNING`, a `PRAGMA`, a commented or multi-statement text, any statement the scope did not prepare itself, a statement run, a batch that is not all such reads, `exec` and a session's write all drop it), and a read that was in flight when that happened is not shared afterwards. The scope lives on that one request's database object: the next request, every other route, the cron tick and every script read the marker afresh. Nothing is kept in the Worker between requests.

**What does not change.** Every write still carries the generation it was read at in its own fenced batch (`UPDATE prediction_domain_authority … WHERE generation=?`, then the fence statement), the lease and epoch fences, the CAS of the queue, the retry bounds of ADR 0064, the queue and priorities, content, prompts, `prediction_validate`, retry, lease semantics, the D1 and R2 authority split and model batching.

## 4. What it can and cannot miss

The held answer carries the schema version, the table list and the marker (mode, generation, queue and profile generation, writes). What a write checks, and what a transition under a request therefore does:

| Transition from outside, between the read and the request's write | Result for the write | Why |
| --- | --- | --- |
| The generation moved | fails closed (`prediction_domain_cas`), nothing written; the failed write drops the held answer and a retry lands | the write is `UPDATE prediction_domain_authority ... WHERE mode='d1' AND generation=?` followed by the fence statement in one batch |
| The mode reverted to `r2` without a generation change (the real revert statement does not change it) | fails closed, nothing reaches D1; a request without the scope would instead re-route to the R2 path | the same statement carries `mode='d1'` |
| `writes` set to `held` while the mode is `d1` | lands, exactly as without the scope | no D1 write checks `writes`; the field only gates the R2 mode (`mode='r2' AND writes='open'`) |
| The schema version raised | lands, exactly as without the scope | nothing a write does depends on a higher version |
| The schema version lowered | refused by the database (`schema_contract_downgrade` trigger) | an enforceable migration contract, not a property of this change |
| A table the write needs dropped | the write fails, the batch is rolled back | SQL error inside one batch |
| A table the write does not need dropped | the write lands for the rest of that request; a fresh read would refuse the whole domain | **the one case the scope tolerates that a fresh read would not.** Migrations only add tables ([migrations README](../../../migrations/README.md)), so this is a contract violation, not a path of the system |

What change 2 can miss is a routed **read** inside the same request after such a change, for at most the length of the request (seconds, bounded by the lease of the step). Mode moves are owner operations under their own holds; a request that holds mode `d1` while the mode is reverted writes nothing. The owner can drop change 2 by reverting its commit alone; change 1 stands without it (65 to 101 and 34 to 47 round trips).

## 5. What the tests prove (`tests/prediction-authority-scope.mjs`)

- The three facts come in one batch and equal the stepwise queries; a binding that cannot batch and a refused batch give the same answer.
- Write detection fails closed: a mutating `WITH` through `all()` and `first()`, `UPDATE ... RETURNING`, a commented, lowercase or newline-prefixed statement, two statements in one text, a `PRAGMA` (setting or reading) in a batch, and a statement the scope did not prepare all drop the held answer; a plain `SELECT` (trailing semicolon, spaces, a subquery) keeps it.
- The scope: two sequential reads, one batch; ten concurrent reads, none beyond the first; a read-only batch keeps the answer; a statement run, a write batch, a session's write and `exec` drop it; a write that happens while a read is in flight keeps that read from being shared after it; scopes are independent; no scope, no reuse.
- A marker that moved under the request: the next write fails with `prediction_domain_cas` and writes nothing; the retry succeeds; a reverted mode makes the write fail closed and nothing reaches D1; a new request sees the new mode at once. Every row of the table in section 4 is a case, each compared with the same request in a world without the scope.
- The same run with and without the scope gives the same answers and the same stored state down to the authority generation, with 36 % fewer round trips in `next` and 28 % fewer in `submit` (the baseline of that comparison already has change 1: 101 → 65 and 47 → 34).
- An interleaved writer that moves the marker just before a step's first write changes nothing about how the step ends, with or without the scope.
- Lease expiry, two steps at once, and a crash with its replay end the same way with and without the scope: an expired runner lease gives the same answer and predicts nothing; two concurrent steps give 200 and 409 either way; a process that dies at the second write batch of a submit stops the run (502), a new run offers the same film, the replay creates it once and a second replay is `already_current`.
- Existing suites keep covering the lease, replay, crash and CAS cases: `prediction-queue-cas`, `prediction-start-diagnostics`, `continuous-drain`, `lease-recovery`, `prediction-domain`, `prediction-domain-production` (whose two race fixtures now target write batches, because the authority read is itself a batch).

## 6. Acceptance gate (not passed)

After the deploy, two natural Prediction runs are read without starting anything: `prediction_step_timing` lines grouped by Worker version, the D1 count per `next` and `submit` (production before: about 239 and 103), and p50/p95 of `wallMs` with the regional latency noted. The expected direction, from the offline counts, is about 189 → 65 for `next` and 93 → 34 for `submit` in this fixture's units; production counts differ (per-film reads, the programme read through D1) and no speed is promised.

## 7. Not known

The production latency per D1 round trip and so the wall time the removed trips were worth (the slow and fast runs differ by 12 times in D1 busy time for the same call count); whether the remaining film-state reads (13 pointer and 13 fingerprint per `next` at selection 12) are the next largest D1 cost; behaviour under a real marker move during a production step (the tests use a stand-in).
