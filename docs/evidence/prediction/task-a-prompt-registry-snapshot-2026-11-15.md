# Production Task A prompt registry snapshot (15 November 2026)

## Scope and source

Read-only registry capture via the connected Automations peek action of Task `6af7a2d8369081918b79bb2892bac0fe` (`IPTV Predictions v2 Canary`). The live Task was previously edited with the owner's explicit authorization. This evidence also records the later separately approved Task B/C/D creations; this separate GitHub documentation PR does not edit, enable, disable, reschedule or run any Task.

## Observed state

- Enabled: `true`. Timezone: `Europe/Madrid`. Nominal hourly trigger: `:00`.
- Prompt installed at the historical 15 November capture: **34056 JavaScript characters**, SHA-256 `4662facc4d25d405ff3bc73ff6bdbede028a63e013502e334a5821dfdbd30247`. The text matched the then-current repository snapshot; the [maintained batch v2 canonical prompt](../../reference/scheduled-task-prompts/hourly-predictions-batch-v2.md) now holds the later installed 39,274-character version (markers and separator newlines excluded).
- Previous GitHub snapshot: 31761 characters, SHA-256 `97e1c54f1eed3a3ba8e40f060b7d135081155fdedfaac19cf5d3d61f00a700ac`.
- Installed instructions include Production Task A source-selection/full-text fallback (variant D), research audit, required `failure.reason`, and the `deferred_budget` rule to preserve a previously accepted submit item or revalidate the actual changed item.
- The frozen A/B dry-run prompt is a separate, non-production experiment and remains **15071 characters**, SHA-256 `a9b28e5a69efe963234243714ed3270924727d11311f0f82fb42539a30caf72d`.

## Task B activation (16 November 2026, Europe/Madrid)

The owner explicitly approved the second producer for the A/B concurrency and throughput trial. The controller read **the installed prompt directly from live Task A** with `Automations.peek` and supplied that exact string as the `prompt` argument to `Automations.create` for Task B. This was not a copy from GitHub. Immediately after creation, both Tasks were independently read back from the registry:

| Property | Task A | Task B |
| --- | --- | --- |
| Registry ID | `6af7a2d8369081918b79bb2892bac0fe` | `6afaf2b2aed8819198eaff652f1fcb55` |
| Title | `IPTV Predictions v2 Canary` | `IPTV Predictions v2 B` |
| Status at readback | enabled | enabled |
| Schedule | hourly `:00` Europe/Madrid | hourly `:15` Europe/Madrid |
| DTSTART | `20261114T020000` | `20261116T131500` |
| RRULE | `FREQ=HOURLY;INTERVAL=1` | `FREQ=HOURLY;INTERVAL=1` |
| Prompt length | 34,056 JavaScript characters, 50,790 UTF-8 bytes | 34,056 JavaScript characters, 50,790 UTF-8 bytes |
| Prompt SHA-256 | `4662facc4d25d405ff3bc73ff6bdbede028a63e013502e334a5821dfdbd30247` | **identical** |

The equality is both exact string comparison (`TaskA.prompt === TaskB.prompt`) and a SHA-256 digest of the UTF-8 bytes. `timing_mode=exact_schedule` and `default_timezone=Europe/Madrid` were set for B. At creation readback, its next nominal occurrence was **16 November at 13:15 Madrid**. A was not updated. No manual task run, prediction producer, lease reset, profile change, flag change or data mutation was made to manufacture evidence. At this B-only readback, Task C/D installation was still separately gated; the subsequent owner-approved scale-out is documented below.

**Documentation drift:** the then-current `main` prompt had 31,761 characters / 47,317 bytes / SHA-256 `97e1c54f1eed3a3ba8e40f060b7d135081155fdedfaac19cf5d3d61f00a700ac`, not the installed A/B prompt. This PR's production `PROMPT` block is the verified A/B version. The frozen dry-run prompt remains unchanged.

**A/B verification gate:** observe 6–8 natural hourly cycles, comparing per-Task `scheduled_for` and `started_at` with Worker `diagnosticStartedAt`, `already_running` and lost slots, run completion, lease ownership, per-film outcomes, assessments and research quality. Scheduler jitter of approximately 0–40 minutes was observed with A before B installation; a 15-minute nominal offset does not guarantee no overlap. Do not start manual runs to resolve an incomplete sample. At the time of this A/B-only sampling plan, C/D were not yet approved; the owner subsequently approved their creation and enablement on 16 November (see below). No prompt edits were authorized.

