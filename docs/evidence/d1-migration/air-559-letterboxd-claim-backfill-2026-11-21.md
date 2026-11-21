# AIR-559: Letterboxd claim backfill, owner-approved production execution

Date: **21 November 2026, Europe/Madrid**. Production scope: one bounded, owner-approved L3 backfill of trusted `letterboxd` external ID claims for currently published programme lids that lacked them. The operator was delivered in [PR #838](https://github.com/vladimino/iptv-watchlist/pull/838) (merged commit `b36b2339f6e866fae7106d652dce640b168ef4d3`, [post-merge CI and Cloudflare deploy #44882346338](https://github.com/vladimino/iptv-watchlist/actions/runs/44882346338): all required jobs successful). The verified-only producer wiring was delivered earlier in [PR #832](https://github.com/vladimino/iptv-watchlist/pull/832). The governing decision is [ADR 0184](../../adr/0184-ratings-confirmed-letterboxd-claim-on-existing-film.md) and the operational contract is the [claim backfill runbook](../../runbooks/letterboxd-claim-backfill.md).

**Verdict: COMPLETE for the approved one-off backfill.** The owner approved the exact frozen cohort and seven pins in the chat on 21 November 2026 after reviewing the live MCP preflight. This is **not** approval to enable the automatic claim producer, invoke any other production writer, or close the downstream product acceptance. [AIR-559 Trello execution and GO evidence](https://trello.com/c/733sRAxu#comment-6b01524b8852cbcca712394c), [AIR-549 product acceptance handoff](https://trello.com/c/BgwRv3uw#comment-6b01524d89d1ba7495118327).

## Method and approved frozen scope

All runtime checks and the one write were made through the already deployed, owner-only MCP tool `letterboxd_claim_backfill`, behind its existing Access/JWT gate. No direct SQL updates, Worker flag changes, scripts or Scheduled Tasks were used. The server derived its own cohort from authoritative publication and Ratings facts, and verified each item with `planLetterboxdClaim`; no lid-to-movie mapping was supplied by the client or published in this report.

A **fresh** `{mode:"dry_run"}` directly before `apply` returned HTTP 200, `ok:true`, `sideEffects:"none"`, `decision:"eligible"`, `cohort:9`, `pass:9`, `conflict:0`, `not_proved:0`, `already:0`, `unresolved:0`, `duplicate:0`, `blockers:[]`. All seven pins matched the owner's previously presented L3 plan:

| Approved pin | Value |
| --- | --- |
| Film/Person authority | `d1/open`, generation `2` |
| Ratings authority | `d1/open`, generation `4193` |
| Published programme run | `984821d8-397f-488b-883f-9be48a9a84c1` |
| Publication generation | `515` |
| Watchlist generation | `18` |
| Cohort count | `9` |
| Cohort digest, SHA-256 of sorted `lid:tmdb` pairs | `3a801adbe424d94b646a3625ae45d5af7692cc1e0aaffe2ea8686d14bb686c51` |

The earlier [20 November SQL-mirror baseline](air-559-letterboxd-claim-preflight-2026-11-20.md) also counted nine but had a *different* digest (`44ee6b4a3cbcedbc00436c11bfa5d9ca728df29579ee66000b3bdf16aeb2e988`). It was historical read-only evidence and was **not** substituted for this live, real-planner proof. These two digests do not establish equivalent member mappings.

## Single authorized execution

Exactly one `letterboxd_claim_backfill` call was made with `mode:"apply"`, `confirmGo:true`, `requestId:"AIR559_20261121_3a801adbe424_01"`, and all seven `expected*` pins listed above. No retry was performed.

The tool returned HTTP 200, `ok:true`, `outcome:"complete"`, `writes:9`, the approved cohort digest, and these per-item outcome aggregates:

| Item state | Count |
| --- | ---: |
| `written` | 9 |
| `already` | 0 |
| `refused` | 0 |
| `unknown` | 0 |
| `deferred` | 0 |
| `failed` | 0 |
| `not_attempted` | 0 |

All nine item results were `state:"written"` with reason `proved`. The only supported mutation path is the existing fenced `film_external_ids` `addOnly` writer with Film revision CAS, write-time authority/publication guards, and an applied receipt, using `ratings_alias_bridge` provenance. The operator did not write Started marks or Events.

## Production readback

The same `apply` response reported the authoritative `catalogStartedFilm` readback for the proved cohort and the following bounded D1 row-count deltas:

| Check | Observed |
| --- | ---: |
| Canonical Started reader `found` | 9 |
| Missing cohort `remaining` | 0 |
| `film_external_id` delta | +9 |
| `film_alias` delta | 0 |
| `ratings_view` delta | 0 |
| `started_mark` delta | 0 |
| `unexpectedChange` | false |

An **additional read-only** `{mode:"dry_run"}` after execution returned HTTP 200, `decision:"already_current"`, `sideEffects:"none"`, `cohort:0`, `blockers:[]`, and the SHA-256 digest of the empty cohort, `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`. Film/Person, Ratings, publication and watchlist generations had not changed.

## Limits and remaining acceptance

- These are the tool's live execution/readback results, not a separate raw SQL audit of all nine applied receipts and Film revisions. The fenced writer's receipt and CAS behavior was independently reviewed and covered by offline tests in PR #838.
- `catalogStartedFilm` returned `found` for all nine, but **no real `POST /api/started` was sent**, and the owner's UI workflow was not exercised. [AIR-549](https://trello.com/c/BgwRv3uw) remains in `Верификация` for set/unset, reload, started-only filter, idempotent `lastEvent`, and Events verification.
- `LETTERBOXD_CLAIM_ACTIVATED=false` remains in the deployed implementation. This successful historical backfill does not prove that future Ratings aliases will automatically be claimed. AIR-559 is not declared fully Done against its original producer-activation acceptance criterion.
- Inferred-import and its revocation edge cases remain explicitly deferred by the owner until after this backfill and the priority AIR-549 product acceptance. The accepted ADR's intended coverage has not been silently narrowed.
- Code rollback cannot remove already stored claims. Any future incorrect claim must follow the approved owner-review/unlink recovery route; no raw deletes or speculative retries were performed.

**No additional production operations are authorized by this evidence report.**
