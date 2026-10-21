# Scored EPG resolution

[AIR-43](https://trello.com/c/7NY6n1Az) PR 1. This is a pure function in `src/domain/scored-resolution.js`. The Worker does not load it, call it, or write its result. It does not read R2, call TMDB, change the resolver queue, or draw the `≈` warning. Those belong to later pull requests.

[AIR-48](https://trello.com/c/rVf8rRoJ) still decides which observation is current. [AIR-42](https://trello.com/c/drLBuWjl) still owns Film identity and reviewed titles. [AIR-49](https://trello.com/c/YNaLFwtW) still owns where a decision is stored. This scorer does not import any of them. `observation.key` is returned as `observationKey` and is not a Film id. A reviewed title on the input is ignored. `acceptedTmdbId` is set only when the status is `accepted`.

`scorerVersion` is `1`. The weights below are the version-1 rules.

| Signal | Weight | Values |
| --- | --- | --- |
| Exact normalized title, original title, or alias | 0.50 | 1 when exact, otherwise 0 and the row cannot be accepted |
| Year | 0.20 | exact 1; one year away 0.85; missing on a long unique title 0.75; missing on the candidate 0.40; missing on a short or non-unique title 0.15; two or more years away 0 and a year contradiction |
| Uniqueness | 0.15 | `1 / competitors`. A competitor is a distinct TMDB id with the same exact title and, when the observation has a year, a missing year or a year within one. A remake whose year is further away is not a competitor. Repeated input rows for one id count once |
| Runtime distance | 0.15 | within `max(8 minutes, 8%)` is 1; within `max(25, 20%)` is 0.55; within `max(45, 40%)` is 0.20; beyond that is 0 and a runtime contradiction. Unknown runtime is 0.50 and is not itself a contradiction |

A title is short when its normalized form is one token or eight characters or fewer. `Dune` is short. A missing year on a short title, or on a title shared by more than one competitor, cannot be accepted.

Acceptance requires a score of at least 0.82, no contradiction on the leader, a year relation other than `year_required`, and a gap of more than 0.12 over the next row. A score of at least 0.70 that fails those gates is `ambiguous`. A contradiction on the leader is `contradicted` even when the score is high. Anything else exact but weaker is `no_confident_match`. No exact title is `no_confident_match` with reason `no_exact_title`.

`confidence` is the leader's score, including when that leader is not accepted. `trusted: true` is recorded evidence for a known alias. It does not skip a collision, a missing year on a short title, or a contradiction. Records that share a TMDB id are combined first: titles, original titles, and aliases stay available for the match, and `sources` is the number of input rows. When those copies disagree, year and runtime use the value closest to the observation. The result has one row per TMDB id, ordered by score and then by that id, so the input order does not change the decision.

No production data is written. Revert the commit to remove the function; nothing stored needs to be restored.
