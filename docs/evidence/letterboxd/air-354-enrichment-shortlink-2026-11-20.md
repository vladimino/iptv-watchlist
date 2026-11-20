# Verified Film enrichment without an HTML shortlink (AIR-354)

**Captured:** 2026-11-20, main `95d7f139`. Code reading and offline synthetic tests only; no Letterboxd, TMDB or production read or write.
**Verdict:** **ROOT CAUSE CONFIRMED AND FIXED IN CODE.** Used by [AIR-354](https://trello.com/c/XAHWobas), [ADR 0090](../../adr/0090-rated-identity-redirect-proof-and-retry.md) (Accepted).

## Root cause

`ownChecks` in `src/letterboxd-identity.js` accepts an absent HTML shortlink when the `boxd.it/<code>` redirect hop proves the code. `enrichmentAgrees` in `src/letterboxd-rated-candidates.js` required `shortlinkPresent && shortCode === code`, so a Film admitted by the redirect proof stopped as `shortlink_mismatch` on its first metadata read. The candidate stayed `verified`, and the page then called it «Код не подтверждён».

## Change

- A present shortlink must still name the code. An absent one is accepted only when the stored admission carries `sourceCode`, `archiveSha256`, `tmdb` and `filmPath` consistent with the row; otherwise `admission_unproven`. No redirect receipt is persisted today, and none is invented.
- The metadata write and the localization write compare the admission they were proven against; a change gives `admission_changed` and no write. A refused write is not promoted to success.
- The candidate state moves to `metadata` or `done` only on the still-`verified` row with the same archive, `tmdb` and `filmPath` (`claim_changed` otherwise); another code's stop is kept.
- The latest candidate row is re-read and must match the admission before the metadata write and before each localization write, so a candidate changed during the fetch gets no new metadata. R2 has no cross-document transaction; a later change shows as partial persistence.
- The absent-tag path requires candidate and admission to agree on `tmdb` and `filmPath`.
- The page separates «Film уже admitted» from the enrichment stop and its reason, and says «Метаданные сохранены, локализация остановлена» for a localization stop.

## Synthetic checks

| Case | Result |
| --- | --- |
| Page without shortlink, consistent admission | metadata stored, `enrichment=metadata` |
| Foreign shortlink | `shortlink_mismatch`, nothing stored |
| No shortlink, admission archive changed | `admission_unproven` |
| Admission changed during the write | `admission_changed`, nothing stored |
| Candidate `filmPath`/`state`/`tmdb` changed during the fetch | `claim_changed`, no `metadata`, no synopsis or `metadataAt` written, unrelated stop kept |
| Metadata already present, candidate path disagrees at localization | `claim_changed`, no title, no `done` |
| Candidate/admission path disagree, no shortlink | `admission_unproven` |
| Admission owner changed during localization | `admission_changed`, no title written, no `done` |
| Changed canonical, TMDB id, TV page | unchanged stops |

Not injectable offline: a refused write whose identity returns before a later readback. The code no longer reads back identity to infer success, so that path cannot promote a refusal.

## Not established

The current production state of `103U` and `10TQ` was not read. Authorizes no production enrichment, identity step or write.
