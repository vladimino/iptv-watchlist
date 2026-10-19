# Cloudflare R2 import

The local importer is `scripts/migration-import.mjs`. It reads a snapshot produced by `scripts/migration-export.mjs` and restored it into the existing Cloudflare bucket `iptv`. It does not contact the legacy Site. The command still refuses an upload without `--confirm-import`. That flag is not approval to run the import again.

## Authority after cutover

Cutover completed on 19 October 2026 from GitHub `main` `58737738275fca182afd8afbdd035870db63315e`.

- Cloudflare Worker `iptv` at `https://iptv.vladimino.workers.dev/`, private behind Cloudflare Access. Its only R2 bucket is `iptv`, bound as `BUCKET`. This bucket is the authoritative production store. GitHub `main` deploys this Worker through GitHub Actions. Do not create another Worker or bucket.
- Legacy ChatGPT Site `https://iptv.vladimino.chatgpt.site/`, Site `appgprj_6abfed826e148191903dec4175166ff7`, binding `BUCKET`. This is a temporary reserve and the source of the historical snapshot. Do not modify that Site or its R2, and do not run writers there.

`Cloudflare Prod` identifies deployment credentials. It does not authorize another data restore. Scheduled Tasks remain off. Unattended ChatGPT authorization to Cloudflare is a separate problem; do not relax Access to solve it.

## Completed restore (19 October 2026)

The historical snapshot, 6,520 objects and 97,759,255 bytes, was imported into an empty bucket `iptv`. The import wrote 6,520 objects and skipped none. A later independent `verify` reported `missing: 0`, `extra: 0`, and `writes: 0`: every key, size, raw-byte SHA-256, and portable metadata matched. An earlier separate verify stopped with HTTP 403 before finishing; listing immediately afterward still showed the same object count and byte total, and the successful verify replaced that incomplete pass.

An independent listing of the legacy reserve covered 66 pages. All 6,520 objects matched the source manifest metadata. Metadata fingerprint: `623a68daeba9513b1aa6b6313187230612af4049aaf79a27a06da0e994385815`.

Do not automatically import, replay, or overwrite production R2 from this snapshot. The main Cloudflare interface was checked through Cloudflare Access with read-only requests. That does not resume schedules.

## Trial snapshot (19 October 2026)

Owner-reported result of one full trial export. This session did not open the snapshot, its manifest, or any object bytes.

- 6 520 objects, 97 759 255 bytes.
- 66 pages in the first listing.
- Second full listing found no changes.
- No download or checksum errors.
- `manifest.json` and `report.json` status: `provisional_no_change_detected`.

The directory is private and outside this Git repository. It contains `manifest.json`, `report.json`, `run.json`, `pages/`, `entries/`, and `objects/`. Entry and object filenames are the SHA-256 hex of the UTF-8 R2 key (`fileId` in `scripts/migration-export.mjs`): `entries/<id>.json` and `objects/<id>.bin`.

`manifest.schemaVersion` is `1`. `manifest.objects[]` records `key`, `file`, `size`, `sha256`, and `metadata`. The aggregate checksum in `totals.aggregateSha256` is computed by `manifestFor`: objects sorted by raw key bytes, then length-prefixed UTF-8 of `key`, `size`, and `sha256`. `verifySnapshot()` recomputes file hashes and totals and rejects schema, path, duplicate-key, size, or total mismatches.

Portable metadata is `httpMetadata` and `customMetadata` from `migrationMetadata()` in `src/migration-export.js`. Source `etag`, `version`, `uploaded`, and `storageClass` describe the old object and must not be forced back as identical system fields on the destination. Do not treat an R2 ETag as a checksum.

`provisional_no_change_detected` means two listings agreed. It does not prove that no write happened during the export. Schedules were disabled for this trial. The snapshot was still the archive used for the completed cutover above. It is not a reusable overwrite of production. A future production backup needs a fresh authorized read of bucket `iptv`.

If the private directory is not mounted in the next session, say so and continue with synthetic fixtures. Never paste manifest contents, object bytes, secrets, or user records into the model context.

## Local tool

Node.js 20 is enough. There is no extra npm dependency: the CLI signs S3 requests for the R2 endpoint `https://<account-id>.r2.cloudflarestorage.com` with the built-in `node:crypto` signer. The endpoint is derived from the account ID. The bucket argument must be `iptv`; any other bucket or a mismatched account confirmation is refused before a request is sent.

Create a mode-0600 JSON file outside the repository. Do not pass secrets as command arguments.

```json
{
  "accountId": "<32-hex Cloudflare account ID>",
  "confirmAccountId": "<the same account ID>",
  "bucket": "iptv",
  "accessKeyId": "<R2 access key>",
  "secretAccessKey": "<R2 secret>"
}
```

The key needs list, get, and put on bucket `iptv` only. It is not the Sites export key and not the GitHub Actions deploy token. `chmod 600` the file. The tool prints counts only: it does not print credentials, object bodies, or object keys.

```bash
node scripts/migration-import.mjs dry-run --snapshot /absolute/private/snapshot-directory --auth-file /absolute/private/r2-import.auth
node scripts/migration-import.mjs import --snapshot /absolute/private/snapshot-directory --auth-file /absolute/private/r2-import.auth --confirm-import
node scripts/migration-import.mjs verify --snapshot /absolute/private/snapshot-directory --auth-file /absolute/private/r2-import.auth
```

Dry-run validates schema version 1, `provisional_no_change_detected`, every file hash, totals, and the aggregate checksum, then lists the destination. It writes nothing and does not modify the snapshot directory. Metadata that cannot survive the S3 API, such as a non-ASCII metadata key, fails the dry-run before the first write. Import uploads missing keys with an explicit `Content-Length` and `If-None-Match: *`. HTTP 412 stops the import; the tool does not overwrite and does not re-check the object with HEAD. An interrupted run can be repeated: objects whose bytes and portable metadata already match are skipped. It refuses an extra destination key or different bytes and never deletes. Verify lists the whole bucket, rejects a repeated continuation token or a repeated key, and hashes every object. Responses are read without automatic decompression, so a gzip payload stays the original bytes. ETags are not checksums. `httpMetadata.cacheExpiry` is sent and compared as an HTTP `Expires` date. Unicode custom metadata values are written and read as RFC 2047 encoded words, then compared as the original text.

Portable metadata is `httpMetadata` and `customMetadata`. Source `etag`, `version`, `uploaded`, and `storageClass` stay in the snapshot as provenance and are not rewritten onto the destination as system identity.

`enrichment/runner-lease.json`, `enrichment/writer-lease.json`, and `epg/resolver-lease.json` were copied unchanged and counted as leases. An expired lease must not be treated as an active lock. Before any background process resumes, confirm these three objects are not stale locks. Do not delete or rewrite them as part of an ordinary deploy.

Durable keys, including watchlist, programme, started flags, fingerprints, predictions, profiles, events, overrides, and operation history, are restored byte for byte.

## Closed

The private snapshot stays outside Git. Do not empty Cloudflare R2, change the legacy Site, start Scheduled Tasks, edit Cloudflare secrets, or pass `--confirm-import` for this snapshot again. Production already contains the restored data, plus any later authorized application writes. Replaying the snapshot would be an overwrite, and the importer is not a cleanup tool.
