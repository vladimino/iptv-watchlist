# Cloudflare CI deploy: metadata HTTP 403 recovery

This is an active diagnostic procedure, not permission to modify production credentials. Consult [deployment](../deployment.md), confirm the actual failure in the current GitHub Actions run and request owner approval before changing token permissions.

## Diagnosis and resolution

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
