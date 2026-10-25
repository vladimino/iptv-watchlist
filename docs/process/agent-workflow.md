# Agent delivery workflow

This document is the durable collaboration policy for the IPTV Watchlist project. It does **not** track today's active Trello card, latest PR, deployment version, or production feature flags. Those must be checked live. For code-agent Git preflight and repository safety, also follow [AGENTS.md](../../AGENTS.md); for Trello formatting follow [trello-card-conventions.md](trello-card-conventions.md).

## Roles and sources of truth

- **Owner:** approves goals, non-routine scope and production-risk actions; may have several ChatGPT conversations working on independent streams.
- **Cursor / coding agent:** implements a bounded card, writes tests/docs, creates a PR and reports evidence. Do not assume the coding agent's summary replaces review.
- **ChatGPT delivery coordinator / reviewer:** checks Trello and GitHub firsthand, maintains the board, reviews changes, provides ready-to-send Cursor instructions, merges approved work, watches deployment, verifies acceptance, documents completion and advances the approved queue.
- **Trello:** current card status, approved ordering, native prerequisites, scoped acceptance criteria and operational discussion. Inspect the *actual* linked cards, not IDs inferred from memory; IDs can collide across independent streams.
- **GitHub:** the latest source, code diff, review threads, CI/CD runs and technical documentation. GitHub main is canonical code, but a successful commit is not proof of an enabled production feature.
- **Production evidence:** safe, authorized status and diagnostic reads; source-of-truth, flag and schedule state must be verified for the relevant decision. Historical snapshots are not live evidence.

At the start of work, read the relevant current card and latest comments, its native checklist and linked upstream/downstream cards, the current PR/commits and CI, plus affected runbooks. Do not reuse a previous-session handoff as a current board snapshot. Separate parallel delivery streams, and do not take over another stream's cards unless authorized.

## Language and public-repository boundary

- **Trello:** Russian for cards, comments, dependencies, delivery reports, and instructions intended for Cursor.
- **GitHub:** English for PR descriptions, review summaries, inline review comments, code discussions, and repository documentation.
- **Technical names:** preserve function/class names, API paths, field names, error/reason codes, commit SHAs, and other identifiers exactly.
- **ChatGPT conversation:** Russian by default, unless the owner asks otherwise.
- This repository is public. Never post secrets, authorization tokens, private production payloads, raw model responses/prompts, personally identifying data or confidential operational records to GitHub. Use sanitized aggregate evidence where appropriate.

## Work item scope, acceptance and dependencies

- Each Trello card must deliver one independently reviewable and closeable outcome. Avoid numbered implementation epics hidden in one card. Split separate shadow/cutover/stabilization or live-migration outcomes into independent cards before work starts.
- Follow the detailed [Trello card conventions](trello-card-conventions.md) for Russian descriptions, '[AIR-N]' names, a current plan-context introduction, relevant functional labels, scope, objectively verifiable Done, tests/evidence and rollback.
- Real prerequisites belong in a **native Trello checklist**, with direct URLs to upstream cards. Do not create false blockers or empty checklists. Reconcile checkmarks with *actual* Done status after closing upstream cards.
- Give direct Trello links to relevant prerequisites and successor work in PR descriptions and final delivery reports. Do not assign the next AIR number without checking whether it is already used.
- Code ready, PR merged, successful deployment, read-only production smoke test, shadow verification and cutover are different claims. Record precisely which of them is proven.

## Delivery pipeline for already approved work

