# AIR-490: first nightly schedule created no GitHub Actions run

**Captured:** 16 November 2026, 08:50 Europe/Madrid (07:50 UTC). **Method:** GitHub REST via `gh` (read-only) and the live Trello card. No Worker, R2, D1, Cloudflare or production call. No `workflow_dispatch` from this session (`gh` write is not available here).

## What failed

The suite split from [PR #649](https://github.com/vladimino/iptv-watchlist/pull/649) (merge `0ffd480eed317da9bc99544d0b1a36053777ac5e`, 15 Nov 2026 12:21 UTC) is in `main`. The remaining acceptance gate was a **natural** `schedule` run of `.github/workflows/nonfunctional-tests.yml` at 04:00 UTC on 16 Nov (05:00 Europe/Madrid). That run was never created. There is no log, no artifact `nonfunctional-test-report`, and no failed/skipped job to inspect.

## Read-only evidence (16 Nov 2026 07:50 UTC)

| Check | Result |
| --- | --- |
| Workflow | `Non-functional tests`, id `419119592`, path `.github/workflows/nonfunctional-tests.yml` |
| `state` | `active` (not `disabled_manually` / `disabled_inactivity`) |
| `created_at` / `updated_at` | `2026-11-15T12:21:19Z` — registered when the file landed on `main`; no later edit |
| Default branch | `main`; repository public, not archived |
| Runs of this workflow | `total_count=0` (no `schedule`, no `workflow_dispatch`) |
| Repo-wide `event=schedule` | `total_count=0` (this repository has never had a scheduled Actions run) |
| Cron on `main` at capture | `'0 4 * * *'` |

The required CI/CD workflow stayed active and produced ordinary push/PR runs on 15–16 Nov. The miss is isolated to the new scheduled workflow.

## Classification

This is **not** a test-suite, routing, or Worker bug. The job never started.

GitHub documents that `schedule` is best-effort: high load at the **start of every hour** can delay queued jobs, and some queued jobs may be **dropped with no run record**. That matches a first fire at `0 4 * * *` that left `total_count=0`. It is the strongest available explanation; GitHub does not expose a per-miss reason. A first-time registration lag is a secondary hypothesis (the workflow existed ~15.5 h before 04:00 UTC). Inactive-repo disable and a disabled workflow are ruled out by `state=active` and ongoing CI/CD.

## Follow-up in this change

Move the single daily cron to `'17 4 * * *'` (04:17 UTC / 05:17 Europe/Madrid in winter) so GitHub re-registers the schedule off the `:00` peak. Frequency stays once per day. A manual `workflow_dispatch` of this workflow remains the way to prove the **job** itself; a later natural `event=schedule` run is still required for schedule acceptance.

The 15 Nov classification evidence is unchanged as a snapshot of the original 04:00 UTC intent.
