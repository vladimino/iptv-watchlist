# AIR-571 activation preflight: Cloudflare configuration and cron quota (read-only)

**Read at 22 Nov 2026 07:35 UTC (08:35 Madrid), by the Executor, through the Cloudflare API connector, GET requests only.** No deploy, binding, cron, flag, Task, migration, forced run or data write was made. This is dated evidence for the activation runbook ([Letterboxd Sync activation](../../runbooks/letterboxd-activation.md)); it is not a runtime authority and is superseded by the preflight that holdpoint E repeats right before the GO.

## What was read

| Read | Result |
| --- | --- |
| `GET /accounts/{account}/workers/scripts` | 1 Worker script in the account: `iptv` |
| `GET /accounts/{account}/workers/scripts/iptv/schedules` | 3 cron triggers: `0 * * * *` (created 8 Nov 2026), `1-59/2 * * * *` (19 Nov 2026), `24 3 * * *` (19 Nov 2026) |
| Cron triggers across every script of the account | 3 in total (all on `iptv`) |
| `GET /accounts/{account}/workflows` | 5 Workflows, all of script `iptv`: `iptv-prediction-start`, `iptv-producer`, `iptv-epg`, `iptv-ratings`, `iptv-discovery`. **No Letterboxd Workflow exists yet** |
| Cloudflare documentation (Limits) | Cron Triggers per account: **5 on Workers Free, 1,000 on Workers Paid**. Workflow `schedules` (not used here): 100 per account |

## What it decides

- **Cron quota.** The account holds 3 crons. The Letterboxd `ensure` cron (`30 * * * *`) makes 4, which is within the 5 of Workers Free and far within the 1,000 of Workers Paid, so the quota does not depend on the plan type (the plan type itself was not read; `limits.cpu_ms: 120000` in `wrangler.jsonc` implies Workers Paid). Option E of ADR 0186 (isolating `ensure` inside the hourly tick) stays the documented fallback and is not needed on this evidence.
- **Deploy semantics.** Cloudflare documents that a Wrangler deploy REPLACES the cron triggers with the `triggers.crons` array. The activation deploy must therefore list all four expressions, and the post-deploy read must show exactly four, the first three unchanged ([Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)).
- **Binding.** The Workflow class `LetterboxdWorkflow` is already exported by the deployed entry (`dist/server/workflow-entry.js`) but no Workflow named for it is registered in the account: the binding `LETTERBOXD_WORKFLOW` and the Workflow registration are added only by the activation deploy.
- **Cron limits of a scheduled invocation.** A scheduled Worker has a 15-minute wall time per invocation and up to 15 minutes of CPU for intervals of one hour or more (documentation, Limits and Pricing). The `ensure` tick is bounded by the code (one mirror pass, one outbox delivery, one slot claim) and creates the Workflow instance that does the slot work.

## Not read, and why

- The Workers plan of the account (not needed for the verdict above).
- The state of the D1 markers: unchanged by this slice and read live by the status commands at each holdpoint, not inferred from this note.
- The Cloudflare Observability logs of the Worker: not needed for this verdict.

## Uncertainty

The connector read the account as authorized for exactly one account. A second Worker script with crons could not be hidden from the listing, but a future second account is out of scope.
