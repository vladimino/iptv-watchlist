# Shared upstream cooldown: `observe` rollout and evidence (UC2)

[AIR-609](https://trello.com/c/q8XXpWAi) · card UC2 of [ADR 0207](../adr/0207-letterboxd-admissions-coordinated-in-d1-only.md) decision 7 · [ADR 0211](../adr/0211-catalog-enrichment-producer.md) decision 5 · contract: [shared upstream cooldown](../reference/integrations/upstream-cooldown.md).

**Delivering this page and its tooling authorizes nothing.** Moving `upstream_coordination.mode` is an owner production operation (L2/L3) that needs its **own, separate GO** on the card, naming the operator digest and the revision `--status` printed. `enforce` (UC3) is out of scope: the operator cannot write it and refuses to touch a row that already holds it. No Scheduled Task, flag, Access rule, R2 object, migration or manual upstream request is part of this rollout.

## What `observe` does

Natural callers (Discovery, the poster routes, Letterboxd Sync, metadata sync, EPG localization, identity checks, removal lookups) **keep sending every request**. On a 429, a Cloudflare challenge or a 403 they write the scope's cooldown (`upstream_cooldown`), and before each request they count "would have skipped" while a cooldown is active. Nothing is skipped, retried differently or delayed. The mode is read once per caller run, so the change takes effect on the **next run** of each caller. Evidence is the Worker log line `{"event":"upstream_cooldown",...}` (logarithmic sample per coordinator) and the rows of `upstream_cooldown`; nothing is written for evidence.

## Tools (all offline-tested, dormant)

| Tool | Reads | Writes |
| --- | --- | --- |
| `node scripts/upstream-cooldown-mode-production.mjs --status --target iptv` | D1 `iptv` through the owner credentials ([credentials skill](../../.claude/skills/iptv-credentials/SKILL.md)): schema version, the two tables, the mode row, every cooldown row and its expiry | nothing |
| `node scripts/upstream-cooldown-mode-production.mjs --set --target iptv --mode observe\|off --expect-revision <n> --confirm set --operator-sha256 <64 hex>` | the same, plus a Time Travel bookmark before and after | **one** statement on `upstream_coordination`, only `off -> observe` or `observe -> off`, only with the exact predecessor mode and revision |
| `node scripts/upstream-cooldown-evidence-report.mjs [--format json\|markdown] [file ...]` | Worker log text exported by a separate authorized read | nothing (no network, no database) |

`--status` is strictly read-only and prints the digest of the operator, the effective mode (an absent row reads `off`), `expectRevision` (0 for an absent row), the decision of each transition and, per scope, the cooldown reason, `setBy` caller, expiry and whether it is still active. It never prints an endpoint, a token or a payload.

Refusals, all before any write: `operator_digest_mismatch`, `tables_missing`, `schema_unexpected` (below version 47), `mode_unexpected`, `already_set`, `enforce_active`, `revision_moved`, `scope_unexpected`, `unknown_state`. A write is never retried. After a lost response or a readback that disagrees the operator reports `write_uncertain` with `retry: false`: run `--status` and decide with the owner; do not re-run `--set`.

## Preconditions (checked live, not from this page)

1. The card carries a **separate GO** for `off -> observe` that names the operator digest and the revision. A GO for AIR-606, AIR-607 or the migration window does not cover it.
2. The `--status` decision for `observe` is `apply`: schema version at least 47 (AIR-603 checkpoint A applied), both tables present, effective mode `off`, no row holding `enforce`.
3. Read the cooldown rows in the same `--status`. Rows left from before are expected to be absent or expired; an active row is not a blocker (observe skips nothing) but is recorded in the report as the starting state.
4. The Worker deployed from the exact `main` commit named in the GO (the callers must carry the coordinator). A deploy applies nothing and changes no mode.
5. Choose the moment so that natural runs of the callers follow soon after: the change takes effect at the next run of each caller. Do **not** trigger a run, a Scheduled Task, a sync or an upstream request to produce evidence; wait for the natural ones.

## Procedure (one owner-approved operation)

1. `--status`; record the digest, the revision and the cooldown rows.
2. `--set --mode observe --expect-revision <n> --confirm set --operator-sha256 <digest>`.
3. Independent readback with `--status`: mode `observe`, revision +1, the same cooldown rows.
4. Note the time (Madrid, UTC in parentheses): it starts the evidence window.

## Rollback

`--set --mode off --expect-revision <n> --confirm set --operator-sha256 <digest>` under the approved operation. It restores today's behaviour for the next run of every caller and needs no code revert. Cooldown rows already written stay (they are never deleted and expire by themselves; with `off` nothing reads them). Restoring a Time Travel bookmark is **not** the rollback and needs a separate GO. Rollback of an `enforce` state is UC3's operator, not this one.

## Evidence window and report

Observe natural evidence only, through authorized read-only sources: the Worker `iptv` logs (see [cloudflare-observability-read](../../.claude/skills/cloudflare-observability-read/SKILL.md)), D1 `SELECT`s through `--status`, and the cron and Workflow history. Export the `upstream_cooldown` lines of the window to a local file and run the aggregator:

```bash
node scripts/upstream-cooldown-evidence-report.mjs --format markdown upstream-cooldown-lines.log
```

Because a coordinator logs at its 1st, 2nd, 4th, 8th ... occurrence, the aggregator reports, per scope, caller and decision, the number of runs and an exact **range** of decisions (lower - upper) instead of a single total, and flags an inconsistent export (a run that logged 2 without 1, a count that is not a power of two). The flags mean:

- `actual_skips`: a `skipped` decision in `observe` is a **defect** (observe must never skip): stop, roll back under the approved operation and open a fix.
- `write_failed`: a cooldown write failed; the caller continued. Needs an explanation in the report, not a rollback by itself.
- `inconsistent_export` / `malformed_lines`: the export is incomplete for the window; widen or repair the read before drawing conclusions.

### Report template (dated, one PR into `docs/evidence/`)

```markdown
# AIR-609: shared upstream cooldown in observe, <date> (UTC)

- Operation: GO <link>; operator digest <sha256>; Worker <commit>; mode readback (revision before/after); Time Travel bookmarks.
- Window: from <Madrid time (UTC)> to <Madrid time (UTC)>; the natural runs that fell in it (callers, count) and the sources read.
- Decisions per scope / caller / decision: the aggregator table, with runs and lower - upper range.
- Cooldown rows: per scope the reason, `setBy`, set time and expiry, and whether the signal was a real 429/challenge/403 of an upstream.
- Skip accounting: `skipped` must be 0; `would_skip` per scope = requests `enforce` would have suppressed; requests actually sent during an active cooldown.
- Expiry: every cooldown expired by itself within its clamp (30-3,600 s; defaults 300/900 s); none outlived its reason.
- False blocks: any would-skip not explained by a real signal of the same scope (a cooldown of one scope blocking another, a 404/5xx/timeout setting one, a stale row).
- Resources: D1 statements added by the mode read and the cooldown reads/writes (observed, not a quota), log volume, caller run durations against the baseline.
- Verdict: enough representative natural evidence for UC3, or a named gap, or an explicit owner No-GO.
- Limits: what was not observed (a scope without a natural signal, a caller that did not run) and what the aggregator bounds cannot say.
```

## Acceptance (card AIR-609)

A separate GO; the mode readback; representative natural evidence per scope and caller that ran; the dated report reviewed; **no actual skips** caused by the cooldown; and either enough evidence for UC3 or an explicit owner No-GO. While natural acceptance is pending the card goes to `Верификация`, not `Готово`.
