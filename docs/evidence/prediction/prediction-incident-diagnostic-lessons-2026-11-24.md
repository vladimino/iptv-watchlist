# Prediction incidents: comparative diagnostic lessons, 22-24 November 2026

**Scope:** sanitized synthesis of the completed AIR-573 recovery and AIR-588 diagnostic investigation, not a new runtime test or a claim of recovery. Sources: [AIR-573 card](https://trello.com/c/4pD66DLd/544-air-573-p0-%D0%B8%D0%BD%D1%86%D0%B8%D0%B4%D0%B5%D0%BD%D1%82-predictions-%D0%BF%D0%BE%D0%B2%D1%82%D0%BE%D1%80%D0%BD%D1%8B%D0%B9-batchstart-%D0%B8-%D0%BF%D0%BE%D1%82%D0%B5%D1%80%D1%8F-owned-run), [AIR-588](https://trello.com/c/vyxbU1l0), existing dated evidence and private coordinator records. The operational procedure is [Prediction incident response](../../runbooks/prediction-incident-response.md). Raw prompts, taste profiles, film payloads and private Task reports are intentionally excluded. Times in this document are UTC; historical card times are Europe/Madrid.

## AIR-573: a useful isolation sequence, followed by a proven recovery

Sources: [deferred start offline](air-573-deferred-start-offline-2026-11-21.md), [first natural deferred run](air-573-first-deferred-run-2026-11-21.md), [task ownership offline replay](air-573-task-id-offline-2026-11-22.md), [ADR 0195](../../adr/0195-scheduled-task-id-as-run-owner-label.md), [delivery PR #891](https://github.com/vladimino/iptv-watchlist/pull/891) and the linked card records.

| Diagnostic | Observation | Conclusion and limit |
| --- | --- | --- |
| Short runner/manifest and MCP-to-web controls | Read-only diagnostics could complete | Connectivity and the basic tool sequence were possible, not proof that production could complete |
| Production-derived longer diagnostic | An MCP text wrapper was not correctly parsed | Explicit type-safe unwrap was a targeted improvement |
| S1/S3/S4/S5 controlled response-size experiments | S1, S3, S4 passed. One S5 response (40,642 bytes) reportedly exceeded an intermediate token budget (10,875 to 10,000); exact S5 prompt replay passed with a 39,991-byte response | No deterministic film-count or byte threshold was established; manifest content, latency and environment varied |
| Isolated real S1 canary | Two overlapping starts; the second encountered a live lease and the Task ended without submitting | Dry-run success did not exercise the real lease/start lifecycle; caller provenance was not independently exposed |
| Contract fix and natural runs | Same-Task repeat joined the owned run; foreign owner remained refused. Eight terminally successful natural runs, 37 durable commits in the accepted observation window (14:11-16:31 UTC, 22 Nov) | Owner accepted recovery; an isolated later-in-window interruption and subsequent successful recovery were reported, not a claim of zero failures |

The productive decision was to stop repeating size probes once a real-run boundary had been localized. The ownership fix was independently reviewed, deployed and verified through committed forecasts, rather than a successful dry-run or deployment alone.

## AIR-588: onset and diagnostic ladder

The [initial RCA](air-588-predictions-stop-rca-2026-11-23.md) documents 118/120 successful starts before the onset, 0/6 after it, including failures with long starts that had previously recovered. Last durable success was 23 Nov 20:28:21 UTC; a docs-only deployment at 20:30:49 separated it from the first failed start at 20:33:25. That first run stopped polling before its successful server response; a later already-running skip was a consequence. The executable diff did not identify the trigger. [Offline optimization measurements](air-588-start-latency-offline-2026-11-24.md) are not proof of restored delivery.

On 24 Nov, coordinator experiments used owner-approved one-shot Scheduled Tasks derived from the live prediction prompt, a read-only S5 manifest unless noted, and local candidates only. Saved reports were compared with independently queried Worker telemetry; research and model identity are caller-reported unless explicitly independently verified. No diagnostic candidate was submitted. PASS below refers to the scoped stage, not production acceptance.

| Experiment group | Main result and useful control |
| --- | --- |
| D0-D2a: runner, manifest and research | D0 manifest PASS; D1/D1a uncovered a JSON text wrapper and root-shape error; D2 failed on a type-unsafe unwrap; D2a completed two-film research after type-safe bounded unwrap. |
| D3-D4: complete schema and context | Intermediate-output truncation in D3 and report truncation limited the result. Compact context projection restored complete input in D3a, but research still stopped early; exact D3b repeat and reduced manifest D4 also failed. |
| D5: minimal generation | Both scoped local fingerprint/prediction candidates produced; no full evidence/assessment/scoring acceptance. [Result](https://trello.com/c/vyxbU1l0#comment-6b058ca621dd5803ef533d71). |
| D6/D6a: add evidence | First run stopped during research; exact replay produced both local candidates with evidence. This is evidence of intermittent execution, not a deterministic prompt-length boundary. [Result](https://trello.com/c/vyxbU1l0#comment-6b0592c2530f2588cb7fab11). |
| D7: add assessment | Both candidate objects survived a truncated report, but content review found speculative premise/risk handling; execution success was not full scoring acceptance. [Result](https://trello.com/c/vyxbU1l0#comment-6b05963bdd2cf3aaa69c0ee5). |
| D8-D11: full scoring, compact variants and per-film order | Full scoring and its repeat stopped before scoring. Further shortening and changing per-film order did not restore completion; several experiments never reached the changed stage. No causal test of scoring semantics or ordering was established. |
| D12-D14: exact positive controls | Previously successful D7 failed; exact D2a research-only passed; exact D5 failed. Same logical manifest and Worker for this group supported comparison, but outcomes did not isolate prompt length. [Research-only control](https://trello.com/c/vyxbU1l0#comment-6b05b2f3aaf54111fcd3d3c1), [D5 replay](https://trello.com/c/vyxbU1l0#comment-6b05b4776040e536cef0823a). |
| D15-D16: interactive vs scheduled D5 | Same logical manifest/Worker/38,798-byte response. D15 made two observed MCP calls and produced local candidate JSON; D16 stopped at one web search with zero candidates. **Correction:** D15 did not actually execute the claimed web research calls in the interactive turn. Its earlier PASS and source-read claims cannot be credited; it is only a verified MCP/local-output comparison, not end-to-end evidence. [Scheduled result](https://trello.com/c/vyxbU1l0#comment-6b05ba727a423db7cd16673f). |
| D17: full functional prompt, one target | Stopped before manifest retrieval, after successful runner. The workload reduction was not reached, so one-film recovery remains untested. |
| D19a/b: original Task vs exact clone | Identical prompts (original D5 plus the same model self-report instruction), same logical manifest and Worker. Both failed, with different research depth. Task identity alone was not a remedy; latency differed. |
| D20: parent model selection | Created after the owner selected a different model in the parent chat. The exact D19b prompt still self-reported GPT-6.2 and stopped immediately after the runner, before start. The tested inheritance path did not switch the reported model. [Result](https://trello.com/c/vyxbU1l0#comment-6b05d35f424180c8e0dc2e47). |

D17, D19a, D19b and D20 all self-reported GPT-6.2 at start and end with unknown effort, and all had untruncated reports and recorded scheduler status completed despite failure. [Matched-series results](https://trello.com/c/vyxbU1l0#comment-6b05ccf18f439f1b84782d1e). The prior working model identity and internal execution budget were not observable. In D17 and D20 the only independently observed MCP call was the successful runner; large-manifest delivery, web switching and generation workload were therefore not necessary triggers of those failures.

**Working incident conclusion:** a platform/caller execution regression is the leading explanation. The coordinator identified a same-day model rollout and similar public user reports in the [external RCA record](https://trello.com/c/vyxbU1l0#comment-6b05bc2b590cafc9583ba9d4); neither that correlation nor model self-report establishes the exact internal change. A fixed time/token cap was not demonstrated. The diagnostic series did not recover production. The owner declined a support escalation, retained the constraints in [AIR-461](https://trello.com/c/a9TdXgNM) and chose to stop experiments and consider a single existing production Task canary the following morning. This decision does not authorize a Task change by itself; verify current state and obtain the specific GO at execution time.

## Reusable lessons

- Preserve the exact successful and failed controls, actual run windows, observed tool boundaries, contract and input identities. Separate wrapper defects, payload size, prompt length, target-film workload and final report truncation.
- Exercise the real production-derived research/generation contract incrementally, with actual manifest films. A diagnostic that never reaches the changed stage cannot falsify that stage. Do not weaken quality to manufacture PASS.
- Compare actual Task execution with Worker responses and durable receipts. For read-only experiments, write counts and local candidates are not saved forecasts. Do not treat status completed as a successful workflow.
- Prefer a real-run canary only when it answers a specific remaining question, under an explicit authorization and safe lease/authority conditions. Keep the successful ownership-recovery case distinct from the unremediated platform case.
- Stop when exact replays and relevant controls fail without a new hypothesis. Preserve uncertainty and the next useful check, not an endless list of prompt variants.

No new model run, production operation, configuration change or external verification was performed for this synthesis. The purpose is to retain operational knowledge rather than turn historical observations into current runtime authority.
