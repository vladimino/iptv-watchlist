# AIR-528: `/admin/identity` failed on a stale observation index without a manifest, 19 November 2026

[AIR-528](https://trello.com/c/bj4JSgB9) · offline RCA and fix, no production operation.

**Symptom (owner, live Access tab).** `Cannot read properties of null (reading 'writtenAt')`; queue and coverage not read.

**Cause.** `DiscoveryAuthority.readObservationIndex()` returns `{state: 'stale', reasons: ['generation_moved'], manifest: null, records: []}` when the D1 generation moves during the read. `src/admin/limbo.js` treated `fresh`/`stale` as readable without checking the manifest, so `limboEvaluate` and `limboObservationCoverage` dereferenced `manifest`; `identityWorkLimbo` carried the error to `GET /api/admin/identity-work`, blocking the Film and Letterboxd lanes.

**Fix.** One guard, `limboIndexReadable` (state `fresh`/`stale` and a manifest object and a record array), now decides readability in `limbo.js` (load, evaluate, coverage, coordination, actions, items) and `identity-work.js`. An index without a manifest is reported as unavailable with its reasons (`index_stale`, `generation_moved`), never as zero.

**Tests.** `tests/admin-limbo-api.mjs` section 13 drives the real Worker routes `/api/admin/limbo` and `/api/admin/identity-work` with the index forced to stale/null-manifest, including a flip after a first successful read: HTTP 200, Film items kept, EPG unavailable, reason kept, no writes or outbound requests, and a valid index is read as before. The case fails on the previous code with the original TypeError.

**Not verified here.** Live production behaviour and the browser visual QA at 1280/390 px; both remain for review and owner acceptance.
