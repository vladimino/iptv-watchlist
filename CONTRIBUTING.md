# Contributing

GitHub `main` is the canonical production source.

Before local work:

1. Run `git fetch origin --prune`.
2. Confirm the working tree is clean with `git status --short`.
3. Confirm the local branch has not diverged from `origin/main`.
4. Fast-forward with `git pull --ff-only origin main`.

Resolve dirty or diverged state explicitly. Do not overwrite other changes, force-push in the normal workflow, or copy files directly to production.

All changes go through commits and pushes. Pull requests run self-contained tests and build. Successful pushes to `main` automatically publish the verified artifact to Cloudflare using GitHub Actions and environment `Cloudflare Prod`.

Deployments to legacy Sites remain separate manual operations requiring explicit authorization. Cloudflare CD does not migrate Sites-managed R2 or switch Scheduled Tasks. The Sites source merge SHA may differ from the GitHub SHA, but their Git trees must match.

Never run EPG sync, prediction, scheduled jobs, or mutation endpoints as part of CI or deployment verification. Emergency fixes follow the same Git-first rule: commit the fix first, let CI validate it, and deploy that commit.

See [docs/deployment.md](docs/deployment.md) for deployment and rollback.
