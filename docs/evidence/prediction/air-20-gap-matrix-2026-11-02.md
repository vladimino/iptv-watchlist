# AIR-20 taste-profile publication — gap matrix

**Captured:** 2026-11-02 (Europe/Madrid).  
**Source:** `main` `29d8aed35114d106e2313c05300a9be4e50224ec`. Code and the documents named below. No Cloudflare call, no `PUT /api/enrichment/profile`, no production dry run, no prediction, EPG, discovery or TMDB call, no R2 or D1 read or write.  
**Verdict:** the publication runtime the original card asked for is already on `main`. The residual gap was two stale sentences that still said every consumer compares the profile strictly until a later activation. Those sentences are corrected in this change. No new publisher, queue writer, event type or profile editor. The candidate body of version 3 is not in this repository.

**Used by:** [AIR-20](https://trello.com/c/EikQ0LUb). Accepted decisions that already cover the runtime: [ADR 0013](../../adr/0013-versioned-taste-profile.md), [ADR 0014](../../adr/0014-fingerprint-prediction-lifecycle.md), [ADR 0031](../../adr/0031-selective-prediction-profile-compatibility.md), [ADR 0044](../../adr/0044-retire-profile-compatibility-switch.md).  
**Superseded by:** none. This note does not authorize a publication or a prediction run.

## Gap matrix

| Criterion | On `main` | Residual | This change |
| --- | --- | --- | --- |
| Immutable version, create-only, current pointer by compare-and-swap | `publishProfile` in `src/enrichment.js`. A refusal returns before any write. A same-body retry reuses the version record. A different record under that number is `version_exists`. A lost compare-and-swap is `profile_changed`. | None | None. Covered by `tests/profile-publisher.mjs` |
| Schema, `changeImpact`, dry run, owner declaration | The same function plus `src/domain/profile-impact.js`. A selective impact without a matching approval is refused, including on `dryRun: true`, and the refusal carries `declarationSha256`. | None | None. The same test covers the dry run, `approval_mismatch` and the field table |
| `current` / `compatible` / `stale` | `PREDICTION_PROFILE_MODE` is `selective`. `predictionFreshness` is what the queue, view, catalog, runner and diagnostics call. Unknown or global impact fails closed. | The D1 prediction projection has no lineage and stays strict ([compatibility reference](../../reference/domain/prediction-compatibility.md)). Not changed here, and not changed beside [AIR-317](https://trello.com/c/jj45y0JW) | None |
| Fingerprints stay independent of a profile edit | A profile publication refreshes the prediction queue (`profile_updated`) and does not regenerate fingerprints. | None | None |
| Incremental refresh and last-good predictions | The queue rebuild marks only the predictions the selective rule does not accept. The film list keeps the last committed prediction and labels a stale one as waiting for a recompute (`public/app.js`). | None | None |
| History and lineage | `current.json` carries `lineage` (at most 32 links). The version record does not. A prediction keeps its own `tasteProfileVersion` and `tasteProfileHash`. | None | None. `tests/profile-publisher.mjs` and `tests/prediction-compatibility.mjs` |
| Restore earlier content | Publishing the earlier body as a new higher version. The same body has the same hash, so predictions stored under that hash are `content_identical` (`src/domain/prediction-compatibility.js`). The pointer is not moved backwards. | The runbook described a code rollback of the publisher and only mentioned content restore in one sentence | Runbook now leads with content restore as a new monotonic version |
| Version and date in the UI | Footer fields `detail-profile-version` and `detail-profile-updated` (`public/index.html`, `public/app.js`). No hash is shown. Changed fields and scope are on `GET /api/enrichment/profile`, which is the operator read. | A public editor of the profile is not required. Not added | None |
| Publication event | Recalculation is an `enrichment` event with `added`, `updated` and `failed` (`writeEvent` from the runner). `publishProfile` does not write an event. The footer and `GET /api/enrichment/profile` show the new version after a refresh. | A dedicated “profile published” event would be a new writer and a new Events panel branch. That is a separate UI change, not this procedure | Not added. Owner triage if that panel row is wanted |
| Counters | Run status and the enrichment event carry checked / added / updated / failed. | None | None |

No new ADR. The accepted records above still decide the architecture. No Mermaid diagram changes.

## Operator path

1. Read `GET /api/enrichment/profile`. The version and hash become `changeImpact.from`.
2. Diff the candidate body field by field. The server recomputes `changedFields` and refuses a mismatch.
3. Default `scope` to `global`. `anchorFilms`, `ratingScale` and `calibration` cannot be selective. A genre or other allowed field may be selective only with selectors that cover it and with the owner's approval of that exact declaration.
4. When a later approval allows it, send `dryRun: true` with no `approval` for a selective draft. The refusal `selective_requires_owner_approval` returns `declarationSha256` and writes nothing. Record the owner's decision on that hash, then send the same body once with `approval`. Do not send a second dry run unless the body, the declaration or the approval changed.
5. Read the answer: `version`, `profileHash`, `changeImpact`, `lineage`. On a timeout or HTTP 5xx, read the current profile before any retry. If that publication is already current, stop. If the version record matches and current did not move, the same request may be sent again. If the state cannot be read, stop.
6. Restoring the previous body is step 1 with the next version number, not a pointer move.

This note does not perform steps 4–6. A production dry run is a write-capable route even when it writes nothing, and it is not authorized while AIR-317 is comparing the prediction domain.

## Version 3 template

The live baseline to re-read before any future publication is the profile recorded in [AIR-206 S4](air-206-s4-publication-2026-10-28.md): version 2, `updatedAt` `2026-10-28T05:49:40.160Z`, hash prefix `78d004ea…449d`, selective `horrorPreferences`, two lineage links. The coordinator's read on 2 November 2026 reported that same version and time. This repository does not contain the profile body, and this note does not invent ratings, skips or preference text.

| Slot | Rule | Candidate value |
| --- | --- | --- |
| `version` | Integer greater than the live current version | empty until a fresh read |
| `schemaVersion` | `1` | `1` |
| `ratingScale`, `calibration`, `anchorFilms` | Any change is `global` only | unchanged unless an owner-sourced edit is attached later |
| Genre and other text fields | Selective only when every changed field is covered and the genre floor is present. Otherwise `global` | empty |
| `positiveSignals`, `negativeSignals`, `hardSkips` | String lists. A change can be selective only with mechanic, execution or genre selectors that cover it | empty |
| `anchorFilms[].rating` | Half-star from 0.5 to 5, with a title and a reason, only from a confirmed rating. A watchlist row or a conscious skip is not a rating | empty. No rating is added here |
| `changeImpact.scope` | `global` unless the diff is entirely inside fields the field table allows and the owner approves that declaration | `global` until that approval |
| `changeImpact.from` | The version and hash read immediately before the dry run | empty |
| Expected invalidation | `global` reaches every prediction. Selective reaches only the films the selectors name. Do not narrow a global edit with a selective scope; the server refuses `global_field_requires_global` and a short selector set | not estimated. The queue refresh after a real publication is the count |
| Restore | Next version with the previous body. Provenance of stored predictions is not rewritten | the version 2 body, re-read at that time, not copied here |

Confirmation still required before any publication, and not collected in this file: a source for each new rating or preference sentence, the owner's review of the exact diff, a dry run under a separate approval, and a separate approval to run predictions afterwards. The Hourly Predictions task is an owner decision and is not enabled by this note.
