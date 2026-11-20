# ADR 0184: A trusted `letterboxd` claim is materialized on an existing Film only when the Ratings alias, canonical TMDB ownership and the absence of any competing claim agree

**Status:** Proposed
**Original decision date:** unknown (awaiting owner decision)
**Recorded at:** 2026-11-20
**Approval source:** not documented. The owner approved a separate card for the identity-rule change and the backfill of the currently affected Films ([AIR-559 handoff](https://trello.com/c/733sRAxu)); the **semantics below are not accepted** until the owner decides on this record. Architecture only: no production run, flag, Task, migration or data write is authorized.
**Related work:** [AIR-559](https://trello.com/c/733sRAxu), [AIR-549](https://trello.com/c/BgwRv3uw), [ADR 0166](0166-diary-rated-only-identity-bridge.md) (option B, deferred there), [ADR 0087](0087-rated-archive-film-admission.md), [ADR 0099](0099-canonical-film-person-d1-authority.md), [ADR 0133](0133-film-external-ids-producer-unit.md)
**Supersedes:** None
**Superseded by:** None

## Context

`POST /api/started` resolves its film id (a Letterboxd lid or `tmdb_<n>`) through `catalogStartedFilm`, which answers only from D1 identity claims: the typed claim must be the one owner's trusted, non-conflicting row. The only live writers of a rated Film, `admitRatedFilm` and the admission producer, write the trusted `tmdb` claim and keep the verified Letterboxd short code as the **historical alias** `letterboxd_short_code`; they never write a trusted `letterboxd` claim (ADR 0166, "Confirmed code facts", item 3, and its deferred option B).

Confirmed on 20 Nov 2026 by a read-only root-cause analysis recorded on the AIR-549 card (aggregated here, no id lists): 395 lids are published, 386 have a trusted canonical Letterboxd claim and **9 have none**, so marking one of those nine started returns `404 Unknown film` although the Film exists. For all nine the Ratings projection `ratings_view` holds the lid with `fact_key = tmdb-<n>` and the movie alias `tmdb_<n>` with the same key, and the canonical `tmdb` claim of that movie is trusted, non-conflicting and not a redirect source. The same gap will recur for any future Film whose lid reached the Ratings alias protocol but never a canonical claim.

## Decision (proposed)

1. **One narrow claim.** For an **existing** canonical Film only, the system may materialize **one** trusted, non-conflicting `letterboxd` external-id claim for a lid. It never creates a Film, alias, title, rating, membership or Started mark, and it never matches by title, year, slug or the watchlist flag.
2. **Proof, all of it, read at write time by the writer's own planner and never supplied by the caller.** (a) The Film/Person marker is `d1`/`open` and the ratings domain is `d1`/`open`, and neither generation moves during the read. (b) `ratings_view` holds the lid with `fact_key = tmdb-<n>` and the movie alias `tmdb_<n>` with the same key, and no other alias carries that key. (c) Exactly one trusted, non-conflicting canonical `tmdb` claim for `<n>` exists; its Film exists, is not a redirect source, and `<n>` is not retired by the owner's retirement ledger. (d) No other Film claims the lid in any form, no untrusted or conflicting claim of the lid or the movie exists, and the Film has no other `letterboxd` claim, no second `tmdb` claim and no untrusted or conflicting claim of either scheme.
3. **Verdicts, not repairs.** Every candidate is classified `pass`, `conflict` or `not_proved` with a typed reason; only `pass` writes. A conflict or missing provenance stops that item alone: nothing is overwritten, merged or silently repaired, and a conflict goes to the existing owner review.
4. **Writer.** The existing fenced, receipted unit `film_external_ids` ([ADR 0133](0133-film-external-ids-producer-unit.md)) in a new `addOnly` mode that never prunes, so the write is one `mutateFilm` batch carrying the marker generation, the Film revision (CAS) and the applied receipt. No new table, migration, receipt kind or SQL writer. Provenance is fixed: `{source: ratings_alias_bridge, tmdb, adr: 0184}`. A Film that already holds the lid as its one trusted claim is a no-op with no receipt and no revision; a replay with the same request id and content opens no second batch.
5. **Producer rule for the future.** The claim is requested from the existing admission paths after the Ratings alias protocol has linked the lid to the movie (the Diary bridge, the inferred-admission import and the rated-candidate step), through the same module, bounded to 12 per call. Wiring those call sites is the **activation** step and is separate from this decision's code delivery.
6. **Backfill of the current cohort** is the same module over a cohort frozen by a fresh read-only preflight (nine on 20 Nov 2026 is a baseline, not a constant). It is a production data write and needs its own owner-approved L3 plan; this ADR and the merge of its code authorize none.

Not decided: any runtime fallback from the Started route to the Ratings alias (rejected here as a second competing authority; if ever needed it is a separate owner decision before implementation), any change to `started_mark`, `GET|POST /api/started`, Events or the 404/409/410/503 semantics, and any claim for a Film created by assumption.

## Alternatives considered

- **Reader fallback through the Ratings alias.** Rejected for now: it would keep two identity authorities forever and weaken the canonical security rule of `catalogStartedFilm`; it also leaves every other canonical-claim reader (`catalogFilmIdentityBridge`, history, recovery) blind to the Film.
- **Extend `admitRatedFilm` to write the claim (ADR 0166 option B).** Changes the semantics of an accepted writer, would not repair the 708 already admitted Films, and carries the larger blast radius ADR 0166 already named.
- **Direct SQL insert for the nine.** Rejected: unfenced, no receipt, no revision CAS, no idempotency.

## Consequences

The nine affected Films become markable without any reader change, and the rule closes the same gap for later Films. A trusted `letterboxd` claim now also exists for a Film whose lid equals its `letterboxd_short_code` alias; the claim's provenance names its basis, so a wrong claim is corrected by the existing owner-review and unlink routes, not by deleting rows. The Ratings projection becomes an input to a canonical write; the proof therefore re-reads it inside the same generation window and refuses on any ambiguity. Cost: one planner pass (about eight small reads) per candidate and at most one fenced batch.

## Recovery and migration boundary

Code rollback leaves written claims in place. A claim written by mistake is corrected through the owner-review path, with its receipt and provenance as the audit trail. This ADR authorizes no flag, Task, migration, import, write or cutover; the production backfill needs a separate owner-approved L3 plan (frozen cohort, read-only preflight, writer identity, fences, stop rules, expected row changes, rollback limits, event boundaries).

## Evidence

- **Original decision:** not recorded (Proposed).
- **Implementation:** dormant module `src/canonical-letterboxd-claim.js` and its offline tests (synthetic ids only), delivered by the implementation PR of AIR-559.
- **Dated verification:** the read-only cohort analysis of 20 Nov 2026 on the AIR-549 card (aggregates only); no production write recorded.
- **Uncertainty:** whether the Ratings alias of a lid is as authoritative as a verified admission receipt for every historical lid; the nine are expected to `pass`, which only a fresh private preflight can show.

## Follow-ups

Owner decision on this record; the L3 plan and the backfill under [AIR-559](https://trello.com/c/733sRAxu); activation of the producer call sites; the owner's repeat acceptance of Started marks under [AIR-549](https://trello.com/c/BgwRv3uw).
