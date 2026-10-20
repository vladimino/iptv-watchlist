# Deployment and rollback: Cloudflare production and legacy Sites reserve

## Production topology (19 October 2026)

GitHub `main` is the canonical code source. Cloudflare is the production runtime:

- Production: https://iptv.vladimino.workers.dev/. Worker `iptv`, deployed by GitHub Actions, private behind Cloudflare Access. R2 bucket `iptv`, binding `BUCKET`, is the authoritative production store.
- Experimental MCP: `https://iptv.vladimino.workers.dev/mcp`, served by the same Worker. A separate Access application, `IPTV MCP`, protects this path with Managed OAuth and an owner-only policy. Application `All Workers` keeps protecting every other path. The Worker verifies the Access JWT using the runtime variables `MCP_ACCESS_TEAM_DOMAIN` and `MCP_ACCESS_AUD`, which are set in the Cloudflare dashboard and not committed. The two probe tools do not use R2. See [docs/mcp.md](mcp.md).
- Legacy reserve: https://iptv.vladimino.chatgpt.site/, Site `appgprj_6abfed826e148191903dec4175166ff7`. Its separate R2 store is a temporary reserve and the source of the historical snapshot. It is not the destination for current writes. Do not run sync, prediction, or other mutating processes there. Do not use it for ordinary browsing or diagnosis without separate approval: opening the UI is not guaranteed read-only, because `GET /api/events` can recover events and `GET /api/enrichment/view` can initialize the ratings index. GitHub/Cloudflare deployment does not update this Site.

Scheduled Tasks are off. Automatic data refresh has not resumed. Unattended ChatGPT authorization to Cloudflare remains a separate problem; acceptance criteria for unattended MCP runs are in [docs/mcp.md](mcp.md). Keep Cloudflare Access enabled.

The GitHub environment `Cloudflare Prod` identifies deployment credentials. It does not authorize a data restore or a schedule change.

## Data cutover (19 October 2026)

Cutover base SHA: `58737738275fca182afd8afbdd035870db63315e`.

The historical Sites snapshot contained 6,520 objects and 97,759,255 bytes, including three lease objects copied unchanged. Independent Cloudflare verification matched every key, size, raw-byte SHA-256, and portable metadata. Independent legacy listing covered 66 pages and matched all 6,520 objects to the source manifest metadata. Metadata fingerprint: `623a68daeba9513b1aa6b6313187230612af4049aaf79a27a06da0e994385815`.

That snapshot is historical. Do not automatically import, replay, or overwrite production R2 with it. A future backup or restore needs its own procedure and explicit approval. Details are in [docs/migration-export.md](migration-export.md) and [docs/r2-import.md](r2-import.md).

Before any background process resumes, confirm these copied leases are not stale locks: `enrichment/runner-lease.json`, `enrichment/writer-lease.json`, and `epg/resolver-lease.json`. An expired lease is not an active lock, and it must not be deleted or rewritten as part of an ordinary deploy.

## Cloudflare: automatic GitHub Actions CI/CD

Source: `.github/workflows/ci.yml`. The former independent Cloudflare Workers Builds integration has been disconnected.

1. Pull requests into `main` run `test-and-build`. A GitHub ruleset must be configured separately if CI is required to block merging.
2. Pushes to `main` run `npm ci --ignore-scripts`, `npm test`, and `npm run build`. The build uses Node.js 20 and uploads `dist/` as an artifact with one-day retention.
3. The `deploy` job requires successful `test-and-build` and downloads that exact verified artifact. Deployment runs only on pushes to `main`.
4. Deployment credentials belong to GitHub environment `Cloudflare Prod`:
   - Secret: `CLOUDFLARE_API_TOKEN`
   - Variable: `CLOUDFLARE_ACCOUNT_ID`
5. Deployment concurrency group: `cloudflare-iptv-production`, with `cancel-in-progress: false`. Before publishing, the job verifies that `GITHUB_SHA` still equals the remote `main` HEAD. This prevents common stale deployments, but the freshness check is not atomic with publication.
6. Before Wrangler starts, the job verifies the account token and the settings of Worker `iptv`. It prints the HTTP status and a short classification, not response bodies. A non-200 response or a network error stops the job before deploy.
7. `cloudflare/wrangler-action@v4` uses Wrangler 4.151.1 and `deploy --message`. Cloudflare release descriptions are:
   - Normal commit: commit subject
   - Merge commit: `PR #N: <PR title>`
8. `wrangler.jsonc` configures:
   - Worker: `iptv`
   - Entrypoint: `dist/server/index.js`
   - R2 binding: `BUCKET` -> `iptv`
   - `keep_vars: true`, so dashboard variables such as `MCP_ACCESS_TEAM_DOMAIN` and `MCP_ACCESS_AUD` survive deploys
   - `preview_urls: false`

