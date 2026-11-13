# AIR-374 owner decision on the ten differential exceptions (13 Nov 2026)

**Capture:** 13 Nov 2026, offline. Code and test change in the registries and one new test; no production, R2, D1, Access, flag, Scheduled Task or connector access. The decision is recorded on the [AIR-374 Trello card](https://trello.com/c/ha7ais3w) (owner comment of 13 Nov 2026, 10:30 UTC, after the Executor's report of the same day and the Controller's working recommendation).

## Decision

| # | Exception (`id`) | Where it lives | Decision |
| --- | --- | --- | --- |
| 1 | `reviewed_owner_rows_protected` | `P6_DIFFERENTIAL_EXCEPTIONS` (`src/canonical-film-writers.js`) | Accepted |
| 2 | `canonical_identity_requires_trusted_tmdb` | `EXTRA_EXCEPTIONS` (`src/canonical-differential-registry.js`) | Accepted |
| 3 | `blank_never_overwrites` | `P6_DIFFERENTIAL_EXCEPTIONS` | Accepted |
| 4 | `redirected_film_refused` | `P6_DIFFERENTIAL_EXCEPTIONS` | Accepted; the calling producer must handle the refusal |
| 5 | `credits_not_pruned_by_the_planner` | `EXTRA_EXCEPTIONS` | Accepted; temporarily stale credits are tolerated |
| 6 | `external_ids_not_pruned_by_the_planner` | `EXTRA_EXCEPTIONS` | **Not accepted: mandatory FIX before the H2 marker flip.** A stale external id can corrupt identity resolution, so the producer delivery that owns the change must remove or deactivate dropped ids, with a test |
| 7 | `held_localization_not_recorded` | `EXTRA_EXCEPTIONS` | Accepted; the conflict history may be lost, a stored owner or reviewed localization must not be broken |
| 8 | `credit_ordinals_kept` | `EXTRA_EXCEPTIONS` | Accepted; a different cast order is tolerated |
| 9 | `updated_at_is_write_time` | `EXTRA_EXCEPTIONS` | Accepted |
| 10 | `noop_write_keeps_updated_at` | `EXTRA_EXCEPTIONS` | Accepted |

The two differences accepted earlier (`sync_null_clock_keeps_stored`, `identity_provenance_title_source`) are unchanged. The stated owner risk position: small differences and losses of secondary metadata do not block the cutover, and perfect parity with the projector is not required; Film/Person identity corruption, two active writers and silent loss of primary records are not acceptable.

## What changed

- `status` of the nine accepted exceptions is now `accepted` (three in `src/canonical-film-writers.js`, six in `src/canonical-differential-registry.js`, plus a comment naming the decision). `external_ids_not_pruned_by_the_planner` stays `draft`.
- New `tests/canonical-exception-decisions.mjs` pins the split (eleven accepted, one open fix, twelve named differences, unique ids) and asserts on the repository's modelled database that `handoffReadiness` names exactly `exception_not_accepted:external_ids_not_pruned_by_the_planner` and names a reopened accepted exception again. Mutants checked by hand: accepting the fix, and turning an accepted exception back into a draft, both fail the test.
- Existing tests rebased to the new accepted set: `tests/canonical-film-writers.mjs` (the accepted list of the Film writers' own exceptions) and the exception text in `tests/canonical-differential-mutation.mjs`.
- The decision pack records the decision (the exception row now reads nine accepted and one fix).

## Effect on readiness

Of the 26 blockers expected after H1, the ten `exception_not_accepted` become one. This is a registry change on the modelled state, not a live production readiness figure. Nothing else moves: the receipts and producer blockers (`receipts_protocol_unregistered`, four `producer_not_wired`) and the eleven `reader_not_moved` remain, as do the activation emitter, the verified receipt baseline, the mirror inventory and the safe-copy held drill.

## Not decided, not done

- Not an owner GO for any production mutation, natural write, migration, flag, Scheduled Task, lease reset or the `prepared` to `open` marker flip. H2 stays closed.
- The fix for #6 is not implemented here: it belongs to the producer delivery that owns the change.
- Whether any consumer reads `updated_at` as source time was not found by a search of `src`, but runtime reads were not examined.
