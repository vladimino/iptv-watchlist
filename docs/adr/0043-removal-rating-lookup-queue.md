# ADR 0043: Films removed from the watchlist get their rating from a bounded per-film lookup queue, not from the films list

**Status:** Accepted  
**Original decision date:** 2026-10-29  
**Recorded at:** 2026-10-29  
**Approval source:** Owner explicitly accepted ADR 0043 and visually approved the rendered Mermaid diagram in ChatGPT on 2026-10-29 ([AIR-268](https://trello.com/c/7ePpEYev))  
**Related work:** [AIR-268](https://trello.com/c/7ePpEYev); [AIR-267 evidence](../evidence/letterboxd/air-267-recent-ratings-diagnostics-2026-10-29.md); [AIR-34](https://trello.com/c/0hQjPzIf); [ADR 0018](0018-letterboxd-last-good-ratings.md); [ADR 0040](0040-retire-ratings-only-refresh.md); [ratings contract](../reference/integrations/letterboxd-ratings.md#removed-films)  
**Supersedes:** None  
**Superseded by:** None

## Context

AIR-34 adds the owner's rating to a watchlist-removal event, but the rating usually comes from the EPG commit's public films list. AIR-267 established that the list is 31 pages in release-date order, that page 2 answers a Cloudflare challenge (403) from the Worker, that `/films/by/rated-date/` is challenged too, and that the last commit's ratings step was lost to a killed request after `stage: complete`. The existing fallback looks up at most ten films from the frozen 19 October diagnostic baseline, not the films removed now. A removed film's own member page (`/<user>/film/<slug>/`) already works for single lookups (`refreshPersonalRating`).

## Decision

1. **Per-film, for the current diff only.** When the EPG commit builds the watchlist diff, it hands over the removed films with their Letterboxd film URL. Right after the commit's events are written and before the films list, `lookupRemovalRatings` queues them and looks them up through the existing per-film path.
2. **A durable, bounded queue.** `enrichment/removal-rating-lookups.json`, one entry per film id, written by compare-and-swap. At most five requests per call, at most three attempts per film; films beyond five stay pending for later calls. A pending film is never dropped: after 14 days it is kept as `expired`; finished entries are kept 14 days and at most 100. The attempt is recorded before the request, so a killed request cannot cause a free retry.
3. **Replay after a killed commit.** The hand-over stays in `sync.json` until the queue holds it; the next sync step on the completed run replays it once before the discovery continuation.
4. **Upstream blocks stop everything.** A 403 or 429 ends the batch and pauses the whole queue for six hours; no request is repeated and no challenge is solved.
5. **No new meaning.** A missing rating is never "watched"; the first confirmed rating on an event stays; rating facts follow the existing greater-observation rule.
6. **Gated and independent.** Behind `REMOVAL_RATING_LOOKUP`, off by default. The lookup never fails the commit; its summary is stored in `sync.json` as `removalRatingLookup`.

Not decided here: the films-list scan itself, its recovery after a killed request ([AIR-270](https://trello.com/c/DJ6Jvg4F)), the footer reading ([AIR-269](https://trello.com/c/4BDoPQfg)), removing the frozen-baseline fallback, and the production activation of the switch.

## Alternatives considered

- **`/films/by/rated-date/` page 1** (AIR-267): the natural recency source, but it answered a challenge on the first server request.
- **Retry the films list**: each retry meets the same page-2 challenge and costs a full scan.
- **Look up at the next sync step instead of the commit**: the step after a complete run goes to discovery and has no diff; the queue makes the next commit pick up leftovers instead.

## Consequences

- A rating for a removed film arrives with the commit that removed it whenever the member page answers, independent of the films list.
- The commit makes up to five more Letterboxd requests and writes one small R2 object; the queue adds a state to inspect.
- A film whose page never shows a rating ends as `not_rated` after three attempts; a later rating then reaches the event only through another path.

## Recovery and migration boundary

Code only, behind an off-by-default switch; switching it off stops queueing and requests on the next commit, and a revert removes the path. The queue object and ratings already written stay. Setting the switch in production is a separate owner-approved writer change. This record authorizes no production request.

## Evidence

- **Original decision:** this record, proposed with AIR-268.
- **Implementation:** `src/enrichment.js` (`lookupRemovalRatings`), `src/worker.js` (hand-over, call order, `resumeRemovalLookups` on the next step), `src/feature-flags.js`, `tests/removal-rating-lookup.mjs`.
- **Dated verification:** none yet; production behavior is a follow-up after an approved activation.
- **Uncertainty:** whether Letterboxd challenges member film pages from the Worker as it does the films list was not measured; the queue pauses rather than retries if it does.

## Follow-ups

Owner decision on activation; a cleanup or permanence decision for `REMOVAL_RATING_LOOKUP` per the flag lifecycle.
