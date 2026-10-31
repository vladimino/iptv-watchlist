# Canonical Person — identities, aliases and roles

**Role:** active technical reference for the pure canonical Person contract, `src/domain/canonical-person.js`. Decision: [ADR 0058](../../adr/0058-canonical-person-grouping.md) (Accepted). Verified against the source on **2026-10-30**.

This is a **read model**, not a writer. The [person identity projection](person-identity-projection.md) calls it with records the caller already loaded. The Worker bundle includes both only as the `PersonIdentity` scope in front of the [person identity GET](../api/d1-catalog.md#person-identity). The enrichment projector, the site filters and the other catalog views do not load it. It writes nothing, merges nothing in storage, mints no stored id and redirects nothing. Storing humans, and pointing a page at them, stays separate work.

## Why

A Person record is role-specific and source-specific ([Film/Person contract](film-person.md)):
- `person:actor/<slug>` and `person:director/<slug>` are Letterboxd records;
- `person:tmdb_actor/<id>` and `person:tmdb_director/<id>` are TMDB records;
- `person:role/<text>` holds credit text only.

One human is therefore stored once per role and once per source. Watchlist Films carry Letterboxd credits, and catalog Films carry TMDB credits; a watchlist Film can carry both. The contract groups records into **canonical humans** and says on what evidence. The [person identity projection](person-identity-projection.md) reads one human instead of up to four records.

## Input

`canonicalPersons({persons, credits, films, decisions})`. Every field is optional, and every array is read, never changed.

| Field | Shape | Notes |
| --- | --- | --- |
| `persons` | Lifecycle `personView` records: `id`, `original`, `aliases` (`kind: name`), `localization`, `localizationConflicts`, `roleLinks` | A caller holding D1 rows passes the `person_alias` names and the `person_dimension` localization in the same shape |
| `credits` | `{filmId, personId, role}`, with `role` `actor` or `director` | Duplicates count once |
| `films` | Lifecycle view Films, or `{id, verified}` | `filmVerified(film)`: exactly one trusted, non-conflicting `tmdb` or `tmdb_tv` identity, or a `tmdb:`/`tmdb_tv:` canonical identity, and not rejected |
| `decisions` | `{personIds: [a, b], verdict: 'same' \| 'different', at, basis}` | The owner's decisions. The [AIR-126](person-name-review.md) `roleLinks` on a record count as `same` decisions with their own time |

`withVerifiedNames(persons, dictionary)` projects the `verified` entries of `data/person-names.json` onto the records first, offline:
- A verified name becomes a `reviewed` localization with `authority: dictionary`. The replaced name stays a name alias.
- A record whose name the owner reviewed keeps it. The dictionary value is held in `localizationConflicts` with reason `owner_kept`, as in AIR-126.
- `provisional` entries change nothing. The function returns new records.

## Accepted names

`personNames(person)` lists every name a record is known by:
- the original credit text;
- each `kind: name` alias;
- a `reviewed` or `provisional` localization.

These are the names the D1 review queue (`GET /api/d1/persons/review`) uses. A value held back by reviewed precedence is not an accepted name.

Names compare after `personFold`, the folding of the admin query library and of AIR-126. It strips Latin diacritics, reads `ё` as `е`, folds case in both alphabets and turns punctuation into spaces. The D1 queue compares with SQLite `lower()`, which folds ASCII only, so the contract finds the same matches and a few more (see the evidence).

## Grouping

`personKey(id)` names the identity authority behind a record:
- a Letterboxd record → `letterboxd:<slug>`;
- a TMDB record → `tmdb:<id>`;
- a `person:role/` record has no key.

Groups form in three steps. Each step does not depend on input order.

1. **`same_key`.** Records of one source key under different roles are one human. A Letterboxd slug is one person page whatever role it is credited in, and a TMDB person id is one TMDB person.
2. **`owner`.** An owner `same` joins two groups, and an owner `different` forbids a join:
   - For one pair, the later decision wins. At an equal time, or with no time, `different` wins. Two entries of one verdict at an equal time are one decision told twice: an explicit decision is kept over a role link, then the smaller basis text, so the recorded provenance never depends on input order.
   - A `same` that would join two groups the owner already called `different` is refused as `invalid_decision`.
   - The owner cannot split one source key. Such a `different` is reported as `owner_split_same_key`, and the key stays one human.
3. **`co_credit`.** A Letterboxd group and a TMDB group join when both hold:
   - On at least one verified Film, a Letterboxd record and a TMDB record of the two groups are credited in the same role under one accepted folded name, and each is the only record of its source credited there under that name.
   - Each of the two groups has such evidence with no other group.

   Names compare per credited record, not over the whole group.

Pairs with evidence that do not join become **candidates**, never links:

| Reason | When |
| --- | --- |
| `ambiguous_co_credit` | A group has evidence with more than one group, or on one Film and role two records of one source share the name |
| `conflicting_keys` | The join would put two different keys of one source into one human |
| `owner_different` | The owner refused the join |
| `name_only` | A Letterboxd human and a TMDB human share a name with no evidence: no shared verified Film, for example namesakes on a remake and its original |
| `same_name` | Two humans of one source share a name: namesakes, or a person stored under two slugs |

## Output

`{version, totals, humans, humanOf, candidates, issues}`. All lists are sorted.

| Field of a human | Meaning |
| --- | --- |
| `id` | `human:letterboxd:<slug>` from the smallest Letterboxd key, else `human:tmdb:<id>`, else `human:record:<rest of the record id>` |
| `formerIds` | The ids the other member keys would have alone. A TMDB-only human that later gains a Letterboxd key keeps its old id here, so a reader that stored it still finds the human |
| `memberIds`, `roles` | Every member record, kept as is, and the roles of the records and their credits |
| `externalIds` | `letterboxd_person` and `tmdb_person` keys with the records that carry them |
| `original` | The first original credit text, Letterboxd records first |
| `preferred` | The highest-ranked localization of any member: owner review, then other reviewed (dictionary), then provisional. Ties go to Letterboxd before TMDB, then to id order. `status: missing` with `value: null` when no member has one |
| `nameConflicts` | Other names of the same rank that differ after folding. They are kept, never dropped |
| `aliases` | Every other accepted or held name of every member, with the records and origins it came from |
| `links` | Why the members are one human: `same_key` (the key), `owner` (time, decision or role link, reason), `co_credit` (records, Films, roles and folded names) |
| `credits` | The `{filmId, role}` pairs of all members |

`humanOf` maps each record id to its human. `issues` reports invalid, duplicate or unknown records, credits and decisions, sorted; nothing is guessed from them. A record id supplied twice counts once when the copies are identical (key order aside). When they differ, the id is left out entirely, with its credits and decisions, and reported as `duplicate_person` with `conflicting: true`: no rule could choose a copy without depending on input order, and nothing is joined on a record in doubt. `totals` counts records, humans, joined humans, links by basis, candidates by reason and issues.

## Invariants

- **Non-destructive.** Every member record, name and key stays in the output. A later owner `different` splits a join, and each part gets back its own id and data.
- **Deterministic.** The same input in any order gives the same output, including owner entries of one verdict at one time and conflicting copies of one record.
- **Evidence or owner.** A name never joins two keys on its own; only a verified Film or the owner does ([ADR 0009](../../adr/0009-canonical-film-person-identity.md)).
- **Reviewed precedence.** An owner review is never replaced by a dictionary or automatic name, and a reviewed name never by a provisional one.

## Not in this contract

- No stored human, owner decision or D1 table of either. The [person identity projection](person-identity-projection.md) is the consumer reference over this grouping. One GET loads a bounded neighborhood and calls that projection ([ADR 0062](../../adr/0062-d1-person-identity-read.md)). Persisting humans or decisions, and pointing a page at the reference, stays separate work.
- No fetching of credits. Films without TMDB credits in D1 give no coCredit evidence until a separately approved credits step adds them; this includes the watchlist Films added after AIR-286.
- No owner decision UI: [AIR-54](https://trello.com/c/yKtj1ahy) and AIR-126 cover owner input.
