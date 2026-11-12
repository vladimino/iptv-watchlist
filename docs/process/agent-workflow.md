# Agent delivery workflow

This document is the durable collaboration policy for the IPTV Watchlist project. It does **not** track today's active Trello card, latest PR, deployment version, or production feature flags. Those must be checked live. For code-agent Git preflight and repository safety, also follow [AGENTS.md](../../AGENTS.md); for Trello formatting follow [trello-card-conventions.md](trello-card-conventions.md).

## Architectural decisions and visual QA

The owner decides **material new** architecture, security or product trade-offs before implementation, based on alternatives, consequences and rollback. An ADR documenting an **already approved** choice may be finalized as Accepted with the approval reference; never silently accept an undecided substantive change. Preserve accepted ADR history by superseding records.

Changed Mermaid diagrams require actual rendered GitHub visual QA, legibility and independent semantic review against code/contracts. Routine diagram edits do **not** require owner sign-off; retain an exceptional visual gate explicitly named in approved scope. Product UI acceptance stays with the owner when scoped.

The Executor handles ordinary ADR/Markdown/Mermaid fixes and re-runs CI; no special handoff to ChatGPT solely to flip an approved ADR status. See [authorization and escalation](authorization-and-escalation.md).

## Roles and sources of truth

- **Product Owner:** intent, priorities, material technical/product decisions and final product acceptance.
- **Planner / Coordinator:** scopes and orders approved work, verifies prerequisites, handles routine exceptions and prepares major decisions.
- **Executor:** any authorized coding/documentation agent implements work and fixes.
- **Independent Reviewer:** checks actual PR diff, safety and acceptance on exact HEAD, independent of implementation context.
- **Delivery Controller:** tracks approved merge, CI/CD, safe verification and Trello status/evidence; may be an agent or durable external service, never automatically an interactive chat.
- **Trello:** current approved scope, prerequisites, status and product disposition. **GitHub:** main, PR, reviews and CI. **Production:** verified readback of state and authorities.

Read live card, comments, dependencies, current main and affected runbooks before acting. Handoffs persist in Trello/GitHub, not in chat memory. See [authorization](authorization-and-escalation.md).

## Language and public-repository boundary

- **Trello:** Russian for cards, comments, dependencies, delivery reports, and instructions intended for Cursor.
- **GitHub:** English for PR descriptions, review summaries, inline review comments, code discussions, and repository documentation.
- **Technical names:** preserve function/class names, API paths, field names, error/reason codes, commit SHAs, and other identifiers exactly.
- **ChatGPT conversation:** Russian by default, unless the owner asks otherwise.
- This repository is public. Never post secrets, authorization tokens, private production payloads, raw model responses/prompts, personally identifying data or confidential operational records to GitHub. Use sanitized aggregate evidence where appropriate.

## Work item scope, acceptance and dependencies

- Each Trello card must deliver one independently reviewable and closeable outcome. Avoid numbered implementation epics hidden in one card. Split separate shadow/cutover/stabilization or live-migration outcomes into independent cards before work starts.
- Follow the detailed [Trello card conventions](trello-card-conventions.md) for Russian descriptions, '[AIR-N]' names, a current plan-context introduction, relevant functional labels, scope, objectively verifiable Done, tests/evidence and rollback.
- Real prerequisites belong in a **native Trello checklist**. **Read existing checklists first; reuse an existing prerequisites checklist instead of creating a duplicate**, and deduplicate prerequisite items across legacy checklists. Each item must be **only the bare Trello card URL**, never a Markdown link or an AIR/title-prefixed label; this is required for Trello to display the actual linked card title and status. Do not create false blockers or empty checklists. Reconcile checkmarks with *actual* Done status after closing upstream cards.
- Give direct Trello links to relevant prerequisites and successor work in PR descriptions and final delivery reports. Do not assign the next AIR number without checking whether it is already used.
- **Ambiguous Trello write results are not permission to retry.** After a timeout, tool error or missing/unclear write response, read or search live Trello to determine whether the mutation actually succeeded before repeating it. Especially never retry `create` blindly: check the intended card's name, AIR number, board/list, and existing matches first. If a duplicate is found, preserve the canonical card and its activity, then archive only the confirmed duplicate. Apply the same verify-before-retry rule to moves, comments, checklist edits and other non-idempotent mutations.
- Code ready, PR merged, successful deployment, read-only production smoke test, shadow verification and cutover are different claims. Record precisely which of them is proven.
- The board's **«Верификация»** column is the explicit post-delivery, pre-acceptance state. Use it only when the approved implementation is merged into current `main`, required post-merge test/build and Cloudflare deploy jobs have succeeded (or the card's explicitly approved delivery boundary is otherwise complete), and the only remaining acceptance evidence requires a later natural production run, a scheduled external observation, a bounded stabilization interval, or an owner visual/product check. Record the outstanding gate and its expected trigger in the card. Do not confuse this state with `Готово`.

