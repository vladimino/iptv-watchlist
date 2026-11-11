# AIR-373: Film/Person baseline recorded and marker moved `r2` to `prepared` (production writes, 11 Nov 2026)

**Captured:** 2026-11-11, measuring run 10:17 to 10:44 UTC, baseline record at about 10:57 UTC, transition immediately after (times in UTC; Madrid is UTC+1 in November). **Method:** the connector path of [ADR 0110](../../adr/0110-film-person-operator-copy-and-accepted-discrepancies.md): D1 read through the Cloudflare Developer Platform connector into a local copy, R2 read with the read-only key, parity computed locally, sealed with the `cutover_accepted` gate version 2. **Result: BASELINE `verified` AND MARKER `prepared`, generation 1.** Each write was a separate owner GO and was read back.

This file holds counts, digests and times only: no id, title, name or payload. The measurement itself is in [the second measurement](air-373-measured-parity-2026-11-11.md); this file records the seal and the two writes that followed.

## Sealed run

| Item | Value |
| --- | --- |
| Path | connector path, 39 tables copied |
| Plan digest | `1f9f4da660fbd4783853301443abb23e7d5d8161e406feb938eb3c285425a757` |
| Manifest digest | `cbc6c0566ffefeeaf78b0c76ecb407578aa52b530af701d04d9009e0ce7046d1` |
| Parity ledger digest | `486b60943b23efaeddbe1e48af1cecd54ffed58b396b8ee845a7ba2c33fd051d` |
| Final cutover ledger digest | `cdf15361919d22f6b04fbd59155711f8e86065e5046e0d5985a2666c558811da` |
| `cutoverDigest` | `2520d5318d80bb5429740b1b56696469e95158fbb3058df9403bcc6782be52bf` |
| `acceptedDigest` | `732b9768abcd3b0c2c460a9b0766b25aa1fbe472daed7a93393dbbe073a97cb5` |
| Evidence times | T0 10:17:15Z, T1 10:36:36Z, resync 10:37:07Z, T2 10:43:40Z |
| Totals | missing 1,237; extra 6,487; differs 0; explained 6,119; unexplained 1,605 |
| Gate `cutover_accepted` version 2 | `gatePass` true, `verified` true, no reasons |

The first seal, with the version 1 constant, was refused with `over_cap:personAlias` (155 against 147) and `operator_copy:lease_not_released` (the hand-typed release time was earlier than T2). After PR #518 (gate version 2) and a release timestamp set after T2, the seal was re-run on the **same files**; no second snapshot was taken.

## Operator facts

- The connector response budget was lowered by hand from 8 MB to 4 MB: the 8 MB response closed the MCP connection twice at the same step.
- The projector lease statements ran through the Developer Platform `d1_database_query` tool. The lease was taken at 10:17 UTC; the row's `started_at` reads 10:18:00Z because the operator typed the lease timestamps by hand. It was released after T2; the release time in the evidence file (10:43:50Z) was typed by hand as an estimate after T2, and the readback showed the lease empty.
- The copy took about 19 minutes; the whole run held the lease about 26 minutes.

## Baseline record

Owner GO, 2026-11-11 about 10:5x UTC; the batch `at` value was `2026-11-11T10:57:37.000Z`.

- Pre-check just before: marker `r2` / `open` / generation 0, baseline empty, projector lease free, window idle.
- One request, 4 statements (two fence assertions at generation 0, `loading`, `verified`), each changing 1 row.
- Reference stored: `cutover_accepted/v2:732b9768abcd3b0c2c460a9b0766b25aa1fbe472daed7a93393dbbe073a97cb5`. Batch digest `302a24b65fb22873adf6281b8dfbe39bdc7d2f1f0efcfdbfc34b26cbf375cdd9`.
- Readback: baseline `verified` with that reference, fence `ok` = 1, marker `r2` / `open` / 0.

## Transition `r2` to `prepared`

Separate owner GO, immediately after the record.

- One request, 2 statements: the `UPDATE` guarded by mode `r2`, cutover `open`, generation 0; then the fence. Batch digest `cabc121d2d6cf5f3bd1429ae95b2a1a92865baeb8fe284bb0fa14ca518c67ca2`.
- Readback: marker `prepared` / `open` / generation 1, fence `ok` = 1, baseline still `verified` with the same reference.

## What this does not prove

- The evidence is operator attestation, not cryptographic proof (ADR 0110).
- R2 and D1 were not read as one snapshot, and the D1 side of the parity was a copy.
- "Production unchanged" covers only the measurement window (10:17 to 10:44 UTC). The record and the transition were written later; the fence checks the marker and the baseline, not the data.
- Owner-link values were not compared.
- The empty `ratedAdmission`, `retention` and `retirement` tables (708 + 401 + 4 accepted gaps) stay open for [AIR-371](https://trello.com/c/gt1afd0C) and [AIR-374](https://trello.com/c/y3oT4gAK).
- The hourly projector ticks now run with the marker `prepared`; that has not been observed yet.

## Consequence

`prepared` changes no behaviour: the projector stays the only writer of Film and Person and R2 stays the authority. No scheduled task, flag or cron was changed. Moving to `open` and the `d1` activation need their own owner decisions and plans ([AIR-374](https://trello.com/c/y3oT4gAK)).
