# Production deployment

## Contract

GitHub `main` is the only production source. CI runs `npm ci --ignore-scripts`, `npm test`, and `npm run build`; it has read-only repository permissions and receives no production credentials.

The production host is ChatGPT Sites. A deployment:

1. selects the exact green commit SHA currently at `origin/main`;
2. builds `dist/server/index.js`;
3. obtains a short-lived, repository-scoped Sites source credential;
4. pushes that unchanged commit to the Site source repository;
5. packages and saves an archive-backed Site version for the same SHA;
6. deploys that saved version, with concurrent production deploys prohibited;
7. performs authenticated read-only GET checks for `/` and `/api/status`;
8. records the SHA and result in GitHub deployment history and Sites version history.

Runtime values and credentials remain in the Sites environment store. They are never committed or printed. CI and smoke checks do not call sync, enrichment, prediction, scheduled-job, or mutation endpoints.

## Rollback

Choose the previous known-good commit from GitHub and redeploy it through the same deployment automation. Do not edit production files or Git history:

1. identify the known-good SHA in GitHub/Sites deployment history;
2. create a normal revert commit on top of `main` (preferred), or re-run deployment for an already saved known-good Site version when immediate code rollback is required;
3. require green CI for a new revert commit;
4. deploy the exact selected SHA and repeat the read-only smoke check.

Deploy failure does not intentionally remove the currently serving version. A smoke-check failure marks the deployment failed and requires investigation or rollback; it never starts a production data job.
