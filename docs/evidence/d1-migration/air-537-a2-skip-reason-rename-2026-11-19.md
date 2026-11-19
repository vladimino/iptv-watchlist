# AIR-537 slice 4, option A2: skip reason renamed, 19 November 2026

**Trello:** [AIR-537](https://trello.com/c/wbe7jjNs). **Decision:** the owner selected **A2** on 19 November 2026 ([source](https://trello.com/c/wbe7jjNs#comment-6aff1ed67e619f77b90d8e80)); the audit is [the slice 4 ledger](air-537-scope4-standin-and-discovery-tails-2026-11-19.md). **Captured:** 19 November 2026 (UTC) on `main` `a9d02a2` (after PR #782). Code, tests and documentation; no production read or write.

## Change

The internal reason string `projector_is_writer` is renamed to `film_person_route_not_open` in the 14 `src/canonical-*.js` modules and the 3 tests that name it (37 occurrences, one line each, nothing else touched). The string was already a stale label: the enrichment projector it names was removed in slice 3, and the value is returned only when the Film/Person writer route is not `canonical`, which never happens at `d1`/`open`. The skip semantics, the states returned (`{state:'skipped'}`, `{skipped:true}`, `{executed:false}`), the write guards and the other `writerRoute` fields (`writer`, `projector`, `canonical`, `state`, `generation`) are unchanged.

## Consumer check before the edit (the owner's precondition)

| Question | Finding |
| --- | --- |
| Persisted anywhere? | No write of this value to D1 or R2 was found; it is an in-memory return field of the producer adapters, chain, store and driver. |
| Compared anywhere? | No. `src/` only emits it; the one outside consumer, `src/letterboxd-diary-identity.js`, branches on `state==='skipped'` and substitutes its own reason (`admission_skipped`). A durable Workflow step result that holds the old string therefore cannot mismatch a new build. |
| External or UI contract? | None in `public/`, `scripts/`, `migrations/` or `wrangler.jsonc`. |
| Historical text | `docs/adr/0120-...` and the earlier evidence files still contain the old string and are not rewritten. |

No persisted or external contract was found, so no compatibility stop was needed.

## Disposition (slice 4, final)

Retained with reasons, as in the audit: the five `*_DB_OPTIONAL=standin` local stand-ins, `r2Allowed`, `routeOf {open:false}`, `SKIPPED`, `routeSkipMs`, `canonicalMirrorsWritable`, the four Discovery key-name façades and the local R2 DR/DI admin recovery variants. Options B and C are not approved. `tests/projector-marker-guard.mjs` now also asserts that the old label does not return.

## Rollback

Revert the PR; the string has no stored state to restore.
