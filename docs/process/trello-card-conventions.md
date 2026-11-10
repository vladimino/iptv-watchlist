# IPTV Watchlist — Trello card conventions

Version: 2026-11-04. Applies to the [IPTV Watchlist Roadmap](https://trello.com/b/HODRHtcO/iptv-watchlist-roadmap).

## Why

A Trello card is one independently reviewable, closeable delivery outcome. See [authorization](authorization-and-escalation.md) for risk tiers, portable agent roles and the owner's product acceptance. Do not hide a multi-day epic inside a single card with numbered phases, phases with letters, or a long chain of unrelated PRs. The board, not comments or a private phase document, must show progress.

Before work starts, split independent outcomes such as schema, repository adapters, migration dry-run, live backfill, shadow writes/reads, reader cutover, writer cutover, and legacy retirement into different cards. Each card has one clear Done condition, bounded scope, test evidence, and (for production changes) rollback. PRs may be smaller still, but a card must not require multiple unrelated production rollouts to close.

## Functional labels (use the labels that apply, not just one)

**System data flow:**
- **Интеграции** — import/ingestion of raw data from external providers, including TMDB and Letterboxd calls when actually modified.
- **Каталог** — persistent local canonical Film/Person model, identity, aliases, relationships, provenance, lifecycle, and their authoritative persistence.
- **Программа** — EPG, shows/availability, catch-up/future, last chance and freshness/window.
- **Прогнозы** — personal scoring/prediction, their profile, history and storage.
- **Находки** — discovery outside the watchlist and the related recommendation experience.

**Other functional areas:**
- **Фильтры** — search, filtering, presets and filter-state.
- **Страница фильма** — film details experience.
- **События** — Events Log and its presentation/content.
- **Платформа** — deployment, runtime, data-source/storage infrastructure, CI/CD.
- **Админка** — owner-facing administration/review workflow.
- **UX**, **Калибровка** — use only when the work substantively changes these concerns.

Labels can be combined: D1 Film repository = Каталог + Платформа; EPG D1 repository adds Программа; enrichment/prediction D1 adds Прогнозы; cross-cutting migration steps can have all affected functional labels. Do not add incidental labels for merely referencing a concept.

## Every new card

1. Title: `[AIR-N] One tangible deliverable`.
2. **Where we are in the plan** at the top: what upstream work is already delivered, the exact boundary of this card, what is still authoritative in production, and which next card(s) become actionable when this one is done. Use direct Trello card links, not plain AIR numbers.
3. **Prerequisites / Зависимости** is a *native Trello checklist*, not a bullet list in the description. **Before creating any prerequisite checklist, read all existing checklists on the live card** (including `Prerequisites`, `Prerequisites / Зависимости` and equivalent names). Reuse and reconcile the existing prerequisite checklist; never create a second checklist for the same purpose. Check all existing items for duplicates before adding any dependency, and consolidate legacy duplicate checklists without losing real dependencies or their verified completion state. Include only upstream cards that are genuine prerequisites. For a cumulative migration chain, show all preceding required milestones, not only the immediately previous card; e.g. AIR-73 depends on AIR-49, AIR-70, AIR-71, AIR-72. AIR-79 includes the full approved migration sequence and the AIR-69 scored stabilization gate.
4. **Each prerequisite checklist item must contain only the bare canonical Trello card URL**, for example `https://trello.com/c/8PRWRx2C`. Do **not** prepend an AIR ID or title, format it as `[AIR-70](url)` Markdown, add any commentary, or embed multiple links. Only the bare URL lets Trello render the linked card's live title and status. Confirm the linked card identity before insertion. Mark checked only after independently confirming that card is Done **in its defined acceptance scope**. Do not assume the checkmark updates automatically when another card moves lists: reconcile after closing a card and before beginning blocked work.
5. Don't introduce false blockers: a previously delivered domain *contract* may be available even when the broader parent card is not fully closed. Make that nuance explicit in context; never label an incomplete card as completed.
6. State **Documentation impact**: exact affected paths/sections according to [documentation governance](documentation-governance.md), or `Documentation impact: none` with specific justification. A material architectural change must include a **new ADR**, relevant Mermaid diagrams and updated contracts; do not treat a Trello comment or PR summary as a substitute. Documentation obligations are part of Done and independently checked in review.
7. State **Scope**, **Done / Acceptance** (objective, verifiable), **Tests / evidence**, **Production impact and rollback**, approved intent/spec reference, relevant L0–L3 actions and any exceptional owner holdpoints. Identify technical acceptance delegated in the approved scope versus final owner product acceptance. For integration PRs, link related Trello cards and current prerequisites in PR description and final report.
8. Keep historical notes as history, but don't leave an obsolete "Prerequisites" text section that contradicts the checklist. If a dependency changes, update the checklist and the card's introductory context.
9. **Production rollout is not code delivery.** A green PR/code-only Done cannot be presented as activated production or final product acceptance. Split independently material shadow/backfill/cutover when needed, but do not create arbitrary per-command cards for a pre-approved bounded plan. Supporting cards may close on explicitly delegated technical acceptance; product outcomes await owner acceptance.
10. No unsanctioned flag toggles, manual sync/model/TMDB calls, live migration, destructive cleanup or source-of-truth change as a side effect of drafting, testing, or closing documentation cards.
11. **Routine PR merge is included in approved scope.** Controller merges only after independent review, resolved blockers and green exact-HEAD CI, then verifies deploy and permitted production evidence. An ADR documenting an already-approved choice and routine rendered Mermaid QA do not require a second owner decision. New material architecture/security/product choices or named exceptional holdpoints do. See [authorization](authorization-and-escalation.md).

12. **Final AIR-number uniqueness readback is mandatory before handoff.** Allocate a tentative `[AIR-N]` from the current board before creation, but do not treat that first lookup as a reservation. After creating the card and completing its description, labels and native prerequisites, **re-read the live board immediately before handing control to the owner or executor**. Check the exact `[AIR-N]` prefix across cards in every list, including `Готово` and `Отклонено`, and archived cards when accessible; do not rely solely on Trello search indexing, the highest remembered number, or the newly created card's own readback. If another card uses the number, use creation evidence to keep the number with the earlier-created card and renumber the later-created one; if order cannot be established, stop and reconcile rather than silently choosing. Keep the same Trello card URL, update affected descriptions, comments and cross-card references, and repeat the board-wide readback after the correction. Report a card as ready only when this final check finds exactly one owner of its AIR number. This reduces the race window but is not an atomic reservation; any later discovered collision must be resolved before implementation handoff.

## Board state: «Верификация»

The live board uses **`Нужно сделать` → `В процессе` → `Верификация` → `Готово`**, with `Отклонено` for cancelled work. `Верификация` is a **post-delivery waiting-for-evidence** state, not a new implementation phase or a synonym for Done.

- **Enter `Верификация`:** approved implementation and required documentation are merged in current GitHub `main`; final-HEAD PR review/CI and post-merge test/build + Cloudflare deploy are verified (or the card explicitly states a different non-deploy delivery boundary). Only an acceptance condition that cannot yet be demonstrated remains: a natural hourly/daily EPG, Discovery, Ratings or Predictions tick; a justified stabilization observation; or owner visual/product acceptance. Do the immediately available safe checks first. Do not move a card merely because a PR is open, CI is pending, deploy has not succeeded, a known defect remains, or code is still being fixed.
- **Handoff comment on entry:** in Russian, include the PR and merge SHA, CI/deploy links, implemented versus **not yet proven** criteria, the precise expected event/date or normal recurrence (Europe/Madrid when relevant), which approved read-only observation or owner action will supply evidence, and the responsible role. If the exact next tick is not established, describe the natural trigger without inventing a time. Keep the existing acceptance criteria; no separate “verification ticket” is necessary for waiting on the original deliverable.
- **While waiting:** the card remains open and **not marked complete**. Delivery Controller/reviewer may read already permitted L0/L1 evidence when available; new Scheduled Tasks, manual EPG/Discovery/TMDB/Predictions/Ratings runs, retries, lease resets, flags, D1/R2 writes and other L2/L3 actions still require their independent authorization. The status itself does not start monitoring or reserve an agent. Use ordinary live readbacks and leave durable handoff when no active observer is available. Dependent cards' native prerequisite items remain unchecked until full Done, unless an independently delivered contract is explicitly enough for a separate downstream scope.
- **Exit successfully:** record the natural-run/visual verification and owner acceptance where required (or explicitly delegated technical acceptance), move to `Готово`, invoke Trello `Отметить как выполненная`, and verify both list and completed state. **Exit on failure:** capture concrete failed evidence, return to `В процессе` for fixes and independent review/new delivery, without quietly closing. Scope expansion requiring a new independent outcome gets its own card; mere waiting does not.
- **Not every card needs `Верификация`:** if all required acceptance evidence is available at delivery, proceed directly to `Готово` after the existing checks. Conversely, do not close merely because the code shipped or the elapsed clock passed a scheduled tick: verify that the run occurred and proved the stated result.

See [delivery workflow](agent-workflow.md#delivery-pipeline-for-already-approved-work) for the Controller responsibilities and safety limits.

## Rollout flag disposition and card completion

At the end of every feature-flag rollout, the owner must explicitly decide **retire now**, **retire after stabilization**, or **retain as permanent operational gate**, with dated evidence, rationale and consequences in the rollout card. For either retirement choice, the existing removal card must link the rollout/acceptance card in its **native prerequisites checklist** as a bare canonical Trello URL, and also an existing stabilization acceptance card only when it is a real, necessary upstream dependency. If no such card exists and no separate work is warranted, record bounded stabilization evidence in the removal card itself; do not invent a blocker merely to fill the checklist. Confirm and check the item only when the upstream card is genuinely Done in its accepted scope; do not leave dependencies only in the description or conversation. Permanent gates need an owner-approved security/operational justification and an explicit future review trigger. See [feature flag lifecycle](agent-workflow.md#feature-flag-lifecycle-plan-test-switch-remove).

For temporary feature-flag removal cards, Done requires not just code merge and deploy but an explicitly owner-approved removal of the retired Cloudflare binding and a readback confirming it is absent. `keep_vars: true` preserves stale variables; do not leave them as a post-closure orphan. If owner approval is pending, the cleanup card stays open. Document rollback behavior including restoration of the previous binding when reverting to code that reads it. Never infer authorization to mutate production from approval of a PR/ADR alone.

Moving a card to **«Верификация»** never marks it complete; keep the card open until the missing acceptance is demonstrated. Moving a card to **«Готово»** does **not** mark the card complete. Every final acceptance requires both the move and the Trello **«Отметить как выполненная»** operation, followed by a readback confirming the destination list **and** completed state. Do not report Done if either is missing.

## Architecture decisions and visual QA

The owner approves **new material** architecture, security or product trade-offs before implementation. An ADR recording a previously approved choice links that approval and follows normal independent review without another decision. Every Mermaid change needs actual rendered GitHub visual QA and independent semantic review; owner visual inspection applies only to explicit exceptional scope gates. See [authorization](authorization-and-escalation.md) and [documentation governance](documentation-governance.md).

## Self-contained implementation handoff

Before moving an approved card to `В процессе`, the coordinator must ensure its current description or a clearly identified handoff comment contains **the full executable scope**: inputs/contract, exclusions, acceptance, test and visual QA expectations, documentation impact, production safety, and PR evidence. Remove stale prerequisite or status claims and reconcile native checklists first. The owner should be able to tell a coding agent simply **«Приступай к AIR-N»**; no separate ChatGPT prompt may be required to implement the agreed outcome. The agent reads the entire live card, latest comments, current `main`, and AGENTS/workflow instructions. Review-fix instructions likewise belong in a linked card comment and the GitHub review, rather than only in chat. See [delivery workflow](agent-workflow.md#delivery-pipeline-for-already-approved-work).

## Example: independent preparation, then one cross-stream gate

- **AIR-43 → AIR-66 → AIR-67 → AIR-68 → AIR-69**: scored EPG resolver implementation, real shadow, parity go/no-go, on cutover, stable normal EPG generations (R2 remains authoritative).
- **AIR-49 → AIR-70 / AIR-71 / AIR-72 → AIR-73**: D1 schema, independent canonical/EPG/prediction adapters, then integrated offline importer/parity (no production migration).
- **AIR-69 + AIR-73 + all three adapters → AIR-74 → AIR-75 → AIR-76 → AIR-77 → AIR-78 → AIR-79**: live backfill, shadow writes, shadow reads, read cutover, authoritative write cutover, legacy runtime retirement, each with independent acceptance and owner approvals.

The Trello checklist is the visible progress source. The repo documentation is the policy reference; neither a checklist checkmark nor a code merge is a substitute for production verification.

## Language conventions

- **Trello:** use Russian for card descriptions, comments, delivery reports, dependency descriptions, and instructions for Cursor.
- **GitHub:** use English for PR descriptions, code reviews, inline review comments, and technical discussions. This repository is public; do not include secrets, private production data, or confidential internal information.
- **Technical identifiers:** preserve function/class names, API paths, reason codes, commit SHAs, and other identifiers verbatim, without translation.
- **ChatGPT collaboration:** communicate in Russian by default unless the user requests another language.
