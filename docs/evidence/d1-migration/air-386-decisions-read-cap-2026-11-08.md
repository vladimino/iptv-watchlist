# Discovery decisions above 20 000 rows: bounded read failure (RCA and fix)

Date: 2026-11-08 (UTC). Scope: read-only D1 `SELECT`s through the connector, code reading and offline tests on a local sqlite stand-in. Trello: AIR-386. No production write, cron, projector, sync or Discovery run was made.

## Observation (read-only, 2026-11-08 UTC)

- `SELECT COUNT(*) FROM discovery_decision` returned 20 001 twice, minutes apart; average payload 267 bytes, maximum 4 034, total 5.3 MB. The authority generation kept moving (32 657 at the second read).
- `projection_run` latest row (started 10:37:30 UTC): `outcome: failed`, `reason: input_invalid`, `inputKey: epg/discovery-resolution.json`, 2 queries, 2 079 ms. The `discovery_bounded` code itself is not in that row.

## Cause (reproduced offline)

`readDecisions` loaded the whole table and threw `discovery_bounded` above `READ_CAP = 20000`. The projector maps every authority code outside its defer list to `input_invalid`. With the old code, 20 000 rows read and 20 001 rows threw `discovery_bounded` on the stand-in. The failing production run is consistent with this, but the production code path was not observed; the offline reproduction is the proof.

## Change

- `readDecisions` reads in keyset pages of 1 000 rows (`DECISION_PAGE`), verifies every `decision_hash`, and fails closed as `discovery_bounded` only past an explicit budget of 100 000 rows or 24 Mi characters of payload; nothing is truncated. `READ_CAP` is unchanged for the other readers.
- Consistency is unchanged in kind: every decision writer moves the authority generation in its batch and `routeRead` compares the generation before and after, so a read that raced a writer fails as `discovery_fence` (the projector defers) and no mixed pages are returned.
- The projector summary gains `inputCause` when the Discovery authority answers with a failure code, on `input_invalid` and on the deferred `authority_unavailable` (`discovery_bounded`, `discovery_unavailable`, `discovery_read_failed`).
- Not changed: authority contract, schema, fencing, R2 fallback (none), lease.

## Tests

`tests/discovery-decisions-read.mjs`: 0, 1, 999, 1 000, 1 001, 20 000, 20 001, 25 000 and 45 000 rows complete and ordered; query count equals pages; byte budget fails `discovery_bounded`; a corrupt hash deep in the table fails `discovery_unavailable`; a generation move between pages fails `discovery_fence`; held and loading authorities stay closed. `tests/d1-enrichment.mjs` asserts `inputCause`.

## Limits

- The Map is still held whole in the projector and in document-mode readers; the budget bounds it. At the current 267 bytes per decision the byte budget allows about 90 000 rows. Reaching it needs a projector-specific bounded projection, a separate decision.
- The document-mode writer (`writeDecisions`) still refuses more than 20 000 entries in one write; the paged resolver writes deltas. Whether any caller still writes the whole document at this size is not verified here.
- Decisions stood at 20 001 across the observation while observations were 39 920; this was not investigated.
- Whether the next natural projector tick succeeds after deploy is not yet observed. Starvation (AIR-383/385) is a separate defect.
