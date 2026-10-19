# Cloudflare R2 trial import

The local importer is `scripts/migration-import.mjs`. It reads a snapshot produced by `scripts/migration-export.mjs` and can restore it into the existing Cloudflare bucket `iptv`. It does not contact the legacy Site. A real import still requires a separate owner approval; the command refuses to upload without `--confirm-import`.

## Authority

Two runtimes share one application and must stay independent until cutover:

- Legacy ChatGPT Site `https://iptv.vladimino.chatgpt.site/`, Site `appgprj_6abfed826e148191903dec4175166ff7`, binding `BUCKET`. This remains the authoritative user-data store. Its exporter is published. Do not modify that Site or its R2.
- Cloudflare Worker `iptv` at `https://iptv.vladimino.workers.dev/`, private behind Cloudflare Access. Its only R2 bucket is `iptv`, also bound as `BUCKET`. GitHub `main` deploys this Worker through GitHub Actions. Until cutover this bucket is not authoritative. Do not create another Worker or bucket; the trial restore uses this existing bucket before it becomes production.

`Cloudflare Prod` identifies deployment credentials. It does not mean data cutover is done.

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

`provisional_no_change_detected` means two listings agreed. It does not prove that no write happened during the export. Schedules were disabled for this trial; that still does not make the snapshot a final cutover archive. A final archive needs an explicitly paused writer set and a fresh export.

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

Dry-run validates schema version 1, `provisional_no_change_detected`, every file hash, totals, and the aggregate checksum, then lists the destination. It writes nothing and does not modify the snapshot directory. Import uploads missing keys with `If-None-Match: *`. HTTP 412 stops the import; the tool does not overwrite and does not re-check the object with HEAD. An interrupted run can be repeated: objects whose bytes and portable metadata already match are skipped. It refuses an extra destination key or different bytes and never deletes. Verify lists the whole bucket, rejects a repeated continuation token or a repeated key, and hashes every object. Responses are read without automatic decompression, so a gzip payload stays the original bytes. ETags are not checksums. `httpMetadata.cacheExpiry` is sent and compared as an HTTP `Expires` date.

Portable metadata is `httpMetadata` and `customMetadata`. Source `etag`, `version`, `uploaded`, and `storageClass` stay in the snapshot as provenance and are not rewritten onto the destination as system identity.

`enrichment/runner-lease.json`, `enrichment/writer-lease.json`, and `epg/resolver-lease.json` are copied unchanged and counted as leases. An expired lease must not be treated as an active lock. They are not dropped or rewritten until a separate cutover decision says to release or omit them.

Durable keys, including watchlist, programme, started flags, fingerprints, predictions, profiles, events, overrides, and operation history, are restored byte for byte.

## Still required before a trial import

The private snapshot was not opened in development. Run dry-run against it only after the auth file exists. Do not pass `--confirm-import` until the owner approves that trial in writing. Do not empty Cloudflare R2, change the legacy Site, start Scheduled Tasks, edit Cloudflare secrets, or treat this snapshot as the final cutover archive. A final cutover still needs paused writers and a fresh export.
