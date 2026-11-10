# AIR-373: `cutover_minimum` baseline gate, offline tests

**Captured:** 2026-11-10, local runs of `node tests/film-person-cutover-minimum.mjs` and `node tests/film-person-cutover-minimum-mutation.mjs`. **Method:** pure synthetic ledgers; no sqlite stand-in, no Worker. **No production access of any kind:** no R2 request, no D1 statement, no Cloudflare API call, no IPTV MCP call, no marker or baseline write.

**Result:** the gate ([`src/film-person-cutover-minimum.js`](../../../src/film-person-cutover-minimum.js), inactive and not bundled) passes its tests, and each of its 53 mutants (one guard removed or inverted) is killed. This is evidence about the code, not about production. Decision of the coordinator, 10 Nov 2026; the runbook section is [the `cutover_minimum` gate](../../runbooks/film-person-baseline.md#the-cutover_minimum-gate-offline-code-nothing-executed).

## What the tests prove

| Property | Test case |
| --- | --- |
| A complete, consistent, verified cut with the pinned waiver passes and reports `accepted` and `notProved` | `accepted` names the one waiver; `notProved` lists the non-atomic R2 + D1 read, the uncompared link values, the separate recording step and (without a reconstructed key set) the missing source parity |
| The strict gate is unchanged | the same ledger still fails `baselineGate` with `class_unavailable:ownerLink`, and `recordBaselineVerified` refuses it |
| An unavailable or missing required class fails | each of the 15 classes, both as `unavailable` and as absent |
| An unexplained difference fails | a differing value, a missing key and an extra key |
| Owner-review keys | a missing and an extra key against a reconstructed set fail; a tampered key digest fails; an unreconstructed set is not declared equal and is named in `notProved`; link values may differ |
| Owner-review facts | changed facts, missing facts, a count mismatch and a non-`d1` authority fail |
| Unauthorized waiver | a free-text decision, an arbitrary `approver: 'owner'` with free text, another scope, another class, a wrong approver, a wrong id, an extra field, a string, a second unrelated waiver, a missing waiver and a duplicate all fail; nothing is accepted on a failure |
| Tampered digest | a changed waiver, total, class digest, `notProved` or `accepted` fails; a forged waiver with a recomputed digest still fails against the pinned constant |
| Unverified source | `verified:false` (the Stage B shape), a malformed digest, no source and a manifest mismatch fail; a plain Stage B ledger without the section fails |
| A changing source | an R2 ETag, a D1 generation, a D1 published ETag, a missing D1 identity, the witness, a lost fence, a lost lease and an incomplete probe fail; absent evidence fails closed |

## What is not proved

- Nothing was read from production. Real counts, sizes and the live owner-review key set are unmeasured.
- R2 and D1 are not read in one mathematically atomic snapshot; the gate detects a change but does not make the two reads one instant.
- The `ownerLink` link values are not compared, by the owner decision pinned in code; without an independent reconstruction the owner-review keys are checked for preservation, not for source parity.
- No baseline was recorded. A pass authorizes nothing: the baseline write, the real capture and parity run and `r2` to `prepared` stay separate owner-approved production steps. The producer wiring and the AIR-371 gaps are out of scope.

## Editorial correction

The runbook and the evidence index named 22 mutants for the Stage B capture check; the check has 37 (as the Stage B report already said). Both now say 37.
