# AIR-79 metadata cache D1-only slice (ADR 0162), 18 November 2026

**Trello:** [AIR-79](https://trello.com/c/485tlGLA). **Decision:** [ADR 0162](../../adr/0162-d1-only-authority-retire-rollback-toolchain.md). **Captured:** 18 November 2026 (UTC). Second per-domain slice of ADR 0162, after [owner reviews](air-79-owner-reviews-d1-only-2026-11-18.md). No production read or write was made for it; the production marker was read on 17 November ([marker read](air-79-d2-closeout-and-d1-preparation-2026-11-17.md#production-markers-read-on-17-november): metadata cache `mode` `d1`, cache generation 43, mirror generation 43).

## Change

| Item | Verdict |
| --- | --- |
| `importMetadataCache`, `activateMetadataCache`, `revertMetadataCache`, their helpers `fencedMirror` and `prove`, and `scripts/metadata-cache-authority.mjs` | Removed |
| `--load` and `--activate` of `scripts/metadata-cache-production.mjs` | Refused with `retired` before any request, like `--revert`; the read-only status, the schema `--apply` and the production constants and helpers that other operator scripts import are retained |
| The mode-`r2` save (claim `cache_generation`, then an unconditional put of `metadata.json`) | Removed |
| `readAuthority` | A marker in any mode other than `d1` fails closed with `metadata_cache_unavailable`. A missing binding, a missing `schema_contract` or a contract below version 6 now fails closed too, unless the new explicit stand-in `METADATA_CACHE_DB_OPTIONAL=standin` is set (before, all three silently returned `mode: r2` and the working set was `metadata.json`: the silent fallback named in the D-1 decision brief) |
| `loadMetadataWorkingSet`, `saveMetadataWorkingSet` | Read the authority from the whole `env`; the stand-in keeps `metadata.json` as the working set |
| `useAuthoritativeMetadata` (projector, schema 6 or later) | A marker that is not `d1` throws, and the run fails with `metadata_cache_unavailable` instead of reading R2 |
| The fenced `d1` commit, the generation compare-and-swap, the mirror publication and read repair, the bound-parameter limit | Retained |
| `scripts/local-dev.mjs` | Sets `METADATA_CACHE_DB_OPTIONAL=standin`, next to the published-EPG and owner-review stand-ins; `wrangler.jsonc` and `src/worker.js` do not |

## Tests

`tests/metadata-cache.mjs` sets the marker to `d1` directly and stores records through `commitMetadataCache` (the same column mapping the import used). It proves the refusals (schema v5, a missing binding, a marker in mode `r2`, also with the stand-in set, a refused save writing nothing to R2), the stand-in path, the projector refusal for a marker in mode `r2`, and keeps the `d1` commit, mirror repair, race and bound-parameter cases. Its operator-script section and the revert and activation-race sections are removed with the code. `tests/metadata-cache-production.mjs` proves `--load`, `--activate` and `--revert` are refused with `retired` before any request. Fixtures that relied on the silent fallback opt in to the stand-in (the ratings harness, EPG commit and publication tests, MCP sync, `tmdb-tv-runtime`, the metadata-sync producer test) or put the marker at `d1` (full-chain projector fixtures, `prediction-domain`, `published-epg`, `owner-review-d1`).

## Verification

Local, after a fresh `npm ci`: `npm run test:all` on the final checkout, `npm run build`, `git diff --check`; the result and the rendered QA of the changed edge label in `docs/architecture/persistence-and-migration.md` are in the pull request.
