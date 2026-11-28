# Shared upstream cooldown: `observe` rollout and evidence (UC2)

[AIR-609](https://trello.com/c/q8XXpWAi) · card UC2 of [ADR 0207](../adr/0207-letterboxd-admissions-coordinated-in-d1-only.md) decision 7 · [ADR 0211](../adr/0211-catalog-enrichment-producer.md) decision 5 · contract: [shared upstream cooldown](../reference/integrations/upstream-cooldown.md).

**Delivering this page and its tooling authorizes nothing.** Moving `upstream_coordination.mode` is an owner production operation (L2/L3) that needs its **own, separate GO** on the card, naming the operator digest and the revision `--status` printed. The operator performs **exactly two transitions**, `off -> observe` and its rollback `observe -> off`, and nothing else: it cannot write `enforce` (UC3, its own card, GO and operator change), it refuses to touch a row that already holds `enforce`, and it does not handle any enforce rollback. No Scheduled Task, flag, Access rule, R2 object, migration or manual upstream request is part of this rollout.

## What `observe` does

Natural callers (Discovery, the poster routes, Letterboxd Sync, metadata sync, EPG localization, identity checks, removal lookups) **keep sending every request**. On a 429, a Cloudflare challenge or a 403 they write the scope's cooldown (`upstream_cooldown`), and wherever a guard looks at the scope while a cooldown is active they count a "would have skipped" **decision**. Nothing is skipped, retried differently or delayed. The mode is read once per coordinator, so the change takes effect on the **next run** of each caller, and a run that already cached `observe` keeps behaving as `observe` until it ends, also after a rollback.

## Tools (all offline-tested, dormant)

| Tool | Reads | Writes |
| --- | --- | --- |
| `node scripts/upstream-cooldown-mode-production.mjs --status --target iptv` | D1 `iptv` through the owner credentials ([credentials skill](../../.claude/skills/iptv-credentials/SKILL.md)), every read **strict** (a response without a result array is an error, never an empty table): schema version, the two tables, the mode row, every cooldown row and its expiry | nothing |
| `node scripts/upstream-cooldown-mode-production.mjs --set --target iptv --mode observe\|off --expect-revision <n> --confirm set --operator-sha256 <64 hex>` | the same, plus a Time Travel bookmark before and after | **one** statement on `upstream_coordination`, only `off -> observe` or `observe -> off`, only with the exact predecessor mode and revision |
| `node scripts/upstream-cooldown-evidence-report.mjs [--format json\|markdown] [--query-limit N] [file ...]` | Worker log events exported by a separate authorized read | nothing (no network, no database) |

`--status` is strictly read-only and prints the digest of the operator, the effective mode (an absent row reads `off`), `expectRevision` (0 for an absent row), the decision of each transition and, per scope, the cooldown reason, `setBy` caller, expiry and whether it is still active. It never prints an endpoint, a token or a payload.

Refusals, all before any write: `operator_digest_mismatch`, `tables_missing`, `schema_unexpected` (below version 47), `mode_unexpected`, `already_set`, `enforce_active`, `mode_unsupported`, `revision_moved`, `scope_unexpected`, `unknown_state` (including any malformed read answer). A write is never retried.

### How the outcome of `--set` is judged

The outcome is judged **only** from the one guarded statement and the exact readback of the control row: mode, revision (+1), the written `updated_at`, one row, and the unchanged schema version. A failed readback, a lost response or a CAS mismatch is `write_uncertain` with `retry: false`: run `--status` and decide with the owner; do not re-run `--set`. Only a proven D1 statement rejection of an unchanged state is `statement_failed`.

**Cooldown rows are not part of that judgement.** The instant the mode becomes `observe` a natural caller may legally write a cooldown, and after a rollback a run that cached `observe` may still write one until it ends. The operator therefore reports cooldown rows that changed during the operation separately, as `cooldownObservations` (`added`, `extended` scopes; `anomalies` if a row shortened or vanished, which the triggers make impossible), and a changed cooldown digest never makes a committed mode write uncertain. No quiet window is taken and no natural caller is stopped to make the rows match.

## Preconditions (checked live, not from this page)

1. The card carries a **separate GO** for `off -> observe` that names the operator digest and the revision. A GO for AIR-606, AIR-607 or the migration window does not cover it.
2. The `--status` decision for `observe` is `apply`: schema version at least 47 (AIR-603 checkpoint A applied), both tables present, effective mode `off`, no row holding `enforce`.
3. Read the cooldown rows in the same `--status`. Rows left from before are expected to be absent or expired; an active row is not a blocker (observe skips nothing) but is recorded in the report as the starting state.
4. The Worker deployed from the exact `main` commit named in the GO (the callers must carry the coordinator). A deploy applies nothing and changes no mode.
5. Choose the moment so that natural runs of the callers follow soon after: the change takes effect at the next run of each caller. Do **not** trigger a run, a Scheduled Task, a sync or an upstream request to produce evidence, and add no logging infrastructure to make a missing signal appear; wait for the natural ones and report the gaps.

## Procedure (one owner-approved operation)

1. `--status`; record the digest, the revision and the cooldown rows.
2. `--set --mode observe --expect-revision <n> --confirm set --operator-sha256 <digest>`.
3. Independent readback with `--status`: mode `observe`, revision +1. Cooldown rows may differ from step 1 only by natural writes (see `cooldownObservations`).
4. Note the time (Madrid, UTC in parentheses): it starts the evidence window.

## Rollback

`--set --mode off --expect-revision <n> --confirm set --operator-sha256 <digest>` under the approved operation. It restores today's behaviour for the next run of every caller and needs no code revert; runs that cached `observe` finish as `observe`. Cooldown rows already written stay (never deleted, they expire by themselves; with `off` nothing reads them). Restoring a Time Travel bookmark is **not** the rollback and needs a separate GO.

## What the evidence counts, and what it does not

- **A decision is not a request.** The coordinator counts a decision where a guard looked at the scope. The removal path looks **twice for one lookup**: the queue's pre-claim peek (caller `removal-rating`, one coordinator per phase) and the real request's guard (caller `removal-rating-request`, one coordinator per request). In `observe` both count `would_skip` for the same cooling lookup while the request is sent; the pre-claim and request sites are kept apart by caller so they are not added up as if they were one. Regression: `tests/removal-ratings-cooldown.mjs` case 6 (three lookups sent, six `would_skip` decisions).
- **`would_skip` is not the number of requests `enforce` would have prevented.** `enforce` would act at the first guard that sees the cooling scope: in the removal phase it stops the whole phase at the first pre-claim check, so no lookup is sent after it and the later per-request decisions never happen. The counterfactual request volume is therefore a different number from the `would_skip` total, and the report states it only qualitatively (which callers/sites would have been stopped, and where), never as a precise count of prevented requests. The **actual** sent requests come from the callers' own run records (for example `run.removal.lookup.checked`, `run.upstreamCooldown`), not from this log.
- **A stream is not a business run.** The lines carry no stream id; a "stream" is one coordinator and one decision kind, and a caller may create one per phase, step or request. The aggregator reports `streams` and an exact range of decisions per scope/caller/decision; it does not claim a number of runs.
- **Counts are conditional on completeness.** The bounds are exact only for a complete export of complete streams. A whole missing stream, a missing tail, a truncated query or an overlapping export can pass the arithmetic, and a real run can be missing from the logs although its effects are in D1 (the [observability skill](../../.claude/skills/cloudflare-observability-read/SKILL.md) records such a case): say "not in the logs", do not guess the cause.

## Evidence window, export and report

Observe natural evidence only, through authorized read-only sources: the Worker `iptv` logs, D1 `SELECT`s through `--status`, and the cron and Workflow history.

**Export shape.** Use the telemetry query of the [observability skill](../../.claude/skills/cloudflare-observability-read/SKILL.md): `view: 'events'`, a `$metadata.service eq iptv` filter and the needle `upstream_cooldown`, a timeframe in Unix milliseconds, and an explicit `limit`. Export the **structured events** (each with `source` = the parsed log body, `timestamp` and `$metadata.id`), one JSON object per line, not hand-copied text; return only those fields. The aggregator de-duplicates events by `$metadata.id`, so a repeated event is counted once and flagged.

**Windows and coverage.**
- Cover the evidence window with **consecutive, non-overlapping** timeframes (the logs are kept at most 7 days; export before they expire) and give each its own file. Pass the files together so the tool can see overlap and duplicate files.
- Pass `--query-limit` equal to the query's `limit`: an export that reaches the limit is flagged `possibly_truncated` and must be split into smaller windows.
- Correlate the export with the **natural run history** of the same window: for each caller that ran (cron, Workflow instances, run records, `run.upstreamCooldown` counters of metadata sync and EPG localization), check that its coordinators appear in the export, and list every caller/run that is **not in the logs** as a gap. A scope with no natural 429/challenge/403 in the window has no cooldown to observe; say so instead of presenting zero decisions as proof.

```bash
node scripts/upstream-cooldown-evidence-report.mjs --format markdown --query-limit 1000 window-1.ndjson window-2.ndjson
```

**Evidence status** (the report's last line, never a GO):

| Status | Meaning |
| --- | --- |
| `none` | No `upstream_cooldown` event was found: **no evidence**, not a zero count and not proof that nothing happened. |
| `insufficient` | A defect was found (flags below); read nothing as complete. |
| `conditional` | Observed counts and bounds that hold only for a complete export; completeness is **never** proven by the tool, and `uc3Eligible` is always `false`. |

Flags: `actual_skips` (a `skipped` decision in `observe` is a **defect**: stop, roll back under the approved operation and open a fix), `write_failed` (a cooldown write failed and the caller continued: explain it), `inconsistent_export`, `malformed_lines`, `duplicate_events`, `overlapping_exports`, `duplicate_files`, `possibly_truncated`, `no_events`. Limits that always remain: `completeness_unproven`, and `identity_unverified` when events carry no id (duplicates cannot then be detected).

**Empty or partial evidence is reported as such.** Whether the evidence is representative enough for UC3 is a judgement of the report's reviewers against the natural run history and the listed gaps; an `insufficient` or `none` status, an unexplained gap, or a caller/scope that never ran **cannot** be presented as a clean UC3 GO. It leads to a named gap (and more natural time) or to an explicit owner No-GO.

### Report template (dated, one PR into `docs/evidence/`)

```markdown
# AIR-609: shared upstream cooldown in observe, <date> (UTC)

- Operation: GO <link>; operator digest <sha256>; Worker <commit>; control-row readback (revision before/after); `cooldownObservations`; Time Travel bookmarks.
- Window: from <Madrid time (UTC)> to <Madrid time (UTC)>; the consecutive exported timeframes, the query limit and the aggregator's export windows; the sources read.
- Natural run history: per caller the natural runs in the window and whether their coordinators are in the export; every caller/run NOT in the logs, named as a gap.
- Decisions per scope / caller / decision: the aggregator table (streams and lower - upper range). Decision-site counts only: the pre-claim and request sites of the removal path are separate callers and are not added as requests.
- Actual requests: the sent requests per caller from the run records, beside the decisions; the difference between decisions and requests explained.
- Cooldown rows: per scope the reason, `setBy`, set time and expiry, and whether the signal was a real 429/challenge/403 of an upstream.
- Skip accounting: `skipped` must be 0. `would_skip` per scope and site is a decision count; the `enforce` counterfactual is stated qualitatively (where it would have stopped), never as an exact count of prevented requests.
- Expiry: every cooldown expired by itself within its clamp (30-3,600 s; defaults 300/900 s); none outlived its reason.
- False blocks: any would-skip not explained by a real signal of the same scope (a cooldown of one scope blocking another, a 404/5xx/timeout setting one, a stale row).
- Resources: D1 statements added by the mode read and the cooldown reads/writes (observed, not a quota), log volume, caller run durations against the baseline.
- Evidence status: `none` / `insufficient` / `conditional`, the flags and the limits, the gaps and what they could hide.
- Verdict: enough representative natural evidence for UC3 (reviewed, with the gaps stated), or a named gap, or an explicit owner No-GO. Never derived from the aggregator alone.
- Limits: what was not observed (a scope without a natural signal, a caller that did not run) and what the bounds cannot say.
```

## Acceptance (card AIR-609)

A separate GO; the control-row readback; representative natural evidence per scope and caller that ran, with the gaps explicit; the dated report reviewed; **no actual skips** caused by the cooldown; and either enough evidence for UC3 or an explicit owner No-GO. While natural acceptance is pending the card goes to `Верификация`, not `Готово`.
