# Read-only export from the old Sites-managed R2

The exporter implementation is merged into GitHub `main` and included in Cloudflare CI/CD builds. It was separately published to the existing legacy Site as version 85 (`appgprj_6abfed826e148191903dec4175166ff7~appgver_881c8227516481919ffb6abe71b9b61a`), source SHA `0640e760d2140ae053952d8ae93f2fe0904d4728`, with environment revision 4. The source tree matches GitHub `5ec19ac463b32c24cee4f261da267a0a5374ad5e`. Owner-authorized one-page listing succeeded; this did not constitute a complete export.

Cloudflare deployments do not publish the exporter on the old Site or provide access to Sites-managed R2. Both runtimes have independent `BUCKET` bindings. Do not run a real export or change Sites environment/deployment without a separate owner approval.

Version 84 remains the pre-exporter code rollback checkpoint. A code rollback does not roll back environment revision 4 or R2 data.

## Trial snapshot (19 October 2026)

An owner-authorized, read-only trial export from the legacy Site completed to a private local directory outside this repository. The first listing covered 66 pages and 6,520 unique objects. The downloader saved 97,759,255 raw bytes, with no download errors or source-change conflicts. Its second complete listing found **zero** added, missing or metadata-changed keys. The manifest and report both record `provisional_no_change_detected`; a separate `--verify` pass checked every local object's raw-byte SHA-256 and size, plus the manifest totals and aggregate checksum, and passed. The private snapshot, manifest, object keys, authorization material and aggregate checksum are not committed here.

| Prefix | Objects | Raw bytes |
| --- | ---: | ---: |
| `enrichment/` | 6,301 | 15,322,997 |
| `epg/` | 8 | 78,129,376 |
| `events/` | 179 | 79,176 |
| `started/` | 25 | 5,349 |
| Root | 7 | 4,222,357 |

The owner stopped the scheduled job during the trial, but writers were not quiesced for the entire export. R2 listing is not atomic; therefore this is suitable for an **authorized trial restore into an isolated target**, not a final migration baseline. A final cutover requires separately approved writer quiescence and a fresh complete export/verification. No Cloudflare R2 import or production data switch was performed.

## Scope and safety

The source is the existing Site `appgprj_6abfed826e148191903dec4175166ff7` at `https://iptv.vladimino.chatgpt.site/`. Its `BUCKET` binding is the authoritative R2 source until migration cutover. The new Cloudflare Worker `iptv` has a **different** R2 bucket. The endpoint is disabled by default, including on Cloudflare: it requires the old Site ID, an explicit enable flag, and a dedicated export key in the Sites environment. The Site's access policy must remain owner-only; the extra key is defense in depth, not a replacement for Sites authentication. All exporter routes are GET-only and invoke only `R2.list`, `R2.head`, or conditional `R2.get`. They never create, update, delete, or lease an R2 object.

`GET /api/migration-export/list` pages through the *entire* bucket with no prefix or delimiter and includes HTTP/custom metadata. `GET /api/migration-export/head` verifies current metadata for a key/version/ETag. `GET /api/migration-export/object` conditionally streams the original bytes for that version without buffering the object in Worker memory. A changed or missing object returns conflict, never silently substitutes newer bytes. The existing `/api/enrichment/diagnostics/export` is not a complete backup.

The local downloader stores every listing page, each object under a SHA-256-derived filename, and a sidecar with the original R2 key, size, metadata, timestamp, ETag, version, and SHA-256 of the downloaded raw bytes. It resumes from saved pages and verified object files after interruption. A second full listing compares keys and metadata to the first. Duplicate keys, broken/repeated cursors, changed objects, local checksum mismatches, and missing/added keys fail or mark the snapshot inconsistent. `manifest.json` includes schema version, timestamps, object records, prefix totals, total bytes/count, and an aggregate checksum. `report.json` summarizes incomplete or inconsistent results.

R2 listing is not an atomic transaction. `provisional_no_change_detected` means two listings and object checks found no difference; it does **not** prove no writes occurred between checks. While Scheduled Tasks continue, every snapshot remains provisional. A final cutover snapshot requires separately authorized writer quiescence and a fresh export/reverification.

## Publication plan — requires separate approval

