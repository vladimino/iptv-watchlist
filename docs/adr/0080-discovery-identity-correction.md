# ADR 0080: One owner confirmation corrects the identity of one current discovery observation

**Status:** Proposed  
**Original decision date:** 2026-11-01  
**Recorded at:** 2026-11-01  
**Approval source:** owner GO on [AIR-65](https://trello.com/c/MKb4JMXi#comment-6ae76fceb83abfea99405ecb); this record stays Proposed until the owner decides after independent review  
**Related work:** [AIR-65](https://trello.com/c/MKb4JMXi)  
**Supersedes:** None  
**Superseded by:** None

## Context

[ADR 0061](0061-discovery-observation-index-and-reconsider.md) lets the owner read one unresolved discovery observation from a generation-scoped index and, for one case, lift its terminal fence with `discovery_reconsider@1`. It left identity conflicts without a page: an ambiguous or wrong match had an explanation and no write. A title match is a hypothesis. It is not a trusted candidate, and `tmdb` and `tmdb_tv` are different identities.

The production authority for identity decisions, read at implementation, is the R2 resolution map named by the published generation pointer `epg/published-generation.json`. That pointer has no `identityAuthority` or `programmeAuthority` marker. A later published-EPG mode is a separate decision and is not permission to move discovery decisions.

## Decision

Add a second owner-only capability, `discovery_identity_correct@1`, on the existing `/admin/limbo` observation panel. It is not a reuse of `discovery_reconsider`.

1. **One key, one movie id, one effect.** `assign` records a numeric TMDB movie id as the owner-verified film of that observation. `reject` blocks that id on that decision only. The confirmation version is `decisionHash:effect:tmdbId`, so an assign confirmation cannot be executed as a reject. The acknowledgement names the observation key and the published generation. There is no wildcard, no future matching rule, no mass relink, and no edit of a historical generation.
2. **Trusted evidence is bounded.** A trusted choice is only the observation's own confirmed movie id already on the index record. The scorer's accepted id is shown as an untrusted hypothesis and is not selectable. A typed movie id is checked, on confirm and again on execute, by one read of `epg/discovered-films.json` at `tmdb_<id>`. A title alone is `title_only` and writes nothing. A year gap greater than one, a television id, a conflicting identity, a missing year, or an ambiguous decision without that confirmed id fails closed. GET does not read the catalogue, the resolution-map body or the ledger, and it calls no TMDB and no model.
3. **Authority.** A published generation whose identity and programme markers are absent or `r2` means the R2 resolution map. Any other marker, or a pointer that is not a published generation, is `unknown_authority` and writes nothing. This capability does not write D1 and does not follow a future published-EPG mode.
4. **The write.** Confirm stores an action record and changes no decision. Execute takes the resolver lease, re-reads the index, re-checks the command, stores a running intent with the before-image, and puts the resolution map by etag compare-and-swap, changing only that key. The decision digest must match the index hash. A lost lease, a lost compare-and-swap, a stale generation, changed evidence or an unknown authority writes no partial decision. A put whose read-back does not match is `unknown`: the receipt does not claim success or failure, and the same confirmation replays that receipt and does not retry. A different effect or id under the same idempotency key conflicts.
5. **What the write changes.** The receipt's consumers are the resolution decision only. Catalogue shows, search and detail follow the next ordinary resolver chunk, and only when the contract says so: an assign of a film that is already in the catalogue updates shows on the cheap pass of that chunk if the candidate is hot; an assign of a confirmed id with no catalogue object waits for that object; a reject does not update shows and does not turn similar titles into a negative rule. The chunk carries `ownerIdentity` and `rejectedTmdbIds`. It does not auto-verify a rejected confirmed id, and it does not search or fetch movie detail when the accepted id is one the owner rejected. This action does not start the chunk. Index refresh is best-effort. If it fails, the manifest still names the old etag and the list may keep the row until the next chunk.
6. **Coverage.** The index is current unresolved observations that already have a decision. `coverage.complete !== true` refuses. An index written before these fields lacks `tmdbId`, `scoring` and `identitySource` until the next chunk or this action rewrites the row. Until then a reject has nothing to reject, and an assign of a typed canonical film still works. GET does not parse the map to fill that gap.

`assessment.review.available` stays false. Identity correction is this capability, not the reconsideration gate. Group propagation and revoke stay out of this decision.

## Alternatives considered

Reusing `discovery_reconsider` for an identity change was rejected: that capability only lifts a terminal fence and must stay that. Scanning the ledger or the catalogue on GET to invent candidates was rejected: it would present a partial index as complete and would read more than the owner page is allowed to read. Treating a matching title as a trusted id was rejected: that is the failure this action exists to correct.

## Consequences

The owner can correct one live observation without a TMDB call and without starting discovery. The next chunk must honour the marker, so a rejection survives an ordinary rewrite of the uncertain fields. The action record and the decision stay after a code revert. Old index rows stay readable; the new decision fields appear when a writer rewrites the row. Confirm and execute parse the resolution map, as reconsideration already does, and an assign also parses one catalogue object. GET does not.

## Recovery and migration boundary

Accepting this record approves the architecture only. It does not authorize a production write, a discovery chunk, an EPG commit, a TMDB call, a flag, a Scheduled Task, an R2 or D1 backfill, or an authority cutover. The owner performs the one confirmation on a real observation after deploy. Restoring a before-image from `admin/actions/discovery_identity_correct/v1/` is a separate owner-approved write. A code revert stops the route; decisions and action records already written stay. Rollback steps are in the [discovery ledger runbook](../runbooks/discovery-ledger.md#one-wrong-identity).

## Evidence

- **Original decision:** [AIR-65 owner GO](https://trello.com/c/MKb4JMXi#comment-6ae76fceb83abfea99405ecb)
- **Implementation:** [PR #318](https://github.com/vladimino/iptv-watchlist/pull/318)
- **Dated verification:** not recorded; no production write is claimed
- **Uncertainty:** production still has no `identityAuthority` marker. A future marker other than absent or `r2` refuses the write until a later decision names that store.

## Follow-ups

[AIR-131](https://trello.com/c/0WtLPRnH) group propagation and [AIR-132](https://trello.com/c/3AXbSoHe) revoke start only after this outcome is accepted, and each needs its own permission. Neither is part of this write.
