# ADR 0087: A confirmed rated archive registers the short code, and only a verified movie admits the Film

**Status:** Proposed
**Original decision date:** 2026-11-04
**Recorded at:** 2026-11-04
**Approval source:** not accepted. The offline delivery comments on [AIR-340](https://trello.com/c/zWxj3laC#comment-6aeb2fb8) and the [AIR-185 supplement](https://trello.com/c/zWxj3laC#comment-6aeb3174) authorize code, docs and synthetic tests only. They are not an acceptance of this record.
**Related work:** [AIR-340](https://trello.com/c/zWxj3laC). Ratings reads follow [ADR 0084](0084-d1-authoritative-ratings.md). Watchlist admission stays [ADR 0086](0086-durable-watchlist-film-retention.md). [AIR-185](https://trello.com/c/PKvrDGKZ) is rejected and is not resumed. [AIR-320](https://trello.com/c/4cA5GlJn) and [AIR-321](https://trello.com/c/KHJM2gnK) are not prerequisites for this offline delivery.
**Supersedes:** None
**Superseded by:** None

## Context

The ZIP preview compares only films the matcher marks `accepted`, then a confirmed apply writes those films through the existing baseline commit. A rated film that is absent from the watchlist and from the canonical catalog is not `accepted`. The previous preview counted it and the commit dropped it. ADR 0086 keeps a Film by a watchlist boolean on the view index. A rated-only film has no such fact. Inferring `watchlist: false` or `watchlist: true` would invent membership.

Authoritative ratings already follow the ratings marker. While that marker is `d1` and cutover is `open`, readers and writers use D1 and do not fall back to R2. The archive comparison was still reading `letterboxd/facts/links.json`, the scan summaries and the fact records with `env.BUCKET.get`, so an older R2 fact could win over the D1 fact.

The 27 October 2026 export reconciliation reported 561 candidates, 1 ambiguous and 1,478 unmatched (2,040). That figure is a snapshot of one private ledger. It is not the queue of a new ZIP. Unverified titles, old provisionals and a halted network checkpoint are not accepted identities. Watched rows with no rating are not a Film source.

## Decision

1. **Fact comparison uses the ratings read contract.** A mutable ratings key is read through `RatingsD1.readOwned` when the marker is open. A missing D1 document is `object_missing` and is not filled from R2. A marker that is not open, including `d1` with cutover `held`, stays on R2. An unreadable marker, including partial tables, is unavailable (`ratings_domain_unavailable`) and is not filled from R2. The open generation is part of the consistency fence (`ratings_domain_generation`). Newer-wins, the receipt and rollback stay on the existing fact writer. Import receipts, the ZIP and the candidate document stay in R2.
2. **A confirmed rated row that is not accepted is a candidate, not a Film.** After the owner confirms that chunk, the short `boxd.it` code and the archive SHA-256 are stored on `letterboxd/imports/<sha256>/rated-candidates.json`. The code is the candidate key. It is not a Letterboxd lid and it is not written as `links.letterboxd`. No `watchlist` field is written. Pending and needs-review rows are chunks of 50 after the fact chunks. Their pin is `archive-` plus the archive SHA-256. The commit creates `letterboxd/imports/<sha256>/chunks/<n>.candidates.json` and does not call the baseline fact commit. A replay of the same hash does not register the code again. A newer stored `observedAt` is kept. Rollback of that receipt removes codes that are still pending or needs-review and keeps a verified code.
3. **Identity is one explicit request, after the candidate is stored.** `POST /api/admin/letterboxd-archive/identity-step` with `{archiveSha256, accepted: true}` fetches one pending code. It reuses `letterboxd-identity.js` page evidence and then the TMDB movie document. A TV id, a title or year alone, an ambiguous alias, and a stored historical TMDB id that disagrees with the page stay needs-review and write no Film. HTTP 403, 429 and a challenge are stored on the checkpoint and the next request fetches nothing until `resume: true`. A missing TMDB read token stops as `tmdb_unavailable` and writes no admission. Preview does not fetch and does not call this route. Nothing in the Worker cron calls it.
4. **A verified movie enters the existing Film read through one admissions object.** The object is `letterboxd/admissions/verified-films.json`, schema version 1, films keyed `tmdb_<n>`, with no `watchlist` field. The existing lifecycle reader and the existing enrichment projector read it. A missing object admits nobody. The same verified movie id already on a programme film stays one Film. The rating is written by the existing `linkTmdbOnly` path: watched and rating only, no Letterboxd link and no watchlist fact. A real EPG airing of that same movie id joins the show to that Film. This delivery writes no synthetic showing.
5. **Historical ledgers are evidence, not the queue.** A remembered count, including 2,040, is ignored. Eligibility is the confirmed archive plus the current Film match and the authoritative rating. A conflicting historical alias stays needs-review.

What this decision does **not** do: it does not authorize a production ZIP commit, a live Letterboxd or TMDB call, an R2 or D1 write, a scheduler, a flag, Access, or a migration. It does not add a second Film authority. It does not pull watched-only rows into the catalog. It does not resume the rejected AIR-185 resolver. It does not change Finds eligibility. Accepting this record would still not authorize those operations.

## Alternatives considered

Treating the October ledger as the current queue was rejected because a new ZIP has its own rows and the stored facts may be newer. Inferring a watchlist boolean for a rated-only film was rejected because membership and a rating are different facts. A separate network mass resolver was rejected with AIR-185. The discovery detail gate was not reused: it requires a programme pin and a duration, and this identity check is a movie document plus title and year.

## Consequences

Preview stays read-only. The page names three groups before any write: films already matched, new candidates, and errors or ambiguity. It does not call an unverified network identity confirmed. After a candidate commit, one button checks one identity. A verified film can appear in the lifecycle view once the admissions object exists. Until that object exists, the projector admits nobody from this path, so deploying this code does not upsert a rated-only Film.

`D1_ENRICHMENT_WRITE` is already `on`. The cron still runs only the existing enrichment projector. After a later identity step has written the admissions object, that same cron would upsert the verified movie. That upsert is not authorized by this delivery or by a merge. It needs a separate explicit owner approval before anyone treats the identity step as allowed to run in production.

An open ratings marker makes the archive comparison ignore an R2 fact. A held marker still reads R2. A broken marker refuses the comparison instead of trusting R2.

## Recovery and migration boundary

This record authorizes no production write. Code rollback stops later identity steps from running and stops later projector reads of the admissions object. It does not delete a Film row, a fact, a candidate document or an admissions object already written. Candidate rollback removes only codes that are still pending or needs-review. A verified movie and its rating stay until their own rollback. A newer rating is not overwritten by an older archive.

## Evidence

- **Original decision:** not accepted. Offline scope is the two comments on [AIR-340](https://trello.com/c/zWxj3laC) dated 2026-11-04.
- **Implementation:** the ratings-backed archive read, the candidate chunk, the one-film identity step, the admissions object, and the reader and projector reads of a missing or present object.
- **Dated verification:** [synthetic rated-admission report, 4 November 2026](../evidence/letterboxd/air-340-rated-admission-2026-11-04.md). No production bucket was read.
- **Uncertainty:** how many rated rows in a future owner ZIP lack an accepted identity is not measured here. The October count is not that number.

## Follow-ups

Owner acceptance of this Proposed record is a separate gate. A production identity step, and the projector upsert that would follow a written admissions object, each need their own explicit approval. AIR-321 remains the Film authority cutover. Finds eligibility for a rated Film stays a later card.
