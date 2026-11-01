# AIR-314 owner-review authority — local contract, 1 November 2026

**Verdict:** code and local SQLite only. **No production migration, import, activation or revert.**

Captured from the AIR-314 branch against `origin/main` at the time of the change. Production D1 was not opened. `admin/owner-reviews.json` was not read from the live bucket. The offline operator `scripts/owner-review-authority.mjs` refuses a database path that names production and was not pointed at one.

## What was checked

- Migration `0009_owner_review_authority.sql` applies after `0001`–`0006`, sets the contract to version 9, inserts `owner_review_authority.mode = r2`, and does not create `prediction_domain_authority` or `published_epg_authority`.
- A contract already at version 10 stays at 10. `UPDATE schema_contract SET version=7` aborts on `schema_contract_downgrade`. The forward-only updates used by the open prediction and published-EPG migrations do not lower version 9.
- Schema v6 without the new tables stays on the R2 object. Schema v9 with the metadata-cache marker set to `d1` still reports that cache mode. Version 9 is not treated as proof that prediction or published-EPG tables exist.
- An absent local file imports as an empty document and inserts no `film` or `person` row. A thrown read, contract version 2, and a missing `people` map are refused.
- A document with an orphan key, a `tmdb_tv` key, a redirect and a role link round-trips. `tmdb_949` links the trusted movie row. `tmdb_tv_949` stays `held`. A failed mirror put leaves `mode` at `d1`. A `d1` read returns the rows and does not put the mirror.
- One generation covers both maps. A film commit followed by a person commit keeps both. A batch that throws leaves the previous rows. A pin revision `etag-from-r2` is `version_conflict` after the marker is `d1`.
- `stampLocalized` and `applyViewOverlay` keep the owner title against a disagreeing dictionary for every combination of published-programme, owner-review, metadata-cache and prediction mode labels. Those functions do not read the other markers. The owner commit puts only `admin/owner-reviews.json`.

## Not checked

Live row counts, a production apply, and the interaction with migrations `0007` and `0008` on the real database. Those two files are on other open branches and were not applied here. Production apply stays a separate owner approval after the monotonic schema contract is confirmed.
