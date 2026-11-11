# ADR 0110: A Film/Person baseline may be recorded from an operator copy of D1 with a capped set of accepted discrepancies

**Status:** Accepted  
**Original decision date:** 2026-11-10 (owner approval and independent code review)  
**Recorded at:** 2026-11-10  
**Approval source:** the Product Owner decisions on [AIR-373](https://trello.com/c/ugu3sQmp) and [PR #501](https://github.com/vladimino/iptv-watchlist/pull/501#issuecomment-6780196358) approving the operator-copy path and exact measured caps, with the missing-evidence guard independently verified in the [successful exact-HEAD re-review](https://github.com/vladimino/iptv-watchlist/pull/501#pullrequestreview-5850223602) on `62e640425d49778be907a1419484a1127d44ef3d`  
**Related work:** [AIR-373](https://trello.com/c/ugu3sQmp), [ADR 0099](0099-canonical-film-person-d1-authority.md), [measured parity of 10 Nov 2026](../evidence/d1-migration/air-373-measured-parity-2026-11-10.md), [offline evidence](../evidence/d1-migration/air-373-connector-path-offline-2026-11-10.md)  
**Supersedes:** None. ADR 0099 and the `strict` and `cutover_minimum` v1 recording paths are unchanged  
**Superseded by:** None

## Context

ADR 0099 lets the marker leave `r2` only after a verified baseline. Two gates existed: the strict `baselineGate` (zero unexplained differences, every class compared) and `cutover_minimum` v1 (the same, with the owner-link values waived). Both require `source.verified:true`, which only a run through the production HTTP transports of `openProductionSource` can produce.

On 10 Nov 2026 the owner approved a measuring run. The session's D1 API token was refused, so by the owner's instruction D1 was read through the Cloudflare API connector, which only the human-facing operator session can call. The operator copied the tables into a local sqlite file, checked the copy against production, and ran the merged capture and parity against it. The result was 0 differing values and 1,600 unexplained missing or extra rows, of which 1,113 are the three classes whose D1 tables are still empty (`ratedAdmission` 708, `retention` 401, `retirement` 4), with `source.verified:false`. Neither gate can pass such a result, and the bridging code of that day was not reviewed.

## Decision

Accepted: one additional, separately named recording path, `cutover_accepted` version 1. Each owner input is a constant in [`src/film-person-cutover-accepted.js`](../../src/film-person-cutover-accepted.js) that a ledger must carry deeply equal; no other text creates the permission.

1. **"ignore the discrepancies and prepare the migration"** and **"exact measured numbers"** are `ACCEPTED_DISCREPANCIES` v1. Unexplained missing or extra rows are accepted up to a per-class cap that is exactly the count measured on 10 Nov 2026 (`caps` equals `measured` per class, 1,600 in total). There is no headroom: one row more in any class fails and needs a fresh owner approval and a new version of the constant. A value that differs is never accepted, in any class, explained or not. A class the constant does not list fails. The acceptance, the measured counts and the caps are inside the ledger and its digest and are shown in the gate result.
2. **"no token is needed, use the same path as before the pause"** is `OPERATOR_COPY_PERMISSION` v1. A source of kind `operator-copy` may be `verified`. The verdict is derived from the evidence files of the run and is not an argument: production equal at three reads for every statement except the Discovery statements, the copy equal to production at the second read, the Discovery tables re-read in one request with the generation equal at its start and end, the production projector lease held by the run at all three reads and released afterwards, unchanged R2 ETags, a complete probe and a consistent read. The statement set is fixed by reviewed constants (every witness statement, every gate statement and one row count per table of the copy plan), never by the evidence: each must be present at all three reads and in the copy comparison, and an unknown statement is refused.

Every other rule of `cutover_minimum` v1 applies unchanged; the gate calls the v1 gate and drops only its zero-unexplained reasons. `recordBaselineVerified` reaches the new gate only through `path: {gate: 'cutover_accepted', version: 1}`, with no fallback to or from the other paths, and stores `cutover_accepted/v1:<acceptedDigest>`.

**Not decided here.** No baseline is recorded and the marker is not moved: each is a separate owner GO. Nothing is repaired. The `d1` activation is not authorized, and the accepted empty `ratedAdmission`, `retention` and `retirement` tables stay open gaps for it ([AIR-374](https://trello.com/c/y3oT4gAK), the producer gaps of [AIR-371](https://trello.com/c/gt1afd0C)).

## Conditions for acceptance

The owner-required conditions for accepting this ADR have both been met, as documented by the [owner decision](https://github.com/vladimino/iptv-watchlist/pull/501#issuecomment-6780196358) and [successful independent re-review](https://github.com/vladimino/iptv-watchlist/pull/501#pullrequestreview-5850223602) on the updated exact HEAD:

- the missing-evidence guard is fixed (the required statement set comes from the reviewed copy plan, not from the keys of the supplied evidence);
- an independent, successful re-review of the updated exact HEAD is recorded.

The capped acceptance and the operator-attestation semantics are owner decisions. A review approval does not authorize any further discrepancy tolerance, and no reviewer confirms caps or attestation on the owner's behalf.

## Alternatives considered

- **Wait for a working D1 token and run the reviewed HTTP path.** It keeps provenance by transport. The owner chose the connector path instead.
- **Owner exceptions per key.** The existing shape `{class, key, reason, approvedBy}` would need 1,600 entries whose keys the measurement did not keep. Not chosen; a capped acceptance by class was selected instead.
- **Repair before recording.** The projector does not write the three empty tables; their producers are later work. The owner chose to prepare the migration first.
- **Relax `cutover_minimum` v1 in place.** Not chosen: v1 stays exactly as reviewed, and the stored reference must say which rule passed.
- **Caps with headroom above the measurement.** The first revision of the delivering pull request proposed the measured count plus 10 percent. The owner rejected it: the caps are the exact measured counts.

## Consequences

- At `prepared` the projector is still the only canonical writer and R2 still the authority, so the accepted differences change no behaviour there. They are not repaired by being accepted.
- Operator-copy verification is **operator attestation, not cryptographic proof**. The evidence files are plain JSON the operator saved from the connector, and a synthetic test builds such files. The checks stop an incomplete, mixed or moved run from being recorded; they do not authenticate one.
- The D1 side of such a run is a copy taken minutes before the R2 reads. A writer that keeps every witness aggregate is not seen, and the Discovery tables are compared by aggregates only.
- The caps are the measurement of one day with no margin. A later run with one more unexplained row in any class fails and needs a new owner decision and a new version of the constant.
- The baseline tooling has a third recording path and a second verification kind to maintain and to mutation-test.

## Recovery and migration boundary

Offline code only. Nothing is bundled into the Worker and no production state changes with this record. Recording a baseline is reversible while the marker is `r2` (`markBaselineLoading` reopens it); `prepared` to `r2` is an allowed marker move under ADR 0099. Each production step (the measuring run with the lease, the baseline record, `r2` to `prepared`) needs its own owner GO, and none is authorized by this record or by the owner decision on PR #501.

## Evidence

- **Owner inputs:** [AIR-373](https://trello.com/c/ugu3sQmp), owner decisions of 2026-11-10; [owner decision on PR #501](https://github.com/vladimino/iptv-watchlist/pull/501#issuecomment-6780196358)
- **Implementation:** [`src/film-person-cutover-accepted.js`](../../src/film-person-cutover-accepted.js), [`scripts/film-person-connector-run.mjs`](../../scripts/film-person-connector-run.mjs), the `cutover_accepted` path of [`src/film-person-baseline.js`](../../src/film-person-baseline.js)
- **Dated verification:** [offline tests and mutation check, 10 Nov 2026](../evidence/d1-migration/air-373-connector-path-offline-2026-11-10.md); [the measurement the caps are](../evidence/d1-migration/air-373-measured-parity-2026-11-10.md)
- **Uncertainty:** the tool has never run against the real connector or production; the result shape of the connector's `execute` tool and the atomicity of a multi-statement D1 request sent through it are assumed from the D1 HTTP API, not observed

## Follow-ups

[AIR-374](https://trello.com/c/y3oT4gAK) (the `d1` activation) and the producer gaps of [AIR-371](https://trello.com/c/gt1afd0C).

## Amendment 2026-11-11

The text above stays as accepted on 2026-11-10; this section changes only the constant of decision 1 and what depends on its version.

**Why.** A second production measurement on 11 Nov 2026 (11:17 to 11:43 Madrid; every witness check at T0, T1 and T2 equal, `differs` 0 in every class) found the unexplained count equal to the version 1 cap in every class except two: personAlias 155 (v1 cap 147, +8) and person 3 (v1 cap 6, -3), total 1,605 against 1,600. The run's gate verdict was `over_cap:personAlias`, so a baseline could not be recorded from it. The [measurement](../evidence/d1-migration/air-373-measured-parity-2026-11-11.md) is dated evidence.

**Owner decisions of 11 Nov 2026** (chat, AIR-373): "ignore these 5" and "finish this time", meaning accept the five rows over the 10 Nov total, i.e. accept this measurement. The decision keeps "exact measured numbers": no headroom.

**Change.**

- `ACCEPTED_DISCREPANCIES` is now **version 2**, id `AIR-373-accepted-discrepancies-2026-11-11`, with `measured` and `caps` the 11 Nov counts: film 8, person 3, filmExternalId 16, personExternalId 3, filmAlias 145, personAlias 155, credit 132, filmLocalization 8, personLocalization 3, watchlist 4, redirect 4, retirement 4, ratedAdmission 708, retention 401, projectionKey 11; total 1,605; `differs` 0 everywhere. The decision text records both owner decisions.
- **person is lowered from 6 to 3.** That is the measured value, and "exact measured numbers" is applied literally. The owner did not say to keep 6; if the cap for person should stay 6, that is a separate owner decision and a further version.
- `cutover_accepted` becomes **gate version 2** (`CUTOVER_ACCEPTED_VERSION`, `RECORDING_PATHS.cutover_accepted` = `{gate: 'cutover_accepted', version: 2}`, reference `cutover_accepted/v2:<acceptedDigest>`, the version is covered by `acceptedDigest`). Rationale: the constant, the gate and the stored reference then carry one version, as for `cutover_minimum`. A path `{gate: 'cutover_accepted', version: 1}` is now `baseline_path_invalid`, a ledger with a version 1 section fails `cutover_accepted_missing`, and a ledger carrying the version 1 constant fails `acceptance_not_permitted`. Version 1 is therefore no longer accepted anywhere.
- Unchanged: the strict gate, `cutover_minimum` v1, `OWNER_LINK_WAIVER`, `OPERATOR_COPY_PERMISSION` v1 and every other rule of the gate.

**What this does not authorize.** No production operation. Recording the baseline and `r2` to `prepared` remain separate owner GOs, and a seal over the 11 Nov evidence still has to pass the version 2 gate (the 11 Nov run itself also had operator-evidence slips, such as hand-typed lease times and `lease_not_released`, so it is not a pass). A later run with one more unexplained row in any class fails again and needs a new owner decision and version 3.

**Executed 2026-11-11 (UTC).** The version 2 gate sealed the run of 10:17 to 10:44 UTC (gate pass, no reasons) after the first seal was refused with `over_cap:personAlias` and a hand-typed lease release time; the seal was re-run on the same files. The baseline was recorded as `verified` (reference `cutover_accepted/v2:<acceptedDigest>`) and the marker moved `r2` to `prepared` (generation 1), each on its own owner GO with a readback. The record is operator attestation, not cryptographic proof, and R2 and D1 were not one snapshot. See the [dated evidence](../evidence/d1-migration/air-373-baseline-prepared-2026-11-11.md). The text above is unchanged.
