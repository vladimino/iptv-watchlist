# Deployment and rollback: Cloudflare production and legacy Sites reserve

## Production topology (19 October 2026)

GitHub `main` is the canonical code source. Cloudflare is the production runtime:

- Production: https://iptv.vladimino.workers.dev/. Worker `iptv`, deployed by GitHub Actions, private behind Cloudflare Access. R2 bucket `iptv`, binding `BUCKET`, is the authoritative production store.
- Experimental MCP: `https://iptv.vladimino.workers.dev/mcp`, served by the same Worker. A separate Access application, `IPTV MCP`, protects this path with Managed OAuth and an owner-only policy. Application `All Workers` keeps protecting every other path. The Worker verifies the Access JWT using the runtime variables `MCP_ACCESS_TEAM_DOMAIN` and `MCP_ACCESS_AUD`, which are set in the Cloudflare dashboard and not committed. The probe tools do not use R2. The EPG and prediction tools call the existing sync and runner functions and can read or write R2 when invoked; deploying the Worker does not invoke them, and it neither configures nor triggers external ChatGPT Scheduled Tasks. [AIR-62](https://trello.com/c/CU71gW4c) separately restored scheduled operations on 21 October 2026. See [docs/mcp.md](../reference/api/mcp.md).
- Resolver continuation: one discovery chunk runs inside the request that asks for it. The EPG commit does not start the next chunk. No service binding, second Worker, or Access exception is configured. The internal `DiscoveryContinuation` entrypoint stays unreachable from public HTTP and carries no credential. A separate request does not guarantee a new isolate. The Sites-era `EPG_SITE_SERVICE_TOKEN` is no longer read. If it still exists as a Worker secret, removing it is a separately approved environment change. See [ENRICHMENT_API.md](../reference/api/enrichment.md#epg-resolver--hotcold-pipeline-v2).
- Legacy reserve: https://iptv.vladimino.chatgpt.site/, Site `appgprj_6abfed826e148191903dec4175166ff7`. Its separate R2 store is a temporary reserve and the source of the historical snapshot. It is not the destination for current writes. Do not run sync, prediction, or other mutating processes there. Do not use it for ordinary browsing or diagnosis without separate approval: opening the UI is not guaranteed read-only, because `GET /api/events` can recover events and `GET /api/enrichment/view` can initialize the ratings index. GitHub/Cloudflare deployment does not update this Site.

**Scheduled operations (checked 24 October 2026):** [AIR-62](https://trello.com/c/CU71gW4c) restored unattended ChatGPT Scheduled Tasks using owner-only IPTV MCP: daily EPG/watchlist at 17:00 Europe/Madrid and hourly predictions. Both tasks were enabled with recent executions in the ChatGPT automation registry on 24 October. These are **external ChatGPT Tasks, not Cloudflare Worker Cron triggers**: Worker `schedules=0`, observed during [AIR-69](https://trello.com/c/FlcWZX7W), did not mean the external tasks were off. Since [ADR 0056](../adr/0056-d1-enrichment-write-through.md) the Worker has one cron trigger (`37 * * * *`) that runs only the D1 enrichment projector; with `D1_ENRICHMENT_WRITE` unset it returns at once, and it never runs EPG, discovery, predictions or ratings. An enabled task or recorded invocation is not proof of a successful EPG or prediction cycle; correlate the specific run with MCP/EPG/runner state. GitHub deploys do not change tasks, OAuth grants or their schedule. Always recheck the live registry and runtime before operational claims. Any schedule change, new writer invocation, lease override or Access policy change needs separate owner approval. Keep Cloudflare Access enabled.

The GitHub environment `Cloudflare Prod` identifies deployment credentials. It does not authorize a data restore or a schedule change.

## Data cutover (19 October 2026)

Cutover base SHA: `58737738275fca182afd8afbdd035870db63315e`.

The historical Sites snapshot contained 6,520 objects and 97,759,255 bytes, including three lease objects copied unchanged. Independent Cloudflare verification matched every key, size, raw-byte SHA-256, and portable metadata. Independent legacy listing covered 66 pages and matched all 6,520 objects to the source manifest metadata. Metadata fingerprint: `623a68daeba9513b1aa6b6313187230612af4049aaf79a27a06da0e994385815`.

That snapshot is historical. Do not automatically import, replay, or overwrite production R2 with it. A future backup or restore needs its own procedure and explicit approval. Details are in [docs/migration-export.md](../archive/legacy-sites/migration-export.md) and [docs/r2-import.md](../archive/legacy-r2/r2-import.md).

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
   - Compatibility date `2026-10-18`, which enables `ctx.exports` for the resolver continuation. Do not add `disable_ctx_exports` or move the date before 2025-11-17.
   - R2 binding: `BUCKET` -> `iptv`
   - `keep_vars: true`, so dashboard variables such as `MCP_ACCESS_TEAM_DOMAIN` and `MCP_ACCESS_AUD` survive deploys
   - `preview_urls: false`

A failed test/build, or a failed account-token or Worker-settings check, prevents deployment. A successful workflow confirms publication, not completion of data migration or end-to-end smoke tests. Use authorized read-only checks after deployment. For `/mcp`, use only the safe verification procedure in [docs/mcp.md](../reference/api/mcp.md). Exercising the resolver continuation in production writes `epg/*` records and calls TMDB, so it is a separately approved operation, never a deploy smoke test.

## Owner person-name confirmation

`POST /api/admin/people/<id>/name-review` is the only writer of a reviewed Russian Person name and of an owner-added name alias. The owner presses **Сохранить вариант** on that person's card in `/admin`. With the checkbox off, the put adds one alias and leaves the preferred name. With the checkbox on, it reviews a new preferred name. The Worker puts `admin/owner-reviews.json` once, replacing `people` entries for that command and copying `films`. It does not rewrite `programme.json`, `people.json`, `titles.json`, the published generation, or D1, and it does not call TMDB, Letterboxd or a model. Deploying the route does not create the object and does not change a name. A missing object stays missing until that button succeeds. The film card's **Сохранить вариант** is the other writer of the same object. Choosing another stored Russian radio checks «Использовать как предпочтительное», and that save reviews the chosen title as preferred. The same radio with the box turned back off does not put. A typed title with the box off adds one film alias and leaves the preferred title. A typed title with the box on reviews a new preferred title. An answer that changes nothing stays on the card and does not reload it. Either way it replaces one `films` entry and copies `people`. A failed readback is unknown until the stored audit for that request is present; an added alias also has to be in the slice. The page accepts that alias only when the reloaded record shows it with owner-added provenance, not because the text is already an option. Do not send a new command for that answer.

Programme and watchlist reads stamp the saved name after the dictionary and the name cache. The EPG commit does not read or write the object. A dictionary or automatic name does not replace an owner review. The route reports the card saved only after it has read the object back and found the request's audit entry on the person and on every linked role. `readback_failed` (503 `storage_unavailable`) means that read did not prove the write. The object may already contain it. Repeat the same request from the card; do not treat that answer as a failed write that needs a new command, and do not delete the object to clear it. Rollback is a Worker redeploy of the previous commit ([procedure](recovery/cloudflare-worker-rollback.md)). That redeploy does not delete the object and does not downgrade the stored review. A later EPG commit on a build without the overlay can publish the dictionary name again; the object remains for the build that reads it. Do not delete the object as part of a code rollback.

**Code-only paths and leftover variables.** Deploying the Worker does not create or write `admin/owner-reviews.json`. That object appears only when the owner confirms one title or one name in `/admin`. A code rollback does not delete it; the previous Worker ignores it until a forward deploy reads it again. The EPG resolver and the localization of the programme and watchlist reads and of the EPG commit have no runtime switch: rolling either back is a redeploy of the previous verified commit through the [Worker rollback procedure](recovery/cloudflare-worker-rollback.md), never a dashboard variable. `keep_vars: true` also preserves variables the code no longer reads (`SCORED_RESOLUTION`; the `epg`, `programme` and `watchlist` tokens of `LIFECYCLE_LOCALIZATION`, which gates the metadata sync alone). They are inert; removing them is a separate owner-approved settings change followed by a read-only check, not part of a deploy. The [flag register](../reference/feature-flags.md) lists what each variable still does.

## Proportionate post-deploy acceptance

For a documentation-only PR with no runtime or configuration changes, **both** required GitHub Actions jobs succeeding and one safe MCP `probe_read` are sufficient operational acceptance unless the card explicitly changes a contract that needs a targeted read. Do not trigger EPG, discovery, predictions, TMDB, imports or full storage parity as a deployment smoke test. A release touching a runtime API or persisted projection gets the **smallest matching safe readback** for that scope, rather than a blanket bucket snapshot, manual replay or speculative incident checklist. Keep both post-merge jobs and report their actual conclusions: they are delivery guarantees, not permission to operate production data writers. [Risk-proportional policy](../process/agent-workflow.md#risk-proportional-operational-safeguards).

## Troubleshooting and recovery

- [Cloudflare deployment metadata HTTP 403](recovery/deploy-metadata-403.md) — token policy diagnostics; do not widen permissions without a specific failed check.
- [Cloudflare Worker rollback](recovery/cloudflare-worker-rollback.md) — code recovery only, not data or schedule rollback; changes require owner approval.
- [Historical legacy Sites publication and rollback](../archive/legacy-sites/site-release.md) — archived evidence and steps, **not** the current production deployment flow.

This is the operational Cloudflare runbook. Historical Sites exports and imports live under [the archive](../archive/README.md).
