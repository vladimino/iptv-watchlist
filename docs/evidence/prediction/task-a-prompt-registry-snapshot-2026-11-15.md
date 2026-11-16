# Production Task A prompt registry snapshot (15 November 2026)

## Scope and source

Read-only registry capture via the connected Automations peek action of Task `6af7a2d8369081918b79bb2892bac0fe` (`IPTV Predictions v2 Canary`). The live Task was previously edited with the owner's explicit authorization; this separate GitHub documentation PR does not edit, enable, disable, reschedule or run any Task.

## Observed state

- Enabled: `true`. Timezone: `Europe/Madrid`. Nominal hourly trigger: `:00`.
- Current installed prompt: **34056 JavaScript characters**, SHA-256 `4662facc4d25d405ff3bc73ff6bdbede028a63e013502e334a5821dfdbd30247`. The exact text is the `PROMPT` block of the [batch v2 snapshot](../../reference/scheduled-task-prompts/hourly-predictions-batch-v2.md) (markers and separator newlines excluded).
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

The equality is both exact string comparison (`TaskA.prompt === TaskB.prompt`) and a SHA-256 digest of the UTF-8 bytes. `timing_mode=exact_schedule` and `default_timezone=Europe/Madrid` were set for B. At creation readback, its next nominal occurrence was **16 November at 13:15 Madrid**. A was not updated. No manual task run, prediction producer, lease reset, profile change, flag change or data mutation was made to manufacture evidence. Task C/D installation remains separately gated.

**Documentation drift:** the then-current `main` prompt had 31,761 characters / 47,317 bytes / SHA-256 `97e1c54f1eed3a3ba8e40f060b7d135081155fdedfaac19cf5d3d61f00a700ac`, not the installed A/B prompt. This PR's production `PROMPT` block is the verified A/B version. The frozen dry-run prompt remains unchanged.

**A/B verification gate:** observe 6–8 natural hourly cycles, comparing per-Task `scheduled_for` and `started_at` with Worker `diagnosticStartedAt`, `already_running` and lost slots, run completion, lease ownership, per-film outcomes, assessments and research quality. Scheduler jitter of approximately 0–40 minutes was observed with A before B installation; a 15-minute nominal offset does not guarantee no overlap. Do not start manual runs to resolve an incomplete sample. Only A and B are owner-approved; no GO for C/D or prompt edits.

## Limits and verification

The registry prompt was read directly, then the installed text, length and SHA-256 were compared with the repository snapshot. The offline `tests/scheduled-task-prompt-v2.mjs` covers the snapshot hash, frozen A/B hash, protocol-tool boundaries, research gates and exact-item reuse instructions. PR merge only updates documentation and tests, never the external registry or Worker.

The Saved Task report for the 15 November 2026 19:00 Europe/Madrid run reported initial preflight success for five items, two successful writes and three `deferred_budget` items whose reconstructed submit payloads omitted `fingerprint.execution.technical_plausibility`. Worker read-only film diagnostics independently confirmed three `fingerprint_schema` rejections at that path. The Saved Task preflight statement is a **caller report**, not independently captured Worker telemetry.

The new instruction is **not yet proven by a natural run**. The next 20:00 slot may occur before the three films' 20:07 retry eligibility; no assumption is made that those same films are in the next manifest. No manual model run, queue write, retry reset or Task mutation is authorized by this documentation evidence.

Related [AIR-473](https://trello.com/c/b9oTfOpI) (research), [AIR-451](https://trello.com/c/NN3N6kRp) (natural-run verification), and [AIR-487](https://trello.com/c/eE5vvZ95) (failure contract).
