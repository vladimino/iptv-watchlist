# AIR-314 owner-review authority — local contract, 1 November 2026

**Verdict:** code and local SQLite only. **No production migration, import, activation or revert.**

Captured from the AIR-314 branch after merging `origin/main` at `ec5e3ad90ae0efbe25a32100b07a7fb3fa31cf95` (published EPG, ADR 0079 Accepted, migration `0008` not applied), then again at `afa648d64f5fba5a76cb882a0605a50b3f07598a` (ADR 0080 Accepted). The second merge keeps this contract and adds the discovery-identity bundle beside `PublishedEpg` and `OwnerReview`. Production D1 was not opened. `admin/owner-reviews.json` was not read from the live bucket. The offline operator `scripts/owner-review-authority.mjs` refuses a database path that names production and was not pointed at one.

## What was checked

- The local chain is `0001` through `0009` in the only supported order: `0007`, then `0008`, then `0009`. That leaves version 9. The prediction marker, the published-EPG marker and the owner-review marker are each `r2`. Schema v9 with the metadata-cache marker set to `d1` still reports that cache mode.
- `0009` refuses version 6, version 7, and a version 8 that is missing `published_epg_show`, before any `CREATE`. The contract version stays where it was and `owner_review_authority` is absent. `0009` before `0008`, and `0007` after `0009`, are not supported paths and were not treated as safe.
- `UPDATE schema_contract SET version=7` aborts on `schema_contract_downgrade`.
- A missing binding, an empty database, a missing `schema_contract` row, and version 9 without the owner-review tables fail closed. They do not read the R2 object. A confirmed version below 9 with those tables absent stays on the object. The stand-in flag is set by the local caller, not by `src/worker.js` or `wrangler.jsonc`.
- An absent local file imports as an empty document and inserts no `film` or `person` row. A thrown read, contract version 2, and a missing `people` map are refused.
- A document with an orphan key, a `tmdb_tv` key, a redirect and a role link round-trips. `tmdb_949` links the trusted movie row. `tmdb_tv_949` stays `held`. A failed mirror put leaves `mode` at `d1`. A `d1` read returns the rows and does not put the mirror.
- One generation covers both maps. A film commit followed by a person commit keeps both. A batch that throws leaves the previous rows. A pin revision `etag-from-r2` is `version_conflict` after the marker is `d1`.
- A document with more entries than one batch, and one slice larger than one statement, are refused before any row is deleted. The generation and the existing slice stay.
- A `d1` read that sees the generation move once, between the marker and the rows, retries and reports the later consistent generation and payload. A read whose marker moves on every sample fails closed and returns no body.
- The built Worker, for published EPG `r2` and `d1` crossed with owner reviews `r2` and `d1`, serves one programme generation, the owner title and the owner name, and does not put `admin/owner-reviews.json` on GET. Admin shows the same preferred title. Dropping `owner_review_entry` after activation returns 503 `owner_review_unavailable` for programme and Admin and does not serve the stale mirror.

## Not checked

Live row counts and a production apply. `0007` and `0008` are on `main` and were checked only on local SQLite, and only in the order `0007`, then `0008`, then `0009`. Production apply stays a separate owner approval.
