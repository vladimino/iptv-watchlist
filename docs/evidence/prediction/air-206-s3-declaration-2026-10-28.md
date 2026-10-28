# Selective prediction compatibility: change-impact declaration and owner approval (stage S3)

**Executed:** 2026-10-28, 00:02:12.574–00:02:12.679 UTC, by the owner in a browser session behind Cloudflare Access (DevTools console, same-origin `fetch`)
**Verified:** 2026-10-28, about 00:03 UTC, owner-only IPTV MCP read tool `enrichment_profile`
**Code:** `main` `1f92365`
**Approval of the call:** the owner's instruction to run only the S3 dry run, recorded on [AIR-206](https://trello.com/c/87mg3VNi) (card comments of 28 October, board time); no publication, flag, Tasks, model or backfill
**Approval of the declaration:** the owner, 2026-10-28T00:03:42.910Z, in the Claude Code session of this delivery; quoted and dated in [this AIR-206 card comment](https://trello.com/c/87mg3VNi#comment-6ae13bf4b0e89c648cdab217)
**Verdict:** **S3 complete.** The production dry run reproduced the locally computed declaration exactly, nothing was written, and the owner approved that exact declaration. Publication (S4), the switch (S2) and a dry run with the approval are separate owner decisions

## The edit

The owner approved the content change on the card before the call. The only change is one sentence appended to the end of `horrorPreferences`, after a single space:

> Если угроза получает новую способность или правило в кульминации, оно должно быть подготовлено наблюдаемыми признаками раньше; неожиданное правило без подготовки снижает оценку, даже если финал зрелищный.

The meaning is: a new ability or rule a threat gains at the climax must be set up earlier by observable signs; an unprepared rule lowers the rating even if the finale is spectacular. Every other field of version 1 is unchanged. The full profile text is not reproduced here.

## The call

The console script first read `GET /api/enrichment/profile` and stopped unless it returned version 1 with the expected hash. It then built the body from that response and sent one request.

| Item | Value |
| --- | --- |
| Request | `PUT /api/enrichment/profile`, `dryRun: true`, `version` 2, `changeImpact` `{impactSchemaVersion: 1, from: {version: 1, profileHash: 14cbed70…9753}, scope: "selective", changedFields: ["horrorPreferences"], selectors: [{kind: "genre", values: ["horror"]}]}`, no `approval` |
| Response | HTTP 400, `code: selective_requires_owner_approval` (the expected answer of a selective dry run without approval) |
| `changedFields` | `["horrorPreferences"]` |
| Target `profileHash` (version 2) | `78d004ea85340f941f8c53a1cc48c73c8c80622c49bc78a6166673a5c56f449d` |
| `declarationSha256` | `3a4d577fa065ea54c62867ed45797435d61fea12ef6084e5f63b606d648f0330` |

The hashed declaration text, the canonical JSON the Worker builds:

```json
[1,"14cbed708f2aaa7921b785a8947c8ae643f30ea91df6ce0962516f6f55889753",2,"78d004ea85340f941f8c53a1cc48c73c8c80622c49bc78a6166673a5c56f449d","selective",["horrorPreferences"],[{"kind":"genre","values":["horror"]}]]
```

**Local prediction before the call.** The agent copied version 1 from the read-only `enrichment_profile` answer and confirmed its hash equals the production `profileHash`. It ran the `main` publisher (`publishProfile`) on an in-memory bucket with the same body. The result was the same code, fields and hashes, with no write. The production answer matched it exactly.

## Controls after the call

| Control | Value |
| --- | --- |
| `enrichment_profile` | `version` 1, `profileHash` `14cbed70…9753`, `updatedAt` 2026-10-04T18:41:55.630Z: unchanged |

A dry run returns before the first bucket write, so no queue, prediction or version record was touched. The queue was not read again.

## Owner approval

The agent reported the dry run and asked for a decision on this exact declaration. The owner answered verbatim: «я напишу тут, что одобряю. с ChatGPT мы разберемся отдельно, если надо будет». In English: "I'll write here that I approve. ChatGPT and I will sort it out separately if needed." The owner chose this session, instead of a card comment, as the place to give the approval. The agent took the message as the approval and recorded it on the card. It approves the declaration above:
- from version 1 to version 2, scope `selective`;
- the changed fields and the selectors above;
- its `declarationSha256`.

The approval block for the next steps is the following:

```json
{"approvedBy":"owner","approvedAt":"2026-10-28T00:03:42.910Z","reviewRef":"https://trello.com/c/87mg3VNi#comment-6ae13bf4b0e89c648cdab217","declarationSha256":"3a4d577fa065ea54c62867ed45797435d61fea12ef6084e5f63b606d648f0330"}
```

The `main` publisher on the same in-memory bucket accepts this approval: HTTP 200, `dryRun: true`, `valid: true`, same hashes, no write. **This was not run in production.**

## Limits

- The response is the owner's console output (screenshot), not a server log. The Worker version and flag bindings were not read.
- The approval binds the content and hash only. It does not authorize a production dry run with approval, the publication, the switch or any other action.
- Any change to the profile body, fields or selectors changes the hash and needs a new approval.
