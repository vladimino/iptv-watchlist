# AIR-664: cleanup of the recovery artifacts of the production repair

Date: **28 November 2026** (UTC). Card: [AIR-664](https://trello.com/c/Og9XxXfy); [ADR 0225](../../adr/0225-one-off-localization-repair-checkpoint-in-r2.md) (Accepted); runbook: [one-off repair](../../runbooks/film-localization-reconciliation.md#one-off-repair-of-the-16-observed-films-air-664). This report is the **successor** of [the production repair evidence](air-664-localization-repair-production-2026-11-28.md), whose section 7 recorded the recovery artifacts as retained. That report describes the state at its own time and is not rewritten; **this report describes the current state of those artifacts.**

**Status: the 32 recovery artifacts were deleted once, under a separate owner GO, and the deletion was read back.** The restore window of the repair is closed. The 16 applied receipts, the canonical revisions, the localization rows and the sources are unchanged. No D1 write, restore, apply, flag, Task, Access or code change was made.

## 1. Authorization and provenance

| Item | Record |
| --- | --- |
| Owner acceptance | 28 Nov 2026, in the owner's chat, as recorded by the Controller: «результат принимаю, recovery-артефакты нужно чистить»; the repair result 16 of 16 was accepted and a restore (which would undo the successful repair) was not requested. Record: [Controller acceptance and cleanup preflight](https://trello.com/c/Og9XxXfy#comment-6b0a7e886e2da9e7fff59dac) |
| Executor handoff | [Controller handoff](https://trello.com/c/Og9XxXfy#comment-6b0a7f27e92cb51d128bb7c2): the executor performs the deletion after presenting an exact plan and recording a separate owner GO; the Controller checks the result independently |
| L3 plan | Presented in the session chat and recorded in [the plan comment](https://trello.com/c/Og9XxXfy#comment-6b0a800c9858bcf648388aef) at 2026-11-28T07:17:16Z (08:17 Madrid) |
| Owner GO | 2026-11-28T07:19:31.893Z, in the Claude Code session ([session](https://claude.ai/code/session_014nGEiYM1Db5YvEyunyiYB7)), verbatim: «GO AIR-664 cleanup: manifest 57a8b474, 32 объекта, закрыть restore window». Recorded before the first deletion in [the GO record](https://trello.com/c/Og9XxXfy#comment-6b0a808cd42e5bc553a72da6). The GO named the manifest digest prefix; the full digest below is the one in the plan |
| Actor | Claude Code, through the Cloudflare API MCP connector (`search` and `execute` over the Cloudflare REST API), authenticated as the owner's Cloudflare user. The identity is not recorded here beyond that |

## 2. Scope and method

Only the private R2 bucket `iptv`, and only the operation prefix `film-localization-repair/air-664/` (the immutable intent and outcome objects of the repair, see the [ADR 0225](../../adr/0225-one-off-localization-repair-checkpoint-in-r2.md) checkpoint). One execution, in this order:

1. A fresh full listing of the prefix, paginated and checked for truncation.
2. The manifest digest recomputed and compared with the approved one; a difference stops the run with no deletion.
3. A strict membership check: every key matches the intent or the `0001` outcome-event pattern, the intent and event identities each equal the 16 applied receipts of kind `film_localization_reconcile` read from D1 (a SELECT), and their targets equal the fixed cohort; any difference stops the run with no deletion.
4. Deletion by exact key, one object per request, sequentially, with a canary: after the first deletion an exact-key listing must be empty, otherwise stop. Any error, any non-success answer or any ambiguity stops the run; no retry.
5. A final listing of the prefix.

Used: the single-object delete of the Cloudflare R2 objects API (permission «Workers R2 Storage Write»). **Not used:** the bulk delete by prefix, a wildcard, a bucket delete, a lifecycle rule, a TTL, a new route or writer. Keys, ETags and object bodies were never printed, read into this report or published; the run returned counts, digests and booleans only.

## 3. State before (read-only L0, 28 Nov 2026 about 07:15 UTC)

| Item | Result |
| --- | --- |
| Listing | 1 page, not truncated; **32 unique objects** |
| Composition | 16 intent objects + 16 outcome events (sequence `0001` only, one per intent), 0 others |
| Size | **30,948 bytes**; last-modified range 2026-11-28T06:43:51.976Z to 06:44:44.380Z |
| Manifest digest | `57a8b4744cbb0f339295c85ee50250ad535546bddb63b4ab4ed0b2c0435070dc`: SHA-256 over the lines `key<TAB>etag<TAB>size`, sorted by key |
| Receipts (D1 SELECT) | 16 of kind `film_localization_reconcile`, all `applied`, `attempts` 1; targets equal the fixed cohort; intent identities equal the receipt identities; event identities equal them as well |
| Active operation | none: the read-only `recover` of the repair tool showed 16 applied intents with one event each and no recorded, in-flight or unknown intent |
| D1 baseline | digests (SHA-256 over row contents, computed inside the sandbox; values never output) of the 16 receipts, the 16 cohort revisions, the 16 localization rows and the 16 source rows, first 16 hex: `169ffeff882441bd`, `6969a3291e54daeb`, `1887cc523065f0dc`, `88099e1425ff4e76`; combined `f09508bef260c829`. All SELECTs reported `rows_written: 0` |

The Controller's earlier read-only preflight ([acceptance record](https://trello.com/c/Og9XxXfy#comment-6b0a7e886e2da9e7fff59dac)) had reported the same 32 objects and 30,948 bytes.

## 4. Execution

| Item | Result |
| --- | --- |
| Time | 2026-11-28T07:23:11.759Z to 07:23:28.083Z (16.3 s), one execution |
| Manifest digest | recomputed before any write and equal to the approved digest |
| Membership | verified (intents 16, events 16, others 0, receipts 16 applied) |
| Deletions | **32 attempts, 32 deleted, 0 errors**; no partial or unknown outcome, no retry |
| Canary | passed (the first deleted key was absent from an exact-key listing) |
| Objects and bytes | before: 32 objects, 30,948 bytes; final listing inside the run: 0 objects |

## 5. State after (executor readback, separate calls, 28 Nov 2026 07:25 UTC)

| Check | Result |
| --- | --- |
| Operation prefix `film-localization-repair/air-664/` | **0 objects, 0 bytes**, not truncated |
| Parent prefix `film-localization-repair/` | 0 objects, 0 bytes, not truncated |
| D1 receipts | the same 16, all `applied`, `attempts` 1 |
| D1 row counts | receipts 16, cohort revisions 16, localization rows 16, source rows 16 |
| D1 digests | all four **equal the baseline** (receipts, revisions, localization, sources) and the combined digest equals it, so request identities, applied revisions, revisions, localization rows and sources did not change |
| D1 writes | every SELECT reported `rows_written: 0` |
| Repair tool, `recover` (read only) | no recorded intent: an empty list (4 D1 queries) |
| Repair tool, `preflight` (read only, 07:25 UTC) | decision `nothing_to_do`; all 16 Films `noop` (the resolver reports each current); eligible, held, absent, unavailable and in-flight 0; pins unchanged: Film/Person generation 2, schema 54, owner-review generation 1, writes open; 222 D1 queries of 1,000 |

## 6. Independent Controller verification and its limits

The Controller's acceptance of the cleanup ([comment](https://trello.com/c/Og9XxXfy#comment-6b0a82a1fd253079535c4b8b)) records an independent read-only check: both R2 listings (the operation prefix and its parent) return empty result arrays, and a D1 SELECT of `canonical_write_receipt` joined to `canonical_revision` (`rows_written: 0`) shows the 16 exact request identities, target ids and full content digests equal to the manifest verified in [review of PR #1065](https://github.com/vladimino/iptv-watchlist/pull/1065#pullrequestreview-6096358524), all applied, one attempt, marker generation 2, applied revision equal to planned revision plus one equal to the current revision, revision time equal to the approved plan time.

What the Controller states it did **not** verify, and what this report therefore claims only as executor evidence: the original deletion was not repeated; the R2 manifest cannot be recomputed after the deletion; the four D1 baseline digests, the raw delete responses, the actor and GO records and the repair tool's `recover` and `preflight` results are the executor's evidence, not an independent Controller readback; the Controller's connector does not expose the repair tool. No global bucket or census verification is claimed.

## 7. Restore boundary after the cleanup

The recovery artifacts were the exact pre-image tokens of the repair. With them deleted, the restore of this operation (`mode: restore`) is **no longer possible** and its restore proof no longer exists. The repair stays accepted (16 of 16, see the [production repair evidence](air-664-localization-repair-production-2026-11-28.md)). Any later change to those Films is a separately approved forward correction through the existing resolver and writers, planned from the then-current state; it cannot be derived from the deleted intents. The D1 receipts of the repair remain and are unchanged. The artifacts were not restored, moved or archived anywhere.

## 8. Limitations

- Deletion is irreversible. This is a scoped result for one prefix of one bucket; other objects of the bucket were not listed beyond the parent prefix, and no bucket-wide inventory is claimed.
- The D1 comparison covers the 16 cohort Films and the receipts of this operation by content digest, not the whole database; it is not a global snapshot, and concurrent legitimate writers were not frozen.
- The delete responses were checked by the executor in the same execution and by the separate listings above; the Controller verified the final emptiness and the receipts, not the individual responses.
- Keys, ETags, object bodies, localization values, credentials and the owner's account identifiers are not recorded here. The provenance of the earlier apply report is preserved; this report supersedes only its statement about the retained artifacts.
