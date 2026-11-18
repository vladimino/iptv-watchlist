# D1 authority and recovery

This page states which store is authoritative per domain, what each kind of recovery can and cannot restore, and which steps need an owner decision. It is a decision guide, not an executable procedure: nothing here is authorized by a merge or a deploy, and every production write below needs its own operation-specific owner approval. Verify the live markers first; dated observations in documentation are not live state.

## Which store is authoritative

Authority is per domain, not per database. The table of domains, markers and what R2 still holds is in [authority per domain](../../architecture/persistence-and-migration.md#authority-per-domain). Read the live marker of the domain before reasoning about recovery, with the read-only tools that already exist (the owner-only MCP `feature_flags` and status tools, or a read-only `SELECT` of the marker table). A read never repairs state.

## What a code rollback does not do

A Worker code rollback reverts code only. It does not revert D1 or R2 data, D1 authority markers, Cloudflare Access configuration, secrets, bindings or external Scheduled Task schedules, and an older Worker may not understand state a newer one wrote. See [Worker code rollback](cloudflare-worker-rollback.md). Never treat a rollback as a data or authority restore.

## Canonical Film/Person: held and forward-fix

The marker moves `open` to `held` and `held` back to `open`; it has no move from `open` to `r2` or `prepared`, and the migration trigger enforces the same table in SQL. While the Film/Person marker is `held` or unreadable, reads answer `503` or `unavailable` and never fall back to the frozen R2 `titles.json` / `people.json`, which are mirrors and not a recovery source. This is a per-domain property: with the published EPG marker `held`, readers instead stay on the R2 pointer and mirrors while mirror repair stops and a publisher fails closed instead of writing R2.

Recovery is therefore forward-fix: hold the domain, correct the D1 rows through the fenced adapters (or the owner-approved operator procedures), verify, and reopen. The details of the handoff and the held state are in the [Film/Person open handoff runbook](../film-person-open-handoff.md) and the [Film/Person lifecycle](../../architecture/film-person-lifecycle.md). Do not look for an R2 revert.

## D1 Time Travel

D1 Time Travel is always on and creates bookmarks automatically ([Cloudflare documentation](https://developers.cloudflare.com/d1/reference/time-travel/)). It restores the whole database `iptv` to any minute inside the retention window: 30 days on the Workers Paid plan and 7 days on Workers Free, and bookmarks older than the window are invalid. Check the account's plan; the window is a platform limit, not a repository setting. Treat a restore as an emergency, owner-approved recovery, not as an automatic rollback:

- **Destructive and whole-database.** A restore overwrites the database in place and cancels in-flight queries and transactions. It moves every domain's markers, generations and rows back, including domains that were healthy, and data written after the restore point is lost unless it can be replayed from R2 events or inputs. The restore returns the previous bookmark, which is the undo point; record it.
- **No manual bookmark is required for the capability.** Point-in-time restore works from a timestamp. Capturing a bookmark before a scoped, risky write can make the intended restore point exact and cheap to cite, so do it when the operation's risk justifies it, in proportion to the [risk-proportional safeguards](../../process/agent-workflow.md#risk-proportional-operational-safeguards). It is a useful practice, not a precondition.
- **Mixed state afterwards.** After a restore, D1 and R2 can disagree: R2 immutable bodies written after the restore point are unreferenced, and compatibility mirrors may be ahead of D1.
- **An L3 operation.** It needs an owner-approved plan and a stated restore point, a read-only check of every marker and generation afterwards, and no Scheduled Task or Workflow run until the markers are verified.

## R2 limits

Classify an R2 object before deciding how to treat it. Not every R2 object is a disposable copy.

- **Immutable bodies** (fingerprint, prediction and profile versions, assessment versions, raw inputs, archive and observation segments, receipts, events) are append-only evidence. They are not rewritten to roll back D1 state; D1 pointers choose which body is current.
- **D1-derived compatibility mirrors** (`programme.json`, `watchlist.json`, `metadata.json`, `admin/owner-reviews.json`, the published-generation pointer) are derived from D1 and repaired by the named writers (the hourly EPG `ensure` for the published mirrors). They are not a source for restoring D1 authority. A GET never repairs them.
- **Current exception: the discovered-films catalog and its poster values.** `epg/discovered-films.json` and its generation copies are not a pure mirror today. Catalog poster hydration updates them directly in R2 with a compare-and-swap and does not write the D1 catalog, so those poster values cannot be reproduced from D1. Preserve these objects, never overwrite them from a D1-derived copy or an old snapshot, and never delete them as "disposable", until that write path is moved to D1 (an open finding in the retirement audit).
- **Frozen `titles.json` / `people.json`** are a historical mirror of the former R2 authority and are not a fallback. A stale reader of the frozen `metadata.json` (the started-film lookup) is a dependency to remove, not evidence that R2 owns canonical Film/Person metadata.
- Do not replay the 19 October 2026 snapshot over production R2 or import it into D1; it predates the cutovers and would overwrite newer authority.

## Authority reverts

[ADR 0162](../../adr/0162-d1-only-authority-retire-rollback-toolchain.md) retires the cutover and revert tooling domain by domain; the owner-review and metadata-cache tooling is already removed, and a restored marker of those domains that is not `d1` is refused with no tool to bring it back. Until each slice lands, the repository still contains that tooling for the published EPG, ratings and predictions (the `scripts/*-production.mjs` and `*-authority.mjs` entry points and their runbook sections in the [backfill runbook](../d1-backfill.md)). Moving a marker back to `r2` is an authority revert: it needs a fenced, owner-approved procedure, a mirror that matches D1, and a verified readback. A code rollback is never a substitute. Film/Person has no such revert.

## Diagnosing without side effects

Use read-only sources: the owner-only MCP status and `feature_flags` tools, `GET` routes that the [read side-effect baseline](../../reference/api/read-side-effects.md) classifies as non-writing, and read-only `SELECT`s of marker tables. Treat any probe whose side effects are not verified as a write that needs approval. Routine producers (the hourly cron, the Cloudflare Workflows and the Predictions Task) keep running on their normal schedule; do not start a run, reset a lease or retry a stuck unit to clear a symptom without an approved contract.
