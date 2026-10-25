# Film reviewed-title review contract

**Role:** maintained contract for the owner's manual choice of a Film's preferred Russian title, delivered offline by [AIR-125](https://trello.com/c/28a7lYcl). It is implemented in [`src/domain/film-title-review.js`](../../../src/domain/film-title-review.js) and tested by `tests/film-title-review.mjs`. The module is pure: it validates a command against a Film projection and returns the next projection, an audit entry and a version token. It does not read or write R2 or D1, is not in the Worker bundle, has no HTTP route and no UI. The guarded live writer is a separate card, [AIR-53](https://trello.com/c/gkuy1awG), gated by [AIR-69](https://trello.com/c/FlcWZX7W) and the storage gate [AIR-78](https://trello.com/c/COdMTjqU). Shipping this contract does not authorize that writer.

Related: [Film/Person lifecycle contract](film-person.md) (the localization dimension and `applyReviewedLocalization`), [admin read contract](admin-read-contract.md) (the record shape search and queues consume), [ADR 0009](../../adr/0009-canonical-film-person-identity.md) (identity is not changed by a title review).

## What a title review is

One Film, one preferred title. The owner either **selects** an existing text already attached to the Film (`mode: alias`: the current preferred value, a title alias, the original title or the EPG title) or **types** a title (`mode: manual`). The result is the Film's `localization` dimension in status `reviewed` with `authority: owner`. The previous preferred value stays as a title alias, the chosen value stops being an alias, and the Film keeps its id, `canonicalIdentity`, external ids, identity, metadata, fingerprint and prediction untouched.

A title review is **not** an identity merge or split, a bulk update, a re-enrichment, a model call or a dictionary edit. `data/film-titles.json` is unchanged by this contract.

## Read model

`titleReviewState(film)` returns, for the review screen:

| Field | Meaning |
| --- | --- |
| `filmId`, `canonicalIdentity` | Copied from the Film; shown, never edited here |
| `version` | Compare-and-set token, see below |
| `preferred` | `value` (`preferredTitle(film)`), `status` (`missing` / `provisional` / `reviewed`), `source`, `authority`, `reviewedAt` (only when reviewed), `basis` |
| `options[]` | Selectable texts in display order: `value`, `origin` (`preferred`, `alias`, `original`, `epg`), `provenance`, `preferred` flag. Duplicate texts collapse to their first occurrence. `filmView` already seeds the original and EPG titles as aliases, so they usually appear as `alias` with `provenance.source` `letterboxd` or `epg` |
| `reviews[]` | The audit trail stored on the Film as `titleReviews` |
| `heldConflicts` | Count of `localizationConflicts`, the automatic values held back by reviewed precedence |

`titleReviewProjection(film)` returns the Film in the [AIR-123 record shape](admin-read-contract.md#air-123-query-contract): `preferred` is the localized value or `null`, never the original title. Search finds a reviewed Film by its new title and still by the old title through the alias; a reviewed Film leaves the `localization-provisional` queue, and a held automatic value shows in `localization-conflict`.

## Command

```text
{ filmId, requestId, mode: 'alias' | 'manual', value, expectedVersion, basis? }
```

| Rule | Failure `reason` |
| --- | --- |
| The Film must exist and `filmId` must equal `film.id` | `missing_film`, `film_mismatch` |
| `requestId` is a non-empty string; it is the idempotency key | `missing_request_id` |
| The command carries no identity fields (`id`, `canonicalIdentity`, `externalIds`, `identity`, `tmdbId`, `letterboxdId`, `redirects`) | `identity_change_forbidden` with `field` |
| `mode` is `alias` or `manual` | `invalid_mode` |
| A Film with `identity.status: rejected` is not reviewed | `rejected_identity` |
| `value` is a string; whitespace runs collapse to one space and the ends are trimmed; the result is 1–200 characters without control characters | `invalid_title` |
| `basis`, when given, is a string of at most 500 characters | `invalid_basis` |
| `expectedVersion` equals the current `titleReviewVersion(film)`; a missing token is a conflict, not a bypass | `version_conflict` with `expected` and `received` |
| In `alias` mode `value` must be one of `options[].value` | `unknown_alias` with `options` |

`validateTitleReview(film, command)` runs these checks and returns `{ ok: true, value, version, selected }` without changing anything. The checks run in the order listed. Failures return `{ ok: false, reason, ... }` and never a Film.

## Transition

`applyTitleReview(film, command, at)`:

1. **Replay.** If `film.titleReviews` already holds `command.requestId` with the same `mode` and normalized `value`, the earlier outcome is returned: `{ ok: true, idempotent: true, changed: false, film, review, version }` with the same Film object. The same `requestId` with a different payload is `request_id_reused`.
2. **Validate** as above.
3. **No-op.** If the Film is already `reviewed` with this exact value, `{ ok: true, changed: false, film, review: null, version }`. No audit entry is written.
4. **Apply** through `applyReviewedLocalization(film, { value, authority: 'owner', source: 'owner', provenance }, at, 'title')` from the lifecycle contract. `provenance` is `{ source: 'owner', authority: 'owner', mode, basis, requestId, selectedFrom }`, where `selectedFrom` names where a selected text came from (`epg`, `letterboxd`, `wikidata`, `original`, `preferred`, …) and is `null` for a typed title. The previous preferred value becomes a title alias with its own provenance; the chosen value is removed from the aliases.
5. **Audit.** One entry is appended to `titleReviews`: `{ contractVersion, requestId, at, mode, authority: 'owner', basis, selectedFrom, from: { value, status, source }, to: { value, status: 'reviewed' }, version: { before, after } }`. Earlier entries are kept as they were.
6. **Result.** `{ ok: true, changed: true, film: next, review, version: next version }`. The input Film is never mutated.

Legal transitions are the lifecycle contract's: `missing → reviewed`, `provisional → reviewed`, `reviewed → reviewed`. `reviewed → provisional` and `reviewed → missing` do not exist, so a later automatic refresh (`applyAutomaticLocalization`) holds its value in `localizationConflicts` with reason `untrusted_review`, a spoofed `status: reviewed` from an automatic source is held too, and a dictionary or other non-owner authority cannot replace the owner's title (`untrusted_authority`). `linkFilms` keeps the survivor's reviewed title and its `titleReviews`.

## Version token (compare-and-set)

`titleReviewVersion(film)` is `title-review:1:<hash>` over the fields a review may change: the localization `status`, `value`, `updatedAt`, `source`, `sourceVersion` and `authority`, the sorted title-alias values, and the `requestId`s of earlier reviews. Metadata, fingerprint, prediction and identity are not part of it. Any successful review changes the token; a stale token from before another review is `version_conflict`. A storage adapter (AIR-53) may map this token onto a row version or etag and must check the mapped version in the same write. Offline, this token is the only version there is.

## Not in this contract

- No route, no UI, no fixture page changes; `/admin` stays fixture-only ([AIR-52](https://trello.com/c/siWtiRcm)).
- No alias CRUD, no bulk review, no Person names ([AIR-126](https://trello.com/c/fTMyNpi5) covers the Person RU-name contract).
- No change to how `titles.json`, `data/film-titles.json`, `programme.json` or `watchlist.json` are written today. The runtime still applies reviewed precedence through `src/sources.js`; this contract adds the owner's manual review as a future input to that precedence, not a new runtime path.
