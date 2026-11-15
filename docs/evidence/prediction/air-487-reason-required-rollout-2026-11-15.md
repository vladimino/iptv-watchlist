# AIR-487: required `failure.reason` — cutover (15 Nov 2026)

Coordination record. No production write, Task edit, unpause, run or deploy in this session.

Owner clarification (PR #641 comment, 15 Nov 2026 ~09:30 Europe/Madrid): **Task A has been paused since the evening of 14 Nov**, waiting for AIR-486 and AIR-487. It is **not** a running legacy caller for this rollout. A temporary backward-compatibility layer and an atomic Worker/Task paste are **not** required while Task A stays paused until its prompt is updated.

## Roles

| Role | Does | Does not |
| --- | --- | --- |
| Executor (this PR) | Canonical batch v2 prompt, Worker `failure.reason` gate, MCP schema, docs, offline tests; refresh from `main` | Access or edit the live Scheduled Task; merge; deploy; unpause |
| Delivery Controller | Independent review, exact-HEAD CI, routine merge, confirm Test shards and Cloudflare deploy | Unpause Task A in that window; paste the prompt |
| ChatGPT | After Worker deploy, copy the approved canonical prompt into installed Task A, verify length/SHA against the repository, keep a restore of the prior text | Implied by this PR; resume, manual run and schedule change are separate owner GOs |

## Registry vs canonical (this session did not re-read the live registry)

| Field | Last recorded value | Source |
| --- | --- | --- |
| Task A state | Paused since evening 14 Nov 2026 (Europe/Madrid), awaiting AIR-486 and AIR-487 | Owner clarification on PR #641 / Trello AIR-487; **not** a fresh Automations peek |
| Installed text (last SHA while it ran) | 28172 characters, SHA-256 `fadb0e385cafbc1ebe0e0ffcd3d9f1bca8a9b0a214116c9c81deeb9bdce9a6c2` | AIR-487 card + RCA |
| Kind-only fallback | Present in that installed text | Canonical file at that SHA |
| Canonical file in this PR | 28426 characters, SHA-256 `f65dee1f258eb71013425d4bbd7e573018245f5c2507f8f0c10064a59646388d` | `hourly-predictions-batch-v2.md` / `tests/scheduled-task-prompt-v2.mjs` |

The GitHub file is **not** the registry. A Worker deploy does not paste a prompt.

## RCA that must stay distinct

Run `c6b2c3d7-7382-41ad-9a4e-cd45c198d929`: three stored `inputDigest` values equal the **legacy** `{failure:"parse_error"}` formula. That proves the **accepted** item had no claim. It does **not** prove which closed reason applied, and it does **not** prove that a 400→legacy fallback ran. See [the RCA](air-487-caller-reported-parse-error-rca-2026-11-15.md).

## Worker contract in this PR (offline)

- Kind-only failure, including beside a valid neighbour: HTTP 400, `items[i].failure.reason required`, **nothing written**.
- Claimed failure + valid candidate in the same body: 200; the neighbour is created; the failure is `caller_reported` with `validation.claimed`.
- Recovery: the caller must add a closed `reason` (and optional preflight) and resubmit.
- v5 `POST /api/enrichment/submit` still accepts `{failure:{kind}}`.

Proof: `tests/prediction-caller-failure-claim.mjs`.

## Rollout (while Task A remains paused)

1. Executor: this PR on current `main`, green exact-HEAD CI.
2. Controller: merge and Cloudflare deploy. **Do not unpause Task A.**
3. ChatGPT, separate owner GO after deploy: paste canonical prompt, registry readback of 28426 / `f65dee1f…`, retain restore of `fadb0e38…`.
4. Resume, a manual run and a schedule change are **further** owner GOs, not this PR.

A compatibility flag is not in this PR.

## Rollback

- Worker: revert the deploy (kind-only accepted again on batch v2). Stored claimed records stay; historical legacy digests stay.
- Prompt: restore the previous Task text (28172 / `fadb0e38…`) under a separate GO. Code rollback does not restore the registry.
