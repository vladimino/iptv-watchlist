# Targeted recovery of one discovery observation: bounded NO-GO for execution, 31 October 2026

[AIR-282](https://trello.com/c/YpCzctKo) · offline code reading and tests. Prerequisites: [AIR-279](https://trello.com/c/uM2rACiO) (limbo inventory) and [AIR-280](https://trello.com/c/ijIEPgm1) (guarded owner action contract).

**Captured at:** 2026-10-31 UTC, against `main` `bbb9efe3`. Line numbers below refer to that commit.

**Sources:** `src/discovery.js`, `src/sources.js`, `src/admin/limbo.js`, `src/domain/data-health.js`, `src/domain/admin-actions.js`; object sizes from the dated [EPG Diary memory evidence](epg-diary-oom-profile-2026-10-30.md) and the [AIR-222 stage 1 evidence](discovery-ledger-split-air-222-stage-1-2026-10-28.md). No new production read.

**Evidence lifecycle:** dated code analysis. **Operational authority:** none. No R2 or D1 write, deployment, flag, Task, Access change, discovery chunk, TMDB request or lease change.

**Later decision:** after this analysis the owner widened the scope. The obstacles below are addressed by a generation-scoped observation index and one guarded action, proposed in [ADR 0061](../adr/0061-discovery-observation-index-and-reconsider.md). The NO-GO stands for the code it describes; the current contracts are in the [admin API](../reference/api/admin.md#discovery-observation-recovery-get-apiadmindiscovery-recovery) and the [recovery assessment](../reference/domain/discovery-recovery.md).

## Question

Can the owner retry or reconsider **one** stalled or failed discovery observation (one EPG candidate key) without rerunning discovery, resetting a lease, bypassing a backoff or calling TMDB outside an approved action, and with the preview, confirmation, CAS, idempotency and receipt the [guarded action contract](../reference/api/admin-actions.md) requires?

## Findings

### 1. There is no bounded per-observation read

- **The candidate exists in one place only:** inside the published generation's discovery ledger `epg/generations/<run>/discovery-latest.json`. That object was 36,072,532 bytes on 30 October with 19,821 active candidates after the AIR-222 split. Its activity window (`seenInLatestSnapshot`, `shows`, `lastSeenAt`) and its evidence key (title, year, durations, shows) decide whether the resolver will look the observation up at all (`candidateActivity`, `candidateEvidence`, `src/discovery.js:12–19`).
- **The decision exists in one place only:** in `epg/discovery-resolution.json`, one map of every observation key (1,552,986 bytes on 30 October).
- **The admin reads exclude both by design:** `GET /api/admin/*`, `/api/admin/health` and `/api/admin/limbo` never read the ledger, the resolution map, the lease or the continuation. The limbo inventory reports observations as `available: false`, `reason: no_bounded_projection` (`src/admin/limbo.js`).
- **Consequence:** a preview of one observation needs either a new bounded projection, written by the discovery writer, or a GET that parses the ledger. Parsing the ledger is the allocation that ended production requests with `exceededMemory` ([memory pressure](epg-memory-pressure-2026-10-27.md), [Diary profile](epg-diary-oom-profile-2026-10-30.md)), so it is excluded.

### 2. The decisions have no per-record version and are rewritten whole

- **Read once, written whole:** a chunk loads the whole decision map once (`src/discovery.js:409`). It then writes the whole object back with an unconditional `saveJSON`: after the cheap pass (`:421`) and after every looked-up candidate (`:463`).
- **No conditional write:** there is no etag precondition on these writes and no version on a record. The only fence is the resolver lease, renewed before each write (`fence`, `:407`; `renewDiscoveryLease`, `:212–217`).
- **Lost update without the lease:** a writer of one decision that does not hold the resolver lease is lost under a running chunk. The chunk overwrites it with its in-memory copy, or the writer overwrites the chunk's decisions.
- **What a safe writer would need:** it must hold the resolver lease for its whole read-modify-write, which makes every chunk answer `busy` / `wait` meanwhile, as the poster maintenance route does (`catalogPosterGuard`, `:278–284`). It would also add an object-level compare-and-swap on the map's etag plus a record hash as the record version the action contract asks for. That is feasible, but it is a **new writer of the resolution ledger**: a new write surface that needs its own ADR and owner gate.

### 3. The only resolver entry point is series-level and cannot target a key

- **The route:** `POST /api/enrichment/discovery/resolve` takes `{limit 1–24, chunks}` and nothing else (`resolveDiscoveryRequest`, `:826–840`).
- **Order:** it runs one chunk over `pending`, every actionable candidate sorted by hot, has-year, last airing and key (`:424–425`).
- **Cost:** up to 16 TMDB calls and 22 seconds.
- **Fences:** `force` still honours a live lease, `chunk_budget` and a backoff (`hardWait`, `:778–780`).
- **Conclusion:** using it as a "retry this observation" would run a whole chunk over other observations, with TMDB calls. That is exactly the bypass the card forbids.

### 4. When a retry of one observation would change anything

From `resolutionActionability` (`:20–32`), `recordUncertain` (`:34–37`) and `recordNeedsVerification` (`:174–177`):

| Observation state | What the pipeline already does | Would a targeted retry help? |
| --- | --- | --- |
| Verified decision | Nothing to do | No |
| Screened as non-film | Not looked up while the screening holds | No |
| Not in the current EPG window (`historical`, `expired`) | Not looked up; a new airing makes it current again | No: there is nothing to match against |
| No decision, retry due, or new evidence | Looked up by the next chunk in priority order | Only sooner, by jumping the global order |
| Retry time in the future, same evidence | Backoff of 1, 2, 4, 7 days, then terminal | No: the backoff is policy; bypassing it is forbidden |
| `ambiguous` | Re-scored automatically after each backoff | Unlikely: the same competing candidates come back; it needs identity review |
| Terminal (`repeated_uncertain_match`, `awaiting_confirmation`) on unchanged evidence | Never retried, after 5 attempts over at least 14 days | Unlikely: the same search on the same evidence; only a change in TMDB data could differ. A new airing resets the attempt series on its own |
| Series waiting (TMDB throttling, budget, error delay) or a live resolver lease | Resumes after the gate or the lease expiry | No: the wait and the lease are fences a retry must respect too |
| Series stopped (`interrupted`, `complete`, `programme_changed`, `idle`, budget spent) | Resumes at the next EPG commit | Only by a series-level action, not a single-item one |
| Series stopped for `missing_secret` | Stops again on every new generation | No: owner configuration, not a retry or a new generation, clears it |

So every state in which a retry could change the outcome is already retried by the normal cycle. The only gain of a targeted retry would be ordering. The remaining states are held back for a reason that a retry must not bypass (backoff, series fences) or cannot change (unchanged evidence, ambiguity, no airing).

## Verdict

**NO-GO for an execute path under AIR-282.** Three facts together rule out a safe targeted writer inside this card:

- there is no bounded source for the preview (finding 1);
- a writer needs a new fenced write surface on the resolution ledger (finding 2);
- the existing route cannot target a key (finding 3).

Finding 4 shows that the value of such a writer would be limited to ordering, plus a reconsideration of terminal observations.

**What ships instead:** the pure assessment [`src/domain/discovery-recovery.js`](../../src/domain/discovery-recovery.js) ([contract](../reference/domain/discovery-recovery.md)). For one observation it gives:

- the verdict;
- whether a retry would help;
- what the pipeline will do next and when;
- whether identity review is the right path;
- `execute.available: false` with `reason: no_targeted_writer`.

It mirrors the resolver's own rules. `tests/discovery-recovery.mjs` runs it and the resolver on the same generated inputs, more than a thousand pairs including the window boundaries. No route, capability or Worker bundle loads it.

## Proposed separate execution scope (owner approval required, one card each)

1. **Bounded observation projection.** A generation-scoped object written by the discovery writer at its checkpoint, holding only the current unresolved observations. It carries the assessment's input fields: key, generation, activity facts, evidence fields, the screening result and the decision subset. This is a writer change: a new ADR, plus updates to the [discovery and resolution](../architecture/discovery-and-resolution.md) and [persistence](../architecture/persistence-and-migration.md) diagrams with the owner's visual approval. Its size is bounded by the current unresolved count, and it is written by the commit and the chunk, which already hold the ledger.
2. **Read-only per-observation view.** `/admin/limbo` `kind=observation` over that projection, plus the lease and the continuation (two small objects). It runs this assessment, with Russian presentation copy and desktop/mobile visual QA. No write.
3. **Optional reconsideration capability, only if the view shows a real need.** A `discovery_reconsider` capability for one observation whose verdict is `no_more_evidence`:
   - **What it does:** it resets that decision's attempt series so the next ordinary chunk looks the observation up.
   - **What it does not do:** no TMDB call inside the action, never for a backoff (policy) or an ambiguity (review).
   - **Fences:** it runs under the resolver lease, with a compare-and-swap on the resolution map's etag plus the record hash.
   - **Contract:** the preview, confirmation, receipt and idempotency of the [guarded action contract](../reference/api/admin-actions.md).
   - **Gates:** its own ADR, the owner's architecture approval and a separate production GO.

Ambiguous and terminal identities go to identity review: [AIR-127](https://trello.com/c/KmHRAigl) (evidence) and [AIR-65](https://trello.com/c/MKb4JMXi) (review). They are not retried.

## Card test list, as covered

| Situation | Covered by |
| --- | --- |
| Live lease | `live_writer`, waits for the lease expiry |
| Orphan | `recovering` / `orphan_resume`, agreeing with `continuationHealth` |
| Expired lease, ambiguous ownership | Expired lease of another hop over a once-interrupted record: `interrupted`, `series_level` |
| Generation change | `stale_generation` for a projection of another generation; `recovering` / `generation_handoff` for a checkpoint of another generation |
| Throttling | Series `waiting` / `backoff` until the stored gate |
| Identity conflict | `identity_conflict`; review suggested, retry `unlikely` |
| Repeat submit | No submission exists. A repeated assessment over deep-frozen inputs returns the same answer and changes nothing |
| Injected partial failure | No writer exists. Malformed or missing parts fail closed to `unknown` or `partial` evidence |
| No writes on read | The module has no I/O; the test forbids storage, network and clock access in its source and asserts that nothing loads it |

## Limits

- This is a code analysis of one commit. The object sizes are earlier dated measurements, not re-read.
- The parity test covers the pure rules and the order of the series decision. The I/O ordering of `advanceDiscovery` stays covered by its existing tests.
- The production count of observations in each state is unknown: the projection of step 1 would make it observable.
