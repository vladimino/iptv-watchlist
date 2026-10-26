# Catalog poster hydration (owner approval required)

Catalog-only films offered in the «Находки» section show the year placeholder when their catalog record has `poster: null` and the `metadata.json` fallback has nothing for them. The decision is [ADR 0020](../adr/0020-owner-triggered-catalog-poster-hydration.md); the route, outcomes and write rules are in the [catalog reference](../reference/api/catalog.md#poster-hydration); the flag is in the [feature flag register](../reference/feature-flags.md). This page is the procedure. Setting the flag and every execution call are separate production operations, each needing explicit owner approval; a code deploy approves neither. It is a one-time bounded operation, not a schedule.

## Plan

1. **Read-only count.** `POST /api/enrichment/catalog/posters` with `{}` through the Access-protected site, from the same origin. Record `programmeRunId`, `catalogRecords`, `missingPoster`, `verifiedMissing`, `unverifiedMissing` and the sampled `ids`. No TMDB request and no write happen. `unverifiedMissing` records are out of scope for this procedure.
2. **Set the flag.** Under its own approval the owner sets the Worker environment variable `CATALOG_POSTER_HYDRATION` to exactly `on` and records the time in the feature flag register. Nothing starts by itself.
3. **Bounded calls until `done`.** Under the execution approval, call `{"dryRun": false, "limit": 10}`, then repeat with `"cursor"` set to the returned `nextCursor` (an empty string means "start again at the first record"). Stop with success when a response has `done: true` (`nextCursor` is then `null`). Keep the per-film `outcomes` and `writes` of every call as the receipt.
   - A `409` with `Resolver is writing the catalog`: wait for the discovery chunk to finish and repeat the same call; never override the lease.
   - `rate_limited` with `retryAt`: wait until `retryAt`, then repeat the same call.
   - `generationChanged: true` or `leaseLost: true`: repeat the same call later. Look at `writes`: a copy written before the stop already holds correct posters; the next call re-reads both copies and completes the other one.
   - **Attempt bound:** stop after at most 5 consecutive calls that hydrate nothing and return the same `nextCursor`, or after 30 calls in total. Report the `retryable` ids of the last response with their outcomes (`tmdb_failed` errors, `catalog_changed`, …) to the owner. Do not skip a retryable record by editing the cursor without a separate decision; `done` is only meaningful for a cursor chain that started without a cursor.
   - `no_poster_on_tmdb` and `tmdb_id_mismatch` are terminal: those films keep the placeholder by design and are listed in the receipt.
4. **Read-only verification.** `GET /api/catalog/available`: `posterCoverage.catalog` grows by the hydrated films that are currently available and `missing` shrinks; for the films the owner reported, `films[].poster` is a URL. A repeated step 1 shows the new `verifiedMissing`. Then the owner's visual smoke on desktop and mobile: at least some «Находки» cards show an image instead of the year.
5. **Unset the flag** under the same approval as step 2 and record it.

## Failure recovery

The two catalog copies are separate R2 objects and are not written atomically together. A call that stops between them leaves the published generation's copy with the poster and the live catalog without it; the response reports it per copy (`writes`) and per record (`writtenTo`). Nothing has to be undone: the poster is the TMDB asset of the record's verified id. The next call re-reads both copies, writes the missing one or reports the record again. A call that stops before the first write wrote nothing.

## Rollback

Unsetting the flag refuses further execution calls. Posters already written stay: each is the TMDB asset of the record's verified id, in the same form the discovery writer stores, and nothing else in the record changed. Removing them would be a separate approved write that sets `poster` back to `null` for the listed ids from the receipts; no deletion step is part of this procedure. The route never writes the generation pointer, identity, shows or decisions, so there is nothing else to restore.

## Remaining gate

Owner approval to set the flag and to run the bounded calls, then the owner's visual smoke with at least some posters visible. Until then the «Находки» posters are not fixed by code alone: the films without a stored asset keep the placeholder. A recurring or scheduled hydration is not part of this procedure; it is to be considered separately only if missing posters recur.
