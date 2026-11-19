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

## Review of PR 796: fixes and how each is proven

| Finding | Fix | Proof |
| --- | --- | --- |
| A1: the fence was dropped by the non-film screening transition | `fenceCarry` on the screening, alias and TMDB-verified transitions, paged D1 cheap pass and whole-ledger path | `tests/discovery-chunk-budget.mjs` section 12b (real paged chunk: revoke fence, screened as non-film, confirmed id 41 appears, 41 is not re-verified, fence stored) and `tests/discovery-identity-review.mjs` (the whole-ledger `resolveDiscoveryBatch` twin). Mutation: removing the carry in either branch fails its test |
| Supersede not an effective-action contract | `identity-confirm` takes and proves `supersedes`, `identity-correct` proves it again, the writer checks `originalStillEffective` inside the CAS fence | `tests/discovery-authority.mjs` HTTP section (confirm refusals: bad shape, unknown, self, not effective; confirm stores the binding; execute writes, replays, keeps the superseded intent; the superseded action is no longer effective; a decision changed after confirmation writes nothing) and `tests/discovery-identity-revoke.mjs` (a superseded original named with the exact current hash is refused by the writer; the live original is accepted). Mutation: disabling the writer check fails the writer test |
| No entry point | `GET discovery-recovery` carries a proven `revoke` field; the Limbo identity section links to the page only for a proven action | `tests/admin-discovery-recovery-page.mjs` (link with both identifiers, no link and the reason for an unproven action, none without a saved action, escaping) and the HTTP section (`revoke.available`, the first action not offered again) |
| `identityBasis` missing on assign and reject | `identity-correct` computes and records it | HTTP section asserts the stored `ownerIdentity.identityBasis` of the live assign |
| Schema-not-ready masked a D1 fault | `revokeSchemaReady` reads the stored table definition; other faults propagate as `storage_unavailable` | HTTP section: a simulated D1 failure on the intent insert answers 503 `storage_unavailable`, writes nothing and is not `revoke_schema_not_ready` |
| Reject revoke after a later independent verification | A `verified` decision is not a carry of a rejection | `tests/discovery-identity-revoke.mjs` |

Browser check of the replace form (same method, 1280 px and 390 px, keyboard only): the form is hidden until a preview allows it, confirm stays disabled until id, basis and box are set, the id and basis fields lock after confirm and the revoke form locks with them, focus moves to the execute button and then to the receipt, the request sequence is preview, `identity-confirm` (with `supersedes`), `identity-correct`, preview, and the read-back says the old action is no longer effective. No horizontal overflow. Checkboxes are 20 px inside labels with the existing 44 px minimum height.

## Not proven here

- The real POST on production, and the product acceptance of it, stay with the owner. There is no production correction to revoke; an offline test does not replace that action or an explicit owner waiver.
- Migration 0027 on production D1 (separate owner GO, own evidence). Until then the confirm route answers `revoke_schema_not_ready`.
- A link from a row of the read-only `/admin/identity` queue is not added (the queue stays read-only); the entry is the Limbo observation detail.
- Behaviour of the next ordinary chunk on a fenced observation is covered by the carry and consumer checks above, not by a production chunk.
