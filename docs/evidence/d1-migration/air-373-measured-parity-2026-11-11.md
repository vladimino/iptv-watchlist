# AIR-373: measured R2 to D1 parity for Film/Person, second measurement (production read, 11 Nov 2026)

**Captured:** 2026-11-11, 11:17 to 11:43 Madrid. **Method:** the connector path ([ADR 0110](../../adr/0110-film-person-operator-copy-and-accepted-discrepancies.md)): D1 read through the Cloudflare Developer Platform connector into a local copy, R2 read with the read-only key, parity computed locally. **Result: MEASUREMENT, NOT A PASS.** The gate verdict of this run was `over_cap:personAlias` (version 1 cap 147), plus operator-evidence slips (the lease start and release times were typed by hand; `lease_not_released`).

This file holds counts and digests only: no id, title, name or payload. It authorizes no production operation. Recording the baseline and moving `r2` to `prepared` remain separate owner GOs, and a seal over this evidence still has to pass the `cutover_accepted` version 2 gate.

## Identity

| Item | Value |
| --- | --- |
| Manifest digest | `cbc6c0566ffefeeaf78b0c76ecb407578aa52b530af701d04d9009e0ce7046d1` |
| Parity ledger digest | `486b60943b23efaeddbe1e48af1cecd54ffed58b396b8ee845a7ba2c33fd051d` |
| Plan digest | `1f9f4da660fbd4783853301443abb23e7d5d8161e406feb938eb3c285425a757` |
| Route | connector path, 39 tables copied |
| Witness checks T0, T1, T2 | all equal; `differs` = 0 in every class |

## Totals

Missing 1,237; extra 6,487; differs 0; explained 6,119; **unexplained 1,605**.

## Per class

| Class | Expected | Actual | Missing | Extra | Differs | Explained | Unexplained | v1 cap (10 Nov) | v2 cap |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| film | 9767 | 9767 | 4 | 4 | 0 | 0 | 8 | 8 | 8 |
| person | 51398 | 52316 | 0 | 918 | 0 | 915 | 3 | 6 | 3 |
| filmExternalId | 10575 | 10567 | 12 | 4 | 0 | 0 | 16 | 16 | 16 |
| personExternalId | 51398 | 51401 | 0 | 3 | 0 | 0 | 3 | 3 | 3 |
| filmAlias | 9923 | 10058 | 5 | 140 | 0 | 0 | 145 | 145 | 145 |
| personAlias | 51400 | 52470 | 0 | 1070 | 0 | 915 | 155 | 147 | 155 |
| credit | 99701 | 103946 | 88 | 4333 | 0 | 4289 | 132 | 132 | 132 |
| filmLocalization | 9767 | 9767 | 4 | 4 | 0 | 0 | 8 | 8 | 8 |
| personLocalization | 51398 | 51401 | 0 | 3 | 0 | 0 | 3 | 3 | 3 |
| watchlist | 394 | 392 | 3 | 1 | 0 | 0 | 4 | 4 | 4 |
| redirect | 11 | 7 | 4 | 0 | 0 | 0 | 4 | 4 | 4 |
| retirement | 4 | 0 | 4 | 0 | 0 | 0 | 4 | 4 | 4 |
| ratedAdmission | 708 | 0 | 708 | 0 | 0 | 0 | 708 | 708 | 708 |
| retention | 401 | 0 | 401 | 0 | 0 | 0 | 401 | 401 | 401 |
| projectionKey | n/a | n/a | n/a | n/a | n/a | n/a | 11 | 11 | 11 |
| **total** | | | | | | | **1,605** | 1,600 | 1,605 |

Against the 10 Nov measurement the only changes are personAlias +8 and person -3 (net +5).

## Operator facts of the run

- The connector copy needed the per-call response budget lowered from 8 MB to 4 MB by hand: an 8 MB response closed the MCP connection twice at the same step.
- The lease was taken and released through the Developer Platform `d1_database_query` tool. The run held the lease for about 26 minutes.
- The lease start and release times were typed by hand, which is why this run's own gate verdict also carried `lease_not_released`. This is operator evidence of the attestation kind described in ADR 0110, not cryptographic proof.

## Consequence

The owner decision of 11 Nov 2026 ("ignore these 5", "finish this time") accepts this measurement; it is recorded as `ACCEPTED_DISCREPANCIES` version 2 in the [ADR 0110 amendment](../../adr/0110-film-person-operator-copy-and-accepted-discrepancies.md#amendment-2026-11-11). Offline tests only for that change; no production access by the change that carries this file.
