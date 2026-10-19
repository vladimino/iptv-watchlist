# Cloudflare R2 trial import

Working memory for the next implementation. The importer is not built yet. Do not start it by inventing a snapshot format: the export contract is already implemented.

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

## Importer to build next

A local Node.js CLI with three separate operations:

- Dry-run: validate the snapshot, Cloudflare target, and plan. Write nothing.
- Import: upload every object. Run only after a separate owner approval.
- Verify: independently list the whole destination bucket and check keys, sizes, portable metadata, and SHA-256 of the bytes. Do not use ETag as the checksum.

Fail closed before any write:

- Schema, completeness, report status, per-file size and SHA-256, totals, and aggregate checksum must match.
- Account ID, bucket name `iptv`, and endpoint must be the expected Cloudflare target.
- Credentials are a dedicated R2 authorization, not the Sites `X-Migration-Export-Key` and not a value passed on the command line or committed in the repo. Prefer a mode-0600 file or an environment variable supplied by the operator's secret store.
- Refuse an unexpected existing object or different bytes. No implicit overwrite or delete.
- Preserve original keys, bytes, and portable HTTP/custom metadata.
- A retry must resume. Do not require a full restart after interruption.
- Verification uses a full paginated listing, not a sample.
- Keep durable data: watchlist, programme, started flags, fingerprints, predictions, profiles, events, overrides, and operation history.
- Do not call the legacy Site or its R2.
- Logs must not contain credentials, object bodies, or personal data.

### Ephemeral leases

Known lock objects include `enrichment/runner-lease.json`, `enrichment/writer-lease.json`, and `epg/resolver-lease.json`. Their `expiresAt` values are process leases, not user data.

Proposed behavior, not yet approved for deletion: the trial import copies these objects unchanged and reports them as leases. An expired lease must not be treated as an active lock after restore. Do not drop or rewrite them until the cutover policy says so. Before the final switch, decide explicitly whether to import them as released (`expiresAt: 0`) or omit them.

### Suggested Cloudflare access

Use the S3-compatible R2 API from a Node.js AWS SDK client configured with the R2 endpoint `https://<account-id>.r2.cloudflarestorage.com`. Required scope is object list, get, and put on bucket `iptv` only. The GitHub Actions deploy token is a separate publication credential and must not be reused as the bulk-import key. The tool must compare the configured account ID and bucket name with the expected values and stop on any mismatch.

Commands, once implemented, should look like:

```bash
node scripts/migration-import.mjs dry-run --snapshot /absolute/private/snapshot-directory
node scripts/migration-import.mjs import --snapshot /absolute/private/snapshot-directory
node scripts/migration-import.mjs verify --snapshot /absolute/private/snapshot-directory
```

Import stays disabled until the owner gives a separate approval. Tests use synthetic fixtures and a fake bucket only: JSON, arbitrary bytes, Unicode keys, portable metadata, a corrupt snapshot, checksum mismatch, wrong account or bucket, an existing conflicting object, a repeated import, an interrupted resume, a missing or extra destination object, metadata mismatch, lease reporting, and a dry-run that performs no writes.

## Still required before a trial import

Read `AGENTS.md`, this file, `docs/migration-export.md`, `docs/deployment.md`, `scripts/migration-export.mjs`, `src/migration-export.js`, `tests/migration-export.mjs`, and `wrangler.jsonc`. Implement the CLI and synthetic tests in a new pull request. Run `npm ci`, `npm test`, and `npm run build`. Do not merge that pull request, run a real import, empty Cloudflare R2, change the legacy Site, start Scheduled Tasks, edit Cloudflare secrets, or perform the cutover without a new explicit approval.