1. **Implementation handoff.** Give Cursor an actionable Russian instruction referencing the Trello card, exact bounded scope, tests, safety limits and PR/report expectations. When a review finds needed changes, provide the *complete ready-to-forward message immediately* rather than asking the owner to request it.
2. **Independent review.** Open the actual PR diff and relevant changed files, confirm the base/head and current card scope, inspect CI/test evidence and documentation changes, check risk/security/read-only claims, consider missing negative tests and rollback, and resolve review threads. Do not accept a summary alone.
3. **Review feedback.** Leave specific technical comments in English on GitHub. Report practical findings and Cursor instructions in Russian to the owner. If reviewing one's own PR via the owner's GitHub identity, GitHub may reject formal APPROVE; use an explicit positive COMMENT review, not a false claim of approval.
4. **Merge.** When acceptance is satisfied and the owner has approved this delivery path, check for newer conflicting changes, merge the reviewed head without force or destructive operations. The usual review-to-merge authority does **not** approve a separate live migration, feature-flag switch or other gated production operation.
5. **Post-merge tracking is mandatory.** Read the new main merge commit and corresponding GitHub Actions workflow. Stay with the workflow through terminal results for **both Test and build and Deploy to Cloudflare**. A running/queued deployment is not a finished report. On failure, do not claim success or close the card; report the blocker and concrete corrective steps.
6. **Production acceptance.** After successful deploy, use only the safe, authorized checks required by the card. If acceptance calls for a new MCP tool, actually invoke that tool; a successful probe/CI alone is not enough. A cached connector tool list is a real blocker, not proof of a successful smoke test.
7. **Close with evidence.** Add a Russian Trello report linking the PR, review, merge SHA, terminal CI/CD run, smoke test or other evidence, unresolved known limitations and exact outcome. Move the card to 'Готово' and mark it complete only when all defined acceptance criteria are met. Update any successor prerequisite checklists.
8. **Continue the conveyor.** If the next card is unambiguous, already approved and unblocked, move it to 'В процессе' and give Cursor the next actionable instruction. Do not ask for re-approval of an agreed sequence. Stop and ask the owner only at a genuine ambiguity, new scope/approval gate, safety decision or unavailable external action.

The reviewer must not return an unfinished routine handoff just because a merge happened while post-merge deployment is still running. If tooling fails or access prevents verification, explicitly distinguish blocked from Done rather than guessing.

## Visual QA

A substantial UI change requires visual QA in a local browser at a desktop width around 1280 px and a mobile width around 390 px. Check representative full and partial states, visual hierarchy, spacing, overflow, whether the controls can be reached, and the main interactions. The PR needs a short written report of what was checked and which problems were found or fixed. Creating, saving, downloading, or attaching screenshots is not required. The owner does the final visual acceptance on real production data after a successful merge and CI/CD. Until that acceptance, the UI card stays open. Green tests or CI are not visual QA. Do not commit screenshots anywhere in the repository.

## Safety and production boundaries

- Never run production sync, discovery/TMDB, model predictions, retry resets, lease overrides, destructive cleanup, R2/D1 migration/backfill, authoritative read/write cutovers, or enable/disable scheduled jobs/feature flags without **separate explicit authorization** for that action.
- Deploying main code is not permission to exercise writable endpoints. A route named GET or 'status' may still have recovery side effects: follow [deployment.md](../runbooks/deployment.md), [mcp.md](../reference/api/mcp.md), README and side-effect tests for safe verification.
- Check the live authoritative storage and configuration; do not assume that a historical Site, R2 snapshot or D1 dry-run has become current production. Treat snapshot integrity/parity and source/target identity reconciliation as evidence gates, not as permission for migration.
- Keep production and historical data private. Do not reproduce raw record dumps in public issues, PR comments, docs, CI logs or chat summaries if those contain sensitive information.
- Verify current Scheduled Task and Access state from authorized live sources before operational claims. Neither an older runbook nor a successful Worker deployment proves tasks are enabled, disabled, connected or executed.

## Conversation handoffs and shared state

- Cross-session handoffs should describe the present blocked acceptance, exact links and the next safe action, **with a date**. New sessions immediately recheck GitHub, Trello and connected tool availability.
- Stable operating rules belong here and in the Trello conventions; live status belongs in Trello, GitHub and current operational evidence. Avoid baking temporary AIR statuses, counts or next-ticket numbers into evergreen instructions.
- The ChatGPT Movies project may include both film-taste modeling and the IPTV website. These workflow rules apply only to IPTV/code/operations tasks, not to general film recommendations or Letterboxd analysis.
- If the owner's requested project change is only documentation, direct-to-main is allowed **only when explicitly approved**; even then, verify the resulting commit and the automatic post-merge/deploy pipeline, because every main push can publish the Worker.

