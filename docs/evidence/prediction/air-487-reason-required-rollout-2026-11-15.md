# AIR-487: required `failure.reason` — cutover hold (15 Nov 2026)

Coordination record. No production write, Task edit, enable, disable, run or deploy.

## Registry vs canonical (this session did not re-read the live registry)

Last **documented** Task A prompt identity, from the AIR-487 Trello card (owner/Controller readback used in the RCA, not a fresh Automations peek):

| Field | Last recorded value | Source |
| --- | --- | --- |
| Installed text | 28172 characters, SHA-256 `fadb0e385cafbc1ebe0e0ffcd3d9f1bca8a9b0a214116c9c81deeb9bdce9a6c2` | Card + RCA of 15 Nov 2026 |
| Kind-only fallback | Present in that text (retry once as `{filmId,failure:{kind:'parse_error'}}`) | Canonical file at that SHA; card says that SHA is what Task A ran |
| Canonical file after this PR | 28426 characters, SHA-256 `f65dee1f258eb71013425d4bbd7e573018245f5c2507f8f0c10064a59646388d` | `hourly-predictions-batch-v2.md` headers / `tests/scheduled-task-prompt-v2.mjs` |
| Task ID | Not restated in the AIR-487 card. An earlier AIR-468 reviewer peek named `6af7a2d8369081918b79bb2892bac0fe` as v2 Task A; **not re-verified here** | AIR-468 evidence |

The GitHub file is **not** the registry. A Worker deploy does not paste a prompt. Enabled/paused state of Task A is **not** proven by this file; treat the caller as still able to send kind-only until a fresh readback after an owner-authorized paste.

## RCA that must stay distinct

Run `c6b2c3d7-7382-41ad-9a4e-cd45c198d929`: three stored `inputDigest` values equal the **legacy** `{failure:"parse_error"}` formula. That proves the **accepted** item had no claim. It does **not** prove which closed reason applied, and it does **not** prove that a 400→legacy fallback ran. See [the RCA](air-487-caller-reported-parse-error-rca-2026-11-15.md).

## Worker contract in this PR (offline)

- Kind-only failure, including beside a valid neighbour: HTTP 400, `items[i].failure.reason required`, **nothing written**.
- Claimed failure + valid candidate in the same body: 200; the neighbour is created; the failure is `caller_reported` with `validation.claimed`.
- Recovery: the caller must add a closed `reason` (and optional preflight) and resubmit; dropping the invalid item is the caller's choice, not a Worker partial commit.
- v5 `POST /api/enrichment/submit` still accepts `{failure:{kind}}`.

Proof: `tests/prediction-caller-failure-claim.mjs`. These tests do not prove compatibility with the installed Task A prompt.

## Rollout (hold merge/deploy until the owner picks one)

**Preferred (matches the approved hard gate):** one owner GO that (1) pastes the canonical prompt into the live Task, (2) readback of length + SHA-256 equal to `f65dee1f…`, (3) no in-flight batch_v2 run (lease idle / `already_running` absent), (4) then merge and deploy this Worker. Quiet window: between hourly slots, after the previous invocation has finished. A run that started under the old prompt and submits after deploy will 400 every kind-only item.

**If paste cannot precede deploy:** do **not** merge this gate. A later approved compatibility stage could keep kind-only accepted until a flag or until the registry SHA matches; that stage is **not** in this PR and needs its own GO.

This PR authorizes neither paste nor deploy.

## Rollback

- Worker: revert the deploy (kind-only accepted again on batch v2). Stored claimed records stay; historical legacy digests stay.
- Prompt: restore the previous Task text (28172 / `fadb0e38…`) under a separate GO. Code rollback does not restore the registry.
