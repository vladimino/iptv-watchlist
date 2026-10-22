# AIR-43 verification path audit

Audit of how an EPG observation becomes `verified` and then a catalog film. This document does not change the resolver, the scorer, the acceptance gate, retry, or localization. `SCORED_RESOLUTION` stays unset. No production EPG, TMDB, resolver, enrichment, or migration was run.

Facts below are what `main` at `88ecd2d` does. Problems are gaps between those facts. Proposals are not implemented.

Related work: [AIR-43](https://trello.com/c/7NY6n1Az), [AIR-42](https://trello.com/c/drLBuWjl), [AIR-48](https://trello.com/c/rVf8rRoJ), [AIR-49](https://trello.com/c/YNaLFwtW), [PR 35](https://github.com/vladimino/iptv-watchlist/pull/35), [PR 36](https://github.com/vladimino/iptv-watchlist/pull/36), [PR 37](https://github.com/vladimino/iptv-watchlist/pull/37).

## 1. Legacy verification, as implemented

`SCORED_RESOLUTION` unset selects the `else` branch in `resolveDiscoveryChunk` (`src/discovery.js`). That branch is the production resolver.

### How a brand-new film is found

The chunk loads the pinned discovery ledger, the resolution ledger, and `epg/discovered-films.json`. It indexes every catalog film and every watchlist film that has a `tmdbId`, under each normalized title, original title, and alias.

Only candidates `resolutionActionability` still calls current are considered. Historical, expired, excluded, verified, and terminal rows with unchanged evidence are not. Hot candidates are sorted first.

If the normalized title hits exactly one indexed film, and the year matches when the EPG row has a year, and some stored duration is within `max(8 minutes, 8% of runtime)`, the candidate is `verified` with no TMDB call. `identitySource` is `known_alias_year_runtime` or `known_alias_unique_runtime`.

Otherwise the chunk searches TMDB. Ukrainian letters in the title try `uk-UA` then `ru-RU`. Other titles try `ru-RU` then `uk-UA`. The first language that returns an exact normalized title, and a release year within one when the EPG row has a year, stops the search. There is no movie-detail request yet.

### What is enough for `verified`

A search result becomes `verified` only when all of these hold:

- Exactly one exact-title result from that search.
- The EPG row has a year, or `total_pages` on that search response is at most 1.
- `GET /movie/{id}` returns the same id, a runtime, and a duration within tolerance.
- With a year, tolerance is `max(25 minutes, 20% of runtime)`. Without a year it is `max(10 minutes, 12% of runtime)`.

More than one exact title is `ambiguous`. No exact title is `no_confident_match`. A detail response whose runtime misses the tolerance is `duration_mismatch`. Those three go through `recordUncertain`: same evidence increments attempts, backs off, and stops after five as `repeated_uncertain_match`.

The movie-detail request is a second HTTP call. It is not a second opinion. Title and year were already taken from the search payload. The new facts are runtime, credits, translations, and alternative titles.

### Where search, verified, and canonical identity split

| Stage | What exists | What it is not |
| --- | --- | --- |
| TMDB search hit | An id and titles on a search page | A decision and a catalog row |
| `verified` decision | `epg/discovery-resolution.json` entry for the candidate key | A Film id. The key remains `normalizedTitle\|year` |
| Catalog row | `tmdb_<id>` inside `epg/discovered-films.json` | Created only when that id is not already a watchlist id in `knownTmdb` |

`canonicalIdentity` on that row is the string `tmdb:<id>`, written by `touchCanonicalFilm`. It is not assigned by `linkFilms`. AIR-42 `filmView` promotes `canonicalIdentity` only when its own identity state is `resolved`. The discovery writer does not call that function.

### What the new catalog row contains

On first insert the row stores TMDB title, original title, Russian, Ukrainian, and English translations, selected alternative titles, year, genres, synopsis, runtime, poster, up to ten directors and ten actors, and the candidate's current shows. `touchCanonicalFilm` unions aliases and replaces shows when the programme run id changes. It does not write a fingerprint or a prediction.

`refreshPredictionQueue` at the end of the chunk unions watchlist films with catalog rows, one row per TMDB id. Fingerprint and prediction are later enrichment work on that id. They do not run inside verification.

### Remake and version guards

The alias shortcut requires an exact year when the EPG row has one, plus the tight runtime band. The search path treats two exact titles as ambiguous and does not open movie details. A yearless row is fetched only when the search reports a single page, then held to the tighter runtime band. The detail step does not look at other local films with the same title. A remake that TMDB did not return as a second exact hit is not a local collision check.

### Failure, retry, and generation

A TMDB 429 or a network error throws before that candidate's decision is saved. The chunk records `error` and `retryAt` and stops. Earlier candidates in the chunk stay saved. The same candidate is not marked uncertain.

`saveDiscoveredFilms` refuses the write when the published generation run id differs from the run the chunk is holding. The chunk then returns `programme_changed`. A decision is written after the catalog write, so a crash between them is repaired by the alias shortcut on the next chunk: the film is already indexed.

A changed title, year, duration, or show start changes `candidateEvidence`. That starts a new attempt series. An identical repeat does not.

### Trusted alias reuse

The alias shortcut is not "apply an existing verified decision again". It treats a stored film that already has this title and a fitting year and runtime as enough to write `verified` for this candidate key. The film may have been created by an earlier movie-detail verification, or it may be a watchlist row whose `tmdbId` was parsed from a Letterboxd page (`data-tmdb-id` in `parseFilm`). Those are different provenances. Legacy code does not record which one it used, beyond `identitySource` on the alias path. The movie-detail path writes `verified` with no `identitySource`.

The cheap pass is narrower. EPG sync passes catalog films that are not already on the watchlist into `scanEPG` with `catalogOnly`. A single valid match of that kind does not attach the showing to a programme film. It sets `confirmedTmdbId` on the discovery item. The cheap pass then writes `verified` for a candidate that has no decision yet, still without a new TMDB call.

## 2. Scored path, as implemented

`shadow` and `on` are the only values that leave the legacy branch. Both are off unless `SCORED_RESOLUTION` is set. `wrangler.jsonc` does not set it.

`shadow` still runs the legacy branch. Before that write it scores only films already in the alias index. It does not score the TMDB search hits the legacy branch may fetch afterward. The gate result is stored in `epg/discovery-score-preview.json`. The decision and the catalog stay on the legacy result.

`on` does not run the legacy branch. It scores alias-index films first. It calls TMDB search only when none of those rows has an exact title. It does not call `/movie/{id}`. Search hits are passed to the scorer without a detail runtime unless the search payload already had one. The gate then chooses the write:

| Gate outcome | What `on` persists |
| --- | --- |
| `candidate_decision` | `recordUncertain` with the mapped AIR-48 status |
| `needs_verification` | Status `needs_verification`, attempt cap, evidence key. Not `verified`. No catalog insert |
| `trusted_acceptance`, `already_applied`, `refused` | Preview only. No decision write and no catalog write |

`verifiedConfirmation` reads only `decisions[candidate.key]`. Another candidate's `verified` row for the same TMDB id is not confirmation.

### Scenario A. New film, exact TMDB match, absent from watchlist and catalog

EPG observation is current, so AIR-48 selects it. The alias index has no exact title.

Legacy searches, fetches movie details, and on a passing runtime writes `verified` and inserts `tmdb_<id>` with metadata, aliases, and shows. The checkpoint refreshes the prediction queue. Fingerprint and prediction are downstream, not part of this write. Shows on that new row are the candidate's current shows.

`shadow` scores an empty candidate list, so the preview reason is `no_exact_title`, while legacy can still verify. The preview does not describe the TMDB evidence. This is a measurement gap, not a production behavior change, because `shadow` keeps the legacy write.

`on` searches, may score `accepted` from title, year, uniqueness, and an unknown runtime, then stores `needs_verification`. No `tmdb_<id>`, no aliases from translations, no shows on a catalog row, no prediction queue entry. The film does not become available through discovery. After five identical attempts the terminal reason is `awaiting_confirmation`. Nothing in the current code turns that row into `verified`.

### Scenario B. Verified catalog film, new EPG alias

If the new title is already an alias on the stored film, and year and runtime fit, legacy verifies this new candidate key with no TMDB call and refreshes shows through `touchCanonicalFilm`.

`on` can score that same film as `accepted`. The gate still returns `needs_verification`, because this candidate key has no verified decision of its own. The catalog is not updated and the new alias is not verified. A later chunk does not inherit trust from the older key.

If the new title is not indexed yet, both paths search. Legacy can verify and merge aliases. `on` again stops at `needs_verification`.

### Scenario C. Same title, remakes, missing year or runtime

The scorer returns `ambiguous`, `contradicted`, or a year-separated `accepted`. Mapped non-accepted statuses become AIR-48 uncertain decisions under both legacy and `on`. That part preserves the retry policy.

A year that separates two remakes can be `accepted` by the scorer. Legacy may also verify that one film through the alias shortcut or the detail check. `on` still stores `needs_verification` for the accepted id. Separation is scored and then not promoted.

### Scenario D. `accepted` with no verified decision and no owner review

The gate returns `needs_verification`. `on` persists that hold. Identity, availability, fingerprint, and prediction do not advance. `shadow` does not use this outcome to replace a legacy `verified` write.

There is no later job that reads `needs_verification` and fetches movie details. The comment at the top of `src/domain/resolution-acceptance.js` still says the Worker does not load the file. `build.mjs` does load it, and discovery calls it when the flag is set. The comment is stale. Behavior is the call described above.

## 3. Trust options

A high score is not a confirmation. These are separate sources.

| Source | What it actually checks | False identity | Cost and latency | Replay | Provenance today |
| --- | --- | --- | --- | --- | --- |
| Verified decision on the same observation key | The decision ledger already says this key is `verified` for this id | Low for a new claim, because it is not a new claim | None | Idempotent. The gate returns `already_applied` when the film already has that canonical id | The decision row. Discovery now passes only this key |
| Owner review | A person marked the id reviewed | Depends on the reviewer | No TMDB call. No such UI exists on this path | Idempotent if the same review is stored | Gate accepts `authority: 'owner'` with `reviewed: true` and the same id. Discovery never builds that object |
| Alias reuse of a stored film | Title plus year and runtime against a row that already has a TMDB id | Medium if the id came only from a Letterboxd page or an earlier loose match. Lower if that id was itself movie-detail verified | No TMDB call when the alias is indexed | Repeating the shortcut writes `verified` again | `identitySource` on the alias path only. It does not name the earlier verification |
| TMDB movie-detail fetch | Same id, runtime, and titles from `/movie/{id}` | Titles repeat the search. Runtime is new data from the same vendor. Local remakes are checked only if the caller compares them | One extra request after search. Legacy already pays this before `verified` | The same id and payload should not create a second row. `tmdb_<id>` is the key | Legacy stores the resulting catalog fields, not the response hash or the tolerance that passed |
| Another catalogue | A second vendor agrees on the id | Lower if the vendor is independent. Not implemented | Extra account, latency, and a mapping table | Needs its own idempotency key | None |
| Manual review of the residue | Ambiguous and contradicted rows only | Low if the queue is the residue rather than every new title | Human time | A stored review must be the owner authority above | Not built for discovery |

Search-page title, search-page year, and the same movie's detail title are one vendor's opinion counted more than once. Detail runtime is the only new measurement legacy requires. It is not an independent identity.

The gate today can be satisfied by a caller-shaped object. `trustedConfirmation` checks shape, not that this process fetched movie details. Discovery's current caller is narrow, which prevents cross-candidate trust. It does not make a future caller honest. A new authority is only as strong as the fetch the Worker performs itself.

## 4. Contract boundaries

AIR-48 remains the activity, retry, terminal, and generation rules. The scored `on` path already uses `resolutionActionability` to choose candidates and `recordUncertain` for mapped failures. `needs_verification` reuses the attempt cap and evidence key. That hold is an AIR-48-shaped record with a status AIR-42's `identityState` does not list. A `needs_verification` decision therefore falls through identity to unresolved with `wait_new_evidence` unless a caller also passes discovery facts. The status is not a Film id.

AIR-42 still owns linking and collision checks inside `acceptScoredIdentity` and `linkFilms`. Discovery does not call `linkFilms` on the scored path. Legacy catalog creation also bypasses `linkFilms`. That is existing behavior, not something this audit changes.

AIR-43 owns the score and the evidence list. The gate owns whether a score may be written. Neither one, in the current `on` branch, performs the movie-detail check that legacy uses as the step from search hit to `verified`.

AIR-49 is where a scored result, its evidence, the attempt fields, and the generation pin should be stored separately from the Film. They are not stored that way now. The preview file is a single JSON object written only when the flag is `shadow` or `on`.

`acceptScoredIdentity` should grow a new authority only if the Worker, not the caller, supplies the payload. A typed `tmdb_detail` authority would require the fetched movie id, runtime, release year, and matched title strings, and the gate would recheck them against the score. A boolean `confirmed: true` is not that authority. This audit does not add the authority. Adding it changes the AIR-42 gate and needs that contract's review.

## 5. Recommendation

Do not treat the score as confirmation. Do not enable `on` on the current gate. The gate is stricter than legacy in a way that drops new films: legacy can verify after movie details, and `on` cannot.

The smallest safe model, after a separate agreement, is:

1. Keep same-key verified decisions and owner review as confirmations. They do not create the first verification.
2. For a first id, the Worker fetches `/movie/{id}` itself. The gate accepts `tmdb_detail` only when the fetched id matches, a title or alias matches exactly, the year is within one when the EPG row has a year, the runtime is inside the legacy tolerance, and no other indexed film with that exact title has a compatible year. Persist those fetched fields. Do not accept a caller-supplied flag.
3. Alias reuse without a new fetch is allowed only when the stored film's id was previously verified by that detail check or by an owner review. A Letterboxd `data-tmdb-id` alone stays a candidate for the detail check, not a confirmation. This is stricter than today's alias shortcut and should be explicit if adopted.
4. Ambiguous, contradicted, and failed runtime rows stay on the AIR-48 uncertain path. They are the manual residue, not the common case.
5. `shadow` must score the same evidence legacy used, including search hits and, when legacy fetched details, the detail runtime. Today's shadow score of an empty alias list cannot answer scenario A.

That is a proposal. It is not implemented here.

### Evidence AIR-49 would need

One scored record per observation key and programme run: `scorerVersion`, status, reason, score, `acceptedTmdbId`, considered rows, gate outcome, and discovery facts. Separately, when a detail fetch ran: movie id, runtime, release year, matched titles, fetch time, and the generation run id. The Film id `tmdb_<id>` stays a different record. The observation key is not that id.

### Minimal pull requests after this one

1. Agree this trust model, including whether the alias shortcut may remain looser than rule 3.
2. Teach `shadow` to score search hits and detail runtime without changing legacy writes. Still do not set the variable in production.
3. Add the Worker-side detail fetch and `tmdb_detail` check behind `on`, still default off, with tests that a new exact film becomes `verified` and a remake does not.
4. Only then decide to set `on`, after the shadow sample below.

### Read-only shadow sample

Do not run this against production as part of this pull request. On a non-production copy of a saved discovery ledger and catalog, set `SCORED_RESOLUTION=shadow` and run the resolver against that copy only. Compare `legacyStatus` with the gate outcome. Count rows where legacy is `verified` and the preview is `no_exact_title` or `needs_verification`. Those are the films `on` would stop creating or stop reusing. Also count true collisions the legacy path verified anyway. Do not copy the preview back into production R2.

### Acceptance and rollback

This audit is accepted when the answers below are agreed, not when `on` is enabled and not when an admin is built. Rollback of this pull request is deleting this document. No data moves.

## 6. Human review, proposed and not built

[AIR-53](https://trello.com/c/gkuy1awG) is the title and alias admin. Its card says that workflow must not change canonical Film identity. Identity confirm, reject, and revoke are a separate admin capability. This section specifies that capability. It does not add a screen, an API, or a write.

### Resident Evil / Обитель зла

No production copy was read for this audit. Dashboard GETs are not a safe read: `GET /api/events` can recover an event, and `GET /api/enrichment/view` can initialize a rating. A 2026 airing is not assumed. A public announcement of a later film, if one exists, is not evidence that this EPG carried it.

On a non-production copy of the published generation, and only that copy, record the following and label anything missing as unseen:

1. Every discovery item whose normalized title is the normalized form of `Обитель зла`, `Resident Evil`, or another alias already stored on a candidate. Fields: `key`, raw titles, year, durations, `seenInLatestSnapshot`, `lastSeenAt`, `lastSeenProgrammeRunId`, and each show's channel id, channel name, start, and end.
2. The decision on each of those keys: status, `tmdbId`, `identitySource`, attempts, `retryAt`, `terminalReason`, evidence key. Do not treat a verified row for a different key as this row's decision.
3. Catalog and watchlist rows whose title, original title, or alias normalizes to the same string. Fields: local id, `tmdbId`, `canonicalIdentity`, year, runtime, and whether `catalogOnly` was set when the row was passed into `scanEPG`.
4. Programme showings already attached to a watchlist film for those titles, including `basis` (`title_year` or `title_duration`). That basis is the legacy label, not a scored reason.
5. Which legacy branch would apply to each key if the resolver ran again with the flag unset: alias shortcut, movie-detail path, or uncertain. Do this on paper from the rules in section 1. Do not run the resolver.
6. If both a 2002-year row and a later-year row appear, keep them separate keys. A missing year is a third key, not proof of either film. Do not fill a missing year from a catalogue.

Confirmed evidence is only what those stored fields say. A hypothesis is any claim about which film aired, which channel carried it, or that a 2026 feature exists on this schedule. Hypotheses stay out of the decision.

### Review queue

The queue is a list of observations, not a list of Films. One row is one candidate key plus the published generation's shows. A Film is linked beside it only when a catalog or watchlist row is already addressed by that key's own decision.

Rows worth review, in order:

1. `on` or shadow preview says `needs_verification` while legacy status is `verified` or would be. Coverage risk.
2. Scorer `contradicted` or `ambiguous`, or legacy `ambiguous` / `duration_mismatch` / `no_confident_match`, and more than one indexed film shares the title.
3. A showing whose `basis` is `title_duration`.
4. An owner flag that a verified film was the wrong version.

Group by normalized title, then by year, then by generation. Do not merge two years into one queue card. Inside a card, show the EPG raw title, channel, start, end, duration, the score, the considered TMDB ids with year and runtime distance, and the provenance of each id (search, movie detail, Letterboxd page, alias, owner). Priority is current shows first, then hot candidates, then the rest. Historical rows stay listed and are not a reason to call TMDB.

### Scoped owner decisions

Each decision names a scope. A wider scope never inherits a narrower one in reverse, and a title alone is never a global TMDB map.

| Decision | Scope | Effect |
| --- | --- | --- |
| Confirm this showing | One `channelId` and start, on one generation | That showing may attach to the named Film. Other showings of the same title do not |
| Confirm this observation | One candidate key | That key may become `verified` for the named TMDB id. Other keys do not |
| Confirm this fingerprint | One stored fingerprint id | Later prediction may treat that fingerprint as reviewed. It does not verify EPG identity |
| Narrow rule | One channel, plus normalized title, plus year or an explicit year-absent flag, plus a runtime band | Applies only to showings that match every part. Requires an expiry |
| Canonical alias | One Film id and one alias string | Adds the alias on that Film. It does not verify every future EPG row that uses the words |
| Reject this candidate | One candidate key and one TMDB id | That pair stays unresolved. It does not delete the Film or block a different id |
| None of these | The queue card | No write |
| Defer | The queue card | Hide until a date. No identity write |
| Revoke or correct | The id of an earlier owner decision | See below |

Precedence is the narrowest matching scope. A showing confirmation beats an observation confirmation, which beats a narrow rule. A narrow rule beats an automatic movie-detail result only inside its scope. Alias reuse and Letterboxd ids do not beat an owner reject for that same key and id. Two owner decisions that name different TMDB ids for the same showing are a collision: apply neither, and keep both in the history.

Expiry: a showing decision is void when that start is no longer in the published generation's shows. An observation decision stays until revoked. A narrow rule stores `expiresAt` and the generation run id it was written against. It does not apply on a later generation unless it is still unexpired and every scope field still matches. There is no default of "forever for this title".

### Correction and replay

An owner decision is an append-only record: reviewer, time, scope, chosen TMDB id or reject, evidence ids, and a reason string. Revoke appends a new record that points at the earlier id. It does not edit the old one.

Replay builds the current answer by walking that history to the latest non-revoked decision whose scope still matches. Current shows and the availability derived from the published generation may be rewritten to match that answer. Fingerprint files, prediction history, and the revoked decision stay. A replay refuses to write when the generation run id it read is no longer the published one, the same guard as `saveDiscoveredFilms`.

### How the gate would learn about an owner

The automatic authorities stay distinct:

| Authority | Evidence that is real | What it must not be |
| --- | --- | --- |
| `tmdb_detail` | A movie payload this Worker fetched | A score, or titles copied from the search response |
| Letterboxd mapping | `data-tmdb-id` on a watchlist page | A `verified` decision |
| Verified alias | This candidate key's own `verified` decision, or a Film id that decision already created | Any other key with the same TMDB id |
| Owner scope | The append-only record above, loaded by id from storage | An object the caller assembled in the request |

The gate checks the owner record's scope against the observation and the showing, and checks that the record is not revoked. A request body that says `authority: 'owner'` without that stored id does not pass. AIR-48 still decides whether the candidate is current and whether attempts are exhausted. AIR-49 would store the owner log, the score, and the Film as separate rows.

### What AIR-53 does not absorb

AIR-53 reviews the preferred Russian title and aliases. It must keep that boundary. Identity review is a later task: queue, scoped decisions, revoke, and replay as specified here. It should not be added to the scored resolver pull requests. Persistence is D1-shaped only as a sketch: one table for owner decisions, one for score evidence, the Film table unchanged. Tests for that future task are the scope table, a collision of two owner ids, a revoke that restores the previous show, and a stale generation that does not write. None of those tests exist yet, and this pull request does not add them.

## Answers

1. A new film becomes `verified` only if some step other than the score writes that decision. Today the legacy movie-detail check is that step, and the scored `on` path never runs it. An automatic scored path needs the Worker to perform that detail fetch and a local collision check, then write `verified` and `tmdb_<id>` under a new gate authority. Same-key reuse and owner review do not create the first verification.
2. The minimum change that preserves legacy coverage is to keep that detail fetch and the catalog insert on the success path, and to make `shadow` record those same inputs. Leaving `on` as it is will score some new titles as `accepted` and then never verify them. Alias reuse must be classified as either a prior verification or a fresh claim, or `on` will also drop new titles for films the catalog already knows.
3. What the automatic path still cannot decide is a scoped owner review, specified in section 6 and not built. It confirms one showing, one observation, or one narrow rule. It does not turn one ambiguous title into a global TMDB map. [AIR-53](https://trello.com/c/gkuy1awG) stays the title admin and does not take this identity queue.
