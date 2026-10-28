# Production R2 snapshot export (read-only, owner approval required)

`scripts/r2-snapshot-export.mjs` takes a local snapshot of the production bucket `iptv` through the S3-compatible API with a **read-only** credential and writes the manifest shape the migration tooling verifies. Running it against production is a separately approved operation: this page is the procedure, not the permission. The decision it implements is [ADR-0019](../adr/0019-live-d1-backfill-boundaries.md); the manifest it produces is described in the [D1 contract](../reference/data/d1-schema.md#production-baseline-manifest).

## What the command never does

- It sends `GET` and `HEAD` only. The client refuses to build any other request, so it cannot write, delete or change bucket settings even with a broader credential.
- It reads the credential from the local environment only (`R2_SNAPSHOT_ACCOUNT_ID`, `R2_SNAPSHOT_ACCESS_KEY_ID`, `R2_SNAPSHOT_SECRET_ACCESS_KEY`, optional `R2_SNAPSHOT_BUCKET`, default `iptv`). No file in the repository holds it, no report or manifest records it, and the Worker, its Access configuration and the Scheduled Tasks are not touched.
- It writes only inside the output directory, which must be an absolute path outside the Git repository. Object bodies, the manifest, listing pages and reports stay there and are never committed, uploaded or logged.
- It does not infer changes from timestamps and does not call two equal listings a snapshot. The proof is the one below, or an explicit NO-GO.

## The consistency proof

**Planned ([ADR 0034](../adr/0034-bounded-discovery-ledger.md), not implemented):** once the bounded discovery ledger is active, the fence must also include `epg/discovery-archive/v1/current.json`. The archive's manifest and segment versions are write-once, so the listing proof covers them as ordinary objects.

1. **Opening listing.** A complete paged `ListObjectsV2` inventory, checkpointed page by page so an interrupted run resumes from the last durable cursor.
2. **Conditional reads of the listed version.** Every request sends a signed `Accept-Encoding: identity`, so the response carries the stored bytes, the strong ETag and the `Content-Length`; without it Cloudflare compresses JSON on the fly, weakens the ETag and every `If-Match` fails with `412`. A content-encoded response or a weak ETag is refused as a `protocol` error (exit 1), never hashed. For every key: `HeadObject` with `If-Match` on the listed ETag, `GetObject` with the same `If-Match` whose response ETag and length must equal the listing, a raw SHA-256 of the streamed bytes, then `HeadObject` with `If-Match` again. A `412`, a missing key or a differing ETag is `source_changed`: the attempt is NO-GO.
3. **Closing listing.** A fresh complete inventory compared key by key with the opening one. Any `added_after`, `metadata_changed` or `missing_after` key is `inventory_changed`; a deletion is also `deletion_observed`, because the Worker never deletes an object.
4. **Fence.** After the closing listing has finished, `HeadObject` on `epg/resolver-lease.json`, `enrichment/writer-lease.json`, `enrichment/runner-lease.json`, `epg/published-generation.json`, `sync.json`, `epg/resolver-continuation.json` and `enrichment/profile/current.json`. Each must carry the ETag the opening listing saw (or be absent at both ends). Otherwise `fence_changed`.
5. **Baseline identity.** From the downloaded bytes only: the published `programmeRunId`, `sync.json` `updatedAt`, the continuation `at` and `hopId`, and the latest enrichment run id. They label the cut; they are not a change log.

The manifest status is `consistent_fenced` only when steps 2 to 4 all hold. Any other outcome is `no_go` with its reasons listed, the manifest (when one was written) says so, and the exit code is 3. A NO-GO discards the opening listing so the next attempt lists afresh; object checkpoints whose listed version is unchanged are re-verified and reused, so a retry transfers only what changed.

Transient failures (`429`, `5xx`, a dropped connection) are retried a bounded number of times with backoff; a failure past the bound ends the run as `incomplete` without a manifest. A `401`/`403` is an authorization failure and is not retried.

## Procedure (each run needs its own approval)

1. **Plan without a credential.** `node scripts/r2-snapshot-export.mjs --plan --output /absolute/private/snapshot` prints the endpoint, bucket, fence keys, the requests an approved run would make and the exit codes. It reads no secret and sends nothing. This is the dry-run for a review.
2. **Rehearse against the fake bucket.** `node tests/r2-snapshot-export.mjs` runs the exporter against a local S3-compatible server: concurrent writer, changed and deleted keys, ETag drift, fence and lease changes, bounded retries, resume and aggregate verification. It needs no credential and no network.
3. **Obtain the approved credential.** The owner creates a read-only, bucket-scoped R2 API token under its own approval, verifies its scope, and places it in the shell environment of the machine that runs the export. Nothing is written to the repository.
4. **Export.** `node scripts/r2-snapshot-export.mjs --output /absolute/private/snapshot`. Exit 0 is a fenced consistent cut; exit 3 is a NO-GO to read in `report.json`; exit 1 is a failed run; exit 2 is a usage or configuration error.
   `--concurrency N` (1 to 16, default 1) verifies N objects at once. Each object still gets its own conditional `HEAD`, `GET` and `HEAD`, and the listings, fence and manifest are unchanged, so the proof is the same; only the waiting overlaps. Use it when the bucket has a periodic writer and a sequential pass cannot fit between its writes: on 28 October 2026 ([AIR-222](https://trello.com/c/9Y4G9DG6)) the hourly Task wrote from about :17 to :50 of every hour, a sequential pass over 8,600 objects took about 70 minutes through the agent proxy, and three attempts were `source_changed`. The first failure stops new work; objects already in flight finish their read-only requests.
   Behind an HTTPS proxy (for example a cloud container that sets `HTTPS_PROXY`), start Node with `NODE_USE_ENV_PROXY=1`. Without it Node's built-in `fetch` ignores the proxy and the run fails as `network` before the first request reaches R2. A machine with direct access needs no setting.
5. **Verify independently.** `node scripts/r2-snapshot-export.mjs --output /absolute/private/snapshot --verify` re-reads every stored object against the manifest, recomputes the aggregate SHA-256 and re-checks the source identity, status and fence record. Exit 3 means the manifest itself records a NO-GO.
6. **On NO-GO.** Do not import. Re-run during a quieter interval; the opening listing is taken again and unchanged objects are reused. If the proof cannot be produced within a reasonable number of attempts, the alternative is a short, separately approved freeze of the Scheduled Tasks for the export window; this page does not grant it.
7. **Afterwards.** The owner revokes or keeps the credential as decided; the snapshot directory stays private. The [backfill executor](d1-backfill.md) consumes the manifest; it refuses one whose status is not `consistent_fenced`.

## Rollback

The command changes nothing outside its output directory. Deleting that directory removes the snapshot; deleting `scripts/r2-snapshot-export.mjs`, `tests/r2-snapshot-export.mjs` and this page removes the tool. Revoking the credential is the owner's Cloudflare action.
