# Catalog poster hydration (owner approval required)

Catalog-only films offered in the «Находки» section show the year placeholder when their catalog record has `poster: null` and the `metadata.json` fallback has nothing for them. The route and its safety rules are in the [catalog reference](../reference/api/catalog.md#poster-hydration); the flag is in the [feature flag register](../reference/feature-flags.md). This page is the procedure. Setting the flag and every execution call are separate production operations, each needing explicit owner approval; a code deploy approves neither.

## Plan

1. **Read-only count.** `POST /api/enrichment/catalog/posters` with `{}` through the Access-protected site, from the same origin. Record `programmeRunId`, `catalogRecords`, `missingPoster`, `verifiedMissing`, `unverifiedMissing` and the sampled `ids`. No TMDB request and no write happen. `unverifiedMissing` records are out of scope for this procedure.
2. **Set the flag.** Under its own approval the owner sets the Worker environment variable `CATALOG_POSTER_HYDRATION` to exactly `on` and records the time in the feature flag register. Nothing starts by itself.
3. **Bounded calls.** Under the execution approval, call `{"dryRun": false, "limit": 10}`, then repeat with `"cursor"` set to the returned `nextCursor` until it is `null`, at most 20 records per call. Stop on any of: a `409` (resolver busy: wait for the chunk, do not override the lease), a `rate_limited` outcome (wait until `retryAt`), `generationChanged: true` (repeat the same call later; nothing was written), a `writes[].reason` of `catalog_changed`, or a `tmdb_failed` rate above a few per call. Keep the per-film `outcomes` of every call as the receipt; `no_poster_on_tmdb` films keep the placeholder by design.
4. **Read-only verification.** `GET /api/catalog/available`: `posterCoverage.catalog` grows by the hydrated films that are currently available and `missing` shrinks; for the films the owner reported, `films[].poster` is a URL. A repeated step 1 shows the new `verifiedMissing`. Then the owner's visual smoke on desktop and mobile: at least some «Находки» cards show an image instead of the year.
5. **Unset the flag** under the same approval as step 2 and record it.

## Rollback

Unsetting the flag refuses further execution calls. Posters already written stay: each is the TMDB asset of the record's verified id, in the same form the discovery writer stores, and nothing else in the record changed. Removing them would be a separate approved write that sets `poster` back to `null` for the listed ids from the receipts; no deletion step is part of this procedure. The route never writes the generation pointer, identity, shows or decisions, so there is nothing else to restore.

## Remaining gate

Owner approval to set the flag and to run the bounded calls, then the owner's visual smoke with at least some posters visible. Until then the «Находки» posters are not fixed by code alone: the films without a stored asset keep the placeholder.