## Task C and D activation (16 November 2026, Europe/Madrid)

After the owner explicitly approved accelerating **step 2 of AIR-451**, the controller performed a new live Automations registry preflight. Tasks A and B were enabled and their full 34,056-character prompts compared **exactly equal**. No Task C/D with those titles existed in the live registry. The controller used the **current Task A prompt string itself** for two separate `Automations.create` operations (not the GitHub copy), with `timing_mode=exact_schedule` and `default_timezone=Europe/Madrid`.

| Property | Task C | Task D |
| --- | --- | --- |
| Title | `IPTV Predictions v2 C` | `IPTV Predictions v2 D` |
| Registry ID | `Automation_c8e5b4cc89d08191b47e979b726a60a3` | `Automation_d9436aec7d108191a3822a244e382592` |
| Enabled (independent readback) | `true` | `true` |
| Schedule (Europe/Madrid) | hourly `:30` | hourly `:45` |
| DTSTART | `20261116T223000` | `20261116T224500` |
| RRULE | `FREQ=HOURLY;INTERVAL=1` | `FREQ=HOURLY;INTERVAL=1` |
| Timing mode | `exact_schedule` | `exact_schedule` |
| Prompt | exact Task A text, 34,056 characters | exact Task A text, 34,056 characters |
| First nominal slot at creation | 16 Nov, 22:30 Madrid | 16 Nov, 22:45 Madrid |

The immediate create responses and a subsequent **independent four-task registry readback** confirmed A/B/C/D all enabled, all hourly at `:00/:15/:30/:45` Madrid, all with `exact_schedule`, `default_timezone=Europe/Madrid`, and **A.prompt === B.prompt === C.prompt === D.prompt**. The unchanged canonical installed prompt is 50,790 UTF-8 bytes with the previously independently calculated SHA-256 `4662facc4d25d405ff3bc73ff6bdbede028a63e013502e334a5821dfdbd30247`. Creating Tasks does not prove a future scheduled execution, uninterrupted lease ownership, 20 predictions/hour, or research-depth quality.

