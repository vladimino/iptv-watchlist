# AIR-374 M2b reader: the reviewed code that executes the copy plan, offline (13 Nov 2026)

**Captured:** 2026-11-13 (UTC), offline, on the sqlite3-CLI D1 stand-in with a fake connector. **Nothing was run against production.** No D1, R2, Cloudflare, MCP or other connector, no credential, flag, Task or marker was used or touched. Every row in the tests is synthetic.

**Scope:** the owner chose the FULL TABLES scope for the M2b copy on 13 Nov 2026; the explicit read-only GO for the read itself is not given. Delivered: [`scripts/epg-producer-m2b-reader.mjs`](../../../scripts/epg-producer-m2b-reader.mjs) (`readCopy`, `bundleText`, `readerDigest`), the bundle command [`scripts/epg-producer-m2b-reader-bundle.mjs`](../../../scripts/epg-producer-m2b-reader-bundle.mjs), the tests `tests/epg-producer-m2b-reader.mjs` and `tests/epg-producer-m2b-reader-mutation.mjs`, the [runbook](../../runbooks/film-person-m2b-dry-run-copy.md) section 2a and the GO text of section 5 with the real digests.

**Digests:** statements `ca84fae592b98b40696348f1c7af355284b8f5acc48e44749a5440aeb79a06b3` (26 statements); reader `f711600eb2dfc564fe836385f19474287d13a7e8d510ac6dbf3ac1ec632bd4bb` (SHA-256 of `String(readCopy)`).

**Results:** `tests/epg-producer-m2b-reader.mjs` passes (about 4 s); `tests/epg-producer-m2b-reader-mutation.mjs` kills 73 mutants (about 66 s locally), with the controls: a fresh work directory per check, the unmutated reader passes twice in one process, a neutral change survives, and a kill counts only as an assertion failure. The tests prove:

- the reader is a pure function over an injected `request` of the shape of `cloudflare.request`: no import, network, timer or environment inside its text, and its text runs as the body of an `execute` call and gives the same file as the function;
- ONE statement per request, in the printed order, one request in flight at a time; every statement sent passes `assertReadOnly`; parameters are `[after, pageRows]` or none;
- the assembled file passes `verifyResults` and `loadCopy` and equals the file of the independent reference reader; the loaded copy is row for row identical to the original (page sizes 2 and 100; a table of exactly one page; empty tables);
- every stop rule fires on the offending response and sends NO further request (the calls are counted against the tampered call): request failure, non-success envelope, wrong shape, missing or invalid metric, per-statement and running-total caps (rows read and milliseconds), schema version other than 21, unreadable marker (also on a request failure and on a non-success), invalid or over-cap count, page over size, a result row with other columns, a non-scalar value, a rowid that does not increase, a table that grew or came back short or with another maximum rowid, and a defect of the reader;
- a plan the reader does not recognise (another digest, a raised or missing cap, a statement that is not the planned SELECT, an unsafe name, a table twice) is refused before any request.

**Limits:** proven against a fake connector only; the real response envelope of the D1 query endpoint through the Cloudflare API connector is taken from its documented shape and is not verified. Whether the `execute` call can return the full results file (about 210,000 rows) is not verified. The reader does not retry and does not resume: any stop ends the run. The run reads pages at different instants (not a consistent cut).

**Next:** the owner's explicit read-only GO in the wording of runbook section 5. This evidence authorizes nothing.
