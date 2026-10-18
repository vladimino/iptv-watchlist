# Read-only export from the old Sites-managed R2

This exporter is **prepared but not published to the old Site**. Merging its PR only updates GitHub and the separate Cloudflare Worker; it does not make the old Site's `env.BUCKET` available to that Worker. Do not run a real export or change Sites environment/deployment without a separate owner approval.

## Scope and safety

The source is the existing Site `appgprj_6abfed826e148191903dec4175166ff7` at `https://iptv.vladimino.chatgpt.site/`. Its `BUCKET` binding is the authoritative R2 source until migration cutover. The new Cloudflare Worker `iptv` has a **different** R2 bucket. The endpoint is disabled by default, including on Cloudflare: it requires the old Site ID, an explicit enable flag, and a dedicated export key in the Sites environment. The Site's access policy must remain owner-only; the extra key is defense in depth, not a replacement for Sites authentication. All exporter routes are GET-only and invoke only `R2.list`, `R2.head`, or conditional `R2.get`. They never create, update, delete, or lease an R2 object.

`GET /api/migration-export/list` pages through the *entire* bucket with no prefix or delimiter and includes HTTP/custom metadata. `GET /api/migration-export/head` verifies current metadata for a key/version/ETag. `GET /api/migration-export/object` conditionally streams the original bytes for that version without buffering the object in Worker memory. A changed or missing object returns conflict, never silently substitutes newer bytes. The existing `/api/enrichment/diagnostics/export` is not a complete backup.

The local downloader stores every listing page, each object under a SHA-256-derived filename, and a sidecar with the original R2 key, size, metadata, timestamp, ETag, version, and SHA-256 of the downloaded raw bytes. It resumes from saved pages and verified object files after interruption. A second full listing compares keys and metadata to the first. Duplicate keys, broken/repeated cursors, changed objects, local checksum mismatches, and missing/added keys fail or mark the snapshot inconsistent. `manifest.json` includes schema version, timestamps, object records, prefix totals, total bytes/count, and an aggregate checksum. `report.json` summarizes incomplete or inconsistent results.

R2 listing is not an atomic transaction. `provisional_no_change_detected` means two listings and object checks found no difference; it does **not** prove no writes occurred between checks. While Scheduled Tasks continue, every snapshot remains provisional. A final cutover snapshot requires separately authorized writer quiescence and a fresh export/reverification.

## Publication plan — requires separate approval

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
