# Production Task A prompt registry snapshot (15 November 2026)

## Scope and source

Read-only registry capture via the connected Automations peek action of Task `6af7a2d8369081918b79bb2892bac0fe` (`IPTV Predictions v2 Canary`). The live Task was previously edited with the owner's explicit authorization; this separate GitHub documentation PR does not edit, enable, disable, reschedule or run any Task.

## Observed state

- Enabled: `true`. Timezone: `Europe/Madrid`. Nominal hourly trigger: `:00`.
- Current installed prompt: **34056 JavaScript characters**, SHA-256 `4662facc4d25d405ff3bc73ff6bdbede028a63e013502e334a5821dfdbd30247`. The exact text is the `PROMPT` block of the [batch v2 snapshot](../../reference/scheduled-task-prompts/hourly-predictions-batch-v2.md) (markers and separator newlines excluded).
- Previous GitHub snapshot: 31761 characters, SHA-256 `97e1c54f1eed3a3ba8e40f060b7d135081155fdedfaac19cf5d3d61f00a700ac`.
- Installed instructions include Production Task A source-selection/full-text fallback (variant D), research audit, required `failure.reason`, and the `deferred_budget` rule to preserve a previously accepted submit item or revalidate the actual changed item.
- The frozen A/B dry-run prompt is a separate, non-production experiment and remains **15071 characters**, SHA-256 `a9b28e5a69efe963234243714ed3270924727d11311f0f82fb42539a30caf72d`.

## Limits and verification

The registry prompt was read directly, then the installed text, length and SHA-256 were compared with the repository snapshot. The offline `tests/scheduled-task-prompt-v2.mjs` covers the snapshot hash, frozen A/B hash, protocol-tool boundaries, research gates and exact-item reuse instructions. PR merge only updates documentation and tests, never the external registry or Worker.

The Saved Task report for the 15 November 2026 19:00 Europe/Madrid run reported initial preflight success for five items, two successful writes and three `deferred_budget` items whose reconstructed submit payloads omitted `fingerprint.execution.technical_plausibility`. Worker read-only film diagnostics independently confirmed three `fingerprint_schema` rejections at that path. The Saved Task preflight statement is a **caller report**, not independently captured Worker telemetry.

The new instruction is **not yet proven by a natural run**. The next 20:00 slot may occur before the three films' 20:07 retry eligibility; no assumption is made that those same films are in the next manifest. No manual model run, queue write, retry reset or Task mutation is authorized by this documentation evidence.

Related [AIR-473](https://trello.com/c/b9oTfOpI) (research), [AIR-451](https://trello.com/c/NN3N6kRp) (natural-run verification), and [AIR-487](https://trello.com/c/eE5vvZ95) (failure contract).
