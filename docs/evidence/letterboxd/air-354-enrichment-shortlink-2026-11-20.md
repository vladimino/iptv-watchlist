# Verified Film enrichment without an HTML shortlink (AIR-354)

**Captured:** 2026-11-20, main `95d7f139`. Code reading and offline synthetic tests only; no Letterboxd, TMDB or production read or write.
**Verdict:** **ROOT CAUSE CONFIRMED AND FIXED IN CODE.** Used by [AIR-354](https://trello.com/c/XAHWobas), [ADR 0090](../../adr/0090-rated-identity-redirect-proof-and-retry.md) (Accepted).

## Root cause

`ownChecks` in `src/letterboxd-identity.js` accepts an absent HTML shortlink when the `boxd.it/<code>` redirect hop proves the code. `enrichmentAgrees` in `src/letterboxd-rated-candidates.js` required `shortlinkPresent && shortCode === code`, so a Film admitted by the redirect proof stopped as `shortlink_mismatch` on its first metadata read. The candidate stayed `verified`, and the page then called it «Код не подтверждён».

## Change

- A present shortlink must still name the code. An absent one is accepted only when the stored admission carries `sourceCode`, `archiveSha256`, `tmdb` and `filmPath` consistent with the row; otherwise `admission_unproven`. No redirect receipt is persisted today, and none is invented.
- The metadata write compares the admission it was proven against; a change gives `admission_changed` and no write.
- The page separates «Film уже admitted» from the enrichment stop and its reason.

## Synthetic checks

| Case | Result |
| --- | --- |
| Page without shortlink, consistent admission | metadata stored, `enrichment=metadata` |
| Foreign shortlink | `shortlink_mismatch`, nothing stored |
| No shortlink, admission archive changed | `admission_unproven` |
| Admission changed during the write | `admission_changed`, nothing stored |
| Changed canonical, TMDB id, TV page | unchanged stops |

## Not established

The current production state of `103U` and `10TQ` was not read. Authorizes no production enrichment, identity step or write.
