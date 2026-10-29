# Catalog poster hydration: maintenance procedure (owner approval required)

Catalog-only films offered in the «Находки» section show the year placeholder when their catalog record has `poster: null` and the `metadata.json` fallback has nothing for them. The decisions are [ADR 0020](../adr/0020-owner-triggered-catalog-poster-hydration.md) and [ADR 0048](../adr/0048-permanent-catalog-poster-maintenance-route.md); the route, outcomes and write rules are in the [catalog reference](../reference/api/catalog.md#poster-hydration). This page is the procedure. The route is a permanent owner-only maintenance tool for restoring posters, for example after a mass TMDB discovery failure; it has no switch of its own (the former `CATALOG_POSTER_HYDRATION` is retired and inert). Access is the Worker's owner-only Cloudflare Access. Every execution call in production is a separate operation needing explicit owner approval; a code deploy approves none. It is a bounded manual operation, never a schedule. The planned data health admin page ([AIR-283](https://trello.com/c/s35GwqRz)) runs the same steps through the same route, with its own preview and confirmation.

## Plan

1. **Read-only count.** `POST /api/enrichment/catalog/posters` with `{}` through the Access-protected site, from the same origin. Record `programmeRunId`, `catalogRecords`, `missingPoster`, `verifiedMissing`, `unverifiedMissing` and the sampled `ids`. No TMDB request and no write happen. `unverifiedMissing` records are out of scope for this procedure.
2. **Bounded calls until `done`.** Under the execution approval, call `{"dryRun": false, "limit": 10}`, then repeat with `"cursor"` set to the returned `nextCursor` (an empty string means "start again at the first record"). Stop with success when a response has `done: true` (`nextCursor` is then `null`). Keep the per-film `outcomes` and `writes` of every call as the receipt.
   - A `409` with `Resolver is writing the catalog`: wait for the discovery chunk to finish and repeat the same call; never override the lease.
   - `rate_limited` with `retryAt`: wait until `retryAt`, then repeat the same call.
   - `generationChanged: true` or `leaseLost: true`: repeat the same call later. Look at `writes`: a copy written before the stop already holds correct posters; the next call re-reads both copies and completes the other one.
   - **Attempt bound:** stop after at most 5 consecutive calls that hydrate nothing and return the same `nextCursor`, or after 30 calls in total. Report the `retryable` ids of the last response with their outcomes (`tmdb_failed` errors, `catalog_changed`, …) to the owner. Do not skip a retryable record by editing the cursor without a separate decision; `done` is only meaningful for a cursor chain that started without a cursor.
   - `no_poster_on_tmdb` and `tmdb_id_mismatch` are terminal: those films keep the placeholder by design and are listed in the receipt.
3. **Read-only verification.** `GET /api/catalog/available`: `posterCoverage.catalog` grows by the hydrated films that are currently available and `missing` shrinks; for the films the owner reported, `films[].poster` is a URL. A repeated step 1 shows the new `verifiedMissing`. Then the owner's visual smoke on desktop and mobile: at least some «Находки» cards show an image instead of the year.

## Failure recovery

The two catalog copies are separate R2 objects and are not written atomically together. A call that stops between them leaves the published generation's copy with the poster and the live catalog without it; the response reports it per copy (`writes`) and per record (`writtenTo`). Nothing has to be undone: the poster is the TMDB asset of the record's verified id. The next call re-reads both copies, writes the missing one or reports the record again. A call that stops before the first write wrote nothing.

## Rollback

To stop, make no further execution call; nothing runs by itself. Posters already written stay: each is the TMDB asset of the record's verified id, in the same form the discovery writer stores, and nothing else in the record changed. Removing them would be a separate approved write that sets `poster` back to `null` for the listed ids from the receipts; no deletion step is part of this procedure. The route never writes the generation pointer, identity, shows or decisions, so there is nothing else to restore.

A code revert to a release that reads the former switch needs `CATALOG_POSTER_HYDRATION=on` restored on Worker `iptv` (owner authorization) before any execution call there; without it that code answers `409 Catalog poster hydration is off`. The dry run works either way.

## When to use

When the read-only count shows verified records without a poster that matter to the owner, typically after a mass TMDB discovery failure. Each run needs the owner's approval of the execution calls, then the owner's visual smoke with at least some posters visible. Films without a stored asset keep the placeholder until a run fills them. A recurring or scheduled hydration is not part of this procedure.
