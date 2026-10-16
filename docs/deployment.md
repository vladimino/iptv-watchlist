# Production deployment

## Contract

GitHub `main` is the only production source. CI runs `npm ci --ignore-scripts`, `npm test`, and `npm run build`; it has read-only repository permissions and receives no production credentials.

The production host is ChatGPT Sites. The intended automatic deployment:

1. selects the exact green commit SHA currently at `origin/main`;
2. builds `dist/server/index.js`;
3. obtains a short-lived, repository-scoped Sites source credential;
4. pushes that unchanged commit to the Site source repository;
5. packages and saves an archive-backed Site version for the same SHA;
6. deploys that saved version, with concurrent production deploys prohibited;
7. performs authenticated read-only GET checks for `/` and `/api/status`;
8. records the SHA and result in GitHub deployment history and Sites version history.

Runtime values and credentials remain in the Sites environment store. They are never committed or printed. CI and smoke checks do not call sync, enrichment, prediction, scheduled-job, or mutation endpoints.

## Current cutover blocker

CI is active, but automatic production deployment is not yet enabled. The existing private Sites source repository and the security-rewritten public GitHub repository have unrelated histories. Sites correctly rejects an ordinary non-fast-forward push and currently also rejects a guarded one-time `--force-with-lease` reset. Merging the old private history into the public repository is prohibited because it would republish removed personal/runtime artifacts.

Complete the cutover only when Sites supports one of these:

- reset/import the Site source branch to the exact GitHub `main` SHA without changing the existing Site, storage, URL, or runtime environment; or
- issue a durable unattended deployment identity that accepts an archive and exact GitHub SHA without requiring that SHA to pre-exist in the internal source repository.

Do not store the current ten-minute Sites source credential in GitHub Secrets; it expires and is not a viable CI identity. Until the cutover is supported, a green GitHub commit is not proof that production was updated.

## Rollback

Choose the previous known-good commit from GitHub and redeploy it through the same deployment automation. Do not edit production files or Git history:

1. identify the known-good SHA in GitHub/Sites deployment history;
2. create a normal revert commit on top of `main` (preferred), or re-run deployment for an already saved known-good Site version when immediate code rollback is required;
3. require green CI for a new revert commit;
4. deploy the exact selected SHA and repeat the read-only smoke check.

Deploy failure does not intentionally remove the currently serving version. A smoke-check failure marks the deployment failed and requires investigation or rollback; it never starts a production data job.
