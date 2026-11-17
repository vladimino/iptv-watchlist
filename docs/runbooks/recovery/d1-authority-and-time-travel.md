# D1 authority and recovery

This page states which store is authoritative per domain, what each kind of recovery can and cannot restore, and which steps need an owner decision. It is a decision guide, not an executable procedure: nothing here is authorized by a merge or a deploy, and every production write below needs its own operation-specific owner approval. Verify the live markers first; dated observations in documentation are not live state.

## Which store is authoritative

Authority is per domain, not per database. The table of domains, markers and what R2 still holds is in [authority per domain](../../architecture/persistence-and-migration.md#authority-per-domain). Read the live marker of the domain before reasoning about recovery, with the read-only tools that already exist (the owner-only MCP `feature_flags` and status tools, or a read-only `SELECT` of the marker table). A read never repairs state.

## What a code rollback does not do

A Worker code rollback reverts code only. It does not revert D1 or R2 data, D1 authority markers, Cloudflare Access configuration, secrets, bindings or external Scheduled Task schedules, and an older Worker may not understand state a newer one wrote. See [Worker code rollback](cloudflare-worker-rollback.md). Never treat a rollback as a data or authority restore.

## Canonical Film/Person: held and forward-fix

The marker moves `open` to `held` and `held` back to `open`; it has no move from `open` to `r2` or `prepared`, and the migration trigger enforces the same table in SQL. While the marker is `held` or unreadable, reads answer `503` or `unavailable` and never fall back to the frozen R2 `titles.json` / `people.json`, which are mirrors and not a recovery source.

Recovery is therefore forward-fix: hold the domain, correct the D1 rows through the fenced adapters (or the owner-approved operator procedures), verify, and reopen. The details of the handoff and the held state are in the [Film/Person open handoff runbook](../film-person-open-handoff.md) and the [Film/Person lifecycle](../../architecture/film-person-lifecycle.md). Do not look for an R2 revert.

## D1 Time Travel

D1 Time Travel can restore the database `iptv` to an earlier point in time. Treat it as an emergency, owner-approved recovery, not as an automatic rollback:

- It restores the whole database, so it also moves every domain's markers, generations and rows back, including domains that were healthy. Data written after the restore point is lost unless it can be replayed from R2 events or inputs.
- A bookmark must be recorded before any risky D1 write so that a restore point exists; the [backfill runbook](../d1-backfill.md) records the bookmark practice. Without a recorded bookmark, rely on the platform retention window and the owner's decision.
- After a restore, the D1 side and the R2 side can disagree: R2 immutable bodies written after the restore point are unreferenced, and D1 pointers can name bodies that R2 lacks only if R2 objects were deleted. Compatibility mirrors in R2 may be ahead of D1 and are derived data.
- Restoring is an L3 operation: an owner-approved plan, a stated restore point, a read-only check of every marker and generation afterwards, and no Scheduled Task or Workflow run until the markers are verified.

## R2 limits

- **Immutable bodies** (fingerprint, prediction and profile versions, assessment versions, raw inputs, archive and observation segments, receipts, events) are append-only evidence. They are not rewritten to roll back D1 state; D1 pointers choose which body is current.
- **Compatibility mirrors** (`programme.json`, `watchlist.json`, `metadata.json`, `admin/owner-reviews.json`, the published-generation pointer) are derived from D1. They are repaired by the named writers (the hourly EPG `ensure` for the published mirrors) and are not a source for restoring D1 authority. A GET never repairs them.
- **Frozen `titles.json` / `people.json`** are a historical mirror of the former R2 authority and are not a fallback.
- Do not replay the 19 October 2026 snapshot over production R2 or import it into D1; it predates the cutovers and would overwrite newer authority.

## Authority reverts

The repository still contains the owner-only cutover and revert tooling for the published EPG, ratings, predictions, owner reviews and the metadata cache (the `scripts/*-production.mjs` and `*-authority.mjs` entry points and their runbook sections in the [backfill runbook](../d1-backfill.md)). Moving a marker back to `r2` is an authority revert: it needs a fenced, owner-approved procedure, a mirror that matches D1, and a verified readback. A code rollback is never a substitute. Film/Person has no such revert.

## Diagnosing without side effects

Use read-only sources: the owner-only MCP status and `feature_flags` tools, `GET` routes that the [read side-effect baseline](../../reference/api/read-side-effects.md) classifies as non-writing, and read-only `SELECT`s of marker tables. Treat any probe whose side effects are not verified as a write that needs approval. Routine producers (the hourly cron, the Cloudflare Workflows and the Predictions Task) keep running on their normal schedule; do not start a run, reset a lease or retry a stuck unit to clear a symptom without an approved contract.