## ChatGPT Scheduled Tasks: explicit owner permission only

Agents must **not create, enable, disable, reschedule, modify, or manually trigger a ChatGPT Scheduled Task unless the owner explicitly authorizes that exact operation**. This covers temporary and one-off tasks as well as recurring tasks, and applies even if the task appears harmless, read-only, useful for monitoring CI/CD or intended to spare the owner a handoff. Approval of a Trello card, PR, normal delivery, monitoring goal or deployment does **not** imply permission to use the Scheduled Tasks scheduler. Tool availability and generic product suggestions do not grant authorization.

For routine PR/CI/CD follow-through, poll within the active session when possible; otherwise leave an accurate handoff in the existing Trello card and GitHub PR. Do not secretly create a timer or Scheduled Task to resume later. Before an explicitly approved Scheduled Task operation, identify its exact task (or proposed new task), action, schedule/timezone and effects; follow the authorization policy and relevant operational contract. These restrictions apply to task-management actions, not to read-only inspection of an existing task registry when otherwise authorized.

## Risk-proportional operational safeguards

IPTV Watchlist is a single-owner service. Select safeguards by **blast radius, data authority, existing writers, reversibility, and recovery cost**, rather than by the blanket rule that every production write needs a full snapshot, multiple parity passes and a large restoration plan. A bounded failure that the existing pipeline can safely reprocess is not the same as irreversible loss. Do not add recovery ceremonies whose cost exceeds the plausible damage.

| Classification | Observable criteria | Proportionate checks |
| --- | --- | --- |
| **Lightweight, additive** | One specifically identified key is absent; only a new object is created, with no overwrite/delete or schema/authority change; the bytes and SHA-256 are approved; there is credible evidence of a single writer for this key or a safe conflict stop; the downstream consumer is idempotent or can re-project; rollback is a bounded delete or superseding correction | Target-specific GET/absence precheck, exact payload + digest and **one** owner approval for the action; one write (no blind retry); immediate GET/bytes or digest readback; one scoped downstream status/consistency check when that consumer next runs; documented bounded recovery. **No default full-bucket fenced snapshot, whole-database bookmark, global parity or duplicate planner rerun.** |
| **Elevated / uncertain** | The key already exists; competing writers cannot be excluded; a conditional write is unavailable and overwriting would be damaging; rollback or source-of-truth is unclear; or a failure can poison shared state | Stop and resolve uncertainty first. Use a conditional write/CAS or lease when supported, narrow before-image, ownership check and the smallest extra verification needed. If single-writer and reversibility cannot be established, use the high-impact procedure, not an optimistic unconditional PUT. |
| **High impact** | Existing authoritative data overwritten or deleted; bulk operation, schema migration, cutover, trust/access boundary, cross-domain references or irreversible side effects; recovery has material cost | Fencing/leases, before-image or scoped/full snapshot as justified, parity and multi-stage acceptance, rollback/restore rehearsals and explicit owner gates appropriate to the changed authority and blast radius. |

