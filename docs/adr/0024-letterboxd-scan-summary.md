# ADR 0024: A complete Letterboxd scan is stored once as a summary observation, and film records are rewritten only when a value changes

**Status:** Accepted (owner decision 2026-10-27; it authorizes no import, R2 or D1 write, flag or Task change)  
**Original decision date:** 2026-10-27  
**Recorded at:** 2026-10-27  
**Approval source:** owner choice in the AIR-171 delivery session, 2026-10-27 ("scan summary" over unchanged per-film rewrites and over a sharded store), recorded on [AIR-171](https://trello.com/c/uvGt48sq)  
**Related work:** [AIR-171](https://trello.com/c/uvGt48sq), [ADR-0023](0023-letterboxd-user-facts.md), [Letterboxd user facts contract](../reference/integrations/letterboxd-user-facts.md)  
**Supersedes:** [ADR-0023](0023-letterboxd-user-facts.md) in part: how decision 4 applies to complete films-list and watchlist scans  
**Superseded by:** None

## Context

ADR-0023 orders every observation of a fact by (`observedAt`, source rank, observation id) and stores facts in one R2 record per film. A complete public films list shows every watched film (about 2,160 today) and the watchlist about 400. Taken literally, each daily scan is a newer observation of every listed film and must refresh each record's `observedAt` even when the value did not change; otherwise an older observation with a different value (for example an export older than the scan but newer than the record) could win later. That is up to about 4,300 R2 operations per scan inside the EPG commit (within the 10,000-subrequest default of a paid Worker, but tens of seconds longer and growing with the catalog).

## Decision

1. Each complete films-list scan and each complete watchlist is stored as **one summary object** holding its `observedAt` and what it showed per Letterboxd id, replaced only by a complete scan with a greater `observedAt`.
2. For a film linked to that Letterboxd id, the summary **is** an observation of its facts. Every merge compares an incoming observation with the greater of the record's stored value and the summary's observation, so the ordering guarantees of ADR-0023 hold without rewriting unchanged records.
3. A scan rewrites only records whose value differs from what it saw, and only for films that already have a record or are on the current watchlist; other ids remain observations in the summary until a record is created, which then starts from the summary.
4. Before a summary is replaced, films listed by the old summary and absent from the new one get the old observation written into their records when it is greater; absence is still not an observation.

Readers still read records only. The rest of ADR-0023 is unchanged.

## Alternatives considered

- **Rewrite every listed record on each scan** (ADR-0023 as written): correct but up to ~4,300 R2 operations per scan, growing with the catalog.
- **Shard the fact store into a fixed number of objects:** fewer operations, but a larger change to the accepted contract and to its convergence protocol.

## Consequences

A daily scan costs a few R2 operations plus one per changed film. Merges read one more object (the summary). The summary of the films list holds every watched Letterboxd id and rating, a private object like the rest of the bucket.

## Recovery and migration boundary

Design and its implementation behind the `LETTERBOXD_FACTS` gate (off by default); no production write until the owner enables it. Deleting the summaries loses only scan observations; records keep their values.

## Evidence

- **Original decision:** owner choice, 2026-10-27, AIR-171
- **Implementation:** AIR-171 PR (facts core and scan writers)
- **Dated verification:** not recorded; Cloudflare's documented default of 10,000 subrequests per paid invocation, read 2026-10-27
- **Uncertainty:** the real duration of a scan's record writes in production

## Follow-ups

The D1 mapping of ADR-0023 decision 7 keeps the summaries as observations when D1 becomes authoritative; that migration needs its own decision.
