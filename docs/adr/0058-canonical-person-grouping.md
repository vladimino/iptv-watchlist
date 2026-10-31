# ADR 0058: A canonical Person groups role records by source key, verified coCredit or owner decision

**Status:** Accepted  
**Original decision date:** 2026-10-31  
**Recorded at:** 2026-10-31  
**Approval source:** [explicit owner acceptance of ADR 0058 on AIR-44, 2026-10-31](https://trello.com/c/ojtZjVc9#comment-6ae531f26e757ef6c51f6fff), following [positive independent review of PR #263 HEAD 6c88ea7](https://github.com/vladimino/iptv-watchlist/pull/263#pullrequestreview-5719948598)  
**Related work:** [AIR-44](https://trello.com/c/ojtZjVc9), [AIR-286](https://trello.com/c/EswNQuv8), [AIR-126](https://trello.com/c/fTMyNpi5), [AIR-275](https://trello.com/c/4x7hH0gI)  
**Supersedes:** None  
**Superseded by:** None

## Context

A Person record is role-specific and source-specific: `person:actor/<slug>` and `person:director/<slug>` from Letterboxd, `person:tmdb_actor/<id>` and `person:tmdb_director/<id>` from TMDB. [ADR 0009](0009-canonical-film-person-identity.md) keeps these ids stable and forbids unifying them by a shared name. It leaves the canonical Person open: the lifecycle contract marks every Person `dedupe: deferred`.

Watchlist Films carried Letterboxd credits only, and catalog Films TMDB credits only, so no record of one source could be tied to a record of the other. Since AIR-286, production D1 holds TMDB credits on the watchlist Films too. The read-only review queue `GET /api/d1/persons/review` then showed 2,782 Letterboxd/TMDB pairs credited in the same role on the same Film under the same name.

Consumers that filter or group by person across the watchlist and the catalog (AIR-201) need one stable answer to "which records are one human, and why", and one that can be undone.

## Decision

A canonical human is a **derived grouping** of Person records, computed by the pure contract `src/domain/canonical-person.js` ([reference](../reference/domain/canonical-person.md)). The stored records stay as they are. Three kinds of evidence join records, and nothing else does.

1. **Same source key.** Records with one Letterboxd slug, or one TMDB person id, under different roles are one human. The source names one person page or person whatever the role.
2. **Owner decision.** An owner `same` joins two groups; an owner `different` forbids a join.
   - For one pair, the later decision wins; at an equal time, `different` wins, and between entries of one verdict an explicit decision wins over a role link, then the smaller basis text.
   - AIR-126 role links are owner `same` decisions.
   - The owner cannot split one source key.
3. **Verified coCredit.** A Letterboxd group and a TMDB group join when both hold:
   - on at least one Film with exactly one trusted, non-conflicting TMDB movie or TV identity, a record of each is credited in the same role under the same accepted name (folded) and is the only record of its source credited there under that name;
   - each group has such evidence with that one other group only.

Everything else with evidence or a shared name is a **review candidate**, never a link. That covers:
- ambiguous evidence;
- a join that would hold two keys of one source;
- an owner refusal;
- a name shared without a verified Film;
- namesakes within one source.

The human id is derived from the strongest key: `human:letterboxd:<slug>`, else `human:tmdb:<id>`, else `human:record:<…>`. The ids the other member keys would have alone are kept as `formerIds`.

A record id supplied twice with different contents is left out, with its credits and decisions, and reported. The grouping never depends on input order.

Names follow reviewed precedence across members: owner review, then reviewed (dictionary), then provisional. Differing names of one rank are kept as conflicts.

**Not decided here:**
- where canonical humans or owner decisions are stored (R2 sidecar or a D1 table);
- any runtime reader or writer, route or UI;
- fetching credits for Films that lack them.

Each of these is separate, gated work.

## Alternatives considered

- **Keep the read-only SQL review queue as the only answer.** It lists pairs per role and compares names with ASCII-only `lower()`. It gives no grouping across roles, no collision guard and no owner override. It stays as a review view.
- **Join on a shared name alone.** Rejected by ADR 0009: namesakes on a remake and its original, and common names, would merge different people.
- **Merge records in storage (rewrite ids, redirects).** Rejected for now. A wrong merge could only be undone by restoring data, while a derived grouping is undone by one owner decision.

## Consequences

- One deterministic, explainable answer per record: each link carries its basis and evidence (Films, roles, names, decision).
- On production D1 of 30 October 2026 the contract:
  - joins every pair of the SQL queue;
  - joins 70 further humans, whose names differ only in case, `ё`, punctuation or diacritics;
  - finds no ambiguous or conflicting evidence ([evidence](../evidence/film-person/air-44-canonical-person-2026-10-30.md)).
- A human id can change when a stronger key joins; `formerIds` keeps the earlier id resolvable.
- Evidence needs both credit sources on one Film. Films without TMDB credits in D1 give none until a separately approved credits step adds them.

## Recovery and migration boundary

The contract is pure and loaded by nothing at runtime, so this ADR changes no data and no behaviour. An owner `different` undoes any automatic join. Persisting humans or decisions, or reading them in the Worker, needs its own card and owner approval. An ADR never authorizes an operation.

## Evidence

- **Original decision:** [AIR-44](https://trello.com/c/ojtZjVc9)
- **Implementation:** the AIR-44 pull request (`src/domain/canonical-person.js`, `tests/canonical-person.mjs`)
- **Dated verification:** [canonical Person on production D1, 2026-10-30](../evidence/film-person/air-44-canonical-person-2026-10-30.md), read-only, aggregates only
- **Uncertainty:** the 70 humans joined only through folding were checked by sample, not one by one. Owner decisions have no store yet, so the owner paths are verified on synthetic data only.

## Follow-ups

- The consumer reference over this grouping, without a Worker read or stored humans, is [ADR 0059](0059-person-identity-projection.md). Storing humans and owner decisions remains a separate card.
- TMDB credits for watchlist Films added after AIR-286.
