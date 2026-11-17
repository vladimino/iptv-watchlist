# ADR 0160: A rated-only Diary Letterboxd id gets its Film bridge from a bounded same-run source check, written by the existing admission writer

**Status:** Proposed
**Original decision date:** unknown (awaiting owner decision)
**Recorded at:** 2026-11-17
**Approval source:** not documented. The [AIR-489](https://trello.com/c/yZigGAVc) card requires owner options and an owner decision before code that adds a writer, an authority, a durable document or retry semantics.
**Related work:** [AIR-489](https://trello.com/c/yZigGAVc), [AIR-475](https://trello.com/c/9OniH9d9), [AIR-499](https://trello.com/c/8ifHCioP), [ADR 0087](0087-rated-archive-film-admission.md), [ADR 0090](0090-rated-identity-redirect-proof-and-retry.md), [ADR 0099](0099-canonical-film-person-d1-authority.md), [ADR 0104](0104-inferred-letterboxd-identity.md), [RCA evidence](../evidence/letterboxd/air-489-rca-2026-11-17.md)
**Supersedes:** None
**Superseded by:** None

## Context

The routine Ratings run stores a Diary watch and rating as the fact `lb-<lid>` and the `ratings_view` row, and that part works. It does not connect the Letterboxd id (`lid`) to a TMDB movie or a canonical Film, so the Event of the run names the film `title=null` («Название недоступно») and Finds cannot exclude the film by TMDB. Two production fixtures: `vMEO` (15 Nov, 3.5) and `Aj8u` (17 Nov, 4.0). Read-only D1 preflight on 17 Nov 2026: neither id has a row in `film_external_id`, `film_alias` or `film_rated_admission`; both have a `ratings_view` row (`watched=1`). See the [RCA](../evidence/letterboxd/air-489-rca-2026-11-17.md).

Confirmed code facts on `main` `30ada9e`:

1. `LetterboxdDiary.parsePage` reads the `lid` (poster) and the film slug of the same Diary row; `ratingEvidence` drops the slug, and `LetterboxdFacts.applyDiaryEvidence` links only `letterboxd:<lid>`.
2. `labelledChanges` runs before `applyDiaryEvidence` and reads only existing catalog titles (`ratingsFilmLabels`). It cannot see a Film that does not exist yet.
3. `catalogFilmIdentityBridge(env, lid)` (AIR-475) is read-only and answers `ok` only for a **trusted `letterboxd` claim** in `film_external_id`. `admitRatedFilm` (the live fenced admission writer) writes the trusted `tmdb` claim and a `letterboxd_short_code` **alias**, never a trusted `letterboxd` claim. The unit that writes typed external ids (`film_external_ids`, ADR 0133) is dormant and not bundled. So no live writer can produce a bridge `ok` for a rated-only Film, and AIR-475 cannot reach this case by design.
4. The source check already exists as machinery: the `boxd.it/<lid>` redirect proof, `LetterboxdIdentity.pageEvidence` (shortlink, canonical path, single `data-tmdb-id` of type movie) and the TMDB movie detail agreement of ADR 0090. They live in the owner-driven archive identity step (`LetterboxdRatedCandidates.identityStep`) and need a title and year from the export, which a Diary row does not carry.

## Options for the owner

**A. Recommended: bounded same-run check, existing admission writer, Facts alias protocol, one new bounded pending document.**
In the Diary phase, after the watched/rating facts are durable, for each page lid with no `ok` bridge (at most three per step, inside the lease margin): follow `boxd.it/<lid>`, require the landing path to equal the Diary row slug, run `pageEvidence` and the existing movie-detail agreement (page title and year against TMDB, not against a guess). Only a unanimous result is `verified`. Then:
- write the immutable receipt entry (`identity: "diary_page"`, the same receipt pattern as ADR 0105) and call the existing `applyRatedAdmissionRetention`; no new canonical writer, no new SQL;
- link `tmdb:<n>` to the existing record of the lid with the existing `LetterboxdFacts.linkFilm` alias protocol (`lb-<lid>` keeps its history; a second record for the same movie stays `alias_conflict`, never merged);
- carry the label into the event before it is finalised, or, when the budget is short, leave the label honest (`unresolved`, Letterboxd link) and enrich on read.
Anything else (no slug, redirect or slug mismatch, two ids, TV id, title/year disagreement, 403/429/challenge, timeout, held or moved authority) stays `pending` with `reason`, `lastAttemptAt` and `nextAttemptAt` in one bounded document, retried only by ordinary Ratings runs (no Task, no queue, no scheduler). Consequence to accept: a new ratings-owned key (`letterboxd/diary/identity.json`) added to the D1-owned ratings key set, and a trusted `letterboxd` claim is still **not** written (the Facts alias plus the tmdb Film are the bridge; `catalogFilmIdentityBridge` stays `absent` for these Films).

**B. A also writes the trusted `letterboxd` claim.** Extend `admitRatedFilm` (or activate `film_external_ids`) to add the trusted `letterboxd` external id in the same fenced batch, so `catalogFilmIdentityBridge` returns `ok` and every AIR-475 reader works unchanged. Consequence: changes the semantics of an accepted canonical writer; the 708 existing admissions would still lack the claim (a separate, owner-gated backfill). Larger blast radius.

**C. Read-side only.** Keep the unresolved fact, add no source check, enrich labels only from an existing trusted bridge. Smallest, but it never resolves `Aj8u` or `vMEO` and does not meet the AIR-489 acceptance.

## Decision

Not taken. Recommendation: **A**, with B left as a later, separate card if a trusted `letterboxd` claim is needed by another reader. No code for A, B or C is written until the owner decides.

Invariants for any option: the rating fact and the Event never wait for the lookup; a title or year, a slug or the owner's statement is never identity proof (ADR 0104 stays export-only); no Film is admitted without a verified receipt; a conflict is never merged silently; no production writer, flag, Task, migration or manual run is authorized by this record.

## Alternatives considered

An autonomous identity worker or queue (rejected by the card: new orchestration); resolving by title and year (rejected: ADR 0087, 0104); relying on AIR-475 alone (rejected: it reads a claim no live writer creates for this case).

## Consequences

If A is accepted: one more outbound Letterboxd GET per new unresolved lid inside an ordinary Ratings step (bounded, never fatal), one bounded ratings document, and a retry rule limited to ordinary runs. Mermaid diagrams of `letterboxd-ingestion`, `film-person-lifecycle` and `persistence-and-migration` change and need rendered visual QA.

## Recovery and migration boundary

Code rollback leaves the admitted Films, the receipts, the alias links and the pending document in place. An admission or alias written by mistake is corrected by the existing unlink and owner-review routes, not by deleting rows. This ADR authorizes no operation.
