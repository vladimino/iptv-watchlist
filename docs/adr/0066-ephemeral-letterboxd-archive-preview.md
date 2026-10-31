# ADR 0066: The owner's Letterboxd archive is previewed by an ephemeral, read-only Worker request, never stored

**Status:** Proposed  
**Original decision date:** 2026-10-31 (topology chosen by the owner; this record and its diagram await owner acceptance)  
**Recorded at:** 2026-10-31  
**Approval source:** [Owner's topology choice on AIR-284](https://trello.com/c/Y9udReUR#comment-6ae5940b46cb2cd2f175c28f): server-side ephemeral processing in the Worker behind the existing owner-only Cloudflare Access; client-local parsing rejected. Acceptance of this record and visual approval of the changed Mermaid diagram are pending.  
**Related work:** [AIR-284](https://trello.com/c/Y9udReUR) (this preview); [AIR-285](https://trello.com/c/FFMUP4qm) (the later, separately approved apply step); [AIR-277](https://trello.com/c/H8OhqtXa), [AIR-278](https://trello.com/c/OES5oHbm) (data health); [ADR 0004](0004-mcp-access-boundary.md); [ADR 0023](0023-letterboxd-user-facts.md); [ADR 0024](0024-letterboxd-scan-summary.md); [ADR 0053](0053-permanent-letterboxd-baseline-import-route.md); [feasibility evidence](../evidence/letterboxd/air-284-archive-preview-feasibility-2026-10-31.md)  
**Supersedes:** None  
**Superseded by:** None

## Context

- **The baseline import is a CLI with a service token.** `scripts/letterboxd-baseline-import.mjs` reads the export ZIP offline (`src/letterboxd-zip.js`, Node `Buffer` and `zlib`), plans against a separately exported, fenced R2 snapshot, and calls the permanent baseline route with a Cloudflare Access service token ([ADR 0053](0053-permanent-letterboxd-baseline-import-route.md)). The owner cannot see from the admin page whether an archive is fresh, complete or what it would change.
- **The baseline has no bounded summary.** The import leaves per-chunk receipts under `letterboxd/imports/<sha256>/chunks/`; no object names the latest confirmed baseline. Finding it would list the bucket, so data health reports `letterboxd_archive` as `unknown`.
- **The archive is private.** It carries every rating, the diary and the watchlist. It must not land in R2, D1, KV, a cache, a log, analytics or GitHub.
- **The Worker is bounded.** One isolate has 128 MB; the deployed `cpu_ms` limit is 120,000. The production programme (about 2.2 MB), `metadata.json` (about 1.2 MB) and the link index (about 420 imported films) are the inputs of the existing matcher; the catalog copy and the view index are several megabytes each.

## Decision

1. **Topology.** The owner's browser sends the archive as `multipart/form-data` in one same-origin `POST /api/admin/letterboxd-archive/preview` from `/admin/letterboxd`, behind the existing Access application, with no second login and no token in the page. The Worker reads the body, the ZIP, the CSV rows and the answer in memory within that request; nothing is written to any store, `waitUntil` is not used, nothing is logged, and the response is `Cache-Control: no-store`. A foreign `Origin` is refused before the body is read. Opening the page sends nothing; only the owner's click does. The page keeps the answer in tab memory and drops it on «Очистить» or `pagehide`; nothing goes to `localStorage`.
2. **A Worker-native ZIP reader with hard limits.** `src/domain/letterboxd-archive-zip.js` uses only `DataView`, `DecompressionStream('deflate-raw')` and `crypto.subtle`. It refuses before inflating anything when the archive, its central directory or an entry header is outside the limits; it counts bytes while it inflates, so a lying size or a bomb stops the read. Only the four top-level CSV files are inflated. Limits: archive 10 MiB, 2,000 entries, 255-byte names, 4 MiB per CSV, 8 MiB in total, ratio 100, 10,000 rows per CSV, 20 s wall. ZIP64, multi-disk, encryption, methods other than stored and deflate, unsafe or duplicate names, overlapping or truncated entries and bad checksums are refused. Its output is byte-for-byte the offline reader's on the same archive.
3. **The offline semantics, bundled.** The CSV parser (`src/letterboxd-export.js`) and the matcher (`src/letterboxd-match.js`) are bundled into the Worker unchanged. What an import would do to each fact is computed with the baseline import's own functions (`observation`, `applyObservation`, `summaryObservations`, `plannedKey` of `LetterboxdFacts`) on a copy of the record, with the same floors and observation ids as a commit.
4. **Read-only, bounded R2 access.** The route's bucket wrapper has `get` and nothing else. It reads single named keys: the published pointer and programme, `metadata.json`, the ratings pointer and its generation, the link index, the films-list and watchlist summaries, and this archive's own chunk 0 intent and receipt. It reads fact records only for films the link index already knows (a record without an alias in the index does not exist), at most 300, six at a time, with one redirect hop. The catalog copy and the view index are not read; the answer names what that omits. The pointer, metadata, ratings pointer, links and summaries are re-read at the end, and a changed ETag marks the answer `drift`.
5. **The answer is a proposal, bounded.** `{schemaVersion, mode: "preview", writes: false, status, archive, completeness, export, baseline, freshness, matching, proposal, consistency, details, reads}`: the archive's SHA-256, size and export time (from the Letterboxd file name, or declared by the owner for a renamed archive, never both); per-file counts, invalid rows, duplicates and conflicts; match statuses and methods; per-fact `new`, `replaces`, `unchanged`, `older`, `tie` and `unverified`; and at most 25 rows per detail list (adds, updates, held newer, unverified, conflicts, identity, invalid rows). «Нужен свежий архив» is shown when the export is older than the data health threshold (60 days) or R2 holds a newer rating than the archive for some film.
6. **The baseline stays `unknown`.** The answer says whether **this** archive's receipt exists (`committed`, `opened` or `absent`); it never infers the latest confirmed baseline from receipts, listings or the clock.
7. **One preview per isolate.** A worst-case preview needs about half of the isolate's heap, so a second concurrent request on the same isolate answers 429 `preview_busy`. The slot is a start time and is taken over after 60 s, because a request the runtime cancels never reaches `finally`.
8. **No apply here.** The page has no import, commit or validate button. Applying a previewed archive is [AIR-285](https://trello.com/c/FFMUP4qm), under its own approval.

Not decided here: how the apply step reaches the baseline route; a bounded baseline-summary object that would let data health and this preview know the confirmed baseline (it needs its own writer, ADR and owner gate); reading the catalog copy for title-year matching.

## Alternatives considered

- **(A) Parse in the browser, send nothing.** The coordinator's first recommendation on 2026-10-30. Rejected by the owner on 2026-10-31 in favour of server-side processing. Its trade-off: the comparison needs R2 facts the browser would have to download in bulk (programme, metadata, links, records), the matcher and merge rules would run in a second runtime, and the page would need far wider read routes than one bounded POST.
- **(B) Upload, store, process later.** A staged object or queue would put the private archive in R2 or another store, need retention and deletion, and create a write surface. Rejected.
- **(C) Read the catalog copy and the view index too.** More `title_year` candidates and rating evidence, at several megabytes per request and with no change to what an import accepts. Rejected for this preview; the answer names the omission.
- **(D) Add a baseline-summary projection now.** Would make `baseline` known, but it is a new production writer. Deferred to its own card and owner gate.

## Consequences

- The owner can check an archive from the browser, without a service token, and see what an import would do, without any write.
- The Worker now carries the export parser and matcher; their semantics are shared with the offline tools, and tests pin the equivalence.
- A preview costs about 19 single-key reads (the admin snapshot's five, up to eight inputs, six fence re-reads) plus at most 300 fact records, each with at most one redirect hop. In workerd it takes under a second of CPU and peaks at about 58 MB of heap for the worst accepted archive ([evidence](../evidence/letterboxd/air-284-archive-preview-feasibility-2026-10-31.md)); the per-isolate slot keeps two of them apart.
- An account with more than 300 linked films gets `unverified` for the rest; more than 10,000 rows per file is refused.

## Recovery and migration boundary

- The route and the page write nothing, so a code revert is the whole rollback; no data, flag, Access policy or Task changes.
- This record authorizes no upload of a real archive by an agent, no snapshot export, no baseline `validate`, `commit` or `rollback`, and no R2, D1, flag, Access or Task change.

## Evidence

- **Original decision:** [owner choice on AIR-284](https://trello.com/c/Y9udReUR#comment-6ae5940b46cb2cd2f175c28f).
- **Implementation:** the AIR-284 pull request (route, reader, preview, page and tests).
- **Dated verification:** [workerd feasibility probe, 2026-10-31](../evidence/letterboxd/air-284-archive-preview-feasibility-2026-10-31.md), synthetic data only.
- **Uncertainty:** the probe ran in local workerd, not on the production edge; heap was sampled sparsely during synchronous work; Cloudflare's request body limit for the plan in use was not measured (the route refuses above 10 MiB plus form overhead).

## Follow-ups

[AIR-285](https://trello.com/c/FFMUP4qm) (apply step); a bounded baseline-summary projection, if the owner wants `baseline` known, as its own card and ADR.
