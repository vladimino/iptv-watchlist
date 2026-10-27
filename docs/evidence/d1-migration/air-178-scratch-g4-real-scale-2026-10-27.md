# Staged generation import G4 at 125% of the real scale on the scratch D1 (synthetic, schema v3)

**Captured:** 2026-10-27, 09:26:47–09:32:49 UTC, code at `main` `a7fed6a` ([PR #144](https://github.com/vladimino/iptv-watchlist/pull/144); schema v3 from [PR #143](https://github.com/vladimino/iptv-watchlist/pull/143)), `node scripts/d1-scratch-g4.mjs --run --approved-scratch-writes --scale real` on the owner's machine  
**Scope:** the existing isolated scratch database `iptv-atomicity-scratch` only, synthetic generations generated locally; no R2 read, no request to the database `iptv`, no production payload, no Task, flag, Access or Worker change  
**Verdict:** **GO** for the staged generation unit at 64,554 candidates (125% of the AIR-175 production generation's 51,643): every step passed, the commit took **1.4 s client / 0.72 s D1 server** against the 10 s bound, and all eight final tables equal the legacy writer's reference row for row, including the earlier AIR-174 history  
**Used by:** [AIR-178](https://trello.com/c/rpRDyobZ), [ADR-0021](../../adr/0021-staged-atomic-generation-import.md) GO/NO-GO gate at the real scale, [AIR-74](https://trello.com/c/5AdAmKPe) G4; follows the [AIR-174 run](air-174-scratch-g4-2026-10-26.md)

This is a scratch result with synthetic generations. It is a **synthetic GO**, not a live-baseline GO: it proves the staged path, the schema v3 identity and the commit budget at the measured size, and authorizes no production write.

## Approvals and commands

The owner approved exactly one bounded G4 run at the real scale on this database (AIR-178 card), and, separately, applying migration `0003` to `iptv-atomicity-scratch` only (recorded on the card, 2026-10-27). `--cleanup` was not approved and was not run. Full reports (`report.json`, `requests.jsonl`) are kept privately outside the repository; this page holds aggregates only.

| Step | Status | Requests | Result |
| --- | --- | --- | --- |
| Post-merge CI of `a7fed6a` | success | — | Test and build, Deploy to Cloudflare |
| `--preflight` | completed | 19, **0 writes** | Live name and uuid equal the configured scratch database; schema version 2; `0001` 42/42 and `0002` 6/6 objects, `0003` 0/2; AIR-174 stages as left (`g4-prior` superseded, `g4-scaled` published, `g4-rival` failed); final tables exactly the AIR-174 history (27,749 candidates, 99,896 candidate shows) |
| `--apply-schema --approved-scratch-writes` | completed | 59: 1 schema write, 55 reads, 3 describes | Only `0003` applied, as one request; schema version 3; both unique identity indexes present; every final row kept (99,896 candidate shows) |
| `--run --scale real` | **GO** | 895 requests: 284 writes, 611 reads; 891 × `200`, 4 × `400` (all expected, below); no `429`/`5xx`, no transport error | 6 min 2 s wall time, including two claim-expiry waits of 57.2 s and 59.6 s |

The four `400` responses are the scenario's intended refusals: the chunk with a failing last statement, the stale claimant's commit and the repeated commit (both logged as harness writes), and the stale-pointer stage's commit. The view `published_film_show` is still listed as an object outside the migrations: `CREATE VIEW` is not counted by the harness's object model. That is a reporting gap, not a foreign object.

## Shape (scale `real`)

| Generation | Run id | Candidates / films | Rows | Bytes | Chunks | Largest chunk | Largest row |
| --- | --- | --- | --- | --- | --- | --- | --- |
| prior | `g4r-prior` | 51,643 / 2,300 | 110,194 | 61,170,840 | 117 | 546,725 bytes | 883 bytes |
| scaled (125%) | `g4r-scaled` | 64,554 / 2,300 | 136,016 | 76,270,744 | 144 | 548,146 bytes | 892 bytes |
| rival (stale pointer) | `g4r-rival` | 40 / 4 | — | — | 1 | — | — |

One show per candidate (production has 0.63), two per film, and eight candidates whose slot carries a second EPG title with the same channel, start and end (the schema v3 / [ADR-0025](../../adr/0025-candidate-show-identity.md) case). The prior generation replaced the AIR-174 pointer (`g4-scaled`), so the run exercised a non-empty database.

## Commit at 125% (GO criterion: ≤ 10 s)

| Measure | Value |
| --- | --- |
| Commit request | 12 statements, 4,692 bytes, HTTP `200` |
| Client wall time of the commit request | **1,392 ms** |
| D1 server time (sum of `meta.duration`) | **719.1 ms** |
| Stage code's `commitMs` | 1,690 ms (includes the stale-claimant fence probe run just before the commit) |
| Prior generation commit (51,643 candidates) | 1,353 ms client, 533.9 ms server |

At 2.3× AIR-174's 1.25× size the commit grew from 0.66 s to 0.72 s of D1 server time: it is dominated by fixed work, not by the rows it moves.

## Requests and timings

| Kind | Count | Client ms (total) | D1 server ms (total) |
| --- | --- | --- | --- |
| chunk | 263 (262 accepted) | 74,195 | 14,000.0 |
| read | 610 | 117,874 | 16,551.4 |
| commit | 3 (2 accepted, 1 refused) | 2,807 | 1,253.0 |
| validate / open / claim | 3 / 3 / 3 | 470 / 295 / 279 | 134.7 / 0.8 / 0.5 |
| seed_films / fail / direct_write | 5 / 1 / 3 | 363 / 91 / 200 | 5.1 / 0.2 / 0.1 |

Accepted chunks: client p50 270 ms, p95 337 ms, max 1,851 ms; D1 server p50 53.6 ms, p95 65.0 ms, max 88.0 ms; largest chunk request 549,491 bytes. `g4r-scaled` after the takeover: the remaining 72 chunks staged in 24.1 s, validation 0.2 s, staged read-back 7.2 s, commit 1.7 s (stage code), committed read-back 6.9 s.

## Steps

All thirteen passed: seed films; prior generation committed; a chunk with a failing last statement rolled back whole (no staged row, no receipt); a second executor refused while a claim was live; interruption before chunk 72 of 144; takeover after claim expiry resumed after the 72 receipts; the stale claimant could neither fail nor commit; commit within budget; staged read-back equal; repeated commit refused; stale-pointer stage refused with nothing written; rerun is a replay; final tables equal to the reference.

## Parity

The legacy `publishGeneration` wrote the AIR-174 history (`g4-prior`, `g4-scaled`) and then `g4r-prior` and `g4r-scaled` into a local SQLite reference built from migrations `0001`–`0003`. Every final table is equal row for row:

| Table | Rows (scratch = reference) |
| --- | --- |
| `programme_generation` | 4 |
| `published_generation` | 1 |
| `film_generation` | 9,200 |
| `film_show` | 18,400 |
| `film_epg_last_airing` | 2,300 |
| `candidate` | 64,554 |
| `candidate_generation` | 166,145 |
| `candidate_show` | 216,109 |

## Limits

- Synthetic data: one show per candidate rather than the production distribution; the real generation's titles, keys and show spread differ. A live-baseline import is AIR-74's G5 and needs its own approvals.
- Not tested here: prediction version objects (AIR-179) and the class C acknowledgement (AIR-180), both still AIR-74 blockers.
- Staging rows of the superseded and failed stages of both runs (`g4-prior`, `g4-rival`, `g4r-prior`, `g4r-rival`) remain until an approved cleanup.
- Client times are from the owner's machine; most client time is network round trip, not D1 work.
