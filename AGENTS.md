# Repository rules for Codex

## Git preflight

- Before changing files, run `git fetch origin main`; inspect branch, HEAD, remotes, working tree (including untracked files), and divergence from `origin/main`. If freshness cannot be confirmed, stop and report it.
- Start new work from current `origin/main` in a separate branch. Preserve unfinished local work; never use destructive Git operations or force-push without explicit authorization. If upstream moves during work, reconcile before publishing.

## Development

- Preserve existing architecture and API contracts. Before publishing, run `npm ci`, `npm test`, and `npm run build`.
- Never commit or expose real secrets or personal data in source, fixtures, build artifacts, or logs.
- Internal continuation (the EPG resolver chain) runs only through the Worker's own `ctx.exports` loopback entrypoint in `src/continuation.js`. Never self-fetch the public hostname or forward cookies, Access JWTs, or `OAI-Sites-Authorization`, and never add an Access bypass for it. `tests/get-side-effects.mjs` and `README.md` pin the GET routes that may write to R2; change them together.
- Documentation is part of the Definition of Done. Any change to architecture, workflows, CI/CD, deployment, operations, integrations, or migration procedures must update the relevant documentation in the same PR or commit.
- Before completing a task, explicitly verify whether `README.md`, `CONTRIBUTING.md`, `AGENTS.md`, or `docs/` require updates. Do not defer documentation drift to a separate cleanup task.

## Deployment and migration

- GitHub `main` is the sole canonical code source; a push to `main` automatically deploys the Cloudflare Worker `iptv`. Prepare changes on a branch and in a PR; do not push directly to `main` without explicit authorization.
- Do not modify production environment, Cloudflare R2, ChatGPT Sites, or Scheduled Tasks without action-specific authorization. Keep every HTTP endpoint private; never relax Cloudflare Access for testing.
- Since the 19 October 2026 cutover at GitHub `main` `58737738275fca182afd8afbdd035870db63315e`, Cloudflare R2 bucket `iptv` is the authoritative production store for Worker `iptv`. The old ChatGPT Site is a temporary reserve and the source of the historical snapshot. Do not run sync, prediction, or other writers on that Site. Do not use it for ordinary browsing or diagnosis without separate approval. Opening its UI is not guaranteed read-only: `GET /api/events` can recover an undelivered event, and `GET /api/enrichment/view` can initialize a missing rating in the view index. The production dashboard polls those same routes about once a minute while the tab is visible, so that poll can cause the same writes. It does not start sync or prediction. GitHub-to-Cloudflare CD deploys Worker code only; it does not copy R2 data and does not update the old Site.
- `/mcp` is an experimental probe protected by the separate Access application `IPTV MCP` (Managed OAuth). Keep its tools free of R2 access and production side effects unless a change is separately approved. Keep the Worker's verification of the signed Access JWT, including the `IPTV MCP` audience, and never add Access bypass rules or anonymous exceptions for MCP discovery. See `docs/mcp.md`.
- Do not automatically import, replay, or overwrite production R2 from the historical Sites snapshot. A future restore needs a separate procedure and explicit approval.
- Scheduled Tasks stay disabled. Restoring unattended ChatGPT authorization to Cloudflare is a separate task. Before any background process resumes, confirm the three copied lease objects are not stale locks.
- For a Sites R2 exporter, verify a supported way to execute it against the **old Site and its complete source storage** before claiming success. If the old Site's code must change, prepare a publication plan and obtain separate approval before deploying. Never mutate or clean up source R2 data.
