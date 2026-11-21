# AIR-559: Letterboxd claim cohort, read-only preflight and L3 decision pack

Date: 20 Nov 2026 (UTC; Madrid is UTC+1). Scope: the read-only preflight of the published programme lids that have no trusted `letterboxd` claim, against production D1 `iptv`, and the L3 plan that the owner is asked to approve for the bounded backfill ([ADR 0184](../../adr/0184-ratings-confirmed-letterboxd-claim-on-existing-film.md), [runbook](../../runbooks/letterboxd-claim-backfill.md)). **No production write was made** (every statement was a `SELECT`; each response reported `changes: 0`, `changed_db: false`). The exact lid-to-movie mapping is owner-private and is not in this repository; it is kept outside GitHub and is identified here only by a digest.

## Result

**9 of 9 candidates classify `pass`** by the SQL equivalent of the planner (below). This is a cross-check, not the planner run itself (see Limits). `catalogStartedFilm` still answers `absent` for all nine until the claims exist.

| Reading | Value |
| --- | --- |
| Film/Person marker | `d1` / `open` / generation 2 |
| Ratings marker | `d1` / `open` / generation 4193 |
| `schema_contract` | 29 |
| Published run | one run; `programme` 395 members and `watchlist` 395 members, none spelled `tmdb_<n>` |
| Members with a trusted, non-conflicting `letterboxd` claim | 386 of 395 |
| Members without one (the cohort) | 9 |
| Cohort digest (sha256 of the sorted `lid:tmdb` lines, private file) | `44ee6b4a3cbcedbc00436c11bfa5d9ca728df29579ee66000b3bdf16aeb2e988` |

Per candidate, all nine read the same: the link index maps `letterboxd:<lid>` and `tmdb:<n>` to the same key (`tmdb-<n>`) and exactly two aliases carry that key; the fact record under the key states the same lid and movie and has no redirect and no migration; the `ratings_view` rows of both aliases carry the same key (corroboration only); the movie has exactly one `film_external_id` row, trusted and non-conflicting, owned by a Film whose `canonical_identity` is `tmdb:<n>`; no redirect, no retirement; no `letterboxd` row for the lid anywhere; the Film has no other `letterboxd` claim, no second `tmdb` claim and no untrusted claim.

| Verdict | Count | Reason |
| --- | --- | --- |
| pass | 9 | proved (not yet claimed) |
| conflict | 0 | |
| not_proved | 0 | |

The Film named in the owner's UI failure is part of the cohort; the earlier title-based hypothesis was not used, the pairing above is the authoritative link index.

## Method

Read-only SQL through the Cloudflare D1 connector, in four steps: markers and schema version; the published run and the count of members with and without a trusted claim; the link index (`letterboxd/facts/links.json`, three parts, valid JSON) for the cohort; and one query per candidate for the record, projection, canonical ownership, redirect, retirement and competing-claim readings listed above.

## Limits

- The verdicts were computed by SQL that mirrors `planLetterboxdClaim`; the module itself was not run against production (no read-only runtime that holds the D1 binding exists for it). The L3 plan therefore starts with the module's own dry run inside the approved writer, and any difference from this table stops the run.
- The preflight is a point-in-time reading at the generations above; the L3 execution repeats it immediately before the write.
- The cohort is the nine of this reading, not a constant.

## L3 decision pack (for the owner's explicit GO; none of it is executed)

**Open decision: how the writer runs.** No production operator for `applyLetterboxdClaims` exists today, and the producer flows stay inactive. Options:

1. **Recommended: an owner-only, dry-run-by-default MCP tool** in the existing pattern of the rollover tools (`dry_run` writes nothing; `apply` needs `confirmGo: true`, a `requestId` and the `expect` pins returned by a dry run: both marker generations and the cohort digest). It would be a small separate PR, reviewed before any GO, and would take no URL, key or route from the caller.
2. The activation constant in the Ratings flows. Not sufficient for this cohort: those flows reach only ids still on Diary page 1 or in a replayed import chunk.
3. A one-off script with direct D1 access. Not recommended: outside the Worker's fences and receipts.

**Plan once an operator exists.** Frozen cohort: the nine pairs above (digest above), re-read immediately before the write; any difference needs a new plan. Writer: `applyLetterboxdClaims`, origin `letterboxd_claim`, one batch of nine (cap 12), event `backfill:AIR-559:<cohort digest>`, so the same cohort replays idempotently. Fences: Film/Person marker `d1`/`open`/2 and Ratings `d1`/`open`/4193 (a moved generation refuses), the Film revision CAS and the write-time guards of each item, the applied receipt. Stop rules: any `conflict`, `not_proved`, `unknown` or `deferred` item is reported and not retried blindly; a typed infrastructure failure stops the run. Expected row changes per item: one `film_external_id` row (trusted `letterboxd`, provenance `ratings_alias_bridge`), one Film revision increment, one applied receipt; nine of each, and nothing else (no Started mark, no Event, no alias, rating, title or Person change). Readback: nine trusted claims, `catalogStartedFilm` `found` for each, 386 plus nine of 395 members with a trusted claim, unrelated Film and Person rows unchanged, receipts `applied`. Rollback and compensation: code rollback does not remove claims; a wrong claim is corrected through the owner-review and unlink routes, with the receipt and provenance as the audit trail. Concurrency with the future producer path: the two share one request id per pair only through the `already` state; a claim written first makes the other a no-op.

Documentation impact of the future execution: a dated execution report in this directory and the index rows.
