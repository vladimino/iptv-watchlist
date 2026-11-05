# Rated identity retry: false `record_changed` and addressed identity step, synthetic RCA

**Captured:** 2026-11-05, local `node tests/letterboxd-rated-candidates.mjs` and `node tests/admin-letterboxd-page.mjs`. No production R2, D1, Worker, Letterboxd page, TMDB call, flag or Scheduled Task
**Input:** an invented four-film rated ZIP (`103U`, `10TQ` and two neighbour codes), an in-memory candidate document, stub redirects and a DOM stand-in of `/admin/letterboxd`. The two production codes are reused only as invented fixture rows; no private export, rating or live HTML is copied
**Method:** status, then a neighbour write, then confirm with the old `documentEtag`; a neighbour write between confirm and execute; a chosen-row `observedAt` change before confirm and a `registeredAt` change before execute; a chosen-row change injected after the `running` mark and before the candidate CAS; verified, admitting and removed chosen rows; a lost confirm and a lost execute answer in the page; a targeted identity-step of one requeued code
**Scope:** contract and regression test only. Not a readback of the 4–5 November production clicks
**Verdict:** **ROOT CAUSE REPRODUCED AND FIXED IN CODE.** Before AIR-350, confirm refused with 409 `record_changed` whenever the whole candidate document's ETag had moved, before any per-code check, and the page showed the ZIP facts text «Факты в R2 изменились… Ничего не записано». After the fix a neighbour write no longer refuses; a chosen-row change still refuses, per code, and is never overwritten
**Used by:** [AIR-350](https://trello.com/c/YWWp7DZI), [ADR 0090](../../adr/0090-rated-identity-redirect-proof-and-retry.md) (Accepted, unchanged)

## Root cause

| Defect | Where | Effect |
| --- | --- | --- |
| Confirm compared the submitted `documentEtag` with the live candidate object before the per-code fingerprints | `lbaRetryConfirm` | Any write to any other candidate (an identity step of another code, a review, a stop) made the owner's unchanged codes look stale: 409 `record_changed` |
| The retry refusal used the ZIP apply error text | `letterboxd-archive-view.js` | «Факты в R2 изменились после проверки. Проверь архив ещё раз. Ничего не записано» pointed at a ZIP re-check that is unrelated to identity retry |
| Execute could refuse after marking the action `running` without a receipt | `lbaRetry` | A later click of the same key resumed instead of reading a settled answer |
| «Проверить одну идентичность» sent no `code` | `onArchiveIdentity` | It took the next shared pending code, not the film the owner had just requeued |

## What the fixtures show after the fix

| Case | Result |
| --- | --- |
| Neighbour row rewritten between status and confirm, old `documentEtag` sent | 200, confirmation issued, nothing requeued |
| Neighbour row rewritten between confirm and execute | 200, both chosen codes `written`; the neighbour writes are kept |
| Same confirmation again | `replayed: true`, `writes: false`, same per-code outcomes |
| Chosen `103U` gets a newer `observedAt` before confirm | 409 `record_changed`, `changed: ["103U"]`, no action stored |
| Chosen `10TQ` gets a newer `registeredAt` before execute | 409 `record_changed`, `103U` `not_attempted`, `10TQ` `skipped_changed`; both rows stay `needs_review`; the action stays `approved` |
| Chosen `103U` changes after the `running` mark, before the CAS | 200 `partial`: `103U` `skipped_changed` and kept, `10TQ` `written`; the receipt is stored |
| Chosen row verified, admitting or removed | 409 `record_changed`, `changed` names that code |
| Status, confirm and retry | No outbound request |
| Identity status after retry | `requeued` lists both codes as `pending` with `retryOf`, no `filmId` |
| Identity-step with `code: "10TQ"` | Only `10TQ` is fetched and verified; `103U` and the neighbours are byte-for-byte unchanged; status then shows `10TQ` `verified`, `filmId: tmdb_40805` |
| Identity-step with `code` of a `needs_review` row | 409 `not_eligible` |
| Page: confirm answer lost | Same key and request on the next click; no ZIP text |
| Page: execute answer lost | Unknown; only «Узнать исход (тот же ключ)»; no «ничего не записано»; replay shows the stored receipt |
| Page: confirm `record_changed` | Changed code named, status re-read, a new confirmation offered with a new key, not run |
| Page: targeted step | The POST names `103U`; the answer and the re-read state are shown under `103U` |

## Production observation that motivated this record

On 4–5 November 2026 the owner's approved retry of `103U` and `10TQ` showed `record_changed` and ambiguous answers after repeated clicks. Whether either code was requeued or admitted was not read back and is **not** established by this record. A later owner-approved bounded acceptance must read both rows and any old action receipt first.

## Limits

Local Node only, no workerd replay. No live Letterboxd or TMDB HTML. A code rollback restores the ETag refusal and does not unwrite a candidate, an action record or a Film admission.
