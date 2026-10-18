# Repository rules for Codex

## Git preflight

- Before changing files, run `git fetch origin main`; inspect branch, HEAD, remotes, working tree (including untracked files), and divergence from `origin/main`. If freshness cannot be confirmed, stop and report it.
- Start new work from current `origin/main` in a separate branch. Preserve unfinished local work; never use destructive Git operations or force-push without explicit authorization. If upstream moves during work, reconcile before publishing.

## Development

- Preserve existing architecture and API contracts. Before publishing, run `npm ci`, `npm test`, and `npm run build`.
- Never commit or expose real secrets or personal data in source, fixtures, build artifacts, or logs.

## Deployment and migration

- GitHub `main` is the sole canonical code source; a push to `main` automatically deploys the Cloudflare Worker `iptv`. Prepare changes on a branch and in a PR; do not push directly to `main` without explicit authorization.
- Do not modify production environment, Cloudflare R2, ChatGPT Sites, or Scheduled Tasks without action-specific authorization. Keep every HTTP endpoint private; never relax Cloudflare Access for testing.
- The old ChatGPT Site and new Cloudflare Worker use separate R2 stores. Until final migration cutover, Sites-managed R2 is authoritative for user data. GitHub-to-Cloudflare CD does not update the old Site's source.
- For a Sites R2 exporter, verify a supported way to execute it against the **old Site and its complete source storage** before claiming success. If the old Site's code must change, prepare a publication plan and obtain separate approval before deploying. Never mutate or clean up source R2 data.
