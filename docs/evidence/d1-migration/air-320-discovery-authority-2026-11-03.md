# AIR-320 discovery authority, local contract

**Date:** 2026-11-03, with the review cases on 2026-11-04 (UTC)
**Scope:** `node tests/discovery-authority.mjs` against local SQLite files created in a temporary directory. Migrations `0001` through `0010` were applied only to those files, in order. No Cloudflare API, no production D1, no production R2, no live TMDB. The 429 and 403 answers are a `fetch` stub inside the test process.

## Result

The local contract holds for the cases in that file. After `npm ci` on 3 November 2026, `npm test` passed 209 self-contained files and `npm run build` completed. The review cases below were run again on 4 November 2026: `npm test` passed the same 209 files and `npm run build` completed. Neither run opened production.

- `0010` refuses schema v1 and a complete schema v8 before it creates a discovery table. The v8 file stays at version 8.
- The full chain leaves version 10. The inserted marker is `mode` `r2`, `cutover` `open`, generation 0. `film` stays empty. A downgrade of `schema_contract.version` raises `schema_contract_downgrade`.
- With the marker set to `d1` / `open` in that local file only: two acquirers, the second gets no lease; a departed observation is archived rather than deleted; a decision whose evidence key does not match is `discovery_fence` and the stored decision stays; decision history records the first hash; a renew for the sealed programme succeeds and a renew for an older programme does not.
- A future `retryAt` makes `resolveDiscoveryChunk` return `backoff` without calling `fetch`.
- Movie `tmdb:41` and TV `tmdb_tv:41` are both admitted. A duplicate movie id and a canonical identity that does not match the id throw `discovery_conflict` and leave the previous admission. Fifty movie admissions fit in batches of at most 40 statements. An observation with 40 shows round-trips. `film` stays empty.
- An archive import with a bad SHA-256 writes nothing. A matching import of 30 items uses more than one batch, each at most 40 statements. A duplicate key in one segment throws `discovery_conflict`.
- A reconsider intent left `running` answers `unknown` and does not clear `terminalReason`. The same key from `approved` writes the decision and the receipt. A replay ignores a bad expected hash. Identity assign stores `verified` and inserts no film. Identity reject stores `rejectedTmdbIds` `['41']`. A missing intent answers `missing`.
- Continuation compare-and-swap rejects `d1:0` and accepts the current etag. The workflow record round-trips. `src/discovery-authority.js` does not call `ensureDiscoveryWorkflow` or `create()`.
- The owner index is `fresh` for the current generation, `stale` for expected generation 0, and `unavailable` when the programme is null. A throwing `prepare` and a marker mode other than `r2` or `d1` are `discovery_unavailable`.
- `scripts/discovery-authority.mjs` prints `mode` `d1` and `writes` `false` for that local file. `--database /tmp/iptv/discovery.sqlite` and `--activate` exit 2.

## Review cases, 2026-11-04 (UTC)

Same file, still only the temporary SQLite. These cases answer the blocking review on the preparation pull request. They do not open production.

- A generation key for a run other than the marker's programme reads as empty, including when R2 holds an object at that key. A write of that other run throws `discovery_fence`. `handoff: true` on the new run moves the ledger, and the previous run's key then reads empty.
- An issued confirmation stores its expiry, expected hash and identity command. Execute refuses a client expiry that is later than the stored one, a different hash, and an assign whose next decision names a different movie id. The stored decision is unchanged.
- A keyed index read of observation `k03000` among 3001 rows returns that row. A list limited to 2 rows does not include it, and `coverage.complete` is false.
- A ledger seal that throws on the second batch leaves `transfer` `loading`, and the same live lease can finish it. An archive import that throws mid-batch leaves `loading`; importing the same source key again, with no live lease, replaces that partial segment and reaches `committed`. The active ledger row is unchanged.
- `ingestLedger` without `handoff` does not pull the generator. With `handoff`, two yielded observations are stored. A ledger of 20001 active rows reads as `paged`, with `items` null. `resolveDiscoveryChunk` with limit 1 then calls the stub once at HTTP 429 and, after `retryAt` is cleared, once at HTTP 403. Both set `retryAt`. The page size stays at or below 500. No request left the process.
- The Worker routes, in a `vm` with the same SQLite, confirm, execute, replay and read the receipt for `discovery_reconsider`. A confirmation whose pin no longer matches its scope is `invalid_request` and writes no decision history. A confirmation whose expiry is later than the issued one is `confirmation_mismatch` and writes nothing. Setting the stored `expires_at` into the past makes execute return `confirmation_expired`, and `terminalReason` stays. The receipt GET does not read an `admin/actions/` object.
- The same routes confirm, execute, replay and read the receipt for `discovery_identity_correct` assign of `tmdb:41`. A confirmation with a different `scopeFingerprint` is `invalid_request`. The decision becomes `tmdbId` `41`. The `film` table stays empty. The stored command keeps the owner's basis, and execute uses that stored command.
- `GET /api/catalog/available` returns the one movie that exists only in the D1 catalog. A television row in that catalog is absent. An R2 catalog object that holds a different movie is not read and is not returned. When the published pointer names another run, the route answers 409 `Catalog generation copy is not in place` and does not serve the D1 catalog.

## Not verified

- Production D1 and production R2 were not opened.
- `0009` and `0010` were not applied to any database outside the temporary directory.
- The marker was not set to `d1` anywhere except that temporary file, inside the test.
- The limbo page was not opened in a browser.
- Worker CPU on a production-sized ledger was not measured. The statement cap is asserted on the local batches above, not on a live generation.
- This note does not authorize schema apply, import, hold, seal, activation, discovery, or TMDB.