Only the two owner-authorized Task creations were performed. Tasks A/B, legacy v5, Drift, Cloudflare, production data/queue/lease, flags and prompts were not modified; there was no manual Task run, Worker model invocation or production retry. [AIR-473](https://trello.com/c/b9oTfOpI) remains open for research-depth acceptance, and [Draft PR #661](https://github.com/vladimino/iptv-watchlist/pull/661) remains a documentation snapshot until final owner acceptance. Next verification must examine **natural** A/B/C/D Task histories and Worker outcomes independently.

## AIR-510 four-task prompt-only recovery activation (16 November 2026, Europe/Madrid)

The Product Owner explicitly approved installing **only** the partial-manifest recovery fallback into Tasks A/B/C/D after the Worker backend of [PR #703](https://github.com/vladimino/iptv-watchlist/pull/703) deployed. The controller first read the actual registry and confirmed the four existing live 34,056-character prompts were identical. Each task was updated *only* through its `prompt` field, then independently read back. All four retained their exact `:00/:15/:30/:45` hourly recurrence, `exact_schedule`, `Europe/Madrid`, `is_enabled=true`, and inherited environment selection. No manual run or other Task/storage operation was performed.

**Final readback for A/B/C/D:** byte-identical live prompt, **35,957 JavaScript characters / 53,486 UTF-8 bytes, SHA-256 `2694953e329231753e05d0df1c1b7523ba9804837fb6190d87e5a14daed9b587`**. Exactly one fallback step was inserted after the existing `running` start outcome. It requests `prediction_batch_manifest` `envelope`, `profile`, `contract`, and each `film` for an existing *known owned* `runId`, checks all parts, identifiers and required fields, and continues the original research/submit only on a complete reconstruction. Never repeat `prediction_batch_start` or fabricate a film. A missing owned ID means no recovery or `prediction_complete` without ownership; an incomplete result fails closed. Research/assessment rules, `manifestSize=5`, `generationSize=1`, and `submitBatchSize=5` were preserved.

**Pending:** a natural Scheduled Task execution must demonstrate access to the newly deployed MCP tool and successful recovery if a truncated start recurs. This registry update does not establish that all future tool responses are complete or that the client sees newly published MCP tools without connection refresh. [AIR-510](https://trello.com/c/01JAM4TP) remains open; this Draft PR is a snapshot only, not a Task operator or permission to induce a failure.

## AIR-510 durable hold installation and canonical readback (17 November 2026, UTC)

After the [AIR-510 PR #704 deployment](https://github.com/vladimino/iptv-watchlist/pull/704), the Product Owner explicitly approved **prompt-only** changes to the four existing A/B/C/D Scheduled Tasks. The live registry was independently re-read on 17 November: all four remained enabled, unchanged at hourly `:00/:15/:30/:45` Europe/Madrid, with identical installed prompts: **38,211 JavaScript characters / 56,989 UTF-8 bytes**, SHA-256 `1269c7e66e7cddabcd0a1eff97c37f413990e6d8bfeac25931aabc4b412f919e`. The new production-only step `7а. DURABLE HOLD (ADR 0157, AIR-510)` stages validated submit-ready items before submit, preserving evidence and payload fidelity; it excludes failure items, supports same-run `useHeld` and recovery by the *next ordinary start*. It does not change the five-film manifest, frozen A/B dry-run experiment, research rules or schedules. The exact live text is now the production `PROMPT` block in the [canonical snapshot](../../reference/scheduled-task-prompts/hourly-predictions-batch-v2.md); the 16 November 35,957-character fallback remains a dated historical capture above.

**Post-installation read-only observation (17 November, 11:11–12:04 UTC).** Seven of eight terminal natural Worker runs completed normally with `manifest_spent`: 33 confirmed created predictions; one run `external_termination` with no first submit; two individual `insufficient_evidence` retry failures. B/C/D Saved Task reports independently named validate → durable hold → submit with five commits on successful passes. The stage-drain recovery path after a confirmed hold and interruption was **not** naturally observed; this is not acceptance of all AIR-510 or AIR-451 stability criteria. See [AIR-510 verification](https://trello.com/c/01JAM4TP). No manual model run, producer mutation or Scheduled Task update was performed for this documentation sync.

## AIR-510 false external-termination prompt guard (17 November 2026, 15:56 UTC)

Following repeated natural `external_termination` with no first submit, the Product Owner explicitly authorized a narrowly scoped prompt-only change in the AIR-510 conversation. Live A/B/C/D were read and confirmed exactly identical before the edit. The only executable prompt changes were in step 2a and step 10: replace the eager `external_termination` on incomplete readback with `api_error` when a real readback failure exists and the owned lease is still active; require progression from a successfully reconstructed manifest to research; allow `external_termination` only for a genuinely observed external interruption, never a voluntary early stop because context, size or time seems limiting. If an external hard kill prevents cleanup, the established lease-expiry path remains. These rules do not invent a new error signal.

**Final live readback:** all four A/B/C/D enabled, unchanged exact hourly :00/:15/:30/:45 schedules in Europe/Madrid, identical prompts of **39,274 JavaScript characters / 58,847 UTF-8 bytes**, SHA-256 `fbd829008b449b7e67a8896ea794a20288d3f39eef6c9b575633d1a0f4a93fb3`. Before: 38,211 characters, SHA-256 `1269c7e66e7cddabcd0a1eff97c37f413990e6d8bfeac25931aabc4b412f919e`. The delta is +1,063 characters; `manifestSize=5`, `generationSize=1`, `submitBatchSize=5`, research and evidence quality gates, preflight, durable hold and batch submit were retained. No manual run, schedule/enablement change, Worker deployment or production writer was triggered for this prompt update.

**Unproven acceptance:** changing instructions does not prove the root cause of prior early termination or guarantee the next natural Task run succeeds. AIR-510 remains in progress pending read-only comparison of Scheduled Task outcomes and Worker receipts. Exact prompt installed in the [canonical repository snapshot](../../reference/scheduled-task-prompts/hourly-predictions-batch-v2.md); this PR preserves the frozen dry-run separately and updates offline guard tests. Draft PR delivery is a documentation sync, not production Task activation.

## Post-guard natural-run stability and research audit (17 November 2026, UTC)

After the final `external_termination` observed at 15:29 UTC (16:29 Europe/Madrid), **eight consecutive owned production batches** completed normally through 17:51 UTC (18:51 Madrid): Worker created **38 predictions** with **two isolated per-film retryable failures** and no newly recorded Worker `serverFault` or `external_termination`. One of these eight runs started before the stricter stop-guard prompt update at approximately 15:55–15:56 UTC; the **seven clean post-update normal runs** therefore created **33 predictions** with two per-film failures. These are bounded natural-run observations, not proof that hard external stops are impossible. The batch remains `manifestSize=5`; no manual production runs were initiated.

Saved natural Task B/C/D reports around 17:11–17:52 UTC recorded **10/15 substantive** source-specific research findings and **5/15 limited** cases. Independent public-article spot checks confirmed the reported heist tactic in Richard Brody's [I Love Boosters review](https://www.newyorker.com/magazine/2026/06/01/i-love-boosters-movie-review) and opposing legal positions in Philip Kemp's [The Mauritanian review](https://www.bfi.org.uk/sight-and-sound/reviews/mauritanian-2021-kevin-macdonald-mohamedou-ould-slahi-guantanamo-internment-jodie-foster-benedict-cumberbatch). One false-negative search remains: the C Task reported no authored review for `tmdb_236735` / *La isla mínima*, but Carlos Boyero's [original review](https://elpais.com/cultura/2014/09/20/actualidad/1411233591_213673.html) was retrievable independently. These are client-reported audits plus bounded article spot checks, **not** a complete R2 provenance audit or model-accuracy validation. AIR-473 was owner-accepted with these limitations recorded.

**Latest separate interruption:** a new owned scheduled run `64a77af9-3502-4be2-852a-56943e72ca7c` acquired a lease at 18:00:59 UTC (19:00 Madrid), returned Worker `batch_start` HTTP 200 and made no heartbeat, hold, submit or complete. Its lease expired at 18:15:59 UTC, and read-only runner status projected `lease_expired` (0 predictions). The 19:00 Task A and 19:15 Task B recorded `already_running` rather than adopting the run. The Worker recorded no server fault and no caller attribution; it is **not proven** which invocation owned the original start or why the caller failed to continue. This is not another caller-reported `external_termination`, but it defeats any blanket statement that no interruptions occurred after 16:29 Madrid. Recovery should be observed on a later **natural** run, without manual lease resets or model retries.

The historical AIR-510 manifest/research hardening was accepted after observed successful recovery. This newer `lease_expired` is an unresolved reliability observation for AIR-451 stabilization and should not be silently declared fixed. The canonical documentation PR remains gated by independent exact-HEAD review and CI; no Worker or external Task configuration changed in this evidence update.

## Limits and verification

The registry prompt was read directly, then the installed text, length and SHA-256 were compared with the repository snapshot. The offline `tests/scheduled-task-prompt-v2.mjs` covers the snapshot hash, frozen A/B hash, protocol-tool boundaries, research gates and exact-item reuse instructions. PR merge only updates documentation and tests, never the external registry or Worker.

The Saved Task report for the 15 November 2026 19:00 Europe/Madrid run reported initial preflight success for five items, two successful writes and three `deferred_budget` items whose reconstructed submit payloads omitted `fingerprint.execution.technical_plausibility`. Worker read-only film diagnostics independently confirmed three `fingerprint_schema` rejections at that path. The Saved Task preflight statement is a **caller report**, not independently captured Worker telemetry.

The new instruction is **not yet proven by a natural run**. The next 20:00 slot may occur before the three films' 20:07 retry eligibility; no assumption is made that those same films are in the next manifest. No manual model run, queue write, retry reset or Task mutation is authorized by this documentation evidence.

Related [AIR-473](https://trello.com/c/b9oTfOpI) (research), [AIR-451](https://trello.com/c/NN3N6kRp) (natural-run verification), and [AIR-487](https://trello.com/c/eE5vvZ95) (failure contract).
