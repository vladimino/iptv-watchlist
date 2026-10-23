# IPTV Watchlist — Trello card conventions

Version: 2026-10-23. Applies to the [IPTV Watchlist Roadmap](https://trello.com/b/HODRHtcO/iptv-watchlist-roadmap).

## Why

A Trello card is one independently reviewable, closeable delivery outcome. Do not hide a multi-day epic inside a single card with numbered phases, phases with letters, or a long chain of unrelated PRs. The board, not comments or a private phase document, must show progress.

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
3. **Prerequisites / Зависимости** is a *native Trello checklist*, not a bullet list in the description. Include the linked upstream cards that must actually be Done before starting this delivery. For a cumulative migration chain, show all preceding required milestones, not only the immediately previous card; e.g. AIR-73 depends on AIR-49, AIR-70, AIR-71, AIR-72. AIR-79 includes the full approved migration sequence and the AIR-69 scored stabilization gate.
4. Use checkbox Markdown links such as `[AIR-70 — Canonical Film/Person repository](https://trello.com/c/8PRWRx2C)`. Mark checked only after independently confirming that linked card is Done **in its defined acceptance scope**. Do not assume the checkmark updates automatically when another card moves lists: reconcile after closing a card and before beginning blocked work.
5. Don't introduce false blockers: a previously delivered domain *contract* may be available even when the broader parent card is not fully closed. Make that nuance explicit in context; never label an incomplete card as completed.
6. State **Scope**, **Done / Acceptance** (objective, verifiable), **Tests / evidence**, **Production impact and rollback**. For integration PRs, link related Trello cards and current prerequisites in PR description and final report.
7. Keep historical notes as history, but don't leave an obsolete "Prerequisites" text section that contradicts the checklist. If a dependency changes, update the checklist and the card's introductory context.
8. **Production rollout is not code delivery.** A green PR/code-only Done must not be misrepresented as an enabled production feature. Put shadow experiment, go/no-go, cutover, and stabilization in separate tickets.
9. No unsanctioned flag toggles, manual sync/model/TMDB calls, live migration, destructive cleanup or source-of-truth change as a side effect of drafting, testing, or closing documentation cards.

## Example: independent preparation, then one cross-stream gate

- **AIR-43 → AIR-66 → AIR-67 → AIR-68 → AIR-69**: scored EPG resolver implementation, real shadow, parity go/no-go, on cutover, stable normal EPG generations (R2 remains authoritative).
- **AIR-49 → AIR-70 / AIR-71 / AIR-72 → AIR-73**: D1 schema, independent canonical/EPG/prediction adapters, then integrated offline importer/parity (no production migration).
- **AIR-69 + AIR-73 + all three adapters → AIR-74 → AIR-75 → AIR-76 → AIR-77 → AIR-78 → AIR-79**: live backfill, shadow writes, shadow reads, read cutover, authoritative write cutover, legacy runtime retirement, each with independent acceptance and owner approvals.

The Trello checklist is the visible progress source. The repo documentation is the policy reference; neither a checklist checkmark nor a code merge is a substitute for production verification.
