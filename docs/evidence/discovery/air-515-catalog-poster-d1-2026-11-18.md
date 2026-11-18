# AIR-515 catalog poster hydration on D1: evidence

Date: 18 November 2026 (UTC). Scope: code and local tests only. No production request, TMDB call, D1 or R2 read or write was made.

- Source finding: [AIR-79 audit F-1](../d1-migration/air-79-legacy-r2-runtime-audit-2026-11-17.md): hydration wrote `epg/discovered-films.json` and the generation copy in R2 while `DiscoveryAuthority.readCatalog` reads `discovery_admission`.
- Change: `DiscoveryAuthority.applyPosters` (one fenced D1 batch), poster-preserving `ON CONFLICT` in `upsertAdmissions` and `replaceCatalog`, D1 source for the maintenance route and `GET /api/admin/posters`.
- Local proof (`tests/catalog-posters-d1.mjs`, real sqlite D1 stand-in): written, duplicate (`present`, no generation bump), superseded, identity mismatch and missing row are `changed`, bad input, wrong programme, lost lease and missing lease fail closed; a poster survives a later same-identity admission and `replaceCatalog`, a different identity never receives it; a competing writer between the TMDB answer and the write yields `already_present`; the Worker route writes no R2 catalog object, reads none, answers `503` for a held authority; admin read, Discovery read and hydration agree on the D1 value.
- Not proven: any production poster mutation, the count of R2-only posters that D1 lacks (read-only inventory not run), a GitHub render of the changed Mermaid edge label.