A **Cloudflare R2 REST API PUT without conditional semantics** is not made atomic by a preceding GET. For an approved single-key additive correction: verify the exact target returns `404` immediately before writing; confirm no application, Task, Worker or other operator writes that key; perform exactly one PUT of approved bytes, with no blind retry; read back and compare byte length and SHA-256; stop on an unexpected object, ambiguity or mismatch. The 404 check only narrows the race: if exclusive ownership cannot be demonstrated, prefer a conditional-capable writer or elevate the operation. After an ambiguous timeout, **read the target before deciding whether any retry is needed**. An unexpected result is not permission to overwrite.

A downstream projector that is already authoritative, repeatable and recoverable may be verified through its single scoped status/readback. Do not automatically require both a full planner rerun and a separate equivalent parity test when one directly proves the acceptance criterion. A full system restore can itself destroy unrelated newer writes; treat it as an exceptional recovery path, not a routine prerequisite for a tiny correction. Record exactly what was checked and what remains unverified.

**Policy-based authorization:** verified L0 observations and approved L1 delivery need no repetitive owner prompt. L2 production remediation requires an operation-specific approved standing contract with enforceable limits; this policy enables **no new L2 production writer**. L3 requires an owner-approved plan and its holdpoints, not a conversation for every safe substep. Existing stronger ADRs/runbooks/Access guards remain in force until specifically changed. Some GET routes write. See [authorization](authorization-and-escalation.md).

The [cross-system safeguard audit](risk-proportional-safeguard-audit.md) records concrete keep/simplify decisions and limits across runbooks. A documentation change does not silently change CLI contracts or accepted ADRs.

## Newly discovered risks: automatic disposition and exception-based escalation

Do not expand acceptance or block unrelated work because a local risk was found. Classify against approved scope and actual invariants:
- **Fix now within scope:** give actionable findings to the Executor; retest/re-review, or use an *existing* authorized L1/L2 recovery.
- **Defer nonblocking:** record evidence, linked atomic follow-up and clear revisit trigger without false prerequisites.
- **Stop affected action:** unknown or conflicting generation, lease, authority, identity or write receipt; do not blind-retry or silently waive acceptance.
- **Escalate owner decision:** changed product intent, material architecture/security trade-off, high-impact action outside a plan or unresolvable integrity issue. Present options, consequences and recommendation.

An isolated problematic record may be deferred only when explicit acceptance/invariants allow partial success. Continue other approved safe work. See [authorization](authorization-and-escalation.md).

## Delivery pipeline for already approved work

### Executor opens the PR and subscribes without asking

