# ADR 0150: No Documentary and no recording of a real concert becomes a Discovery Film

**Status:** **Accepted** (2026-11-16; product policy recorded on [AIR-501](https://trello.com/c/ShipZn0N). This records the admission rule, not permission to correct already verified Films or to run Discovery, EPG, TMDB, predictions, Tasks, or a storage write)  
**Original decision date:** 2026-11-16  
**Recorded at:** 2026-11-16  
**Approval source:** [AIR-501](https://trello.com/c/ShipZn0N), the owner's product policy for automatic Discovery admission  
**Related work:** [AIR-496](https://trello.com/c/4NxERbZW) / [ADR 0149](0149-concert-recording-identity-gate.md), [AIR-500](https://trello.com/c/dD3BRQ2H), [AIR-498](https://trello.com/c/3dPOigK9), [ADR 0010](0010-scored-detail-verification.md), [ADR 0142](0142-epg-owned-generation-addressed-discovery-slots.md)  
**Supersedes:** The permissive clauses of [ADR 0149](0149-concert-recording-identity-gate.md): a Music-only card without a concert category still verifies; Documentary+Music verifies; a missing or film XMLTV category saves a concert recording; owner confirmation verifies a proven concert recording. ADR 0149's text stays as accepted history.  
**Superseded by:** None

## Context

ADR 0149 withholds `detail_verified` only for a concert telecast whose XMLTV category is concert or music, not film, and whose TMDB card is Music without Documentary or another feature genre. That left theatrical concert films and every documentary in the catalog. The owner's catalog and the programme he wants scored contain neither documentaries nor recordings of real concerts, including a full-length concert film. A fiction film about musicians, including a musical biography, remains in scope. Title words must not screen candidates.

## Decision

After title, year and runtime on the fetched TMDB movie card succeed, `acceptScoredIdentity` applies this policy before `detail_verified`. Genre ids win. A display name is used only on a genre entry that has no id.

1. **Documentary.** Any card with genre id `99`, or a documentary display name (`documentary`, `документальный`, `документальний`) on an id-less entry, is `candidate_decision` / `no_confident_match` / `documentary_excluded`. Other genres, the XMLTV category, the title and the runtime do not save it.
2. **Concert recording, Music.** A card with Music (genre id `10402`, or the id-less Music names) and no feature genre is `concert_recording` when either of these holds:
   - the observation's XMLTV categories name a concert or music broadcast and do not also name a film (the same whitelist as ADR 0149);
   - the observation title, the movie title, the original title, or an alias contains an explicit performance-recording phrase (`live at`, `live in`, `live from`, `in concert`, `concert film`, `concert recording`, `filmed live`, `live performance`, `recorded live`, `performing live`, `запись концерта`, `запись выступления`, `живой концерт`, or the stem `концертн`);
   - the overview contains one of those phrases except `live in`. `live in` inside an overview is ordinary narrative (`live in Paris`) and is not a recording phrase.
3. **Concert recording, TV Movie without Music.** A card whose genres are only TV Movie (`10770`, or the id-less names `tv movie`, `телефильм`, `телефільм`), with no Music and no feature genre, is `concert_recording` when either of these holds:
   - the concert/music category in rule 2 together with a performance phrase under the same field rules;
   - the title fields contain a performance phrase **and** the overview independently contains one (except `live in`). A film XMLTV category or a missing category does not save that independently proven recording.
   A TV Movie with a concert category and no performance phrase still verifies. A single uncorroborated phrase without the concert category does not refuse a TV Movie.
4. **Concert recording, empty genres.** A card with no Music, no TV Movie, no Documentary and no feature genre is `concert_recording` when the title and overview independently corroborate as in rule 3. The gate does not invent a genre id.
5. **Ambiguity.** A Music card with no feature genre, when rule 2 does not already refuse it, and a title field contains a bare token `live`, `concert` or `концерт` with no stronger performance phrase, is `needs_verification` / `concert_recording_ambiguous`. It is not verified from title, year and runtime alone. The same token in the overview, including the verb `live`, does not hold the card. Owner confirmation of that observation may then verify it.
6. **Not sufficient by themselves.** Music, TV Movie, one XMLTV category, a bare Live/Concert word, `live in` or a bare `live` in an overview, or a single uncorroborated performance phrase on a TV Movie without a concert category. A feature genre (anything other than Music, TV Movie and Documentary) keeps the card, including a musical biography whose overview mentions a concert and a fiction title that contains Live or Concert.
7. **Confirmation does not cancel a proven exclusion.** Owner confirmation and this observation's verified decision do not produce `detail_verified` for a documentary or a concert recording, including a TV Movie or empty-genre concert recording under rules 3 and 4. They still confirm every other identity, including the ambiguous hold and a TV Movie that those rules do not refuse.

No Film and no prediction-queue member is written for an excluded or held card. The EPG programme stays on its slot. Discovery does not move the published generation (ADR 0142). There is no new model and no external catalog.

These automatic paths were checked and left as they are:

- `already_applied` returns before the policy when this observation is already verified onto the same canonical Film. It does not admit a new Film and does not un-verify a stored one.
- The cheap pass `known_epg_alias` verifies an id the scan already confirmed against the existing catalogue. It does not read TMDB genres. Letterboxd import and the manual catalogue are out of scope.
- `discovery_identity_correct` remains an explicit owner write of one decision, not an automatic admission.

Not decided: deleting or reclassifying Films, queue rows and predictions that were verified before this gate. That stays with the separate audit and cleanup cards.

## Alternatives considered

- **Keep ADR 0149's false-negative for theatrical concert films and documentaries.** Rejected: the product policy is that those works are not Films in this catalog.
- **Refuse every Music-only or TV Movie card.** Rejected: a Music-only fictional feature and a television feature are not concert evidence.
- **Screen titles that contain Live or Concert.** Already rejected for the title screen. The gate uses those words only as an ambiguity hold on a Music-only card, not as a refusal and not as a screen.
- **A model or another catalog to classify concert films.** Rejected for this gate. The phrases and genre ids above are the evidence.

## Consequences

New Discovery admissions skip documentaries and proven concert recordings, including a TV Movie whose title and overview independently name a recorded performance even when XMLTV says `Фильм` or is empty, and hold a Music-only card that only says Live or Concert in the title until the observation is confirmed. An overview that only says people `live in` a city, or uses `live` as a verb, does not refuse or hold a Music-only fictional feature. A verified decision is not selected again, so Films already admitted stay until a separate correction. A drifted revalidation of one of those Films can fail to reconfirm a duration; it does not change the verified status. Code that still expects ADR 0149 to verify Stop Making Sense or a Music-only concert film now sees `documentary_excluded` or `concert_recording`.

## Recovery and migration boundary

Code rollback restores the ADR 0149 gate and does not delete stored Films, decisions, or queue rows. Cleaning those rows needs its own owner-approved procedure. This ADR authorizes no production write.

## Evidence

- **Original decision:** [AIR-501](https://trello.com/c/ShipZn0N)
- **Implementation:** the delivery that introduces this record
- **Dated verification:** not a production observation. Offline gate tests and the R2 and D1 discovery regressions cover the named cases
- **Uncertainty:** live TMDB genre arrays and overviews of titles already in the catalog were not re-read. The fixtures use the ids and genre shapes the policy names

## Follow-ups

Read-only audit of admissions this gate would now refuse, then a separate controlled cleanup. Neither is part of this decision.
