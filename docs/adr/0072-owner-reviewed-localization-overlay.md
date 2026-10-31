# ADR 0072: Owner-reviewed Film titles and Person names live in one R2 overlay

**Status:** Proposed  
**Original decision date:** 2026-10-31  
**Recorded at:** 2026-10-31  
**Approval source:** not documented  
**Related work:** [AIR-53](https://trello.com/c/gkuy1awG), [AIR-54](https://trello.com/c/yKtj1ahy), [film title review](../reference/domain/film-title-review.md), [person name review](../reference/domain/person-name-review.md)  
**Supersedes:** None  
**Superseded by:** None

## Context

The owner's preferred Russian title of one Film is already a pure transition (`applyTitleReview`). The same shape exists for one Person name (`applyPersonNameReview`), including role links that must commit together. Neither transition had a store. A title written only onto `programme.json` would disappear the next time an EPG generation is published. `titles.json` and `people.json` are automatic caches. `data/film-titles.json` and `data/person-names.json` are the hardcoded dictionaries. D1 follows R2 and is not the authority for a title the owner just confirmed.

AIR-53 and AIR-54 need one shared object so the two writers do not invent two formats. The Film writer and the Person writer are still separate routes, separate UI and separate domain modules.

## Decision

1. **One overlay object.** `admin/owner-reviews.json` holds `{contractVersion: 1, films, people}`. `films` is keyed by the programme stored id. A film slice is `{filmId, localization, aliases, titleReviews, localizationConflicts}`. `people` is keyed by the role-specific person id. A person slice is `{localization, aliases, nameReviews, localizationConflicts, roleLinks}`. Absent object is an empty document. A body that is not an object, or whose `films` or `people` is not an object, is unreadable.
2. **Each writer touches one map.** The Film route replaces one `films` entry and copies `people` unchanged. The Person route replaces the `people` entries of one command and copies `films` unchanged. Role links are one put of every record that command commits. A replay is success only when that command's completion is already stored. This record describes both maps. It does not implement the Person route.
3. **Two compare-and-set checks, one put.** The screen token is the existing domain token (`title-review:1:…` or the person-name token). The storage token is the object's R2 etag: `onlyIf.etagMatches` when the object exists, `etagDoesNotMatch: '*'` when it does not. There is no unconditional put. A lost etag reloads the snapshot once. If the domain token then mismatches, the answer is 409 `version_conflict`. A second lost put is the same 409. The same `requestId` and the same payload return the earlier result and do not put. A different payload under that `requestId` is 409 `request_id_reused`.
4. **Readback.** After the put, the route reads the object. The stored audit entry must contain that `requestId` and the new domain token. Anything else is 503 `storage_unavailable` with reason `readback_failed` and is not success. The admin snapshot cache is dropped after the put.
5. **Precedence is applied in memory.** Owner explicit, then the hardcoded dictionary, then the automatic cache. Programme, watchlist, admin detail and admin search stamp a reviewed owner localization before the dictionary. The next EPG or metadata update does not write this object and does not delete it. The next read stamps it again. An owner value that differs from the dictionary is kept, and the dictionary value is a conflict (`owner_kept`). The same text is not a conflict. A reviewed dictionary title that the owner selects unchanged does not become an owner title and writes nothing: the domain no-op stands.
6. **What this object is not.** It is not `programme.json`, `titles.json`, `people.json`, `epg/published-generation.json`, a generation object, or a D1 row. Identity fields are refused. There is no merge, split, bulk edit, refresh or sync on this route. GET does not write it. Deploying the Worker does not create it. The first confirmed POST creates it.
7. **Admin pin.** The catalogue pin is version `2` and includes the overlay etag (empty when the object is absent). A pin from version `1` does not parse. A changed overlay etag is a stale pin. The limbo pin wraps that catalogue pin.

Not decided here: accepting this record, the Person route and its UI (AIR-54), any production confirmation of a real title, and any change to Cloudflare Access.

## Alternatives considered

- **Write the title onto the published programme object.** Rejected. The next EPG publication replaces that object, and ordinary readers would lose the title.
- **Store the title in `titles.json` or the hardcoded dictionary.** Rejected. Those are the automatic cache and the dictionary, which this precedence puts below an owner choice. Editing them from the admin form would mix the three layers.
- **One object per film.** Rejected. Role links need one put of several person records, and two writers need one etag so a film write cannot drop a person write that landed between a read and a put.
- **D1 as the store.** Rejected. R2 remains the authority. The enrichment projector may follow later; it does not lead.

## Consequences

Programme and watchlist reads, the admin snapshot, health and limbo each gain one R2 get of this key. The key is inside the existing Worker-to-R2 boundary. A warm admin isolate must include the overlay etag in its cache key, or it will serve the title from before the write. The Person writer has to copy `films` verbatim. A film write that rebuilt `people` would erase a name review.

Code rollback does not delete the object. A later deploy of the previous Worker would ignore the object and show dictionary or automatic titles again, while the object remains for a forward deploy to read.

## Recovery and migration boundary

Creating the route does not write R2. The object appears only when the owner confirms one title in `/admin`. That confirmation is the production write. It is not authorized by merging this record. No flag, Access policy, Scheduled Task, EPG run, or D1 migration is part of this decision. Rollback of the Worker is the [code rollback](../runbooks/deployment.md); it does not remove `admin/owner-reviews.json`.

## Evidence

- **Original decision:** shared contract on [AIR-53](https://trello.com/c/gkuy1awG) and [AIR-54](https://trello.com/c/yKtj1ahy), 2026-10-31.
- **Implementation:** the Film route in this change. The Person route is not in this change.
- **Dated verification:** `not recorded` until the owner confirms one real title after deploy.
- **Uncertainty:** production R2 etags are present on objects this Worker writes. A stored object with an empty etag is not a case this route special-cases.

## Follow-ups

AIR-54 implements the `people` map on this object and does not add a second ADR for the same store. Owner acceptance of this record is separate from merge of the Film route.
