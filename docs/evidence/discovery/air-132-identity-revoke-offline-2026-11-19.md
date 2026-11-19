# AIR-132: revoke one saved identity correction, offline evidence, 19 November 2026

[AIR-132](https://trello.com/c/3AXbSoHe) · [ADR 0178](../../adr/0178-identity-correction-revoke-event-contract.md) (Accepted, owner choice A + A1 recorded in the card). Offline tests and a local browser check only. **No production read or write was made, no migration was applied, no Discovery chunk, TMDB call, EPG run, flag or Scheduled Task was touched.** No production correction exists to revoke (none was confirmed when [AIR-65](https://trello.com/c/MKb4JMXi) closed), and none was created for a test.

## What the tests prove

| File | Proves |
| --- | --- |
| `tests/discovery-intent-migration-0027.mjs` | 0027 applies only to a complete version 26; every `discovery_intent` row is copied unchanged; the new kind is accepted, an unknown kind, a duplicate key and a bad state are refused; the table stays STRICT with no leftover; the version never goes down; a second apply and a version-24 database are refused |
| `tests/discovery-identity-revoke.mjs` | Real D1 stand-in writer: assign then revoke (decision, history row appended, original intent kept, assigned shows of that observation gone, another observation and its shows untouched, no Film change); reading the evidence writes nothing; replay returns the receipt; a second revoke of the same original is `old_action_not_effective`; reject then revoke keeps an independent exclusion and writes no negative fence; a reject of an already excluded id is `provenance_ambiguous`; stale hash, missing lease, a next decision that keeps the marker, a revoke intent with a non-revoke command, and an unknown (running) outcome are all refused with nothing written; supersede is written only when bound to the original and the exact hash, and refused for another observation or another hash; the pure refusals (`intent_missing`, `intent_not_applied`, `not_identity_action`, no introducing revision, no prior image, wrong writer, another owner action, a newer independent decision, a later revision that dropped the marker); a carried marker with a drifted `evidenceKey` stays revocable; `identityBasis` ignores airings, durations and scores; the resolver's `ownerMarkerCarry` keeps the fence and `ownerRejected` blocks exactly the revoked id |
| `tests/discovery-authority.mjs` (HTTP section) | Through the real Worker routes on a D1 stand-in with the 0027 DDL applied: the preview writes nothing and states the fence; `intent_missing`, `wrong_observation`, 400 and 405 answers; no Access assertion is 403; `confirmation_missing`, `basis_required`, `stale_pin`, a non-fresh key; before 0027 `revoke_schema_not_ready` and nothing written; after it confirm, a tampered confirmation (400), execute, replay, `identity-receipt` readback, and the post-revoke preview `already_revoked`; unrelated decisions, the original intent and `film` untouched |
| `tests/admin-identity-revoke-page.mjs` | Static boundary of the page and bundle, the client (one GET, two POSTs, action header, same-origin credentials, fresh key, no retry, network mapping) and the pure view (every reason has wording, stored text is escaped, empty history stated) |

## Rollback compatibility of migration 0027 (old code, new kind)

The pre-change Worker source (`main` at `a11d0ca0`) was run offline against a stand-in built from the full migration chain (schema 27 with 0027) that holds one `identity_revoke` intent in state `receipt`: `readIntent` returns the row without filtering on kind; `putIntent` with the same key is refused (`saved: false`); `ownerDecision` on that key answers `replay` with the stored receipt and writes nothing. The old `identity-receipt` route serves any non-`reconsider` intent, so the receipt stays readable. The old `identity-correct` route refuses a confirmation whose version is not an assign or reject (`parseIdentityVersion` is null), and `tests/discovery-authority.mjs` now pins the cross-route refusal in both directions (`unsupported_capability`). A code rollback therefore leaves the new rows inert and readable and cannot execute them; it does not revert D1 rows or the schema version, and the table rebuild itself has no down migration (the version never goes down).

## Local browser check (Visual QA, written report, no screenshots)

Chromium via Playwright against the built Worker's static assets with the three revoke routes answered by fixed fakes. Desktop 1280 px and mobile 390 px, keyboard only (Enter to preview, Tab and Space for the checkbox, Enter on the confirm and execute buttons):

- nothing is requested on load; the link parameters prefill both fields;
- confirm stays disabled until the basis is typed and the box ticked; after confirm the execute button takes focus and the fields lock; after execute the receipt takes focus and the read-back shows «Это действие уже отозвано»;
- the request sequence is preview, confirm, execute, preview and no other;
- no horizontal overflow at either width; every visible button and the checkbox are at least 44 px; the only console error is the shared footer status call, which the fake server does not serve.

The Mermaid diagram of `docs/architecture/discovery-and-resolution.md` is not changed by this PR, so no rendered Mermaid QA applies.

## Not proven here

- The real POST on production, and the product acceptance of it, stay with the owner. There is no production correction to revoke; an offline test does not replace that action or an explicit owner waiver.
- Migration 0027 on production D1 (separate owner GO, own evidence). Until then the confirm route answers `revoke_schema_not_ready`.
- A link from a queue row to this page and from the Limbo panel is not part of this PR.
- Behaviour of the next ordinary chunk on a fenced observation is covered by the carry and consumer checks above, not by a production chunk.
