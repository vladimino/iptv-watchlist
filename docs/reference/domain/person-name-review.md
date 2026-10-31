# Person reviewed-name review contract

**Role:** maintained contract for the owner's manual choice of a Person's preferred Russian name. The pure rules were delivered by [AIR-126](https://trello.com/c/fTMyNpi5) and are implemented in [`src/domain/person-name-review.js`](../../../src/domain/person-name-review.js), tested by `tests/person-name-review.mjs`. The module validates a command against a Person projection (and the other Person records the caller already loaded) and returns the next projections, audit entries and version tokens. It does not read or write R2 or D1. The Worker loads it so [`POST /api/admin/people/<id>/name-review`](../api/admin.md#person-name-confirmation-post-apiadminpeopleidname-review) ([AIR-54](https://trello.com/c/yKtj1ahy), [ADR 0072](../../adr/0072-owner-reviewed-localization-overlay.md)) can persist the returned records. [AIR-78](https://trello.com/c/COdMTjqU) was declined and does not gate that route. This contract is not the canonical Person entity of [AIR-44](https://trello.com/c/ojtZjVc9).

Related: [Film/Person lifecycle contract](film-person.md) (the localization dimension, `personView`, `applyReviewedLocalization`), [Film title review contract](film-title-review.md) (the same command, replay and token rules for a Film title), [admin read contract](admin-read-contract.md) (the record shape search and queues consume), [ADR 0009](../../adr/0009-canonical-film-person-identity.md) (role-specific Person ids are never merged automatically).

## What a name review is

One Person record, one preferred name. A Person record is role-specific (`person:actor/<slug>`, `person:director/<slug>`, `person:role/<name>`, `person:tmdb_actor/<id>`, `person:tmdb_director/<id>`), so the same human credited as actor and as director is two records. The owner either **selects** a text already attached to the record (`mode: alias`: the current preferred name, a name alias or the original credit text) or **types** a name (`mode: manual`). The result is the record's `localization` dimension in status `reviewed` with `authority: owner`. The previous preferred name stays as a name alias, the chosen value stops being an alias, and the record keeps its `id`, `roleId`, external ids and identity untouched; `identity.provenance.dedupe` stays `deferred`.

The owner may **link roles** in the same command: `roles` names other loaded Person records that are the same human. Each linked record receives the same reviewed name under the same `requestId` and a `roleLinks` entry pointing at the primary record; the primary record gets the reverse entry. Ids are never replaced, redirected or merged by a link: a link is an owner assertion recorded on both records, and the admin search still returns one row per role with the AIR-123 `collision` flag.

A name review is **not** a canonical Person merge, an alias CRUD flow, a bulk rename, a re-enrichment or a dictionary edit. `data/person-names.json` and the `REVIEWED_PEOPLE` override are unchanged by this contract.

## Read model

`personNameState(person, people = [])` returns, for the review screen:

| Field | Meaning |
| --- | --- |
| `personId`, `roleId`, `original` | Copied from the record; shown, never edited here |
| `version` | Compare-and-set token of this record, see below |
| `preferred` | `value`, `status` (`missing` / `provisional` / `reviewed`), `source`, `authority`, `reviewedAt` (only when reviewed), `basis` |
| `options[]` | Selectable texts in display order: `value`, `origin` (`preferred`, `alias`, `original`), `provenance`, `preferred` flag. Duplicate texts collapse to their first occurrence. `personView` seeds the original credit and the dictionary/Wikidata names as `kind: name` aliases |
| `reviews[]` | The audit trail stored on the record as `nameReviews`: the record's own commands (`linkedFrom: null`, with `nameChanged` and the `records` a link touched) and the entries a link from another record wrote onto it (`linkedFrom: <that id>`) |
| `heldConflicts` | Count of `localizationConflicts`, the later values held back by reviewed precedence |
| `roleLinks[]` | Links to other role records recorded by earlier reviews, sorted by id |
| `collisions[]` | Other records in `people` that look like the same human: same folded `original`, or same folded preferred name (`reason` `same_original` / `same_preferred`), with their `status`, `authority`, `linked` flag and current `version`. Folding strips Latin diacritics, reads `ё` as `е`, folds case and punctuation. A collision is information for the owner, never a merge |

`personNameProjection(person)` returns the record in the [AIR-123 record shape](admin-read-contract.md#air-123-query-contract): `preferred` is the localized value or `null`, never the original credit text. Search finds a reviewed Person by the new name and still by the old name through the alias; a reviewed record leaves the `localization-provisional` queue, and a held later value shows in `localization-conflict`.

## Command

```text
{ personId, requestId, mode: 'alias' | 'manual', value, expectedVersion, basis?, roles?: [{ id, expectedVersion }] }
```

| Rule | Failure `reason` |
| --- | --- |
| The record must exist and `personId` must equal `person.id` | `missing_person`, `person_mismatch` |
| `requestId` is a non-empty string; it is the idempotency key | `missing_request_id` |
| The command carries no identity fields (`id`, `roleId`, `externalIds`, `identity`, `canonicalIdentity`, `tmdbId`, `redirects`) | `identity_change_forbidden` with `field` |
| `mode` is `alias` or `manual` | `invalid_mode` |
| `value` is a string; whitespace runs collapse to one space and the ends are trimmed; the result is 1–200 characters without control characters | `invalid_name` |
| `basis`, when given, is a string of at most 500 characters; it is trimmed and an empty string reads as no basis | `invalid_basis` |
| `roles`, when given, is an array of distinct `{ id, expectedVersion }` (or bare ids) that does not name the record itself | `invalid_roles` with `role` |
| A record with `identity.status: rejected` is not reviewed | `rejected_identity` |
| `expectedVersion` equals the current `personNameVersion(person)`; a missing token is a conflict, not a bypass | `version_conflict` with `expected` and `received` |
| In `alias` mode `value` must be one of `options[].value` | `unknown_alias` with `options` |
| Every role id is among the supplied `people` | `unknown_role` with `role` |
| Every role is a collision of the record (same folded original or preferred name) | `unrelated_role` with `role` |
| No role has `identity.status: rejected` | `rejected_role` with `role` |
| Every role's `expectedVersion` equals that record's own `personNameVersion`; missing is a conflict | `role_version_conflict` with `role`, `expected`, `received` |

The checks run in the order listed and fall into two groups. The **shape checks** (`missing_person` through `invalid_roles`) judge the command on its own against the record's identity and hold for a retry as much as for a new review. The **state checks** (`rejected_identity` through `role_version_conflict`) judge whether a new change is allowed against the current state of the record and of each named role. `validatePersonNameReview(person, command, people)` runs both groups and returns `{ ok: true, value, basis, version, selected, linked }` without changing anything. Failures return `{ ok: false, reason, ... }` and never a record.

## Transition

`applyPersonNameReview(person, command, at, people = [])`:

1. **Shape.** The shape checks run first; a mismatching `personId`, an identity field, an invalid mode, name, basis or role list is refused before anything is looked up.
2. **Replay.** If `person.nameReviews` already holds `command.requestId`, the entry is compared with the command on `personId`, `mode`, normalized `value`, normalized `basis` and the set of role ids, and it must be the record's own primary entry (`linkedFrom: null`). When all match, the earlier outcome is returned: `{ ok: true, idempotent: true, changed: false, person, people: [], review, reviews: [], version, commit: [] }` with the same record and nothing else touched. This deliberately ignores `expectedVersion` and the role tokens: a retry of a committed request carries the tokens from before that request. The same `requestId` with any other payload, or an entry a link wrote onto this record from another primary, is `request_id_reused` with the stored `review`; an entry recorded for another record never replays. See the persistence section: a replay on the primary record is not proof that the linked roles were written.
3. **State.** `rejected_identity`, `version_conflict`, `unknown_alias`, then the role checks, as above.
4. **No-op.** If the record is already `reviewed` with this exact value, every named role already carries it, and every named role is already linked on both sides, `{ ok: true, changed: false, person, people: [], review: null, reviews: [], version, commit: [] }`. No audit entry is written. Anything less than that (a new link, a role that still lacks the name) is a change and goes through the steps below.
5. **Apply** through `applyReviewedLocalization(record, { value, authority: 'owner', source: 'owner', provenance }, at, 'name')` from the lifecycle contract, for the record and then for each named role, skipping a record that already carries the value. `provenance` is `{ source: 'owner', authority: 'owner', mode, basis, requestId, selectedFrom, linkedFrom }`, where `selectedFrom` names where a selected text came from (`wikidata`, `dictionary`, `letterboxd`, `original`, `preferred`, …; `null` for a typed name) and `linkedFrom` is `null` on the primary record and the primary record's id on a linked role. The previous preferred name becomes a name alias with its own provenance; the chosen value is removed from the aliases.
6. **Link.** Each named role gets `roleLinks` entry `{ id: <primary id>, roleId, reason: 'owner_same_person', requestId, at }`, and the primary record gets the reverse entry for each role. An existing link to the same id is replaced, and links are sorted by id.
7. **Audit.** One entry is appended to the primary record's `nameReviews` whenever anything changed, its own name or not: `{ contractVersion, requestId, personId, linkedFrom: null, at, mode, authority: 'owner', basis, selectedFrom, roles: [ids], nameChanged, records: [{ id, version: { before, after } }], from: { value, status, source }, to: { value, status: 'reviewed' }, version: { before, after } }`. `nameChanged: false` with `from.value === to.value` is the owner's assertion that only links or linked roles changed; it is what makes a retry of such a command replay. `records` lists every linked role the command touched with that role's token before and after. Each role whose name changed gets its own entry with `linkedFrom: <primary id>`, `roles: []` and `records: []`; a role that already carried the name is linked without an entry of its own and appears only in the primary entry's `records`. Earlier entries are kept as they were.
8. **Result.** `{ ok: true, changed: true, person: next, people: [next roles], review, reviews: [role entries], version: next version, commit: [{ id, version: { before, after } }, …] }`. `commit` names the primary record first and then every linked role the command touched, each with its token before and after. Every input record is left unmutated.

## Persisting a multi-record result

A command with `roles` returns more than one record, and the tokens above make each record's write safe on its own, not the set atomic. The writer (AIR-54) must treat `commit` as one unit:

- **All or nothing.** Persist every record in `commit` in one atomic write that checks every `version.before` against the stored token, or refuse the whole command. Writing the primary record and losing a role leaves the owner's assertion recorded without the role it names.
- **Recovery when the store cannot do that.** The writer must not answer a retry from the primary record's replay alone: a replay says the primary entry exists, nothing about the roles. `personNameReviewCompletion(review, person, people)` compares the stored records with the entry: each record is `applied` when its token equals the entry's `after`, `pending` when it still equals `before` (that write never landed, re-apply it from the entry), `diverged` when something else changed it since (stop and surface it; do not overwrite), `missing` when the record was not supplied. `complete` is true only when every record is `applied`. A retry is answered as idempotent success only when the check is complete.

The live writer stores the review fields in one R2 object, `admin/owner-reviews.json`, shared with the Film title review ([ADR 0072](../../adr/0072-owner-reviewed-localization-overlay.md)). The body is `{contractVersion: 1, films, people}`. `people` is keyed by Person id and keeps `localization`, `aliases`, `nameReviews`, `localizationConflicts` and `roleLinks`. One conditional put writes every person in `commit` or writes none, and copies `films` unchanged. The object's etag is the storage compare-and-swap; the domain tokens are still checked before that put. A replay is answered as idempotent only when `personNameReviewCompletion` is `complete`. This card does not write `films`. The pure module still performs no write.

Legal transitions are the lifecycle contract's: `missing → reviewed`, `provisional → reviewed`, `reviewed → reviewed`. `reviewed → provisional` and `reviewed → missing` do not exist.

## Reviewed precedence

`reconcilePersonName(person, incoming, at)` is the rule for every later input once the owner has reviewed a name:

- When the record is `reviewed` with `provenance.authority: owner`, any different later value, automatic (`status: provisional`) or dictionary (`status: reviewed`, `authority: dictionary`), is held in `localizationConflicts` with reason `owner_kept` (the vocabulary `src/sources.js` already uses for `REVIEWED_PEOPLE`) and kept as a name alias. The same value is not a conflict and changes nothing.
- Otherwise the lifecycle contract applies: a reviewed dictionary value promotes a provisional or missing name and may replace an earlier dictionary value through `applyReviewedLocalization`; an automatic value goes through `applyAutomaticLocalization`, stays provisional and is held as `untrusted_review` against any reviewed name.

`applyAutomaticLocalization` alone already holds an automatic value against a reviewed name, and `applyReviewedLocalization` alone refuses a non-trusted authority (`untrusted_authority`). The addition here is the owner-over-dictionary rule, which the lifecycle contract leaves to the caller.

## Version token (compare-and-set)

`personNameVersion(person)` is `name-review:1:<hash>` over everything `personNameState` shows for the record itself, serialized with sorted keys so that key and alias order do not matter:

- the whole `localization` envelope, including its `provenance` (`basis`, `requestId`, `selectedFrom`, `linkedFrom`, `authority`, …);
- the name aliases with their provenance;
- the selectable option texts (so a changed original credit counts);
- the audit entries (`nameReviews`) in full and in order, except each entry's own `version.after`, which is the token of the state the entry belongs to and is stamped after the token is computed;
- the `localizationConflicts` held by reviewed precedence;
- the `roleLinks`, sorted by id.

Identity, external ids, the role id and other records are not part of it: a linked role carries its own token, and a command that links roles must present each role's token. Any successful review changes the token of every record it touched, and so does a provenance-only, conflict-only, link-only or audit-history-only concurrent change. A stale token is `version_conflict` (or `role_version_conflict` for a role); the only command accepted with stale or missing tokens is the replay of an already committed `requestId`. A storage adapter (AIR-54) may map each token onto a row version or etag and must check every mapped version in the same write. Offline, these tokens are the only versions there are.

## Not in this contract

- The pure module still has no route of its own. The route, the confirm button and the R2 object are the [AIR-54 writer](../api/admin.md#person-name-confirmation-post-apiadminpeopleidname-review).
- No canonical Person entity, no automatic dedupe, no id redirects, no alias CRUD, no bulk rename. The canonical Person is the separate [AIR-44 read model](canonical-person.md), which reads the `roleLinks` this contract records as owner `same` decisions.
- `people.json`, `titles.json`, `data/person-names.json` and `programme.json` are not rewritten by a name confirmation. The programme and watchlist reads, and the EPG commit, overlay the stored owner name after the dictionary and the cache (`overlayOwnerPersonNames` in `src/sources.js`). A later automatic or dictionary value is held, not applied.
