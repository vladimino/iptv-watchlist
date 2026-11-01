# Film reviewed-title review contract

**Role:** maintained contract for the owner's manual choice of a Film's preferred Russian title, delivered offline by [AIR-125](https://trello.com/c/28a7lYcl). It is implemented in [`src/domain/film-title-review.js`](../../../src/domain/film-title-review.js) and tested by `tests/film-title-review.mjs`. The module is pure: it validates a command against a Film projection and returns the next projection, an audit entry and a version token. It does not read or write R2 or D1. The Worker bundle loads it so the admin route can call it. The live writer is [`POST /api/admin/films/<storedId>/title-review`](../api/admin.md#film-title-review-post-apiadminfilmsstoredidtitle-review) ([AIR-53](https://trello.com/c/gkuy1awG), [ADR 0072](../../adr/0072-owner-reviewed-localization-overlay.md), Accepted). [AIR-78](https://trello.com/c/COdMTjqU) is declined and is not a gate. Deploying the route writes nothing; the owner confirms one title in `/admin`.

Related: [Film/Person lifecycle contract](film-person.md) (the localization dimension and `applyReviewedLocalization`), [admin read contract](admin-read-contract.md) (the record shape search and queues consume), [ADR 0009](../../adr/0009-canonical-film-person-identity.md) (identity is not changed by a title review).

## What a title review is

One Film, one command. The owner either **selects** an existing text already attached to the Film (`mode: alias`: the current preferred value, a title alias, the original title or the EPG title) or **types** a title (`mode: manual`). `effect` chooses what that text does. `add_alias` appends one title alias with owner provenance and does not change `localization`: the preferred title, its status, its source and its authority stay as they are. `promote`, and a command that omits `effect`, sets `localization` to status `reviewed` with `authority: owner`. The previous preferred value stays as a title alias. When that text is already an alias, `mergeAliases` keeps the first row and the transition stamps `previousPreferred: true` on it, so a programme or Wikidata row is not dropped and stays selectable. The chosen preferred value stops being an alias. Either effect leaves the Film's id, `canonicalIdentity`, external ids, identity, metadata, fingerprint and prediction untouched. An old audit entry that has no `effect` stays a preferred change; it is not reread as an alias add.

A title review is **not** an identity merge or split, a bulk update, a re-enrichment, a model call or a dictionary edit. `data/film-titles.json` is unchanged by this contract.

## Read model

`titleReviewState(film)` returns, for the review screen:

| Field | Meaning |
| --- | --- |
| `filmId`, `canonicalIdentity` | Copied from the Film; shown, never edited here |
| `version` | Compare-and-set token, see below |
| `preferred` | `value` (`preferredTitle(film)`), `status` (`missing` / `provisional` / `reviewed`), `source`, `authority`, `reviewedAt` (only when reviewed), `basis` |
| `options[]` | Selectable texts in display order: `value`, `origin` (`preferred`, `alias`, `original`, `epg`), `provenance`, `preferred` flag. Duplicate texts collapse to their first occurrence. `filmView` already seeds the original and EPG titles as aliases, so they usually appear as `alias` with `provenance.source` `letterboxd` or `epg`. The admin record merges two further lists onto that Film before `titleReviewState`: the published film's `aliases` (`provenance.source` `programme`; an entry that already carries provenance keeps it) and the dictionary entry's `aliases` (`provenance.source` `dictionary`). A text equal to the current preferred value is not added again. The read model still lists every text. The `/admin` card does not turn that list into radios. It pins the current localized preferred title first, including a provisional Wikidata or automatic value, labeled «текущее предпочтительное». A missing localization whose `preferredTitle` falls back to the original is not that pin, so a Latin original is not offered as a Russian choice. It then pins a previous preferred title: an alias with `previousPreferred: true`, and, when that flag was not stored, the `from.value` of a confirmed preferred-change audit (`effect` absent with `to.status: reviewed`, or `effect: 'preferred_changed'`). An `alias_added` row does not create that radio. Ordinary choices are then at most five further texts whose provenance `source` or `authority` is `dictionary` or `owner`. Either field qualifies, including `authority: dictionary` when `source` is absent or is something else. A Cyrillic string with neither mark is not a choice. The current and previous titles are outside that cap. The other texts stay in the closed «Другие названия» list, in `alias` mode and in search |
| `reviews[]` | The audit trail stored on the Film as `titleReviews` |
| `heldConflicts` | Count of `localizationConflicts`, the automatic values held back by reviewed precedence |

`titleReviewProjection(film)` returns the Film in the [AIR-123 record shape](admin-read-contract.md#air-123-query-contract): `preferred` is the localized value or `null`, never the original title. Search finds a reviewed Film by its new title and still by the old title through the alias; a reviewed Film leaves the `localization-provisional` queue, and a held automatic value shows in `localization-conflict`.

## Command

```text
{ filmId, requestId, mode: 'alias' | 'manual', value, expectedVersion, basis?, effect?: 'promote' | 'add_alias' }
```

| Rule | Failure `reason` |
| --- | --- |
| The Film must exist and `filmId` must equal `film.id` | `missing_film`, `film_mismatch` |
| `requestId` is a non-empty string; it is the idempotency key | `missing_request_id` |
| The command carries no identity fields (`id`, `canonicalIdentity`, `externalIds`, `identity`, `tmdbId`, `letterboxdId`, `redirects`) | `identity_change_forbidden` with `field` |
| `mode` is `alias` or `manual` | `invalid_mode` |
| `effect`, when given, is `promote` or `add_alias`. Absent `effect` is the historical promote and is not stored on the audit | `invalid_effect` |
| `value` is a string; whitespace runs collapse to one space and the ends are trimmed; the result is 1–200 characters without control characters | `invalid_title` |
| `basis`, when given, is a string of at most 500 characters; it is trimmed and an empty string reads as no basis | `invalid_basis` |
| A Film with `identity.status: rejected` is not reviewed | `rejected_identity` |
| `expectedVersion` equals the current `titleReviewVersion(film)`; a missing token is a conflict, not a bypass | `version_conflict` with `expected` and `received` |
| In `alias` mode `value` must be one of `options[].value` | `unknown_alias` with `options` |

The checks run in the order listed and fall into two groups. The **shape checks** (`missing_film` through `invalid_basis`) judge the command on its own against the Film's identity and hold for a retry as much as for a new review. The **state checks** (`rejected_identity`, `version_conflict`, `unknown_alias`) judge whether a new change is allowed against the Film's current title state. `validateTitleReview(film, command)` runs both groups and returns `{ ok: true, value, basis, version, selected }` without changing anything. Failures return `{ ok: false, reason, ... }` and never a Film.

## Transition

`applyTitleReview(film, command, at)`:

1. **Shape.** The shape checks above run first; a mismatching `filmId`, an identity field, an invalid mode, title or basis is refused before anything is looked up, so such a command is never answered with an earlier outcome.
2. **Replay.** If `film.titleReviews` already holds `command.requestId`, the entry is compared with the command on every semantic field: `filmId`, `mode`, normalized `value`, normalized `basis` and `effect` (`null` when the command or the stored entry omits it). When all match, the earlier outcome is returned: `{ ok: true, idempotent: true, changed: false, film, review, version }` with the same Film object. This deliberately ignores `expectedVersion`: a retry of a committed request carries the token from before that request, and later changes to the Film (another review, a held automatic value) do not turn the retry into a conflict. The same `requestId` with any other payload, including a different `effect`, is `request_id_reused` with the stored `review`; an entry recorded for another Film never replays. An entry stored without `effect` is not treated as `add_alias`.
3. **State.** `rejected_identity`, `version_conflict`, `unknown_alias` as above. `alias` mode still requires the text to be one of `options`, for both effects. `manual` with `add_alias` may introduce a new title.
4. **Alias.** When the resolved effect is `alias_added` and the text is already a preferred value, an alias, the original or the EPG title, the result is `{ ok: true, changed: false, reason: 'duplicate_alias', review: null }` and nothing is appended. Otherwise one `{ kind: 'title' }` alias is merged, with provenance `{ source: 'owner', authority: 'owner', mode, basis, requestId, added: 'alias' }`. `localization` is the same object. The audit entry has `effect: 'alias_added'`, `requestId`, and `to.status` equal to the current localization status, not `reviewed`.
5. **No-op promote.** If the effect is a promote and the Film is already `reviewed` with this exact value, `{ ok: true, changed: false, film, review: null, version }`. No audit entry is written.
6. **Apply promote** through `applyReviewedLocalization(film, { value, authority: 'owner', source: 'owner', provenance }, at, 'title')` from the lifecycle contract. `provenance` is `{ source: 'owner', authority: 'owner', mode, basis, requestId, selectedFrom }`, where `selectedFrom` names where a selected text came from (`epg`, `letterboxd`, `wikidata`, `original`, `preferred`, …) and is `null` for a typed title. The previous preferred value becomes a title alias with its own provenance, or keeps the existing row when `mergeAliases` already has that text; that row then gets `previousPreferred: true` and `historicalSource`. The chosen value is removed from the aliases.
7. **Audit.** One entry is appended to `titleReviews`: `{ contractVersion, requestId, filmId, at, mode, authority: 'owner', basis, selectedFrom, from: { value, status, source }, to: { value, status }, version: { before, after } }`. A promote stores `to.status: 'reviewed'`. An explicit promote also stores `effect: 'preferred_changed'`. A command that omits `effect` does not add the field. An alias add stores `effect: 'alias_added'` and does not describe itself as a preferred-title change. Earlier entries are kept as they were. No migration rewrites them.
8. **Result.** `{ ok: true, changed: true, film: next, review, version: next version }`. The input Film is never mutated. An alias add returns before the promote steps.

Legal transitions are the lifecycle contract's: `missing → reviewed`, `provisional → reviewed`, `reviewed → reviewed`. `reviewed → provisional` and `reviewed → missing` do not exist, so a later automatic refresh (`applyAutomaticLocalization`) holds its value in `localizationConflicts` with reason `untrusted_review`, a spoofed `status: reviewed` from an automatic source is held too, and a dictionary or other non-owner authority cannot replace the owner's title (`untrusted_authority`). `linkFilms` keeps the survivor's reviewed title and its `titleReviews`.

## Version token (compare-and-set)

`titleReviewVersion(film)` is `title-review:1:<hash>` over everything `titleReviewState` shows, serialized with sorted keys so that key and alias order do not matter:

- the whole `localization` envelope, including its `provenance` (`basis`, `requestId`, `selectedFrom`, `authority`, …);
- the title aliases with their provenance;
- the selectable option texts (so a changed original or EPG title counts);
- the earlier audit entries (`titleReviews`) in full and in order, except each entry's own `version.after`: that field is the token of the state the entry belongs to, so it is stamped after the token is computed and cannot be part of it;
- the `localizationConflicts` held by reviewed precedence.

Metadata, fingerprint, prediction and identity are not part of it. Any successful review changes the token, and so does a provenance-only, conflict-only or audit-history-only concurrent change (a corrected `basis`, `selectedFrom`, timestamp or `from`/`to` on an earlier entry under the same `requestId`): a screen that shows stale provenance or history, or misses a newly held value, cannot pass the check and has to reload. A stale token is `version_conflict`; the only command that is accepted with a stale or missing token is the replay of an already committed `requestId` (see Transition). The live writer maps this token onto the screen the owner is looking at and maps the R2 etag of `admin/owner-reviews.json` onto the stored object. Both checks happen before the one put. Offline, this token is the only version there is.

## Where the result is stored

The transition stays in this module. [`src/admin/film-title-route.js`](../../../src/admin/film-title-route.js) persists a changed result in `admin/owner-reviews.json` under the programme stored id and copies the `people` map unchanged. A promote stores the owner localization. An alias add stores `localization: null` together with the aliases and `titleReviews`, so a later read does not invent an owner-reviewed preferred title. The same R2 object, etag and screen token are the compare-and-set; this command does not add a second object. The admin film card pins the current localized preferred title and any confirmed previous preferred title, then at most five other dictionary or owner choices, a text field, an optional basis and the checkbox «Использовать как предпочтительное». The checkbox starts off and the preview is hidden. Choosing another existing radio checks it, so «Сохранить вариант» sends `promote` for that radio; choosing the current preferred title, or turning the box off on an existing radio, sends nothing. A typed title sends `add_alias` with the box off and `promote` with the box on. The preview appears only for a real promote target (`Сейчас` → `Станет`). A `changed: false` answer that is not an idempotent replay stays on the card. Film alias rows are the title text; kind stays in the technical disclosure. The audit is a closed «Журнал (N)» after every other film section, times are Europe/Madrid civil time, and an empty audit adds no block. A retry whose outcome is still unknown posts the original command, including `effect` and `expectedVersion`, rather than a command rebuilt from the reloaded card. The page treats the write as stored only when the audit for that `requestId` has an after-token. An alias add is stored only when that audit's effect is `alias_added`, its `to.value` is the submitted text, and the reloaded record's aliases contain that text with owner-added provenance. Membership in `titleReview.options` is not proof. An unchanged preferred title is not that proof. Programme, watchlist, film detail and admin search show an owner-reviewed title ahead of the dictionary and the automatic cache, and they show an alias-only overlay as extra alias text without changing the preferred title. The next EPG or metadata update does not write the overlay.

## Not in this contract

- No alias delete or rename, no bulk review, no identity merge or split, no refresh and no sync. Adding one alias is `effect: 'add_alias'` on this command.
- No Person names. [AIR-54](https://trello.com/c/yKtj1ahy) writes the `people` map of the same object and does not change `films`.
- No write to `titles.json`, `data/film-titles.json`, `programme.json`, `watchlist.json`, a published generation, or D1. A reviewed dictionary title of the same text is still a no-op: it does not become an owner title.
