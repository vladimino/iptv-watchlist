# AIR-448: size and cost of one batch_submit on an offline fixture

**Captured:** 12 November 2026 (UTC). **Method:** the real Worker code (`src/enrichment.js`, `src/mcp.js`) on a sqlite D1 stand-in with the prediction domain in D1 mode and an in-memory R2, driven through `POST /api/enrichment/batch/submit` by `tests/prediction-batch-submit.mjs` (the numbers below are printed by that test). **Scope:** offline only, no model call, no production read or write, no Scheduled Task. **Verdict:** supports the ADR's 64 KiB boundary rule; it decides nothing and it is not a production measurement.

## 1. Request size against the MCP limit

The MCP transport rejects a request body over 64 KiB (65,536 bytes) with `413` before any processing; the MCP tool `prediction_batch_submit` refuses a group over 56 KiB (57,344 bytes) with a tool error and nothing submitted.

| Group | Request bytes | Against the limits |
| --- | --- | --- |
| 10 items, each a fingerprint with four strengths and four risks of about 330 characters and the fixture prediction (a rich, valid fingerprint) | 40,653 | fits both |
| 10 items, each a fingerprint at the contract's own maximum of 12,000 characters (eight strengths and eight risks of 500 characters) and the fixture prediction | 91,613 | over both: `413` at the transport, a tool error at the tool |

The fingerprint contract bounds one fingerprint at 12,000 characters (`FINGERPRINT_MAX_CHARS`), so ten maximal fingerprints cannot fit one 64 KiB call whatever the evidence holds. The Worker does not shorten or split a group and the target group size of 10 is unchanged: the caller splits a larger payload into groups that fit, and a group over the advised limit is refused whole with a clear message. Real fingerprints with `evidence` were not measured here; their size is bounded by the same 12,000 characters.

## 2. Work of one call (offline counts, not wall time in production)

For the 10-item rich group above: 545 to 717 ms offline wall, 239 D1 round trips (650 statements), 217 R2 operations, one queue settlement. The offline clock has no network latency, so production wall time cannot be derived: 239 round trips at a production D1 latency of a few milliseconds would be a second or two, and the call's soft budget is 25 s between items. Production CPU, wall and D1 cost of a 10-item call are **not measured**.

## 3. Not known

Production bytes of real fingerprints with evidence; production wall, CPU and D1 cost; model behavior with ten films per answer.