When an Executor finishes the work of an approved card, opening the pull request and subscribing to its events are part of that delivery and are done **by default, in the same turn**, without a confirmation question to the owner: push the working branch, open a PR against `main` (never a direct `main` commit) with a body that satisfies [documentation governance](documentation-governance.md#automated-pull-request-checks), then subscribe to its activity where a subscription tool exists and follow it to a terminal status ([AGENTS.md](../../AGENTS.md)). Asking "shall I open a PR?" after finishing delivers nothing and delays review. This does not widen authority: merge, Task changes, production writes and flag changes keep their existing gates, and a tool or platform default that says "do not open a PR unless asked" is satisfied by this standing owner instruction.

### Test-suite performance quality gate

**A pull request is not merge-ready when the complete `npm test` step (`Run tests`) takes more than 180 seconds in GitHub Actions on the proposed final HEAD.** This is a mandatory review and delivery gate for changes that affect test runtime, including additions of new tests; a green test result alone does not override the limit.

- The suite runs as two shards in two jobs, `Test and build` (shard 1 of 2) and `Test shard 2 of 2` (owner decision on [AIR-418](https://trello.com/c/5HEzNlvh), 10 Nov 2026: one runner's speed varied by a factor of 1.65 on the same code). The gate applies to **each** job's `Run tests` step; the limit itself is unchanged. Every test file is in exactly one shard (`scripts/run-tests.mjs --shard`, checked by `tests/run-tests-runner.mjs`); `npm test` without a shard still runs the whole suite.
- Measure the actual `Run tests` step duration of both jobs on the GitHub-hosted runners, excluding queue time, dependency installation, build and deployment. Local timings are diagnostic only. Do not reduce test coverage, assertions, fixtures or production-scale parity checks merely to meet the budget.
- If a run exceeds 180 seconds, the Executor must investigate and optimize the affected tests, fixtures, harness or scheduling, preserving isolation and correctness, and rerun CI on the updated HEAD. The Independent Reviewer and Delivery Controller must not approve or merge the PR until the gate passes. Record the slow files, before/after timings and the remedy in the PR.
- For a suspected anomalous or contended runner, collect comparable reruns of the **same HEAD** and document the variance; do not silently discard a slow run. A persistent regression above the budget is a merge blocker, not a reason to accept a slower suite. Any exception requires an explicit Product Owner decision recorded in the PR; agents cannot waive the gate themselves.
- The limit is a **documented review gate**, not a claim that GitHub currently enforces it automatically. A future automated check may implement the same threshold without changing the policy.


1. **Select ready work:** inspect live approved Trello scope and native prerequisites, current main and related PRs. Choose unblocked tasks by approved priority, capacity and change conflicts. Do not infer owner approval from remembered AIR identifiers.
2. **Portable handoff:** self-contained task requirements, acceptance, tests, docs, safety and PR evidence live in Trello/GitHub. A new agent can resume without copying chat history.
3. **Implement and review:** branch/PR, tests, code/docs, independent review of actual HEAD, feedback, fixes, resolved blocking threads and green CI on final HEAD. No self-approval.
4. **Ordinary merge:** approved scope includes Controller merge without repeated owner confirmation when independent review, exact-head CI, prerequisites and exceptional gates pass; never force an unsafe overwrite.
5. **Post-merge:** verify main SHA and the terminal GitHub Actions jobs: `Test and build`, `Test shard 2 of 2` and `Deploy to Cloudflare` (the deploy needs both test jobs). A deploy is neither data publication nor permission for unrelated writers.
6. **Scoped checks:** proven L0 and authorized L1 verification. L2 recovery requires its existing operation-specific approved contract and L3 requires a plan/holdpoints. Distinguish code delivered, runtime activated, producer completed and product accepted.
7. **Verification queue:** after successful post-merge delivery, move a card from `В процессе` to **`Верификация`** when acceptance genuinely depends on a later natural/scheduled producer tick, a stabilization window, permitted production evidence, or owner UI/product acceptance. In a dated Russian Trello comment record the exact merged SHA, passing CI/deploy, which acceptance criteria remain unproven, the next natural trigger (with timezone when known), the read-only evidence to collect, the responsible reviewer/owner, and any blocker. No periodic polling, new Scheduled Task, forced run, recovery, lease reset or production write is authorized by this status. If the missing check can be completed safely now, perform it instead of parking the card. Avoid making a separate waiting card for the same outcome.
8. **Acceptance and disposition:** verify the outstanding result against the card's original criteria and record evidence. On success, obtain owner acceptance when required (or rely on explicitly delegated technical acceptance), then move `Верификация` to `Готово`, mark the card complete and read back **both** list and completion flag. If the natural check fails or exposes more implementation work, record the failure and move the card **back to `В процессе`**, retaining the original scope; escalate or create a separate atomic issue only for genuinely independent new work. `Верификация` is neither delivered-and-done nor an automatic completion, and a prerequisite dependent on this card remains unchecked until it is truly `Готово` and marked complete.
9. **Advance queue:** reconcile dependencies and select the next approved, unblocked card. If a callable executor or event listener is unavailable, record the limitation and durable handoff rather than using owner as an invisible message relay.

This defines permitted behavior, not a claim that ChatGPT already has autonomous dispatch or persistent subscriptions.

## Feature flag lifecycle: plan, test, switch, remove

Every temporary feature flag must have an explicit end-to-end lifecycle **at the time it is first planned**:

1. **Create and plan.** Specify its owner, exact permitted values and defaults, consumers, data effects, rollback boundaries and the reason the flag is temporary. Create a separate, atomic Trello **flag-removal card immediately**, before implementation, link it from the introduction/rollout card, and include the specific cutover, stabilization and acceptance criteria that will unblock deletion. Do not defer creation of the removal card until after rollout.
2. **Implement and test.** Ship the gated change with tests for old/new modes, compatibility and failure paths; register the flag in [the maintained feature-flag contract](../reference/feature-flags.md). No assumption that a deployed flag is enabled.
3. **Switch and stabilize.** Execute shadow/rollout/cutover under an owner-approved L3 plan with its explicit holdpoints; bounded preflight, steps and readback need not generate redundant per-call approval prompts. Verify the actual production binding from authoritative Cloudflare settings or an MCP diagnostic that **explicitly exposes that exact effective setting**, then verify the relevant production behavior and complete the defined stabilization period. A code default, previous Trello comment, generic MCP probe, or successful deployment alone does not establish a live binding.
4. **Close the rollout with an explicit flag disposition.** Before marking the rollout card Done, record in its Trello comments one owner-approved disposition for **each introduced temporary flag** (reusing a decision recorded in the approved rollout plan): `retire now`, `retire after stabilization`, or `retain as permanent operational gate`. State the evidence, reason, rollback/operational consequences, and exact successor card. For either retirement outcome, the pre-created removal card **must contain the actual rollout/acceptance/stabilization card as a native Trello prerequisite** (one bare canonical Trello URL per item), not merely a descriptive sentence or a chat note. Verify live card IDs and status, reuse the existing prerequisite checklist, and mark the item checked only after that prerequisite's defined acceptance is truly Done. For `retire after stabilization`, link an existing stabilization acceptance card **only if one genuinely exists and its outcome is required**. Stabilization can instead be a bounded, evidenced check inside the removal card's readiness/acceptance, using already available routine production observations; do not invent a separate card, waiting period, or rollback exercise merely to populate a checklist. If a distinct unsafe operation or material independent delivery is actually required, obtain its owner gate and create a separate atomic task. Do not confuse a readiness card (which may only prepare activation) with proof that activation occurred. For `retire now`, the completed rollout card remains a linked, checked prerequisite and the removal card can proceed only after readiness preflight. A permanent gate requires an explicit safety/operational rationale, owner-approved disposition, and a clear follow-up/review trigger; do not silently omit an existing disposal ticket. **The cleanup card's own scope and prerequisites are live Trello data, never chat-only knowledge.**
5. **Remove and deconfigure.** When the new mode is accepted and the old mode is no longer needed, use the removal card to delete the selector, legacy branch and obsolete tests and update references/runbooks. After approved merge, both CI/CD jobs and safe runtime verification, the **final required acceptance step** for a retired Cloudflare Worker environment variable is to remove that exact production binding under the approved L3 cleanup plan and any named holdpoint, then independently read back its absence (authorized settings or an MCP diagnostic reporting the exact flag). Never silently remove bindings or assume deployment clears them (`keep_vars: true`). Record both the code retirement and verified binding removal; only then mark the cleanup card Done and Trello `mark_done`. If permission or access is unavailable, leave the cleanup card open with the precise remaining step. Retaining a permanent operational gate requires a separate explicit disposition, not deletion. Restore the old binding according to the documented rollback procedure if reverting to code that reads it. Preserve data, security gates and supported operational capabilities.

Distinguish a **transitional switch** from a **permanent owner-only safety gate**: an endpoint permitting sensitive one-off writes may need a durable gate rather than automatic removal. In that case the initial card must state the rationale and the removal/disposition ticket must explicitly decide whether to retire the endpoint, retain its gate, or replace it with a supported operational control. Never remove protections merely to satisfy a cleanup metric.

Before creating any cleanup card, search live Trello for an existing removal/disposition card using the flag's literal identifier and relevant migration terms; avoid duplicate tickets and duplicate prerequisite checklists. If the required rollback or migration remains incomplete, do not prematurely remove the flag. Review the register after each rollout and verify the cleanup card's existence and prerequisites.

## Read routes must not write

A new or changed GET, HEAD, page or MCP read tool must pass `tests/get-write-audit.mjs` ([read side effects](../reference/api/read-side-effects.md), [ADR 0107](../adr/0107-get-head-read-side-effect-boundary.md)): register a new prefix route or MCP tool in `tests/get-write-baseline.mjs`, with no effect. A reviewer rejects an entry added to the baseline for new work; a PR that fixes a baseline writer deletes the entry in the same PR and moves the write to its owner writer. The audit runs the production bundle against an instrumented R2 and D1; it never calls production, and a production read of a route the baseline lists is still L2/L3.

## Documentation acceptance

Before implementation, record the documentation impact in the Trello card and implementation handoff using the [documentation governance matrix](documentation-governance.md). At independent review, compare the actual diff with that matrix; require the matching source, contract, evidence, ADR and diagram changes in the same delivery. A claimed `Documentation impact: none` needs a reason that survives review. Missing required documentation is a blocking finding even when tests are green. Do not defer it to a future cleanup card.

Every material architectural change requires a new ADR that records alternatives, rationale, trade-offs, and supersession where applicable, plus corresponding Mermaid diagrams and technical contracts. Pure refactoring that preserves architectural decisions does not require a new ADR. Mermaid modifications retain the existing owner visual review gate.

## Visual QA

A substantial UI change requires visual QA in a local browser at a desktop width around 1280 px and a mobile width around 390 px. Check representative full and partial states, visual hierarchy, spacing, overflow, whether the controls can be reached, and the main interactions. The PR needs a short written report of what was checked and which problems were found or fixed. Creating, saving, downloading, or attaching screenshots is not required. The owner does the final visual acceptance on real production data after a successful merge and CI/CD. Until that acceptance, the UI card stays open. Green tests or CI are not visual QA. Do not commit screenshots anywhere in the repository.

## Safety and production boundaries

- Side-effect-free verified observation is L0 and needs no repeated owner approval; unknown GET/status endpoints are not presumed read-only.
- Manual production sync, ratings, predictions, discovery/TMDB, lease resets, migration, cutover, cleanup, feature flags, Scheduled Tasks and security operations are **not** authorized merely by code deployment or this docs-only policy. Use existing L2 contract or owner-approved L3 plan.
- This policy grants no new autonomous L2 production writes and no new Access permissions. Preserve accepted ADRs, CAS, leases, identity and source-of-truth guards until specifically changed.
- A code rollback does not roll back R2/D1 data, authority markers or external schedules. Unknown receipt does not prove no side effect. Protect confidential data and credentials.

## Conversation handoffs and shared state

- Cross-session handoffs should describe the present blocked acceptance, exact links and the next safe action, **with a date**. New sessions immediately recheck GitHub, Trello and connected tool availability.
- Stable operating rules belong here and in the Trello conventions; live status belongs in Trello, GitHub and current operational evidence. Avoid baking temporary AIR statuses, counts or next-ticket numbers into evergreen instructions.
- The ChatGPT Movies project may include both film-taste modeling and the IPTV website. These workflow rules apply only to IPTV/code/operations tasks, not to general film recommendations or Letterboxd analysis.
- Documentation-only work normally uses a PR, independent review and CI; direct main commit needs explicit approval. Every main push may deploy Worker code; verify terminal jobs.

