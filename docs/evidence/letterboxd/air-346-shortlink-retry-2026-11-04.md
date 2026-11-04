# Rated identity shortlink proof and retry: synthetic contract

**Captured:** 2026-11-04, local `node tests/letterboxd-identity-resolve.mjs`, `node tests/letterboxd-rated-admission.mjs`, `node tests/letterboxd-rated-candidates.mjs` and `node tests/admin-letterboxd-page.mjs`. No production R2, D1, Worker, Letterboxd page, TMDB call, flag or Scheduled Task
**Input:** invented HTML pages, stub redirects, an in-memory candidate document and a DOM stand-in of `/admin/letterboxd`. No private export, rating or live HTML is copied
**Method:** parse of extra `rel` tokens, a trailing slash, a protocol-relative href and an href-before-rel tag; `decide` with a missing tag plus `redirectCode`; `planIdentityRetry` of a `shortlink_missing` row beside a Stay pending row; identity-step of a film page without the tag; a review answer with `writes: true`; confirm and execute of the retry, including a stale etag and a verified skip
**Scope:** contract test only. Not a live inventory and not a claim about production HTML
**Verdict:** **SYNTHETIC CONTRACT HOLDS.** A matching hop proves the short code when the HTML tag is absent. A present tag that names another code stays a mismatch. Title and year alone do not verify. A review stores a bounded reason list and a `reasonKind`. `writes` is true when the candidate document changes. Retry returns only named `shortlink_missing` reviews to pending and leaves the other pending codes. A verified row is skipped. A missing or newer document version refuses. No production bucket was written
**Used by:** [AIR-346](https://trello.com/c/49p4EZ8b), [ADR 0089](../../adr/0090-rated-identity-redirect-proof-and-retry.md) (Proposed)

## What the fixtures show

| Case | Result |
| --- | --- |
| Missing `<link rel="shortlink">`, `redirectCode` equals the export code, other checks pass | `accepted` |
| Missing tag and no `redirectCode` | `shortlink_missing`, `reasonKind` `page_incomplete` |
| Tag `rel="shortlink canonical"` or a protocol-relative href | Same code as `https://boxd.it/<code>` |
| Tag present with another code | `shortlink_mismatch` |
| Title and year match, hop missing | Not accepted |
| Identity-step of a film page without the tag | `verified` after the TMDB document agrees |
| Review CAS of `shortlink_missing` | `writes: true`, `persisted: review` |
| Confirm then execute of two `shortlink_missing` codes | Those two become `pending` with `retryOf`. A Stay pending row is unchanged |
| Execute of a verified or other-reason row | `skipped_changed` |
| Confirm with a stale `documentEtag` | 409 `record_changed` |

## Production observation that motivated this record

On 4 November 2026 two owner-approved identity steps, codes `103U` and `10TQ`, returned HTTP 200, fetched a page and stored `needs_review` / `shortlink_missing` with `writes: false`. That observation is not proof that Letterboxd removed the tag: the HTML was not kept. This report authorizes no production retry or later identity-step.

## Limits

Local Node only. No workerd replay. No live Letterboxd or TMDB HTML. Code rollback restores the old parser and does not unwrite a candidate.
