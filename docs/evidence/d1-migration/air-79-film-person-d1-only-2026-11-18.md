# AIR-79 Film/Person D1-only slice (ADR 0162), 18 November 2026

**Trello:** [AIR-79](https://trello.com/c/485tlGLA). **Decision:** [ADR 0162](../../adr/0162-d1-only-authority-retire-rollback-toolchain.md). **Captured:** 18 November 2026 (UTC). Seventh and last per-domain slice of ADR 0162. Code and documentation only; no production read or write, no migration, no marker, flag, Task or Access change.

## Change

| Item | Verdict |
| --- | --- |
| `readAuthority` in `src/film-person-authority.js` | Serves only `d1` with `cutover` `open`. `held` stays the separate fail-closed gate (`film_person_held`, `open` to `held` to `open` with its SQL fences). An installed `r2` or `prepared` marker, a missing binding, a missing `schema_contract`, a contract below 13, a missing or partial set of `film_person_authority`, `film_person_cas`, `film_person_baseline` and `canonical_revision`, a contract at 13 or later with none of them, a malformed marker, baseline or fence row and any D1 error throw `film_person_unavailable` before any R2 read and before any D1 write. |
| `readMarker` (new) | The non-serving reader for `transitionAuthority`, `film_person_open_handoff` readiness and the baseline module: well-formed `r2` and `prepared` are reported, everything else is still refused. |
| Local stand-in | `FILM_PERSON_DB_OPTIONAL=standin`, in `tests/local-standins.mjs` and `scripts/local-dev.mjs` only (not `wrangler.jsonc`). It answers `legacy` only for a domain that is not installed at all; a partial install, a contract at 13 or later (13 and 24 tested) without tables, an empty or broken contract with a partial install, and every installed `r2`/`prepared` marker stay refused even with the flag. No D1, marker, baseline or fence error becomes a stand-in. |
| Unreachable arms removed | The `r2`/`prepared` D1-contradiction check and the marker re-read in the Worker's R2 catalog fallback (`src/worker.js`); the matching mutants. The `route.writer!=='canonical'` skips, the `routeSkipMs` cache and the `{open:false}` route branch of the producers are unreachable now and are listed below as retained. |
| Unchanged | The working `d1`/`open` read and write paths, baseline verification, generation, CAS and ABA fences, canonical producer writes, the compare-only projector, immutable sources and R2 mirrors, `transitionAuthority`, `projectorGuard`, migrations, SQL CHECK constraints and the production marker (`d1`/`open`, generation 2). Frozen `titles.json` and `people.json` are never a fallback. |

## Retained and deferred (needs its own approved card)

- Cutover operator tooling: `src/film-person-open-handoff.js` (MCP `film_person_open_handoff`), `scripts/film-person-connector-run.mjs`, the capture, prepared-loader and cutover-record scripts and tests. Reason: not unreachable code but offline/operator tools whose removal is a separate decision; risk: none at runtime (production is `open`).
- The enrichment projector's `legacy`/`r2`/`prepared` write arms in `src/d1-enrichment.js` and about 25 projector-family tests that rely on an `r2` marker: the projector reads the marker itself and is compare-only at `d1`/`open` ([ADR 0155](../../adr/0155-retire-enrichment-projector-cron.md)). Retiring them is a separate slice.
- Dead defensive skips in the canonical producers (`projector_is_writer` branches behind `writerRoute`), kept to avoid a mass refactor.
- From the earlier Discovery slice: the legacy R2 `discovery-ledger-install` tool stays an open AIR-79 inventory item.

## Tests

The stage cases for `legacy`, `r2` and `prepared` in about 50 test files now assert the refusal and zero R2 access and zero D1 writes; `open` and `held` assertions are unchanged. `tests/film-person-authority.mjs` carries the strict-versus-opt-in matrix (no binding, no schema, v12 without tables, partial install with an empty or broken contract, contract 13 and 24 without tables, `r2`, `prepared`, `held`, corrupted baseline and fence rows, a D1 read error, the `held` to `open` forward fix). Mutants that could no longer be killed because their guard is unreachable were removed or retargeted to the `writerRoute` call.

## Verification

Pre-PR: `npm ci`, `npm run test:all`, `npm run build`, `git diff --check` on the final checkout; the result is in the pull request. Production was not touched.