A failed test/build, or a failed account-token or Worker-settings check, prevents deployment. A successful workflow confirms publication, not completion of data migration or end-to-end smoke tests. Use authorized read-only checks after deployment. For `/mcp`, use only the safe verification procedure in [docs/mcp.md](mcp.md).

### Cloudflare API token permissions and dashboard deployments

The account-owned API token `iptv-github-actions-deploy` needs two separate policies:

- `Specified Workers → iptv → Individual Workers Editor`
- `Entire Account → Workers Metadata Read-Only`

The second policy lets the token read Workers metadata for the account. It does not grant edit access to other Workers.

On 19–20 October 2026 a dashboard edit exposed the difference. The last successful Wrangler deploy before the failure published version `39280c59-48a5-45ae-8658-4f13b979b49d` in [run 39332844121](https://github.com/vladimino/iptv-watchlist/actions/runs/39332844121). Runtime variables were then added through the Cloudflare dashboard, and `last_deployed_from` became `dash`. Wrangler 4.151.1 took the `downloadWorkerConfig()` path and issued extra metadata reads. With only the Individual Workers Editor policy, `service routes` and `domain records` returned HTTP 403 and Cloudflare API error 10000. Wrangler replaced that result with `Unable to fetch bindings, routes, or services metadata from the dashboard`. Adding `Workers Metadata Read-Only` for the entire account cleared both refusals. Attempt 2 of [run 39377053427](https://github.com/vladimino/iptv-watchlist/actions/runs/39377053427) deployed successfully with Wrangler 4.151.1. No rollback and no Wrangler upgrade were required. This is the observed behavior and the configuration that restored deploys.

`keep_vars: true` preserves dashboard variables across publication. It does not grant permission to read the metadata API.

If a later dashboard change makes an automatic deploy fail with that metadata message:

1. Check the current `last_deployed_from`.
2. Check both token policies above.
3. Read the metadata endpoints with the same CI token and record only the HTTP status and API error code.
4. Do not widen the token until a specific request has failed.
5. Do not roll the Worker back or repeat the R2 migration to diagnose a permission failure.

## Legacy Sites: historical release baseline

The version/SHA table below records the earlier Sites code checkpoint, including environment revision 3 at that time. It is not the latest confirmed environment. The latest confirmed Sites environment revision is 4, recorded with version 85. Re-query the live Site before any release or rollback; do not treat revision 3 as current.

The existing production Site is `appgprj_6abfed826e148191903dec4175166ff7` at `https://iptv.vladimino.chatgpt.site/`. The supported, ordinary-merge cutover succeeded without changing the Site, its URL, or its storage:

| Item | Verified value |
| --- | --- |
| GitHub `main` at cutover | `dd9ed9917d63400417126a67a5531175d982cb33` |
| Sites source merge commit | `d511970ddac7fcd99fd70b97a88680fcd05cb608` |
| Identical Git tree | `762b0596d4327f313c4ca78ce58c54a11843a8d6` |
| Saved and serving Sites version | 84 (`appgprj_6abfed826e148191903dec4175166ff7~appgver_cccfafb4a1408191a4d3bfb9a42bede4`) |
| Serving environment revision | 3 |
| Previous code rollback version | 83 (`appgprj_6abfed826e148191903dec4175166ff7~appgver_5cce7db688a0819197a36588aeb6b717`) |

The Sites merge commit has the selected GitHub commit and the previous Sites source HEAD as parents; its tree equals the GitHub tree. The distinct commit SHAs are expected. Never push Sites merge commits to public GitHub or merge private Sites history into GitHub.

## Why legacy Sites has no unattended CD

The supported Sites flow requires **both** (1) an authorized, short-lived Sites source-repository write credential for the non-force push and (2) authorized Sites actions to save and deploy the pushed SHA. The credential obtained in an authoring session expires within minutes and must not be stored as a GitHub Secret. The available Sites actions do not expose a documented GitHub Actions OIDC exchange, service credential, or standalone deployment API/CLI usable by this repository without a user session. GitHub OIDC for the OpenAI API Platform and workspace Codex access tokens/service accounts are separate products; neither is documented as granting this existing Site's source/version/deploy permissions. Do not substitute a browser/session token or a Site visitor bypass token.

This is an **authorization/control-plane blocker**, not a Git-history blocker. A workflow that builds an archive but cannot obtain the Sites credential and save/deploy authorization is not automatic CD for the legacy Site. Packaging and tree/archive validation can be automated without production access, while Sites publication remains an explicit, authorized Sites operation.

## Legacy Sites: repeatable manual release contract

This contract applies only to a separately approved publication of the legacy Site. The reserve Site is not required to match today's Cloudflare `main`.

For each such release, use the exact green GitHub `main` SHA chosen for that publication, never an uncommitted local tree:

1. Fetch current GitHub `main` and Sites source HEAD; verify CI succeeded for the exact GitHub SHA and it is still `main`.
2. Create an ordinary merge commit with **both** current HEADs as parents and a Git tree exactly equal to that GitHub SHA. The Sites HEAD must be an ancestor of the new commit. Do not rewrite either history.
3. Verify both tree IDs, run the tests/build, and build the Sites archive from that exact tree. Check its manifest, Worker entrypoint, and expected assets; do not package local-only files or credentials.
4. Obtain a fresh supported Sites source credential, perform a **non-force** push, and verify the remote HEAD is the pushed merge SHA. If either HEAD moved, discard this candidate and start over.
5. Save a Sites version from that pushed SHA with the checked archive; verify its recorded source SHA and archive metadata. Do not deploy an unsaved or mismatched version.
6. Recheck the current GitHub `main` and CI status immediately before deployment. Skip stale candidates; serialize releases and ensure a newer successful release cannot be superseded by an older run. Deploy only the saved version. Do not open the Site UI as a smoke test. `GET /api/events` can recover events, and `GET /api/enrichment/view` can initialize the ratings index, so a GET is not automatically read-only. Never call sync, enrichment, prediction, schedule, or mutation endpoints as smoke tests.
7. Record the GitHub SHA, Sites merge SHA, tree SHA, saved version, serving deployment, environment revision, and smoke result. Treat a later `main` push during publication as a new release requiring its own check/deploy; a pre-deploy freshness check alone is not an atomic guarantee against that race.

An unattended Sites implementation needs a documented non-human principal authorized for **all** Sites source/save/deploy actions on this exact Site, plus a tested way to invoke them from GitHub Actions. Before activation, restrict that identity to the repository/`main` workflow, use a protected production environment and deployment concurrency, verify the failure/rollback behavior in a separately authorized controlled test, and keep credentials out of source and logs. Do not enable a production Sites workflow on the assumption that API Platform OIDC, a Codex token, or a Sites visitor token is sufficient.

## Rollback boundaries

### Cloudflare Worker

Identify the previous known-good version in Cloudflare Deployments and roll back the Worker if needed. Verify Access, bindings, live version and read-only APIs.

Code rollback does not restore R2 data, secrets, environment configuration, or Scheduled Tasks. It also does not change GitHub `main`; a later push may supersede the rollback. Do not roll data back by replaying the 19 October 2026 snapshot over production R2. Backup of production data is a separate authorized read of bucket `iptv`, not a write from the legacy reserve.

For a permanent fix, merge a revert or corrective commit into `main` and deploy it through GitHub Actions. After deployment, use authorized read-only checks. Do not call sync, enrichment, prediction, schedule, or mutation endpoints as smoke tests. Do not enable Scheduled Tasks to prove a deploy.

### Legacy Sites

Version 84 was the last verified working checkpoint before exporter publication. Confirm the currently serving version before selecting a rollback target.

The read-only migration exporter was subsequently deployed on the same Site as version 85 (`appgprj_6abfed826e148191903dec4175166ff7~appgver_881c8227516481919ffb6abe71b9b61a`), Sites source `0640e760d2140ae053952d8ae93f2fe0904d4728`, using environment revision 4. Version 84 is the preferred pre-exporter code rollback checkpoint; re-query serving state before using it. See `docs/migration-export.md` for the trial snapshot and restore procedure. No GitHub-to-Sites CD was enabled by this release.

The 19 October 2026 export was then restored into Cloudflare R2 and independently verified. That completed the data cutover recorded above. It did not enable GitHub-to-Sites CD, and it did not make the legacy Site authoritative again. Do not repeat the import against production R2.

Version 83 remains an older fallback, not the automatically preferred rollback target.

Sites code rollback does not restore an earlier environment revision or revert R2 data. Do not force-push/reset Sites source, alter GitHub history, or mutate R2 data. A serving-version rollback does **not** roll back the Sites source branch or runtime data.

Sites deploys a saved version using the environment revision that is current at deploy time. The last confirmed revision is 4, recorded with version 85. Version 83 originally served with revision 2, and the earlier code checkpoint above records revision 3. Neither historical number is safe to assume. Before any rollback, re-query the live revision. A version rollback is code rollback only, not a guaranteed environment rollback. If code rollback still fails, inspect environment keys/bindings and request owner intervention for unavailable secret values rather than guessing or restoring them automatically.

Runtime values and credentials remain in each runtime's own environment store. No production data migration, sync, prediction runner, scheduled job, or mutation endpoint belongs in CI, packaging, or smoke verification.
