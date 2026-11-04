# ADR 0090: A rated identity may prove the short code by the redirect, and a parser-defect review returns to pending only through an owner retry

**Status:** Accepted
**Original decision date:** 2026-11-05
**Recorded at:** 2026-11-05
**Approval source:** Explicit owner acceptance on 2026-11-05 (Europe/Madrid), [recorded in AIR-346](https://trello.com/c/49p4EZ8b#comment-6aebbd81c8d90eaec0138b8e), after [independent code review PASS](https://github.com/vladimino/iptv-watchlist/pull/372#pullrequestreview-5777239970) of PR #372 HEAD `5c1142027ecdac73a84a321d98ecf24b18605b70` and [green exact-head CI](https://github.com/vladimino/iptv-watchlist/actions/runs/41930800592). Architecture only. The owner explicitly did not authorize production identity retry or identity-step; no Letterboxd/TMDB fetch, enrichment, projector, R2/D1 data write, flag, Task or Access change is authorized by this ADR.
**Related work:** [AIR-346](https://trello.com/c/49p4EZ8b). Rated admission stays [ADR 0087](0087-rated-archive-film-admission.md). Watchlist admission stays [ADR 0086](0086-durable-watchlist-film-retention.md). [AIR-343](https://trello.com/c/hCy6fLne) is not a prerequisite and is not a D1 identity store.
**Supersedes:** [ADR 0087](0087-rated-archive-film-admission.md) in part, only for HTML shortlink evidence, the `writes` flag, stored review reasons, and a bounded owner retry of a parser-defect review.
**Superseded by:** None

## Context

Two owner-approved production identity steps on 4 November 2026, codes `103U` and `10TQ`, returned HTTP 200, fetched a page, wrote `needs_review` with reason `shortlink_missing`, and set `writes: false` even though the candidate document and checkpoint changed. TMDB detail was not reached. The HTML shortlink check required an exact `rel="shortlink"` and `https://boxd.it/<code>` href. That is stricter than the hop the Worker already took from `boxd.it/<code>` to a film page. The first review reason overwrote the rest. This record does not claim Letterboxd removed the tag: the live HTML was not kept, and a new production fetch is not authorized.

## Decision

1. **The shortlink HTML tag is optional when the hop already proved the code.** `pageEvidence` treats extra `rel` tokens, a trailing slash and a protocol-relative `boxd.it` href as the same code. If that tag is absent, `ownChecks` accepts the code only when the observation carries `redirectCode` equal to the export code: the Worker followed `https://boxd.it/<code>` through allowed HTTPS hops onto `https://letterboxd.com/film/<slug>/`. A present tag that names another code stays `shortlink_mismatch`. Title, year or a TMDB id alone still cannot verify. Canonical path, a single movie `data-tmdb-id`, title/year agreement and the independent TMDB movie document stay required.
2. **A review stores a bounded reason list.** `markReview` keeps at most eight typed codes and a `reasonKind` of `page_incomplete`, `parser`, `conflict` or `review`. The first reason remains `reason` for older readers. HTML, ratings and credentialed URLs are not stored.
3. **`writes` follows a persisted candidate mutation.** `POST /api/admin/letterboxd-archive/identity-step` sets `writes` true when the candidate document, checkpoint, admission or enrichment object changes. `verified` and `enriched` stay the Film and metadata outcomes. `persisted` is `review`, `stop`, `admission`, `enrichment` or `none`.
4. **A parser-defect review returns to pending only through an owner retry.** The retryable reason is `shortlink_missing`. Confirm and execute are `POST /api/admin/letterboxd-archive/identity-retry-confirm` and `…/identity-retry`. Confirm writes only the action record. Every named code must submit `state`, `reason` and a matching `fingerprint` in `expected`. Individual `observedAt` and `registeredAt` properties are optional in the submitted payload; the fingerprint includes both fields (`state|reason|observedAt|registeredAt`). Confirm checks the fingerprint against the live candidate and stores the complete server snapshot, including both timestamps. An omitted or incomplete required `expected` is `invalid_request`. Execute marks the action `running`, re-reads the document, and compare-and-swaps only rows that still match that snapshot. The CAS callback re-plans against the current document. It does not fetch, does not admit a Film, and does not touch the other pending codes. A verified, admitting, removed, other-reason or newer-observation row is `skipped_changed` or `record_changed`. A lost receipt leaves the action `running`; the same key recovers already-applied rows and writes the receipt. Optional `code` on `identity-step` then checks that one pending or admitting row. Deploy and cron never requeue. A missing or newer document version refuses.

Not decided here: a production retry of `103U` or `10TQ`, any later identity-step, enrichment, the projector upsert, or a D1 identity store.

## Alternatives considered

Blindly dropping the shortlink check was rejected because a random film page would then verify from title and year. Auto-requeue on deploy was rejected because the other 48 pending codes must stay untouched. Editing R2 by hand was rejected because it has no receipt.

## Consequences

A later identity-step of a suitable movie page can verify without the HTML shortlink tag. Existing `needs_review` / `shortlink_missing` rows stay until an owner retry. The page tells the owner when the candidate document changed even if no Film was admitted. Code rollback restores the old parser and does not unwrite a candidate, admission or rating.

## Recovery and migration boundary

This record authorizes no production write. Retry action records live at `admin/actions/letterboxd_identity_retry/v1/`. Rolling back the code leaves those objects and any requeued candidates in place.

## Evidence

- **Original owner decision:** Accepted on 2026-11-05 (Europe/Madrid), [recorded in AIR-346](https://trello.com/c/49p4EZ8b#comment-6aebbd81c8d90eaec0138b8e). No production operation was approved.
- **Dated verification:** [synthetic shortlink and retry report, 4 November 2026](../evidence/letterboxd/air-346-shortlink-retry-2026-11-04.md). No production bucket was written.

## Follow-ups

Owner acceptance of the architecture is recorded above. A production retry of the two stored reviews, and each later identity-step, need their own explicit approval.
