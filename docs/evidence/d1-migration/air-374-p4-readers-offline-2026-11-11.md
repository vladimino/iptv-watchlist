# AIR-374 P4: marker-gated, fail-closed Film/Person readers, first slice (offline)

**Captured:** 2026-11-11, local runs only (sqlite3-CLI D1 stand-in on the real migration chain, vm-scoped Worker bundle pieces). No production, R2, D1, Cloudflare, connector or Trello access of any kind. Authority: owner decisions 3 and 4 of 11 Nov 2026 on [AIR-374](https://trello.com/c/ha7ais3w); [ADR 0099](../../adr/0099-canonical-film-person-d1-authority.md).

**Result:** code evidence only. The module is dormant at `prepared`: responses for `legacy`, `r2` and `prepared` are byte-identical to before (asserted). It authorizes no marker move, no live probe and no production write.

## What changed

| Area | Change |
| --- | --- |
| `src/canonical-catalog-reader.js` (new, bundled) | `catalogReaderGate` (existing runtime for legacy/r2/prepared, `d1` for open, throws for held and unknown); `catalogAdmittedFilmFromD1` (retirement ledger, identity claims, redirects, `film_rated_admission`, marker generation re-read); `loadAdmissionRows` / `readAdmissions` moved here unchanged. SELECT only, no R2. |
| `src/film-admission.js`, `src/canonical-read-model.js` | Re-export the moved readers / the gate (`canonicalReaderMode`), so every existing caller and test keeps its path. Neither is bundled. |
| `src/worker.js` `catalogArchiveFallback` | At `open` it reads D1 only (no R2 receipt, no R2 retirements object); otherwise the unchanged R2 path; new D1 failure codes map to `503`. |
| `src/catalog-d1.js` (`/api/d1/*`) | GET gated by the marker: held/unknown `503 {error:"storage_unavailable",reason}`; `authoritative:true` only at `open` (status and identity views, the only ones that carry the flag). The owner-review overlay is reachable only through this route and inherits the gate; the owner-review marker is unchanged. |
| `build.mjs` | Bundles only the new reader (`scopedReplacing`). `canonical-producers`, `canonical-mutations`, `canonical-read-model`, `localization-sources`, `film-admission` stay unbundled. |

## Tests

| File | Covers |
| --- | --- |
| `tests/canonical-catalog-reader.mjs` (new) | Marker states legacy, r2, prepared, open, held, unknown (malformed row, missing companion table, failed read) x the gate, the D1 fallback reader and six `/api/d1/*` routes; no R2 handle touched; prepared byte-identical to r2; open differs only in `authoritative`; marker moves mid-read refused (also held-then-reopened); SELECT-only; static allowlist of the reader's importers (`canonical-read-model.js`, `film-admission.js`) and the unbundled list. |
| `tests/catalog-film.mjs` (extended) | Worker route at open: found, absent, conflict, retired (ledger, redirect), failed reads, moved marker; asserts neither R2 object is read at open and the receipt is still read at r2. |
| `tests/canonical-catalog-reader-mutation.mjs` (new) | 32 mutants (19 reader, 10 `/api/d1` gate, 3 worker branch) all killed; controls pass. |
| `tests/catalog-d1.mjs`, `tests/get-write-audit.mjs` | Updated loader only / unchanged and green: no new writing read. |

The assertion that nothing imports `canonical-read-model.js` is kept unchanged: the new bundled module is imported by it, not the reverse. A stricter allowlist assertion for the reader was added.

## Not proved

Not run against production or the real marker; the byte-identity is on fixtures. The film page at `open` is the reduced admission shape (title, year). The generation re-read narrows but does not eliminate a straddling race. The Mermaid diagram added to the lifecycle page has not been rendered on GitHub (reviewer QA).

## Remaining R2 readers (follow-up), classified per owner decision 4

Lines are in the current `src/worker.js`. "Verified" means read in code in this change.

| Reader | Reads | Class | Status |
| --- | --- | --- | --- |
| `worker.js` 419 (catalog film route, optional context) | `metadata.json` | Former mutable canonical mirror: freeze at open, move to D1 | Verified in code; not moved |
| `worker.js` 552 (`ratingsFilmLabels`) | `metadata.json`, `titles.json` | Same | Verified; not moved |
| `worker.js` 1621 `/api/programme`, 1638 `/api/watchlist` | `titles.json` (programme and watchlist documents are independent EPG mirrors) | `titles.json`: canonical mirror, move; `programme.json` / `watchlist.json`: NOT frozen | Verified; not moved |
| `worker.js` 619, 647-653, 1545-1548 | `metadata.json` / `titles.json` / `people.json` read and written by metadataSync and epgSync | Writers of the mirrors (producers, P3a/P3b) | Verified; not moved |
| `src/admin/read.js` 8 | `titles.json`, `people.json` | Canonical mirrors, move | Verified |
| `src/admin/limbo.js` 15 | `titles.json`, `people.json`; plus prediction queue and view index | Mirrors move; view-index prediction retention NOT frozen without exact classification | Verified (source list) |
| `src/admin/health.js` 149 | lists `titles.json`, `people.json` among reads | Mirrors, move | Verified (list only) |
| `src/enrichment.js` 1731 | `metadata.json` | Mirror | Seen by grep, not read further: not verified |
| Immutable sources/receipts, input artifacts, `view-index.json` | various | Not frozen | Not verified individually |
