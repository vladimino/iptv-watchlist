# AIR-373 stage B: narrow projector-input capture, offline tests

**Captured:** 2026-11-10, local run of `node tests/film-person-capture.mjs` and `node tests/film-person-capture-mutation.mjs`. **Method:** synthetic fixtures, the sqlite3-CLI D1 stand-in through migrations `0001`–`0018`, and a fake read-only S3 server on loopback. **No production access of any kind:** no R2 request, no D1 statement, no Worker log read, no credential used.

**Result:** the capture adapter ([`scripts/film-person-capture.mjs`](../../../scripts/film-person-capture.mjs), inactive and not bundled) passes its tests, and each of its 37 guards is killed by at least one test when removed (mutation check). This is evidence about the code, not about production.

## What the tests prove

| Property | Test case |
| --- | --- |
| The allowlist is derived from the projector's loader | every key `d1EnrichmentStore` reads is in `ALLOWLIST`; every key is found in the code; two templated generation keys only |
| A key outside the allowlist is never requested | refused before a request is built (`key_not_allowlisted`); the fake bucket sees only `GET` and `HEAD` of allowlisted paths and no listing query |
| Stable ETags | `HEAD`, `GET` with `If-Match`, `HEAD`, then a final `HEAD`; deterministic manifest digest |
| Moving ETag | between `HEAD` and `GET`, between `GET` and the second `HEAD` (also when the server ignores `If-Match`), and between the R2 reads and the D1 reads |
| Missing, malformed, oversized objects | stable reasons; nothing partial is returned |
| Failed probes | missing table, error envelope, non-array result, malformed and duplicate rows |
| D1 gate | schema, marker, fence, foreign live lease, live window, held discovery cutover each refuse before any R2 request; a marker, baseline, discovery generation, published generation, projector lease or witnessed table that moves between the reads refuses |
| Read-only | every statement issued is one `SELECT`; the guard refuses writes, a second statement and `PRAGMA`; the bucket of the D1-derived readers refuses every read |
| Resume | a checkpoint is used only with an unchanged D1 gate and unchanged ETags, otherwise discarded whole; a forged checkpoint key is ignored |
| Parity run | the real view builds Films and People from captured objects; ledger and report digests are deterministic; ETag moved after the D1 cut is reported; a doctored manifest is refused before any D1 read; a foreign lease blocks the cut; an unreadable class is unavailable, never empty |
| Source identity (review fix) | between capture and parity each of Discovery generation, published run id and generation, owner-review generation, marker generation, schema version, baseline state, a live lease and a live window refuses with a field-named reason and no report; a Discovery or owner generation that moves after the cut is caught by the second comparison; an unchanged identity passes |
| Derived payloads bound to the manifest | for each of catalog, resolution, owner reviews and published EPG a well-formed but mutated payload, a missing one and a wrong generation or run id refuse; extra payloads and route mismatches refuse; a reordered-keys payload verifies (canonical digest); a tampered set is refused before any D1 read |
| Diagnostics are a separate observation | `diagnostics.cut` is `separate_observation`; a write between the ledger read and the diagnostics read sets `diagnostics.stable=false` |
| Gate stays closed | the report's source is never verified, so `baselineGate` refuses it (`source_unverified`); `ownerLink` is unavailable offline |
| Diagnostics | (a) Person keys by candidate cause, (b) every redirect against retirements including one with no expected source, (c) changed Films as retained duplicate, changed but unwritten or other; ids only as 12-hex hashes; none is an exception |

## Limits

- Equal R2 ETags do not prove a consistent R2 and D1 snapshot; the cut does not cover writers that bypass the projector lease or inputs that move between the R2 and D1 reads (see the [runbook](../../runbooks/film-person-baseline.md)).
- Fixtures only: real object sizes, request latency, D1 time, the real counts of the three diagnostics and any class-C exception are **unmeasured**.
- The diagnostic thresholds (48,807 keys against 48,804 people, five redirects against four retirements, three or four changed Films) come from the 10 Nov 2026 preflight and are not re-measured here.
- Production execution needs its own owner GO under the plan in the runbook; this evidence authorizes nothing.
