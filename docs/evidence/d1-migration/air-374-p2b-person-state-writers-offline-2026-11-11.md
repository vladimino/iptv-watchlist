# AIR-374 P2b: fenced Person-state and localization-conflict writers, offline tests

**Captured:** 2026-11-11, local runs of `node tests/canonical-person-state.mjs`, `node tests/canonical-person-state-mutation.mjs`, then the full `npm test` and `npm run build`. **Method:** a sqlite file plays D1 (migrations `0001` to `0018`, marker moved to `prepared` or `open` as each case needs), the D1 stand-in applies each write as one atomic batch, and the projector (`src/canonical-repository.js`) runs on a second copy of the same fixture; no production D1, R2, connector or network access of any kind. Authority: owner decisions 1 and 5 of 11 Nov 2026 ([AIR-374](https://trello.com/c/ha7ais3w), [ADR 0117](../../adr/0117-film-person-d1-handoff-owner-decisions.md)); the module is [`src/canonical-person-state.js`](../../../src/canonical-person-state.js), described in the [Film/Person reference](../../reference/domain/film-person.md).

This file holds counts only: no id, title or payload.

**Result:** the fenced writers produce the projector's `person_dimension`, `person_alias` and `localization_conflict` rows on ten shared fixtures (two rounds each) and never downgrade an owner or reviewed localization. It is **code evidence only**: the module is not bundled or imported by the Worker, no live write happened, and the projector remains the only canonical writer until the owner-approved `open`.

| Check | Result |
| --- | --- |
| Marker matrix | `r2`, `prepared` refuse with `film_person_not_open`, `held` with `film_person_held`, legacy is not writable; no batch, no row, no revision in any of them; `open` writes |
| Equivalence with the projector | Ten fixtures (fresh, provisional replaced, reviewed kept, owner kept against a dictionary review, owner replaced by an owner review, dictionary replaced, a review without authority, same value, a domain conflict, owner kept with a domain conflict), each written twice: identical dimension, alias and conflict rows; the second round is a replay |
| Owner or reviewed value | Survives an automatic write, repeated refreshes and a dictionary review; replaced only by an owner review; an owner review landing between the snapshot and the batch still wins in the same batch (alias and conflict recorded) |
| Conflicts outside a merge | Film and Person rows equal the projector's; a repeat is a no-op without a batch; an existing row is never rewritten; nothing clears a conflict; a redirected or missing entity, a stale revision and an empty list are refused |
| Idempotency | A replay returns the current revision with no batch and no bump; a deleted row is restored, not skipped; an unknown outcome (applied or not) is reported by `dispatch`, named `settle_by_replay` by `readback`, and the replay applies it exactly once |
| Bounds and fences | Revision conflict leaves the rows unchanged; a marker that moves before the batch fails it whole (`film_person_fence`); a Person removed before the batch is refused by the batch itself; more than the statement cap is refused before any statement |
| Untouched | The person row, external ids, credits, other aliases and Films are byte-identical after the writes |
| Static | Imported only by the producer routing module, not bundled, no R2 or network text, writes only `person_dimension`, `person_alias` and `localization_conflict` (the fenced helper writes the revision) |
| Mutation check | 32 mutants, each removing or inverting one rule (gate, fence, revision, guard, in-batch SQL guard, held-value statements, conflict id, replay), all killed; the control copy passes |

**Not proved:** that D1's multi-statement request rolls back like the stand-in's transaction; behaviour against production rows; the film-side dimension writers (P2a) and the differential harness over both writers (P6). A durable per-request receipt needs a table beyond schema 18 and an owner GO; none is added here (replay is by content).