The current GitHub `main` SHA may differ from the SHA used to prepare an earlier local Sites merge candidate. Before reusing any candidate or archive, confirm both HEADs, the selected green GitHub SHA and exact Git tree. Recreate stale artifacts rather than publishing an outdated candidate.

1. Confirm the exact approved GitHub SHA, green CI, current Sites source HEAD, serving version, owner-only access policy, Site ID/URL, `BUCKET` binding, environment key names, and enabled schedules. Preserve the current saved version as a code rollback checkpoint. Record that redeploying it uses the *current* environment revision, not necessarily its original one.
2. Produce a normal merge commit with current GitHub and Sites HEADs as parents and a tree identical to the approved GitHub SHA. Verify tree IDs, `npm ci`, `npm test`, `npm run build`, and the Sites archive. Never push the Sites merge commit back to public GitHub.
3. With separate approval, configure **only on the old Site** `MIGRATION_EXPORT_SITE_ID=appgprj_6abfed826e148191903dec4175166ff7`, `MIGRATION_EXPORT_ENABLED=true`, and a new high-entropy `MIGRATION_EXPORT_KEY` secret. Do not reveal the secret in source, chat, logs, or GitHub. This changes the current Sites environment revision; verify other bindings/keys and schedules remain unchanged. Do not copy these values into the new Cloudflare Worker.
4. Perform only a non-force push to Sites source, save an archive-backed version from the exact pushed SHA, verify source/archive provenance, then deploy that saved version through supported Sites actions. Stop before deploy on any changed HEAD, tree/build/archive mismatch, rejected push, failed save, or changed Site identity/configuration.
5. Check the same Site ID/URL, old `BUCKET` binding, environment and schedules, normal UI/read-only APIs, and owner-only exporter authorization. If critical checks fail, redeploy the saved pre-export version and recheck. This is **code rollback only**; it does not restore an earlier environment revision or change R2 data.
6. Only after a second explicit approval, run a real trial export and independently verify the manifest, key count, sizes, raw-byte SHA-256, and another complete source listing. Do not disable writers or call the trial snapshot a final consistent cutover.

## Local download after approved Sites publication

Keep the output directory and credentials **outside the repository**, on encrypted local storage with restrictive permissions. Supply current, owner-authorized Sites request headers in a mode-0600 file, one `Header-Name: value` per line. The client accepts `Cookie`, supported Sites service access (`OAI-Sites-Authorization`), and `X-Migration-Export-Key`; it never prints their values, never follows redirects, and sends them only to the pinned old-Site origin. Obtain/refresh access through supported owner controls; do not scrape a browser session or create bypass credentials. If access expires, update the private header file and rerun in the same output directory. No long-lived session is needed for already completed objects.

```bash
node scripts/migration-export.mjs --output /absolute/private/snapshot-directory --auth-file /absolute/private/migration-export.auth
node scripts/migration-export.mjs --output /absolute/private/snapshot-directory --verify
```

The first command is for the separately approved trial, **not** CI. It refuses output under this repository. Do not upload the snapshot, header file, manifest, or reports to GitHub, the new Cloudflare R2, public build artifacts, or logs. Keep the archive encrypted and access-restricted; delete temporary authorization material through the owner's normal secure handling after the export. Resume by rerunning the first command with the same output directory; do not edit checkpoint pages or object files. An `inconsistent` result requires investigation and a fresh export after writers are paused, not automatic acceptance.

## Trial restore procedure (requires separate authorization)

Treat a trial snapshot as a candidate for a **non-production** restore, not permission to import it into Cloudflare R2. Before any restore, run `--verify`, require a complete manifest and zero reported changes, and retain the original snapshot unchanged. Use an empty, isolated destination or namespace; never overwrite the live `iptv` bucket as a test. For every manifest entry, read the referenced hashed `.bin` file, verify its size and SHA-256, then restore it under the original R2 key with the recorded HTTP and custom metadata. Re-list the destination and compare key count, key set, sizes and metadata; read every restored object and verify its raw-byte SHA-256 against the manifest. Record any metadata fields the destination cannot reproduce. A successful trial restore still does not make the snapshot a final cutover baseline while source writers remain active. Import, writer quiescence and production cutover each need separate approval.
