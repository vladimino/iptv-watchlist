# Deployment and rollback: Cloudflare and legacy Sites

## Deployment topology (18 October 2026)

GitHub `main` is the canonical code source. Two independent runtimes currently coexist:

- Cloudflare Worker `iptv`: https://iptv.vladimino.workers.dev/. Automatically deployed by GitHub Actions. Private behind Cloudflare Access. R2 bucket: `iptv`. Not authoritative until AIR-62.
- Legacy ChatGPT Sites: https://iptv.vladimino.chatgpt.site/. Still authoritative for user data. GitHub/Cloudflare deployments do not update this Site or its separate R2 storage.

The GitHub environment `Cloudflare Prod` identifies deployment credentials, not completion of data cutover.

## Cloudflare: automatic GitHub Actions CI/CD

Source: `.github/workflows/ci.yml`. The former independent Cloudflare Workers Builds integration has been disconnected.

1. Pull requests into `main` run `test-and-build`. A GitHub ruleset must be configured separately if CI is required to block merging.
2. Pushes to `main` run `npm ci --ignore-scripts`, `npm test`, and `npm run build`. The build uses Node.js 20 and uploads `dist/` as an artifact with one-day retention.
3. The `deploy` job requires successful `test-and-build` and downloads that exact verified artifact. Deployment runs only on pushes to `main`.
4. Deployment credentials belong to GitHub environment `Cloudflare Prod`:
   - Secret: `CLOUDFLARE_API_TOKEN`
   - Variable: `CLOUDFLARE_ACCOUNT_ID`
5. Deployment concurrency group: `cloudflare-iptv-production`, with `cancel-in-progress: false`. Before publishing, the job verifies that `GITHUB_SHA` still equals the remote `main` HEAD. This prevents common stale deployments, but the freshness check is not atomic with publication.
6. `cloudflare/wrangler-action@v4` uses Wrangler 4.151.1 and `deploy --message`. Cloudflare release descriptions are:
   - Normal commit: commit subject
   - Merge commit: `PR #N: <PR title>`
7. `wrangler.jsonc` configures:
   - Worker: `iptv`
   - Entrypoint: `dist/server/index.js`
   - R2 binding: `BUCKET` -> `iptv`
   - `keep_vars: true`
   - `preview_urls: false`

A failed test/build prevents deployment. A successful workflow confirms publication, not completion of data migration or end-to-end smoke tests. Use authorized read-only checks after deployment.

## Legacy Sites: historical release baseline

The version/SHA table below records the earlier Sites cutover checkpoint. Re-query the live Site before using these values for any release or rollback.

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

For each future Sites release, use the exact green GitHub `main` SHA, never an uncommitted local tree:

1. Fetch current GitHub `main` and Sites source HEAD; verify CI succeeded for the exact GitHub SHA and it is still `main`.
2. Create an ordinary merge commit with **both** current HEADs as parents and a Git tree exactly equal to that GitHub SHA. The Sites HEAD must be an ancestor of the new commit. Do not rewrite either history.
3. Verify both tree IDs, run the tests/build, and build the Sites archive from that exact tree. Check its manifest, Worker entrypoint, and expected assets; do not package local-only files or credentials.
4. Obtain a fresh supported Sites source credential, perform a **non-force** push, and verify the remote HEAD is the pushed merge SHA. If either HEAD moved, discard this candidate and start over.
5. Save a Sites version from that pushed SHA with the checked archive; verify its recorded source SHA and archive metadata. Do not deploy an unsaved or mismatched version.
6. Recheck the current GitHub `main` and CI status immediately before deployment. Skip stale candidates; serialize releases and ensure a newer successful release cannot be superseded by an older run. Deploy only the saved version, then perform authenticated read-only GET checks (`/`, `/api/status`, and suitable existing data endpoints). Never call sync, enrichment, prediction, schedule, or mutation endpoints as smoke tests.
7. Record the GitHub SHA, Sites merge SHA, tree SHA, saved version, serving deployment, environment revision, and smoke result. Treat a later `main` push during publication as a new release requiring its own check/deploy; a pre-deploy freshness check alone is not an atomic guarantee against that race.

An unattended Sites implementation needs a documented non-human principal authorized for **all** Sites source/save/deploy actions on this exact Site, plus a tested way to invoke them from GitHub Actions. Before activation, restrict that identity to the repository/`main` workflow, use a protected production environment and deployment concurrency, verify the failure/rollback behavior in a separately authorized controlled test, and keep credentials out of source and logs. Do not enable a production Sites workflow on the assumption that API Platform OIDC, a Codex token, or a Sites visitor token is sufficient.

## Rollback boundaries

### Cloudflare Worker

Identify the previous known-good version in Cloudflare Deployments and roll back the Worker if needed. Verify Access, bindings, live version and read-only APIs.

Code rollback does not restore R2 data, secrets, environment configuration or Scheduled Tasks. It also does not change GitHub `main`; a later push may supersede the rollback.

For a permanent fix, merge a revert or corrective commit into `main` and deploy it through GitHub Actions.

### Legacy Sites

Version 84 was the last verified working checkpoint before exporter publication. Confirm the currently serving version before selecting a rollback target.

Version 83 remains an older fallback, not the automatically preferred rollback target.

Sites code rollback does not restore an earlier environment revision or revert R2 data. Do not force-push/reset Sites source, alter GitHub history, or mutate R2 data. A serving-version rollback does **not** roll back the Sites source branch or runtime data.

Sites deploys a saved version using the **current** environment revision. Version 83 originally served with revision 2, but a redeploy now uses current revision 3; revision 2 cannot be assumed recoverable or pinned. Consequently, a version-83 redeploy is a code rollback, not a guaranteed full environment rollback. If code rollback still fails, inspect environment keys/bindings and request owner intervention for unavailable secret values rather than guessing or restoring them automatically.

Runtime values and credentials remain in each runtime's own environment store. No production data migration, sync, prediction runner, scheduled job, or mutation endpoint belongs in CI, packaging, or smoke verification.
