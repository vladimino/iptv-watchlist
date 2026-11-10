# ADR 0110: A Film/Person baseline may be recorded from an operator copy of D1 with a capped set of accepted discrepancies

**Status:** Accepted  
**Original decision date:** 2026-11-10  
**Recorded at:** 2026-11-10  
**Approval source:** two Product Owner decisions of 2026-11-10 on [AIR-373](https://trello.com/c/ugu3sQmp), quoted in the Decision section as they were handed to the Executor. The headroom of the caps and the list of evidence checks are the implementation of those decisions proposed in the delivering pull request; they are confirmed by its independent review, not by a separate owner statement  
**Related work:** [AIR-373](https://trello.com/c/ugu3sQmp), [ADR 0099](0099-canonical-film-person-d1-authority.md), [measured parity of 10 Nov 2026](../evidence/d1-migration/air-373-measured-parity-2026-11-10.md), [offline evidence](../evidence/d1-migration/air-373-connector-path-offline-2026-11-10.md)  
**Supersedes:** None. ADR 0099 and the `strict` and `cutover_minimum` v1 recording paths are unchanged  
**Superseded by:** None

## Context

ADR 0099 lets the marker leave `r2` only after a verified baseline. Two gates existed: the strict `baselineGate` (zero unexplained differences, every class compared) and `cutover_minimum` v1 (the same, with the owner-link values waived). Both require `source.verified:true`, which only a run through the production HTTP transports of `openProductionSource` can produce.

On 10 Nov 2026 the owner approved a measuring run. The session's D1 API token was refused, so by the owner's instruction D1 was read through the Cloudflare API connector, which only the human-facing operator session can call. The operator copied the tables into a local sqlite file, checked the copy against production, and ran the merged capture and parity against it. The result was 0 differing values and 1,600 unexplained missing or extra rows, of which 1,113 are the three classes whose D1 tables are still empty (`ratedAdmission` 708, `retention` 401, `retirement` 4), with `source.verified:false`. Neither gate can pass such a result, and the bridging code of that day was not reviewed.

## Decision

Two owner decisions of 10 Nov 2026 are implemented as one additional, separately named recording path, `cutover_accepted` version 1. Each decision is a constant in [`src/film-person-cutover-accepted.js`](../../src/film-person-cutover-accepted.js) that a ledger must carry deeply equal; no other text creates the permission.

1. **"ignore the discrepancies and prepare the migration"** is `ACCEPTED_DISCREPANCIES` v1. Unexplained missing or extra rows are accepted up to a per-class cap: the measured count plus 10 percent rounded up, at least 2. A value that differs is never accepted, in any class, explained or not. A class above its cap, a class the constant does not list, or one differing value fails the gate. The acceptance, the measured counts and the caps are inside the ledger and its digest and are shown in the gate result.
2. **"no token is needed, use the same path as before the pause"** is `OPERATOR_COPY_PERMISSION` v1. A source of kind `operator-copy` may be `verified`. The verdict is derived from the evidence files of the run and is not an argument: production equal at three reads for every statement except the Discovery statements, the copy equal to production at the second read, the Discovery tables re-read in one request with the generation equal at its start and end, the production projector lease held by the run at all three reads and released afterwards, unchanged R2 ETags, a complete probe and a consistent read.

Every other rule of `cutover_minimum` v1 applies unchanged; the gate calls the v1 gate and drops only its zero-unexplained reasons. `recordBaselineVerified` reaches the new gate only through `path: {gate: 'cutover_accepted', version: 1}`, with no fallback to or from the other paths, and stores `cutover_accepted/v1:<acceptedDigest>`.

**Not decided here.** No baseline is recorded and the marker is not moved: each is a separate owner GO. Nothing is repaired. The `d1` activation is not authorized, and the accepted empty `ratedAdmission`, `retention` and `retirement` tables stay open gaps for it ([AIR-374](https://trello.com/c/y3oT4gAK), the producer gaps of [AIR-371](https://trello.com/c/gt1afd0C)).

## Alternatives considered

- **Wait for a working D1 token and run the reviewed HTTP path.** It keeps provenance by transport. The owner chose the connector path instead.
- **Owner exceptions per key.** The existing shape `{class, key, reason, approvedBy}` would need 1,600 entries whose keys the measurement did not keep. Rejected for a capped acceptance by class.
- **Repair before recording.** The projector does not write the three empty tables; their producers are later work. The owner chose to prepare the migration first.
- **Relax `cutover_minimum` v1 in place.** Rejected: v1 stays exactly as reviewed, and the stored reference must say which rule passed.

## Consequences

- At `prepared` the projector is still the only canonical writer and R2 still the authority, so the accepted differences change no behaviour there. They are not repaired by being accepted.
- Operator-copy verification is **operator attestation, not cryptographic proof**. The evidence files are plain JSON the operator saved from the connector, and a synthetic test builds such files. The checks stop an incomplete, mixed or moved run from being recorded; they do not authenticate one.
- The D1 side of such a run is a copy taken minutes before the R2 reads. A writer that keeps every witness aggregate is not seen, and the Discovery tables are compared by aggregates only.
- The caps are bound to one measurement. A later run with more differences than a cap fails and needs a new owner decision and a new version of the constant.
- The baseline tooling has a third recording path and a second verification kind to maintain and to mutation-test.

## Recovery and migration boundary

Offline code only. Nothing is bundled into the Worker and no production state changes with this record. Recording a baseline is reversible while the marker is `r2` (`markBaselineLoading` reopens it); `prepared` to `r2` is an allowed marker move under ADR 0099. Each production step (the measuring run with the lease, the baseline record, `r2` to `prepared`) needs its own owner GO.

## Evidence

- **Original decision:** [AIR-373](https://trello.com/c/ugu3sQmp), owner decisions of 2026-11-10
- **Implementation:** [`src/film-person-cutover-accepted.js`](../../src/film-person-cutover-accepted.js), [`scripts/film-person-connector-run.mjs`](../../scripts/film-person-connector-run.mjs), the `cutover_accepted` path of [`src/film-person-baseline.js`](../../src/film-person-baseline.js)
- **Dated verification:** [offline tests and mutation check, 10 Nov 2026](../evidence/d1-migration/air-373-connector-path-offline-2026-11-10.md); [the measurement the caps come from](../evidence/d1-migration/air-373-measured-parity-2026-11-10.md)
- **Uncertainty:** the tool has never run against the real connector or production; the result shape of the connector's `execute` tool and the atomicity of a multi-statement D1 request sent through it are assumed from the D1 HTTP API, not observed

## Follow-ups

[AIR-374](https://trello.com/c/y3oT4gAK) (the `d1` activation) and the producer gaps of [AIR-371](https://trello.com/c/gt1afd0C).
